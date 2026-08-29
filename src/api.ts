import { readdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AppContext,
  ChromeInstance,
  CookieInfo,
  CreateSessionRequest,
  InstanceInfo,
  Isolation,
  SessionInfo,
  SessionResponse,
  TabInfo,
} from './types.ts';
import { ApiError } from './types.ts';
import { MAX_TTL } from './config.ts';
import { isOpenTabExternalTarget } from './proxy.ts';

const ISOLATIONS: readonly Isolation[] = ['shared', 'context', 'profile', 'attached'];
// Profile names become directory names under profilesDir; keep them path-safe.
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Instance ids look like "i_default_headless" or "x_chrome".
const INSTANCE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Mirrors sessions.ts: no file:// tabs; ttl capped so expiresAt stays a representable Date.
const URL_RE = /^(?:https?:\/\/|about:)/i;

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function parseBody(body: string): Record<string, unknown> {
  if (!body.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ApiError(400, 'request body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, 'request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function validateCreateSession(raw: Record<string, unknown>): CreateSessionRequest {
  const allowed = new Set(['isolation', 'profile', 'headless', 'url', 'ttl', 'instance', 'targetId']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new ApiError(400, `unknown field: ${key}`);
  }
  const out: CreateSessionRequest = {};
  if (raw.isolation !== undefined) {
    if (typeof raw.isolation !== 'string' || !ISOLATIONS.includes(raw.isolation as Isolation)) {
      throw new ApiError(400, `isolation must be one of: ${ISOLATIONS.join(', ')}`);
    }
    out.isolation = raw.isolation as Isolation;
  }
  if (raw.profile !== undefined) {
    if (typeof raw.profile !== 'string' || !PROFILE_RE.test(raw.profile)) {
      throw new ApiError(400, 'profile must match [A-Za-z0-9][A-Za-z0-9._-]* (max 64 chars)');
    }
    out.profile = raw.profile;
  }
  if (raw.headless !== undefined) {
    if (typeof raw.headless !== 'boolean') throw new ApiError(400, 'headless must be a boolean');
    out.headless = raw.headless;
  }
  if (raw.url !== undefined) {
    if (typeof raw.url !== 'string' || !URL_RE.test(raw.url)) {
      throw new ApiError(400, 'url must be an http://, https:// or about: URL');
    }
    out.url = raw.url;
  }
  if (raw.ttl !== undefined) {
    if (typeof raw.ttl !== 'number' || !Number.isFinite(raw.ttl) || raw.ttl < 0 || raw.ttl > MAX_TTL) {
      throw new ApiError(400, `ttl must be a number of seconds between 0 and ${MAX_TTL}`);
    }
    out.ttl = raw.ttl;
  }
  if (raw.instance !== undefined) {
    if (typeof raw.instance !== 'string' || !INSTANCE_RE.test(raw.instance)) {
      throw new ApiError(400, 'instance must be an instance id (e.g. "x_chrome")');
    }
    out.instance = raw.instance;
  }
  if (raw.targetId !== undefined) {
    if (typeof raw.targetId !== 'string' || raw.targetId.length === 0 || raw.targetId.length > 256) {
      throw new ApiError(400, 'targetId must be a non-empty string');
    }
    out.targetId = raw.targetId;
  }
  if (out.instance !== undefined && (out.profile !== undefined || out.headless !== undefined)) {
    throw new ApiError(400, 'instance routes to a running instance and cannot be combined with profile or headless');
  }
  if (out.isolation === 'profile' && out.profile === undefined) {
    throw new ApiError(400, "profile is required when isolation is 'profile'");
  }
  const iso = out.isolation ?? 'context';
  if (iso === 'attached') {
    if (out.instance === undefined || out.targetId === undefined) {
      throw new ApiError(400, "isolation 'attached' requires instance and targetId");
    }
    if (out.url !== undefined) {
      throw new ApiError(400, "url is not valid with isolation 'attached' (the tab already has one)");
    }
  } else if (out.targetId !== undefined) {
    throw new ApiError(400, "targetId is only valid with isolation 'attached'");
  }
  return out;
}

function toInstanceInfo(i: ChromeInstance): InstanceInfo {
  const {
    id, profile, headless, pid, adopted, external, state,
    cdpPort, browserWsPath, devtoolsHash, startedAt, sessionCount,
  } = i;
  return {
    id, profile, headless, pid, adopted, external, state,
    cdpPort, browserWsPath, devtoolsHash, startedAt, sessionCount,
  };
}

interface UrlBases {
  base: string;
  ws: string;
  token: string;
  tokenBase: string; // `${base}/t/${token}`
  param: 'ws' | 'wss';
}
function urlBases(ctx: AppContext, req: IncomingMessage): UrlBases {
  const token = ctx.auth.token;
  const base = ctx.publicBase(req);
  return {
    base,
    ws: ctx.wsBase(req),
    token,
    tokenBase: `${base}/t/${token}`,
    param: base.startsWith('https://') ? 'wss' : 'ws',
  };
}
/** Hosted DevTools relayed same-host, so the token-bearing ws= query never leaves us. */
function devtoolsUrl(u: UrlBases, devtoolsHash: string, cdpWs: string): string {
  return `${u.tokenBase}/devtools-frontend/@${devtoolsHash}/inspector.html?${u.param}=${cdpWs.replace(/^wss?:\/\//, '')}`;
}

export function buildSessionResponse(
  info: SessionInfo,
  ctx: AppContext,
  req: IncomingMessage,
): SessionResponse {
  const inst = ctx.instances.get(info.instanceId);
  if (!inst) throw new ApiError(500, `instance ${info.instanceId} is not running`);
  const u = urlBases(ctx, req);
  // Same shape for launched and external instances: /s/<id> rides the bridge on externals.
  const cdpWs = `${u.ws}/t/${u.token}/s/${info.id}`;
  return {
    ...info,
    urls: {
      cdp_ws: cdpWs,
      browser_http: `${u.tokenBase}/i/${info.instanceId}`,
      browser_ws: `${u.ws}/t/${u.token}/i/${info.instanceId}${inst.browserWsPath}`,
      devtools: devtoolsUrl(u, inst.devtoolsHash, cdpWs),
      live_view: `${u.tokenBase}/view/s/${info.id}`,
    },
  };
}

function listProfiles(ctx: AppContext): Array<{ name: string; running: boolean; headless: boolean | null }> {
  const running = new Map<string, boolean>();
  for (const inst of ctx.instances.list()) running.set(inst.profile, inst.headless);
  const names = new Set<string>(running.keys());
  try {
    for (const e of readdirSync(ctx.config.profilesDir, { withFileTypes: true })) {
      if (e.isDirectory()) names.add(e.name);
    }
  } catch {
    // profilesDir missing: only running instances
  }
  return [...names].sort().map((name) => ({
    name,
    running: running.has(name),
    headless: running.get(name) ?? null,
  }));
}

const SAME_SITE = new Set(['Strict', 'Lax', 'None']);

/** Cookie domains are written with or without a leading dot; compare them without it. */
function normDomain(d: string): string {
  return d.replace(/^\./, '').toLowerCase();
}

/** Validate one cookie for Storage.setCookies. Chrome rejects the rest (e.g. SameSite=None without secure). */
function validateCookie(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'each cookie must be a JSON object');
  }
  const c = raw as Record<string, unknown>;
  const allowed = new Set(['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite', 'priority']);
  for (const key of Object.keys(c)) {
    // getCookies output is echoed back verbatim by the dashboard; ignore its read-only extras.
    if (!allowed.has(key) && !['size', 'session', 'sourceScheme', 'sourcePort'].includes(key)) {
      throw new ApiError(400, `unknown cookie field: ${key}`);
    }
  }
  const out: Record<string, unknown> = {};
  for (const key of ['name', 'value', 'domain'] as const) {
    if (typeof c[key] !== 'string' || (key !== 'value' && (c[key] as string).length === 0)) {
      throw new ApiError(400, `cookie "${key}" must be a${key === 'value' ? '' : ' non-empty'} string`);
    }
    out[key] = c[key];
  }
  out.path = c.path === undefined ? '/' : c.path;
  if (typeof out.path !== 'string' || !(out.path as string).startsWith('/')) {
    throw new ApiError(400, 'cookie "path" must be a string starting with "/"');
  }
  if (c.expires !== undefined) {
    if (typeof c.expires !== 'number' || !Number.isFinite(c.expires)) {
      throw new ApiError(400, 'cookie "expires" must be a number of unix seconds (-1 = session cookie)');
    }
    // -1 from getCookies means "session cookie": omit it rather than expiring the cookie at the epoch.
    if (c.expires >= 0) out.expires = c.expires;
  }
  for (const key of ['httpOnly', 'secure'] as const) {
    if (c[key] !== undefined) {
      if (typeof c[key] !== 'boolean') throw new ApiError(400, `cookie "${key}" must be a boolean`);
      out[key] = c[key];
    }
  }
  if (c.sameSite !== undefined) {
    if (typeof c.sameSite !== 'string' || !SAME_SITE.has(c.sameSite)) {
      throw new ApiError(400, 'cookie "sameSite" must be one of: Strict, Lax, None');
    }
    out.sameSite = c.sameSite;
  }
  return out;
}

/** Cookies live on the browser connection, so the instance must be connected. */
function cookieTarget(ctx: AppContext, id: string): ChromeInstance {
  const inst = ctx.instances.get(id);
  if (!inst) throw new ApiError(404, `no such instance: ${id}`);
  if (inst.state === 'disconnected') {
    throw new ApiError(409, `instance ${id} is disconnected — re-adopt with POST /api/adopt (or \`opentab adopt\`)`);
  }
  return inst;
}

async function getCookies(inst: ChromeInstance): Promise<CookieInfo[]> {
  const r = await inst.cdp.send('Storage.getCookies');
  return (r?.cookies ?? []) as CookieInfo[];
}

/** Chrome has no browser-level delete: re-setting a cookie with a past expiry removes it (session ones too). */
async function deleteCookies(inst: ChromeInstance, doomed: CookieInfo[]): Promise<void> {
  if (doomed.length === 0) return;
  const past = Math.floor(Date.now() / 1000) - 3600;
  await inst.cdp.send('Storage.setCookies', {
    cookies: doomed.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: past })),
  });
}

