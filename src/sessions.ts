import { randomBytes } from 'node:crypto';
import { ApiError } from './types.ts';
import { MAX_TTL } from './config.ts';
import type {
  ChromeInstance,
  Config,
  CreateSessionRequest,
  InstanceManager,
  Isolation,
  SessionInfo,
  SessionManager,
  WindowBounds,
} from './types.ts';
import type { ChromeInstanceManager, TargetDestroyedSource } from './chrome.ts';

const ISOLATIONS: readonly Isolation[] = ['shared', 'context', 'profile', 'attached'];
const ALLOWED_KEYS = new Set(['isolation', 'profile', 'headless', 'url', 'ttl', 'instance', 'targetId', 'newWindow']);
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Instance ids look like "i_default_headless" or "x_chrome".
const INSTANCE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Contain the blast radius of a leaked dashboard/token: no file:// or chrome:// tabs.
const URL_RE = /^(?:https?:\/\/|about:)/i;

interface ParsedRequest {
  isolation: Isolation;
  profile: string;
  headless: boolean;
  url: string;
  ttl: number;
  instance: string | null;
  targetId: string | null;
  newWindow: boolean;
}

/** Internal session record: SessionInfo plus what must never leave the process. */
interface SessionRecord extends SessionInfo {
  /** false for 'attached': destroy/expiry unregister but never close the user's tab. */
  closeOnDestroy: boolean;
}

function toInfo(r: SessionRecord): SessionInfo {
  const { closeOnDestroy: _closeOnDestroy, ...info } = r;
  return info;
}

export function parseRequest(req: CreateSessionRequest, config: Config): ParsedRequest {
  if (typeof req !== 'object' || req === null || Array.isArray(req)) {
    throw new ApiError(400, 'request body must be a JSON object');
  }
  for (const key of Object.keys(req)) {
    if (!ALLOWED_KEYS.has(key)) throw new ApiError(400, `unknown field "${key}"`);
  }
  const { isolation, profile, headless, url, ttl, instance, targetId, newWindow } = req;
  if (isolation !== undefined && !ISOLATIONS.includes(isolation)) {
    throw new ApiError(400, '"isolation" must be one of shared|context|profile|attached');
  }
  if (profile !== undefined && (typeof profile !== 'string' || !PROFILE_RE.test(profile))) {
    throw new ApiError(400, '"profile" must be a name of letters, digits, ".", "_" or "-"');
  }
  if (isolation === 'profile' && profile === undefined) {
    throw new ApiError(400, 'isolation "profile" requires an explicit "profile" name');
  }
  if (headless !== undefined && typeof headless !== 'boolean') {
    throw new ApiError(400, '"headless" must be a boolean');
  }
  if (url !== undefined && (typeof url !== 'string' || !URL_RE.test(url))) {
    throw new ApiError(400, '"url" must be an http://, https:// or about: URL');
  }
  if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < 0 || ttl > MAX_TTL)) {
    throw new ApiError(400, `"ttl" must be a number of seconds between 0 and ${MAX_TTL}`);
  }
  if (instance !== undefined && (typeof instance !== 'string' || !INSTANCE_RE.test(instance))) {
    throw new ApiError(400, '"instance" must be an instance id (e.g. "x_chrome")');
  }
  if (instance !== undefined && (profile !== undefined || headless !== undefined)) {
    throw new ApiError(400, '"instance" routes to a running instance and cannot be combined with "profile" or "headless"');
  }
  if (targetId !== undefined && (typeof targetId !== 'string' || targetId.length === 0 || targetId.length > 256)) {
    throw new ApiError(400, '"targetId" must be a non-empty string');
  }
  if (newWindow !== undefined && typeof newWindow !== 'boolean') {
    throw new ApiError(400, '"newWindow" must be a boolean');
  }
  const iso = isolation ?? 'context';
  if (iso === 'attached') {
    if (instance === undefined || targetId === undefined) {
      throw new ApiError(400, 'isolation "attached" requires "instance" and "targetId"');
    }
    if (url !== undefined) {
      throw new ApiError(400, '"url" is not valid with isolation "attached" (the tab already has one)');
    }
  } else if (targetId !== undefined) {
    throw new ApiError(400, '"targetId" is only valid with isolation "attached"');
  }
  return {
    isolation: iso,
    profile: profile ?? 'default',
    headless: headless ?? config.defaultHeadless,
    url: url ?? 'about:blank',
    ttl: ttl ?? config.defaultTtl,
    instance: instance ?? null,
    targetId: targetId ?? null,
    // A dedicated window when parking, so parking never drags the user's other tabs along.
    newWindow: newWindow ?? config.windowBounds != null,
  };
}

