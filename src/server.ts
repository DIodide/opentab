import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AppContext, Config } from './types.ts';
import { ApiError } from './types.ts';
import { loadAuth } from './auth.ts';
import { handleApi, applyCors } from './api.ts';
import { renderDashboard } from './ui.ts';
import { renderLiveView } from './liveview.ts';
import type { CloseAction } from './liveview.ts';
import { handleFrontendHttp, handleInstanceHttp, handleUpgrade, isOpenTabExternalTarget } from './proxy.ts';
import { createInstanceManager } from './chrome.ts';
import { createSessionManager } from './sessions.ts';

const INSTANCE_JSON_RE = /^\/i\/([^/]+)(\/json(?:\/[^?]*)?)$/;
const FRONTEND_RE = /^\/devtools-frontend\/(.+)$/;
const VIEW_SESSION_RE = /^\/view\/s\/([^/]+)$/;
const VIEW_TARGET_RE = /^\/view\/i\/([^/]+)\/([^/]+)$/;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_UPLOAD = 256 * 1024 * 1024;
const UPLOAD_TTL_MS = 60 * 60 * 1000;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new ApiError(400, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readRawBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new ApiError(400, 'upload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Stores a file uploaded by the remote machine so DOM.setFileInputFiles can hand Chrome its path. */
async function handleUpload(req: IncomingMessage, res: ServerResponse, home: string): Promise<void> {
  const hdr = Array.isArray(req.headers['x-upload-name']) ? req.headers['x-upload-name'][0] : req.headers['x-upload-name'];
  let raw = hdr ?? 'upload.bin';
  try {
    raw = decodeURIComponent(raw); // clients percent-encode so any filename survives the header
  } catch {
    // malformed encoding: fall back to the literal header
  }
  const safe = raw.replace(/^.*[\\/]/, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'upload.bin';
  const body = await readRawBody(req, MAX_UPLOAD);
  const dir = join(home, 'uploads');
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (now - statSync(p).mtimeMs > UPLOAD_TTL_MS) unlinkSync(p);
    }
  } catch {
    // best-effort sweep
  }
  const path = join(dir, `${randomBytes(6).toString('hex')}-${safe}`);
  writeFileSync(path, body);
  sendJson(res, 200, { path, name: safe, size: body.length });
}

/** Split "/t/<token>/rest" → { token, stripped } (stripped defaults to "/"). */
function splitTokenPath(pathname: string): { token: string; stripped: string } | null {
  if (pathname !== '/t' && !pathname.startsWith('/t/')) return null;
  const rest = pathname.slice(3);
  const slash = rest.indexOf('/');
  const token = slash === -1 ? rest : rest.slice(0, slash);
  const stripped = slash === -1 ? '/' : rest.slice(slash);
  return { token, stripped };
}

export async function startServer(config: Config): Promise<{ server: Server; ctx: AppContext }> {
  const auth = loadAuth(config);
  const instances = createInstanceManager(config);
  const sessions = createSessionManager(config, instances);
  const version = (
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  ).version;

  const publicBase = (req: IncomingMessage): string => {
    if (config.publicUrl) return config.publicUrl.replace(/\/+$/, '');
    const fwd = req.headers['x-forwarded-proto'];
    const raw = Array.isArray(fwd) ? fwd[0] : fwd;
    const proto = (raw ?? 'http').split(',')[0].trim() || 'http';
    const host = req.headers.host ?? `${config.host}:${config.port}`;
    return `${proto}://${host}`;
  };

  const ctx: AppContext = {
    config,
    auth,
    instances,
    sessions,
    publicBase,
    wsBase: (req) => publicBase(req).replace(/^http/, 'ws'),
    version,
  };

  async function routeAuthed(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    search: string,
  ): Promise<void> {
    if (path === '/') {
      if (req.method !== 'GET') {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderDashboard(ctx, req));
      return;
    }
    if (path === '/api/upload' && req.method === 'POST') {
      applyCors(res, config.corsOrigin);
      await handleUpload(req, res, config.home);
      return;
    }
    if (path === '/api' || path.startsWith('/api/')) {
      await handleApi(req, res, ctx, path, await readBody(req));
      return;
    }
    const inst = INSTANCE_JSON_RE.exec(path);
    if (inst) {
      await handleInstanceHttp(req, res, ctx, inst[1], inst[2] + search);
      return;
    }
    const fe = FRONTEND_RE.exec(path);
    if (fe) {
      // The ws=/wss= query is consumed client-side; the relay ignores it.
      await handleFrontendHttp(req, res, fe[1]);
      return;
    }
    const vs = VIEW_SESSION_RE.exec(path);
    if (vs) {
      const sess = ctx.sessions.get(vs[1]);
      if (!sess) {
        sendJson(res, 404, { error: 'no such session' });
        return;
      }
      const attached = sess.isolation === 'attached';
      const close: CloseAction = {
        label: attached ? 'release' : 'demolish',
        title: attached ? 'End this session; the tab stays open' : 'Close this tab and end the session',
        method: 'DELETE',
        path: `/api/sessions/${sess.id}`,
        confirm: attached ? `Release ${sess.id}? The tab stays open in the browser.` : `Demolish ${sess.id}? This closes the tab.`,
        done: attached ? `released ${sess.id} — the tab is still open` : `demolished ${sess.id}`,
      };
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderLiveView(ctx, req, `${sess.isolation} · ${sess.id}`, close));
      return;
    }
    const vt = VIEW_TARGET_RE.exec(path);
    if (vt) {
      const inst = ctx.instances.get(vt[1]);
      if (!inst) {
        sendJson(res, 404, { error: 'no such instance' });
        return;
      }
      // On an adopted browser only OpenTab's own tabs get a close button; the user's never do.
      const canClose = !inst.external || isOpenTabExternalTarget(inst, ctx, vt[2]);
      const close: CloseAction | null = canClose
        ? {
            label: 'close tab',
            title: 'Close this tab',
            method: 'GET',
            path: `/i/${inst.id}/json/close/${vt[2]}`,
            confirm: `Close tab ${vt[2].slice(0, 8)}…? This closes it in the browser.`,
            done: 'tab closed',
          }
        : null;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderLiveView(ctx, req, `${vt[1]} · ${vt[2].slice(0, 8)}`, close));
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://internal');
    const pathname = u.pathname;

    if (pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        version,
        instances: instances.list().length,
        sessions: sessions.list().length,
      });
      return;
    }

    // Preflight carries no Authorization, so answer it before the auth gate (only when CORS is on).
    if (req.method === 'OPTIONS' && config.corsOrigin && (pathname === '/api' || pathname.includes('/api/'))) {
      applyCors(res, config.corsOrigin);
      res.writeHead(204);
      res.end();
      return;
    }

    const tokenized = splitTokenPath(pathname);
    if (tokenized) {
      if (!auth.check(tokenized.token)) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      await routeAuthed(req, res, tokenized.stripped, u.search);
      return;
    }

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const header = req.headers.authorization;
      const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header) : null;
      if (!match || !auth.check(match[1].trim())) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      await handleApi(req, res, ctx, pathname, await readBody(req));
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        const status = err instanceof ApiError ? err.status : 500;
        sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
      } else {
        res.destroy();
      }
    });
  });

  const refuse = (socket: Duplex): void => {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
  };

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      const u = new URL(req.url ?? '/', 'http://internal');
      const tokenized = splitTokenPath(u.pathname);
      if (!tokenized || !auth.check(tokenized.token)) {
        refuse(socket);
        return;
      }
      // handleUpgrade re-checks the /t/<token> prefix from req.url itself.
      handleUpgrade(req, socket, head, ctx);
    } catch {
      socket.destroy();
    }
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    sessions.stopReaper();
    try {
      await instances.disconnectAll();
    } catch {
      // best effort; launched Chrome is left running for the next serve to re-adopt
    }
    server.close();
  };
  const onSignal = (): void => {
    void shutdown().then(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  await instances.adoptExisting();
  // Not awaited: the consent dialog can hold a dial for 120 s and must not delay listen;
  // the reaper retries anything unresolved.
  for (const name of config.autoAdopt) {
    void instances.adoptExternal(name).catch(() => {});
  }
  sessions.startReaper();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return { server, ctx };
}
