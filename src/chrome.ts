import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectCdp } from './cdp.ts';
import { ApiError } from './types.ts';
import type { CdpClient, ChromeInstance, Config, InstanceManager } from './types.ts';

/** sessions.ts subscribes here to reap sessions whose tab a human closed. */
export interface TargetDestroyedSource {
  onTargetDestroyed(handler: (instanceId: string, targetId: string) => void): void;
}

export interface ChromeInstanceManager extends InstanceManager, TargetDestroyedSource {
  /** Re-dial every 'disconnected' external instance; the same id returns to 'running'. Never throws. */
  reprobeDisconnected(): Promise<void>;
}

const MAC_BUNDLE_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
];
const PATH_NAMES = ['chromium', 'google-chrome'];

/** Persist session cookies across relaunch: Chromium keeps them only when startup is set to
 *  "continue where you left off" (restore_on_startup=1). Merged non-destructively; seed before launch. */
export function seedProfilePreferences(profileDir: string): void {
  const defaultDir = join(profileDir, 'Default');
  mkdirSync(defaultDir, { recursive: true });
  const prefsPath = join(defaultDir, 'Preferences');
  let prefs: Record<string, unknown> = {};
  if (existsSync(prefsPath)) {
    try { prefs = JSON.parse(readFileSync(prefsPath, 'utf8')) as Record<string, unknown>; } catch { prefs = {}; }
  }
  const session = { ...(prefs.session as Record<string, unknown> | undefined) };
  if (session.restore_on_startup === 1) return;
  session.restore_on_startup = 1;
  prefs.session = session;
  writeFileSync(prefsPath, JSON.stringify(prefs));
}

export function detectChromeBinary(chromePath: string | null): string {
  if (chromePath) return chromePath;
  for (const p of MAC_BUNDLE_PATHS) if (existsSync(p)) return p;
  for (const name of PATH_NAMES) {
    for (const dir of (process.env.PATH ?? '').split(':')) {
      if (dir && existsSync(join(dir, name))) return join(dir, name);
    }
  }
  throw new ApiError(500, 'Chrome binary not found (set chromePath in config or OPENTAB_CHROME_PATH)');
}

function instanceKey(profile: string, headless: boolean): string {
  return `i_${profile}_${headless ? 'headless' : 'headful'}`;
}

function externalKey(name: string): string {
  return `x_${name}`;
}

function parseDevtoolsHash(webkitVersion: string | undefined): string {
  const m = /@([0-9a-fA-F]+)/.exec(webkitVersion ?? '');
  return m ? m[1] : '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function settled(p: Promise<void>, ms: number): Promise<boolean> {
  let done = false;
  await Promise.race([p.then(() => { done = true; }), sleep(ms)]);
  return done;
}

async function fetchVersion(port: number, timeoutMs: number): Promise<Record<string, string>> {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`/json/version -> ${res.status}`);
  return (await res.json()) as Record<string, string>;
}

interface Managed {
  info: ChromeInstance;
  child: ChildProcess | null; // null for adopted
  stopping: boolean;
  exited: Promise<void>;
  markExited: () => void;
  /** External instances only: the user-data-dir whose DevToolsActivePort we probe. */
  externalDir?: string;
}

interface ExternalProbe {
  cdpPort: number;
  wsPath: string;
  startedAt: string;
  devtoolsHash: string;
  cdp: CdpClient;
}

