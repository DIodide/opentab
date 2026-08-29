import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { ApiError } from './types.ts';
import type { AppContext, ChromeInstance } from './types.ts';
import { bridgePageConnection } from './bridge.ts';

// Chrome CDP frames can reach ~100MB (screenshots).
const MAX_PAYLOAD = 256 * 1024 * 1024;

// Mirrors the REST allowlist so a leaked token cannot open file:// or chrome:// tabs.
const CREATE_URL_RE = /^(?:https?:\/\/|about:)/i;

// Never forwarded to an adopted browser; acked so puppeteer's browser.close() still resolves.
const BLOCKED_EXTERNAL_BROWSER_METHODS = new Set([
  'Browser.close',
  'Browser.crash',
  'Browser.crashGpuProcess',
]);

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return (data as Buffer).toString('utf8');
}

// Targets OpenTab created on an adopted browser; /json/close and the pipe may close only these.
const externalCreatedTargets = new WeakMap<ChromeInstance, Set<string>>();

/** True for a target OpenTab created or owns on an adopted browser — the only ones it may close. */
export function isOpenTabExternalTarget(inst: ChromeInstance, ctx: AppContext, targetId: string): boolean {
  if (externalCreatedTargets.get(inst)?.has(targetId)) return true;
  return ctx.sessions
    .list()
    .some((s) => s.instanceId === inst.id && s.isolation !== 'attached' && s.targetId === targetId);
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

export interface RewriteOpts {
  wsBase: string;
  token: string;
  instanceId: string;
  cdpPort: number;
  devtoolsHash: string;
}

const FRONTEND_BASE = 'https://chrome-devtools-frontend.appspot.com/serve_rev';

export function rewriteJsonBody(body: string, opts: RewriteOpts): string {
  const { wsBase, token, instanceId, cdpPort, devtoolsHash } = opts;
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return body;
  }
  const wsPrefix = `ws://127.0.0.1:${cdpPort}/devtools/`;
  const proxied = (rest: string) => `${wsBase}/t/${token}/i/${instanceId}/devtools/${rest}`;
  // DevTools frontend param is host/path with no scheme; param name matches ws/wss base.
  const param = wsBase.startsWith('wss://') ? 'wss' : 'ws';
  // Same-host relay, never appspot: the query carries the token.
  const frontendUrl = (rest: string) =>
    `${wsBase.replace(/^ws/, 'http')}/t/${token}/devtools-frontend/@${devtoolsHash}` +
    `/inspector.html?${param}=${proxied(rest).replace(/^wss?:\/\//, '')}`;

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value !== 'string') {
        walk(value);
        continue;
      }
      if (key === 'devtoolsFrontendUrl') {
        const m = value.match(/[?&]wss?=[^&]*?\/devtools\/([^&]+)/);
        if (m) obj[key] = frontendUrl(m[1]);
      } else if (value.startsWith(wsPrefix)) {
        obj[key] = proxied(value.slice(wsPrefix.length));
      }
    }
  };
  walk(data);
  return JSON.stringify(data);
}

export async function handleInstanceHttp(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AppContext,
  instanceId: string,
  subPath: string,
): Promise<void> {
  const inst = ctx.instances.get(instanceId);
  if (!inst) throw new ApiError(404, `unknown instance: ${instanceId}`);
  if (inst.external) {
    // Toggle-mode Chrome serves empty /json responses; emulate them from CDP.
    await handleExternalJson(req, res, ctx, inst, subPath);
    return;
  }

  const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
    const preq = http.request(
      {
        host: '127.0.0.1',
        port: inst.cdpPort,
        path: subPath || '/',
        method: req.method,
        // Chrome rejects non-IP/localhost Host headers.
        headers: { host: `127.0.0.1:${inst.cdpPort}` },
      },
      resolve,
    );
    preq.on('error', (err) => reject(new ApiError(500, `instance unreachable: ${err.message}`)));
    req.pipe(preq);
  });

  const chunks: Buffer[] = [];
  for await (const chunk of upstream) chunks.push(chunk as Buffer);
  const rewritten = rewriteJsonBody(Buffer.concat(chunks).toString('utf8'), {
    wsBase: ctx.wsBase(req),
    token: ctx.auth.token,
    instanceId,
    cdpPort: inst.cdpPort,
    devtoolsHash: inst.devtoolsHash,
  });
  res.writeHead(upstream.statusCode ?? 500, {
    'content-type': upstream.headers['content-type'] ?? 'application/json; charset=UTF-8',
    'content-length': Buffer.byteLength(rewritten),
  });
  res.end(rewritten);
}