async function listTabs(inst: ChromeInstance, ctx: AppContext, req: IncomingMessage): Promise<TabInfo[]> {
  if (inst.state === 'disconnected') {
    throw new ApiError(409, `instance ${inst.id} is disconnected — re-adopt with POST /api/adopt (or \`opentab adopt\`)`);
  }
  let result: any;
  try {
    result = await inst.cdp.send('Target.getTargets');
  } catch (err) {
    throw new ApiError(500, `Target.getTargets failed on ${inst.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const u = urlBases(ctx, req);
  return (result.targetInfos as { targetId: string; type: string; title: string; url: string }[])
    .filter((t) => t.type === 'page')
    .map((t) => {
      // Raw page-ws pipe on launched instances, session bridge on external ones; same URL shape.
      const cdpWs = `${u.ws}/t/${u.token}/i/${inst.id}/devtools/page/${t.targetId}`;
      return {
        targetId: t.targetId,
        title: t.title,
        url: t.url,
        closable: !inst.external || isOpenTabExternalTarget(inst, ctx, t.targetId),
        urls: {
          cdp_ws: cdpWs,
          devtools: devtoolsUrl(u, inst.devtoolsHash, cdpWs),
          live_view: `${u.tokenBase}/view/i/${inst.id}/${t.targetId}`,
        },
      };
    });
}

function validateAdopt(raw: Record<string, unknown>): { name: string; userDataDir: string | undefined } {
  for (const key of Object.keys(raw)) {
    if (key !== 'name' && key !== 'userDataDir') throw new ApiError(400, `unknown field: ${key}`);
  }
  let name = 'chrome';
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || !PROFILE_RE.test(raw.name)) {
      throw new ApiError(400, 'name must match [A-Za-z0-9][A-Za-z0-9._-]* (max 64 chars)');
    }
    name = raw.name;
  }
  let userDataDir: string | undefined;
  if (raw.userDataDir !== undefined) {
    if (typeof raw.userDataDir !== 'string' || raw.userDataDir.length === 0) {
      throw new ApiError(400, 'userDataDir must be a non-empty path');
    }
    // Must be absolute: a relative or traversal path is never a legitimate profile directory.
    if (!isAbsolute(raw.userDataDir)) {
      throw new ApiError(400, 'userDataDir must be an absolute path');
    }
    userDataDir = raw.userDataDir;
  }
  return { name, userDataDir };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AppContext,
  path: string,
  body: string,
): Promise<void> {
  const pathname = path.split('?')[0];
  const parts = pathname.split('/').filter(Boolean);
  const method = req.method ?? 'GET';
  if (parts[0] !== 'api' || parts.length < 2 || parts.length > 4) throw new ApiError(404, 'not found');
  const resource = parts[1];
  const id = parts[2];

  if (resource === 'sessions' && parts.length === 2) {
    if (method === 'POST') {
      const request = validateCreateSession(parseBody(body));
      const info = await ctx.sessions.create(request);
      json(res, 200, buildSessionResponse(info, ctx, req));
      return;
    }
    if (method === 'GET') {
      json(res, 200, { sessions: ctx.sessions.list().map((s) => buildSessionResponse(s, ctx, req)) });
      return;
    }
  }

  if (resource === 'sessions' && parts.length === 3) {
    if (method === 'GET') {
      const info = ctx.sessions.get(id);
      if (!info) throw new ApiError(404, `no such session: ${id}`);
      json(res, 200, buildSessionResponse(info, ctx, req));
      return;
    }
    if (method === 'DELETE') {
      if (!ctx.sessions.get(id)) throw new ApiError(404, `no such session: ${id}`);
      await ctx.sessions.destroy(id);
      json(res, 200, { ok: true });
      return;
    }
  }

  if (resource === 'adopt' && parts.length === 2 && method === 'POST') {
    const { name, userDataDir } = validateAdopt(parseBody(body));
    const inst = await ctx.instances.adoptExternal(name, userDataDir);
    json(res, 200, toInstanceInfo(inst));
    return;
  }

  if (resource === 'instances' && parts.length === 2 && method === 'GET') {
    json(res, 200, { instances: ctx.instances.list().map(toInstanceInfo) });
    return;
  }

  if (resource === 'instances' && parts.length === 4 && parts[3] === 'tabs' && method === 'GET') {
    const inst = ctx.instances.get(id);
    if (!inst) throw new ApiError(404, `no such instance: ${id}`);
    json(res, 200, { tabs: await listTabs(inst, ctx, req) });
    return;
  }

  if (resource === 'instances' && parts.length === 3 && method === 'DELETE') {
    const inst = ctx.instances.get(id);
    if (!inst) throw new ApiError(404, `no such instance: ${id}`);
    if (inst.external) {
      // External: destroy only OpenTab-created sessions, then stop() disconnects
      // and forgets — the user's browser is never closed.
      for (const s of ctx.sessions.list()) {
        if (s.instanceId === id) await ctx.sessions.destroy(s.id).catch(() => {});
      }
    }
    await ctx.instances.stop(id);
    json(res, 200, { ok: true });
    return;
  }

  if (resource === 'instances' && parts.length === 4 && parts[3] === 'tabs' && method === 'DELETE') {
    const inst = ctx.instances.get(id);
    if (!inst) throw new ApiError(404, `no such instance: ${id}`);
    if (inst.state === 'disconnected') {
      throw new ApiError(409, `instance ${id} is disconnected — re-adopt with POST /api/adopt (or \`opentab adopt\`)`);
    }
    const targetId = new URL(req.url ?? '/', 'http://internal').searchParams.get('targetId');
    if (!targetId) throw new ApiError(400, 'DELETE requires ?targetId=<targetId>');
    if (inst.external && !isOpenTabExternalTarget(inst, ctx, targetId)) {
      throw new ApiError(403, `refusing to close ${targetId} on ${id}: OpenTab did not open that tab`);
    }
    try {
      await inst.cdp.send('Target.closeTarget', { targetId });
    } catch {
      throw new ApiError(404, `no such target on ${id}: ${targetId}`);
    }
    // Any session on that tab is unregistered by the Target.targetDestroyed reaper.
    json(res, 200, { ok: true });
    return;
  }

  if (resource === 'instances' && parts.length === 4 && parts[3] === 'cookies') {
    const inst = cookieTarget(ctx, id);
    const query = new URL(req.url ?? '/', 'http://internal').searchParams;
    const domain = query.get('domain');

    if (method === 'GET') {
      let cookies = await getCookies(inst);
      if (domain) cookies = cookies.filter((c) => normDomain(c.domain) === normDomain(domain));
      cookies.sort((a, b) => normDomain(a.domain).localeCompare(normDomain(b.domain)) || a.name.localeCompare(b.name));
      json(res, 200, { instanceId: inst.id, profile: inst.profile, external: inst.external, cookies });
      return;
    }

    if (method === 'PUT') {
      const raw = parseBody(body);
      if (!Array.isArray(raw.cookies)) throw new ApiError(400, 'body must be { cookies: [...] }');
      if (raw.cookies.length === 0) throw new ApiError(400, '"cookies" must not be empty');
      const cookies = raw.cookies.map(validateCookie);
      try {
        await inst.cdp.send('Storage.setCookies', { cookies });
      } catch (err) {
        throw new ApiError(400, `chrome rejected the cookie: ${err instanceof Error ? err.message : String(err)}`);
      }
      json(res, 200, { ok: true, count: cookies.length });
      return;
    }

    if (method === 'DELETE') {
      const name = query.get('name');
      if (!domain) throw new ApiError(400, 'DELETE requires ?domain=<domain> (add &name= to delete one cookie)');
      const path = query.get('path');
      const all = await getCookies(inst);
      const doomed = all.filter(
        (c) =>
          normDomain(c.domain) === normDomain(domain) &&
          (name === null || c.name === name) &&
          (path === null || c.path === path),
      );
      if (doomed.length === 0) throw new ApiError(404, 'no matching cookie');
      await deleteCookies(inst, doomed);
      json(res, 200, { ok: true, deleted: doomed.length });
      return;
    }
  }

  if (resource === 'profiles' && parts.length === 2 && method === 'GET') {
    json(res, 200, { profiles: listProfiles(ctx) });
    return;
  }

  // Discovery for integrators, resolved against the request's public host.
  if (resource === 'info' && parts.length === 2 && method === 'GET') {
    const u = urlBases(ctx, req);
    json(res, 200, {
      service: 'opentab',
      version: ctx.version,
      auth: 'Authorization: Bearer <token>, or the token in the URL path (/t/<token>/...)',
      publicBase: u.base,
      tokenBase: u.tokenBase,
      isolations: ISOLATIONS,
      defaultTtl: ctx.config.defaultTtl,
      counts: { instances: ctx.instances.list().length, sessions: ctx.sessions.list().length },
      externalInstances: ctx.instances.list().filter((i) => i.external).map((i) => i.id),
      endpoints: {
        createSession: 'POST /api/sessions  {isolation?,profile?,headless?,url?,ttl?,instance?,targetId?,newWindow?}',
        listSessions: 'GET /api/sessions',
        getSession: 'GET /api/sessions/:id',
        destroySession: 'DELETE /api/sessions/:id',
        listInstances: 'GET /api/instances',
        listTabs: 'GET /api/instances/:id/tabs',
        closeTab: 'DELETE /api/instances/:id/tabs?targetId=',
        listCookies: 'GET /api/instances/:id/cookies[?domain=]',
        setCookies: 'PUT /api/instances/:id/cookies  {cookies:[{name,value,domain,path?,expires?,httpOnly?,secure?,sameSite?}]}',
        deleteCookies: 'DELETE /api/instances/:id/cookies?domain=[&name=][&path=]',
        stopInstance: 'DELETE /api/instances/:id',
        adopt: 'POST /api/adopt  {name?,userDataDir?}',
        listProfiles: 'GET /api/profiles',
        upload: 'POST /api/upload  (raw body, X-Upload-Name header)',
      },
      urlTemplates: {
        // Every session/tab response also returns these fully-resolved under `urls`.
        cdp_ws: `${u.ws}/t/${u.token}/s/<sessionId>`,
        live_view: `${u.tokenBase}/view/s/<sessionId>`,
        browser_ws: `${u.ws}/t/${u.token}/i/<instanceId>/devtools/browser/<uuid>`,
      },
    });
    return;
  }

  throw new ApiError(404, 'not found');
}

/** CORS for /api when configured; set before writeHead so every response carries them.
 * The gate is a header, not a cookie, so "*" is a valid origin and no Allow-Credentials. */
export function applyCors(res: ServerResponse, corsOrigin: string | null): void {
  if (!corsOrigin) return;
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-upload-name');
  res.setHeader('Access-Control-Max-Age', '600');
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AppContext,
  path: string,
  body: string,
): Promise<void> {
  applyCors(res, ctx.config.corsOrigin);
  try {
    await route(req, res, ctx, path, body);
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    json(res, status, { error: err instanceof Error ? err.message : String(err) });
  }
}