export function createSessionManager(config: Config, instances: InstanceManager): SessionManager {
  const sessions = new Map<string, SessionRecord>();
  const idleSince = new Map<string, number>(); // instanceId -> first time seen with 0 sessions
  let reaper: NodeJS.Timeout | null = null;
  let reaping = false;

  function syncCounts(): void {
    const counts = new Map<string, number>();
    for (const s of sessions.values()) counts.set(s.instanceId, (counts.get(s.instanceId) ?? 0) + 1);
    for (const inst of instances.list()) inst.sessionCount = counts.get(inst.id) ?? 0;
  }

  function newId(): string {
    let id: string;
    do id = 's_' + randomBytes(3).toString('hex');
    while (sessions.has(id));
    return id;
  }

  function disposeContext(instanceId: string, browserContextId: string): void {
    instances
      .get(instanceId)
      ?.cdp.send('Target.disposeBrowserContext', { browserContextId })
      .catch(() => {});
  }

  // Best-effort: move the target's window onto windowBounds; never fails session creation.
  async function parkWindow(instance: ChromeInstance, targetId: string, bounds: WindowBounds): Promise<void> {
    try {
      const { windowId } = await instance.cdp.send('Browser.getWindowForTarget', { targetId });
      // Normal state first: bounds are ignored while minimized/maximized/fullscreen.
      await instance.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await instance.cdp.send('Browser.setWindowBounds', { windowId, bounds: { ...bounds, windowState: 'normal' } });
    } catch {
      // Headless refuses window ops and adopted browsers may decline; parking is a convenience.
    }
  }

  // Tab closed by a human (or anything else) -> drop the session.
  (instances as InstanceManager & Partial<TargetDestroyedSource>).onTargetDestroyed?.(
    (instanceId, targetId) => {
      for (const s of sessions.values()) {
        if (s.instanceId === instanceId && s.targetId === targetId) {
          sessions.delete(s.id);
          if (s.browserContextId) disposeContext(instanceId, s.browserContextId);
          break;
        }
      }
      syncCounts();
    },
  );

  instances.onExit((instanceId) => {
    for (const s of [...sessions.values()]) {
      if (s.instanceId === instanceId) sessions.delete(s.id);
    }
    idleSince.delete(instanceId);
  });

  async function destroy(id: string): Promise<void> {
    const s = sessions.get(id);
    if (!s) throw new ApiError(404, `no such session: ${id}`);
    sessions.delete(id);
    const instance = instances.get(s.instanceId);
    if (instance) {
      // Only close what OpenTab created; 'attached' wraps the user's own tab.
      if (s.closeOnDestroy) {
        try {
          await instance.cdp.send('Target.closeTarget', { targetId: s.targetId });
        } catch {}
      }
      if (s.browserContextId) {
        try {
          await instance.cdp.send('Target.disposeBrowserContext', {
            browserContextId: s.browserContextId,
          });
        } catch {}
      }
    }
    syncCounts();
  }

  async function reap(): Promise<void> {
    if (reaping) return;
    reaping = true;
    try {
      const now = Date.now();
      for (const s of [...sessions.values()]) {
        if (s.expiresAt && Date.parse(s.expiresAt) <= now) {
          await destroy(s.id).catch(() => {});
        }
      }
      // Sessions on vanished or disconnected instances are unreachable: unregister, close nothing.
      for (const s of [...sessions.values()]) {
        const inst = instances.get(s.instanceId);
        if (!inst || inst.state === 'disconnected') sessions.delete(s.id);
      }
      // Reconcile against live targets: drop sessions whose tab is gone.
      for (const inst of instances.list()) {
        if (inst.state === 'disconnected') continue;
        let result: any;
        try {
          result = await inst.cdp.send('Target.getTargets');
        } catch {
          continue;
        }
        const alive = new Set<string>(
          (result.targetInfos as { targetId: string }[]).map((t) => t.targetId),
        );
        for (const s of [...sessions.values()]) {
          if (s.instanceId !== inst.id || alive.has(s.targetId)) continue;
          sessions.delete(s.id);
          if (s.browserContextId) disposeContext(inst.id, s.browserContextId);
        }
      }
      syncCounts();
      if (config.stopIdleInstancesAfter > 0) {
        const live = new Set<string>();
        for (const inst of instances.list()) {
          live.add(inst.id);
          // Never idle-reap adopted instances, and never external ones (safety rule).
          if (inst.adopted || inst.external) continue;
          if (inst.sessionCount > 0) {
            idleSince.delete(inst.id);
            continue;
          }
          const since = idleSince.get(inst.id);
          if (since === undefined) {
            idleSince.set(inst.id, now);
          } else if (now - since >= config.stopIdleInstancesAfter * 1000) {
            idleSince.delete(inst.id);
            await instances.stop(inst.id).catch(() => {});
          }
        }
        for (const id of [...idleSince.keys()]) if (!live.has(id)) idleSince.delete(id);
      }
      // Best-effort (the reaper must never throw): re-probe disconnected externals, adopt autoAdopt names.
      const mgr = instances as InstanceManager & Partial<ChromeInstanceManager>;
      if (mgr.reprobeDisconnected) {
        try {
          await mgr.reprobeDisconnected();
        } catch {}
      } else {
        for (const inst of instances.list()) {
          if (!inst.external || inst.state !== 'disconnected') continue;
          try {
            await instances.adoptExternal(inst.profile);
          } catch {}
        }
      }
      for (const name of config.autoAdopt ?? []) {
        if (instances.get(`x_${name}`)) continue;
        try {
          await instances.adoptExternal(name);
        } catch {}
      }
    } finally {
      reaping = false;
    }
  }

  return {
    async create(req) {
      const p = parseRequest(req, config);
      let instance: ChromeInstance;
      if (p.instance) {
        const found = instances.get(p.instance);
        if (!found) throw new ApiError(404, `no such instance: ${p.instance}`);
        if (found.state === 'disconnected') {
          throw new ApiError(
            409,
            `instance ${p.instance} is disconnected — check that Chrome is running with ` +
              'remote debugging enabled, then re-adopt (POST /api/adopt or `opentab adopt`)',
          );
        }
        instance = found;
      } else {
        instance = await instances.ensure(p.profile, p.headless);
      }
      if (instance.external && p.isolation === 'profile') {
        throw new ApiError(
          400,
          `isolation "profile" is meaningless on external instance ${instance.id} — use shared, context or attached`,
        );
      }
      let browserContextId: string | null = null;
      let targetId: string;
      let url = p.url;
      if (p.isolation === 'attached') {
        // Wrap an existing target; create nothing.
        const r = await instance.cdp.send('Target.getTargets');
        const target = (r.targetInfos as { targetId: string; url: string }[]).find(
          (t) => t.targetId === p.targetId,
        );
        if (!target) {
          throw new ApiError(
            404,
            `no such target on ${instance.id}: ${p.targetId} (list tabs with GET /api/instances/${instance.id}/tabs)`,
          );
        }
        targetId = target.targetId;
        url = target.url;
      } else {
        if (p.isolation === 'context') {
          const r = await instance.cdp.send('Target.createBrowserContext');
          browserContextId = r.browserContextId as string;
        }
        try {
          const params: Record<string, unknown> = { url: p.url };
          if (browserContextId) params.browserContextId = browserContextId;
          if (p.newWindow) params.newWindow = true;
          const r = await instance.cdp.send('Target.createTarget', params);
          targetId = r.targetId as string;
        } catch (err) {
          if (browserContextId) disposeContext(instance.id, browserContextId);
          throw err;
        }
        if (config.windowBounds) await parkWindow(instance, targetId, config.windowBounds);
      }
      const now = Date.now();
      const info: SessionRecord = {
        id: newId(),
        isolation: p.isolation,
        profile: instance.profile,
        headless: instance.headless,
        instanceId: instance.id,
        targetId,
        browserContextId,
        url,
        createdAt: new Date(now).toISOString(),
        expiresAt: p.ttl > 0 ? new Date(now + p.ttl * 1000).toISOString() : null,
        closeOnDestroy: p.isolation !== 'attached',
      };
      sessions.set(info.id, info);
      idleSince.delete(instance.id);
      syncCounts();
      return toInfo(info);
    },

    get(id) {
      const r = sessions.get(id);
      return r && toInfo(r);
    },

    list() {
      return [...sessions.values()].map(toInfo);
    },

    destroy,

    async destroyAll() {
      for (const id of [...sessions.keys()]) {
        await destroy(id).catch(() => {});
      }
    },

    startReaper() {
      if (reaper) return;
      // Test-only override; production is 30s.
      const interval = Number(process.env.OPENTAB_REAPER_INTERVAL_MS) || 30_000;
      reaper = setInterval(() => void reap(), interval);
      reaper.unref();
    },

    stopReaper() {
      if (reaper) {
        clearInterval(reaper);
        reaper = null;
      }
    },
  };
}