interface TargetInfoLike {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

/** A tab entry in Chrome's own /json/list shape, so rewriteJsonBody yields byte-compatible URLs. */
function nativeTabEntry(inst: ChromeInstance, t: TargetInfoLike): Record<string, string> {
  return {
    description: '',
    devtoolsFrontendUrl:
      `${FRONTEND_BASE}/@${inst.devtoolsHash}/inspector.html` +
      `?ws=127.0.0.1:${inst.cdpPort}/devtools/page/${t.targetId}`,
    id: t.targetId,
    title: t.title,
    type: t.type,
    url: t.url,
    webSocketDebuggerUrl: `ws://127.0.0.1:${inst.cdpPort}/devtools/page/${t.targetId}`,
  };
}

// Chrome labels its plain-text /json responses application/json.
function chromeText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=UTF-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendRewrittenJson(res: ServerResponse, nativeBody: string, opts: RewriteOpts): void {
  const rewritten = rewriteJsonBody(nativeBody, opts);
  res.writeHead(200, {
    'content-type': 'application/json; charset=UTF-8',
    'content-length': Buffer.byteLength(rewritten),
  });
  res.end(rewritten);
}

/** Emulates Chrome's /json endpoints from CDP, matching the forwarding path's contract exactly. */
async function handleExternalJson(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AppContext,
  inst: ChromeInstance,
  subPath: string,
): Promise<void> {
  req.resume(); // no upstream to pipe any request body into
  if (inst.state === 'disconnected') {
    throw new ApiError(
      500,
      `instance ${inst.id} is disconnected (Chrome restarted or the remote-debugging toggle was disabled); ` +
        're-adopt it (POST /api/adopt) or wait for the reaper to reconnect',
    );
  }
  const u = new URL(subPath || '/', 'http://internal');
  const path = u.pathname;
  const opts: RewriteOpts = {
    wsBase: ctx.wsBase(req),
    token: ctx.auth.token,
    instanceId: inst.id,
    cdpPort: inst.cdpPort,
    devtoolsHash: inst.devtoolsHash,
  };
  const cdp = async (method: string, params?: Record<string, unknown>): Promise<any> => {
    try {
      return await inst.cdp.send(method, params);
    } catch (err) {
      throw new ApiError(500, `instance unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (path === '/json' || path === '/json/list') {
    const r = await cdp('Target.getTargets');
    const pages = (r.targetInfos as TargetInfoLike[]).filter((t) => t.type === 'page');
    sendRewrittenJson(res, JSON.stringify(pages.map((t) => nativeTabEntry(inst, t))), opts);
    return;
  }

  if (path === '/json/version') {
    const v = await cdp('Browser.getVersion');
    // Browser.getVersion.revision is the "@<hash>" /json/version embeds in WebKit-Version.
    const revision =
      typeof v.revision === 'string' && v.revision.startsWith('@') ? v.revision : `@${inst.devtoolsHash}`;
    const native = {
      Browser: v.product,
      'Protocol-Version': v.protocolVersion,
      'User-Agent': v.userAgent,
      'V8-Version': v.jsVersion,
      'WebKit-Version': `537.36 (${revision})`,
      webSocketDebuggerUrl: `ws://127.0.0.1:${inst.cdpPort}${inst.browserWsPath}`,
    };
    sendRewrittenJson(res, JSON.stringify(native), opts);
    return;
  }

  if (path === '/json/new') {
    if (req.method !== 'PUT') {
      chromeText(
        res,
        405,
        `Using unsafe HTTP verb ${req.method} to invoke /json/new. This action supports only PUT verb.`,
      );
      return;
    }
    // Chrome treats the entire query string as the URL; invalid ones become about:blank.
    const rawQuery = u.search.startsWith('?') ? u.search.slice(1) : '';
    let url = rawQuery;
    try {
      url = decodeURIComponent(rawQuery);
    } catch {}
    if (!url) url = 'about:blank';
    if (!CREATE_URL_RE.test(url)) {
      chromeText(res, 400, `Disallowed URL: only http(s):// and about: tabs may be created (${url})`);
      return;
    }
    const created = await cdp('Target.createTarget', { url });
    const targetId = created.targetId as string;
    let owned = externalCreatedTargets.get(inst);
    if (!owned) externalCreatedTargets.set(inst, (owned = new Set<string>()));
    owned.add(targetId);
    let info: TargetInfoLike = { targetId, type: 'page', title: '', url };
    try {
      const ti = await inst.cdp.send('Target.getTargetInfo', { targetId });
      if (ti?.targetInfo) info = ti.targetInfo as TargetInfoLike;
    } catch {}
    sendRewrittenJson(res, JSON.stringify(nativeTabEntry(inst, info)), opts);
    return;
  }

  const mClose = /^\/json\/close\/(.+)$/.exec(path);
  if (mClose) {
    const targetId = mClose[1];
    const owned = externalCreatedTargets.get(inst);
    if (!isOpenTabExternalTarget(inst, ctx, targetId)) {
      // Never close the user's own tabs; answer as Chrome does for an unknown id (no oracle).
      chromeText(res, 404, `No such target id: ${targetId}`);
      return;
    }
    try {
      await inst.cdp.send('Target.closeTarget', { targetId });
      owned?.delete(targetId);
      chromeText(res, 200, 'Target is closing');
    } catch {
      chromeText(res, 404, `No such target id: ${targetId}`);
    }
    return;
  }

  const mActivate = /^\/json\/activate\/(.+)$/.exec(path);
  if (mActivate) {
    try {
      await inst.cdp.send('Target.activateTarget', { targetId: mActivate[1] });
      chromeText(res, 200, 'Target activated');
    } catch {
      chromeText(res, 404, `No such target id: ${mActivate[1]}`);
    }
    return;
  }

  chromeText(res, 404, `Unknown command: ${path.replace(/^\/json\/?/, '')}`);
}

// "@<hash>/<asset path>"; ".." passes the char class, hence the explicit check below.
const FRONTEND_PATH_RE = /^@[0-9a-f]+(?:\/[A-Za-z0-9_.-]+)+$/i;

/** Relays DevTools frontend assets from our origin so the tokened ws= query never reaches appspot. */
export async function handleFrontendHttp(
  req: IncomingMessage,
  res: ServerResponse,
  rest: string,
): Promise<void> {
  if (req.method !== 'GET' || !FRONTEND_PATH_RE.test(rest) || rest.includes('..')) {
    throw new ApiError(404, 'not found');
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${FRONTEND_BASE}/${rest}`, { signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new ApiError(500, `devtools frontend unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    'content-length': body.length,
    // Assets are revision-pinned and immutable; let the browser cache them.
    'cache-control': upstream.headers.get('cache-control') ?? 'public, max-age=604800',
  });
  res.end(body);
}

export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, ctx: AppContext): void {
  const url = req.url ?? '';
  const m = url.match(/^\/t\/([^/]+)(\/.*)$/);
  if (!m || !ctx.auth.check(m[1])) {
    socket.destroy();
    return;
  }
  const rest = m[2];

  let target: string | null = null;
  // Only the raw browser-ws pipe to an adopted Chrome gets the command guard.
  let guardExternalBrowser = false;
  let guardInst: ChromeInstance | null = null;
  let bridge: { inst: ChromeInstance; targetId: string } | null = null;
  const mi = rest.match(/^\/i\/([^/]+)\/devtools\/(.+)$/);
  if (mi) {
    const inst = ctx.instances.get(mi[1]);
    if (inst && inst.external) {
      // Adopted browsers serve only the browser ws upstream: pipe it raw, bridge page paths.
      if (`/devtools/${mi[2]}` === inst.browserWsPath) {
        target = `ws://127.0.0.1:${inst.cdpPort}${inst.browserWsPath}`;
        guardExternalBrowser = true;
        guardInst = inst;
      } else {
        const mp = /^page\/([^/?]+)$/.exec(mi[2]);
        if (mp) bridge = { inst, targetId: mp[1] };
      }
    } else if (inst) {
      target = `ws://127.0.0.1:${inst.cdpPort}/devtools/${mi[2]}`;
    }
  } else {
    const ms = rest.match(/^\/s\/([^/?]+)$/);
    if (ms) {
      const sess = ctx.sessions.get(ms[1]);
      const inst = sess && ctx.instances.get(sess.instanceId);
      if (sess && inst) {
        if (inst.external) bridge = { inst, targetId: sess.targetId };
        else target = `ws://127.0.0.1:${inst.cdpPort}/devtools/page/${sess.targetId}`;
      }
    }
  }
  if (bridge) {
    const { inst, targetId } = bridge;
    wss.handleUpgrade(req, socket, head, (client) => {
      bridgePageConnection(client, inst, targetId);
    });
    return;
  }
  if (!target) {
    socket.destroy();
    return;
  }

  // Deliberately no Origin header: Chrome rejects upgrades carrying a browser Origin.
  const upstream = new WebSocket(target, { maxPayload: MAX_PAYLOAD });
  // The raw socket has no error listener until ws attaches; cover the dial window explicitly.
  const abortDial = (): void => {
    socket.destroy();
    upstream.terminate();
  };
  socket.on('error', abortDial);
  socket.on('close', abortDial);
  upstream.on('error', () => socket.destroy());
  upstream.on('open', () => {
    socket.off('error', abortDial);
    socket.off('close', abortDial);
    // wss.handleUpgrade may reject the handshake and never call back; until pipePair owns
    // the upstream, tie its cleanup to the socket closing.
    let piped = false;
    socket.once('close', () => {
      if (!piped) upstream.terminate();
    });
    wss.handleUpgrade(req, socket, head, (client) => {
      piped = true;
      pipePair(
        client,
        upstream,
        guardExternalBrowser && guardInst
          ? (data, isBinary) => neutralizeExternalBrowserCommand(client, data, isBinary, guardInst!, ctx)
          : undefined,
      );
    });
  });
}