export function createInstanceManager(config: Config): ChromeInstanceManager {
  const managed = new Map<string, Managed>();
  const launching = new Map<string, Promise<ChromeInstance>>();
  const exitHandlers: ((id: string) => void)[] = [];
  const targetDestroyedHandlers: ((instanceId: string, targetId: string) => void)[] = [];

  function finalize(id: string): void {
    const m = managed.get(id);
    if (!m) return;
    managed.delete(id);
    try { m.info.cdp.close(); } catch {}
    m.markExited();
    for (const h of exitHandlers) h(id);
  }

  function register(info: ChromeInstance, child: ChildProcess | null): void {
    let markExited: () => void = () => {};
    const exited = new Promise<void>((r) => { markExited = r; });
    managed.set(info.id, { info, child, stopping: false, exited, markExited });
    info.cdp.on('Target.targetDestroyed', (p: { targetId: string }) => {
      for (const h of targetDestroyedHandlers) h(info.id, p.targetId);
    });
    // targetDestroyed only fires once discovery is on for this connection.
    info.cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
    if (child) child.on('exit', () => finalize(info.id));
    else info.cdp.onClose(() => finalize(info.id));
  }

  // External browsers (the user's real Chrome): never spawned, never closed, never signalled.

  /** Read <dir>/DevToolsActivePort and dial the browser ws; /json is off in toggle mode. */
  async function connectExternal(name: string, dir: string): Promise<ExternalProbe> {
    const portFile = join(dir, 'DevToolsActivePort');
    let cdpPort = 0;
    let wsPath = '';
    let startedAt = '';
    try {
      // lstat, never follow: the dir is caller-supplied, so a symlinked port file must not be chased.
      const st = lstatSync(portFile);
      if (!st.isFile()) {
        throw new ApiError(
          409,
          `DevToolsActivePort in ${dir} is not a regular file; refusing to follow it`,
        );
      }
      const [line1, line2] = readFileSync(portFile, 'utf8').split('\n');
      cdpPort = Number.parseInt(line1, 10);
      wsPath = (line2 ?? '').trim();
      startedAt = st.mtime.toISOString();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        409,
        `no DevToolsActivePort in ${dir}: enable chrome://inspect/#remote-debugging and relaunch Chrome`,
      );
    }
    if (!(cdpPort > 0) || !wsPath.startsWith('/devtools/browser/')) {
      throw new ApiError(
        409,
        `unusable DevToolsActivePort in ${dir}: enable chrome://inspect/#remote-debugging and relaunch Chrome`,
      );
    }
    let cdp: CdpClient;
    try {
      // Toggle mode gates each new browser-ws connection behind a consent dialog; allow two minutes.
      cdp = await connectCdp(`ws://127.0.0.1:${cdpPort}${wsPath}`, { connectTimeoutMs: 120_000 });
    } catch {
      throw new ApiError(
        409,
        `browser websocket for "${name}" (127.0.0.1:${cdpPort}) did not open: ` +
          'if Chrome is showing a remote-debugging consent dialog, approve it and retry; ' +
          'otherwise Chrome restarted or the toggle is disabled — re-check chrome://inspect/#remote-debugging',
      );
    }
    let version: Record<string, string>;
    try {
      version = await cdp.send('Browser.getVersion');
    } catch {
      try { cdp.close(); } catch {}
      throw new ApiError(
        409,
        `browser websocket for "${name}" did not answer Browser.getVersion: ` +
          'Chrome restarted or toggle disabled; re-check chrome://inspect/#remote-debugging',
      );
    }
    // No /json/version here; revision is "@<hash>" (same hash the frontend relay needs).
    const devtoolsHash = String(version.revision ?? '').replace(/^@/, '');
    return { cdpPort, wsPath, startedAt, devtoolsHash, cdp };
  }

  /** Like register(), but on close mark 'disconnected' and keep the entry for the reaper to re-probe. */
  function wireExternal(m: Managed, cdp: CdpClient): void {
    const id = m.info.id;
    cdp.on('Target.targetDestroyed', (p: { targetId: string }) => {
      for (const h of targetDestroyedHandlers) h(id, p.targetId);
    });
    cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
    cdp.onClose(() => {
      const cur = managed.get(id);
      // Forgotten (DELETE) or already superseded by a reconnect: nothing to do.
      if (!cur || cur.info.cdp !== cdp) return;
      cur.info.state = 'disconnected';
      for (const h of exitHandlers) h(id); // sessions on it get reaped
    });
  }

  function registerExternal(name: string, dir: string, probe: ExternalProbe): ChromeInstance {
    const info: ChromeInstance = {
      id: externalKey(name),
      profile: name,
      headless: false,
      pid: null,
      adopted: true,
      external: true,
      state: 'running',
      cdpPort: probe.cdpPort,
      browserWsPath: probe.wsPath,
      devtoolsHash: probe.devtoolsHash,
      startedAt: probe.startedAt,
      sessionCount: 0,
      cdp: probe.cdp,
    };
    let markExited: () => void = () => {};
    const exited = new Promise<void>((r) => { markExited = r; });
    const m: Managed = { info, child: null, stopping: false, exited, markExited, externalDir: dir };
    managed.set(info.id, m);
    wireExternal(m, probe.cdp);
    return info;
  }

  async function launch(profile: string, headless: boolean): Promise<ChromeInstance> {
    const id = instanceKey(profile, headless);
    const bin = detectChromeBinary(config.chromePath);
    const dir = join(config.profilesDir, profile);
    mkdirSync(dir, { recursive: true });
    seedProfilePreferences(dir);
    const portFile = join(dir, 'DevToolsActivePort');
    const launchStart = Date.now();
    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(headless ? ['--headless=new'] : []),
      // Drops navigator.webdriver; the HeadlessChrome UA tell remains (see wiki).
      ...(config.stealth ? ['--disable-blink-features=AutomationControlled'] : []),
      ...config.extraChromeArgs,
      'about:blank',
    ];
    // detached: own process group, so a terminal Ctrl-C (SIGINT to serve's group) can't kill Chrome.
    const child = spawn(bin, args, { stdio: 'ignore', detached: true });
    child.unref();
    let spawnError: Error | null = null;
    let exitedEarly = false;
    child.once('error', (e) => { spawnError = e; });
    child.once('exit', () => { exitedEarly = true; });

    const fail = (msg: string): ApiError => {
      try { child.kill('SIGKILL'); } catch {}
      return new ApiError(500, msg);
    };

    const deadline = launchStart + 30_000;
    let cdpPort = 0;
    let wsPath = '';
    while (Date.now() < deadline) {
      if (spawnError) throw fail(`failed to launch chrome: ${(spawnError as Error).message}`);
      if (exitedEarly) throw fail(`chrome exited during startup (profile "${profile}")`);
      try {
        const st = statSync(portFile);
        // mtime must postdate this launch: ignore stale files from crashed runs.
        if (st.mtimeMs > launchStart) {
          const [line1, line2] = readFileSync(portFile, 'utf8').split('\n');
          const port = Number.parseInt(line1, 10);
          const path = (line2 ?? '').trim();
          if (port > 0 && path.startsWith('/devtools/browser/')) {
            cdpPort = port;
            wsPath = path;
            break;
          }
        }
      } catch {}
      await sleep(100);
    }
    if (!cdpPort) throw fail('timed out waiting for DevToolsActivePort (30s)');

    let version: Record<string, string> | null = null;
    while (Date.now() < deadline && !version) {
      if (exitedEarly) throw fail(`chrome exited during startup (profile "${profile}")`);
      try {
        version = await fetchVersion(cdpPort, 2000);
      } catch {
        await sleep(200);
      }
    }
    if (!version) throw fail('timed out waiting for /json/version (30s)');

    const cdp = await connectCdp(`ws://127.0.0.1:${cdpPort}${wsPath}`).catch((e: Error) => {
      throw fail(`failed to connect browser websocket: ${e.message}`);
    });

    const info: ChromeInstance = {
      id,
      profile,
      headless,
      pid: child.pid ?? null,
      adopted: false,
      external: false,
      state: 'running',
      cdpPort,
      browserWsPath: wsPath,
      devtoolsHash: parseDevtoolsHash(version['WebKit-Version']),
      startedAt: new Date(launchStart).toISOString(),
      sessionCount: 0,
      cdp,
    };
    register(info, child);
    return info;
  }

  const manager: ChromeInstanceManager = {
    async ensure(profile, headless) {
      if (!profile || profile.includes('/') || profile.includes('..')) {
        throw new ApiError(400, `invalid profile name: ${JSON.stringify(profile)}`);
      }
      const id = instanceKey(profile, headless);
      const existing = managed.get(id);
      if (existing) {
        if (!existing.stopping) return existing.info;
        // Mid-teardown (idle reap / DELETE racing us): wait it out, then launch fresh.
        await existing.exited;
        return manager.ensure(profile, headless);
      }
      const inflight = launching.get(id);
      if (inflight) return inflight;
      const oppositeId = instanceKey(profile, !headless);
      if (managed.has(oppositeId) || launching.has(oppositeId)) {
        throw new ApiError(
          409,
          `profile "${profile}" is locked by ${headless ? 'headful' : 'headless'} instance ${oppositeId}; ` +
            `stop it (DELETE /api/instances/${oppositeId}) or use another profile`,
        );
      }
      const p = launch(profile, headless);
      launching.set(id, p);
      try {
        return await p;
      } finally {
        launching.delete(id);
      }
    },

    get(id) {
      return managed.get(id)?.info;
    },

    list() {
      return [...managed.values()].map((m) => m.info);
    },

    async adoptExisting() {
      let entries;
      try {
        entries = readdirSync(config.profilesDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const profile = entry.name;
        const portFile = join(config.profilesDir, profile, 'DevToolsActivePort');
        let cdpPort = 0;
        let wsPath = '';
        let startedAt = '';
        try {
          const st = statSync(portFile);
          const [line1, line2] = readFileSync(portFile, 'utf8').split('\n');
          cdpPort = Number.parseInt(line1, 10);
          wsPath = (line2 ?? '').trim();
          startedAt = st.mtime.toISOString();
        } catch {
          continue;
        }
        if (!(cdpPort > 0) || !wsPath.startsWith('/devtools/browser/')) continue;
        let version: Record<string, string>;
        try {
          version = await fetchVersion(cdpPort, 1500);
        } catch {
          continue; // stale file, nothing listening
        }
        // Stale file + port reused by another process would carry a different ws uuid.
        if (!(version.webSocketDebuggerUrl ?? '').endsWith(wsPath)) continue;
        const headless = /headless/i.test(version['User-Agent'] ?? '');
        const id = instanceKey(profile, headless);
        if (managed.has(id) || managed.has(instanceKey(profile, !headless))) continue;
        let cdp;
        try {
          cdp = await connectCdp(`ws://127.0.0.1:${cdpPort}${wsPath}`);
        } catch {
          continue;
        }
        register(
          {
            id,
            profile,
            headless,
            pid: null,
            adopted: true,
            external: false,
            state: 'running',
            cdpPort,
            browserWsPath: wsPath,
            devtoolsHash: parseDevtoolsHash(version['WebKit-Version']),
            startedAt,
            sessionCount: 0,
            cdp,
          },
          null,
        );
      }
    },

    async adoptExternal(name, userDataDir) {
      if (!name || name.includes('/') || name.includes('..')) {
        throw new ApiError(400, `invalid external browser name: ${JSON.stringify(name)}`);
      }
      const id = externalKey(name);
      const existing = managed.get(id);
      const dir = userDataDir ?? existing?.externalDir ?? config.externalBrowsers[name]?.userDataDir;
      if (!dir) {
        const known = Object.keys(config.externalBrowsers).join(', ');
        throw new ApiError(
          400,
          `unknown external browser "${name}" (known: ${known || 'none'}); ` +
            'add it to config externalBrowsers or pass userDataDir',
        );
      }
      // Idempotent: a connected instance is simply returned.
      if (existing && existing.info.state === 'running') {
        existing.externalDir = dir;
        return existing.info;
      }
      const inflight = launching.get(id);
      if (inflight) return inflight;
      // A known entry that vanishes mid-probe was DELETE'd and must not be resurrected.
      const wasKnown = existing !== undefined;
      const p = (async () => {
        const probe = await connectExternal(name, dir);
        const m = managed.get(id);
        if (!m) {
          if (wasKnown) {
            // Forgotten by DELETE while we probed: drop the probe, do not re-register.
            try { probe.cdp.close(); } catch {}
            throw new ApiError(409, `external instance ${id} was forgotten during reconnect`);
          }
          return registerExternal(name, dir, probe);
        }
        if (m.info.state === 'running') {
          // Reconnected elsewhere while we probed; keep the live connection.
          try { probe.cdp.close(); } catch {}
          return m.info;
        }
        // Re-probed after disconnect: same id returns to 'running'; a restart changes port + uuid.
        m.externalDir = dir;
        m.info.cdp = probe.cdp;
        m.info.cdpPort = probe.cdpPort;
        m.info.browserWsPath = probe.wsPath;
        m.info.devtoolsHash = probe.devtoolsHash;
        m.info.startedAt = probe.startedAt;
        m.info.state = 'running';
        wireExternal(m, probe.cdp);
        return m.info;
      })();
      launching.set(id, p);
      try {
        return await p;
      } finally {
        launching.delete(id);
      }
    },

    async reprobeDisconnected() {
      const jobs: Promise<unknown>[] = [];
      for (const m of [...managed.values()]) {
        if (m.info.external && m.info.state === 'disconnected') {
          jobs.push(manager.adoptExternal(m.info.profile, m.externalDir).catch(() => {}));
        }
      }
      await Promise.all(jobs);
    },

    async stop(id) {
      const m = managed.get(id);
      if (!m) throw new ApiError(404, `no such instance: ${id}`);
      if (m.info.external) {
        // Never Browser.close or signal an external; the caller already destroyed
        // OpenTab-created sessions, so just disconnect and forget.
        m.stopping = true;
        m.info.state = 'disconnected';
        finalize(id);
        return;
      }
      if (m.stopping) {
        await m.exited;
        return;
      }
      m.stopping = true;
      try {
        await Promise.race([m.info.cdp.send('Browser.close'), sleep(2000)]);
      } catch {}
      if (!(await settled(m.exited, 5000)) && m.child) {
        try { m.child.kill('SIGTERM'); } catch {}
        if (!(await settled(m.exited, 5000))) {
          try { m.child.kill('SIGKILL'); } catch {}
          await settled(m.exited, 2000);
        }
      }
      finalize(id); // idempotent; covers adopted instances whose socket never closed
    },

    async disconnectAll() {
      // serve shutdown drops CDP but leaves every Chrome running; adoptExisting re-adopts on next boot.
      for (const m of managed.values()) {
        if (m.info.external) m.info.state = 'disconnected';
        try { m.info.cdp.close(); } catch {}
      }
    },

    onExit(handler) {
      exitHandlers.push(handler);
    },

    onTargetDestroyed(handler) {
      targetDestroyedHandlers.push(handler);
    },
  };

  return manager;
}