/** Guards the raw browser_ws pipe to an adopted Chrome: neutralizes commands that would kill the
 * browser or close the user's tabs, acking the client. Returns true when the frame was handled. */
function neutralizeExternalBrowserCommand(
  client: WebSocket,
  data: RawData,
  isBinary: boolean,
  inst: ChromeInstance,
  ctx: AppContext,
): boolean {
  if (isBinary) return false;
  let msg: any;
  try {
    msg = JSON.parse(rawToString(data));
  } catch {
    return false;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
  const ack = (result: Record<string, unknown>): boolean => {
    if (typeof msg.id === 'number' && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ id: msg.id, result }));
    }
    return true;
  };
  if (BLOCKED_EXTERNAL_BROWSER_METHODS.has(msg.method)) return ack({});
  // Only OpenTab-created targets may be closed; Chrome answers unknown ids with success:false.
  if (msg.method === 'Target.closeTarget') {
    const targetId = msg.params?.targetId;
    if (typeof targetId === 'string' && isOpenTabExternalTarget(inst, ctx, targetId)) return false;
    return ack({ success: false });
  }
  // OpenTab disposes its own contexts over the manager connection, never here.
  if (msg.method === 'Target.disposeBrowserContext') return ack({});
  return false;
}

function pipePair(
  client: WebSocket,
  upstream: WebSocket,
  onClientFrame?: (data: RawData, isBinary: boolean) => boolean,
): void {
  const relay = (from: WebSocket, to: WebSocket, intercept?: (data: RawData, isBinary: boolean) => boolean) => {
    from.on('message', (data, isBinary) => {
      if (intercept && intercept(data, isBinary)) return;
      if (to.readyState === WebSocket.OPEN) to.send(data, { binary: isBinary });
    });
    from.on('close', (code, reason) => closeWith(to, code, reason));
    from.on('error', () => {
      from.terminate();
      to.terminate();
    });
  };
  relay(client, upstream, onClientFrame);
  relay(upstream, client);
}

function closeWith(ws: WebSocket, code: number, reason: Buffer): void {
  if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) return;
  try {
    // 1005/1006 are reserved and may not be sent on the wire.
    if (code === 1005 || code === 1006) ws.close();
    else ws.close(code, reason.subarray(0, 123));
  } catch {
    ws.terminate();
  }
}
