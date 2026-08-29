import { strict as assert } from 'node:assert';
import vm from 'node:vm';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppContext, ChromeInstance, Config, SessionInfo } from '../src/types.ts';
import { ApiError } from '../src/types.ts';
import { MAX_TTL, loadConfig } from '../src/config.ts';
import { seedProfilePreferences } from '../src/chrome.ts';
import { parseRequest } from '../src/sessions.ts';
import { renderLiveView } from '../src/liveview.ts';
import { renderDashboard } from '../src/ui.ts';
import { loadAuth, rotateToken } from '../src/auth.ts';
import { buildSessionResponse, handleApi, validateCreateSession } from '../src/api.ts';

const ENV_KEYS = [
  'OPENTAB_HOME',
  'OPENTAB_PORT',
  'OPENTAB_STEALTH',
  'OPENTAB_DEFAULT_TTL',
  'OPENTAB_HOST',
  'OPENTAB_PUBLIC_URL',
  'OPENTAB_CHROME_PATH',
] as const;

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'opentab-unit-'));
}

test('config: defaults with OPENTAB_HOME, dirs created', () => {
  const home = tempHome();
  try {
    const cfg = withEnv({ OPENTAB_HOME: home }, () => loadConfig());
    assert.equal(cfg.home, home);
    assert.equal(cfg.profilesDir, join(home, 'profiles'));
    assert.equal(cfg.port, 9333);
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.publicUrl, null);
    assert.equal(cfg.chromePath, null);
    assert.equal(cfg.defaultHeadless, true);
    assert.equal(cfg.stopIdleInstancesAfter, 0); // off by default: keep logged-in profiles alive
    assert.equal(cfg.defaultTtl, 48 * 3600);
    assert.equal(cfg.stealth, true);
    assert.deepEqual(cfg.extraChromeArgs, []);
    assert.ok(statSync(cfg.profilesDir).isDirectory());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('config: precedence defaults < file < env < overrides', () => {
  const home = tempHome();
  try {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ port: 1234, host: '0.0.0.0', defaultHeadless: false }),
    );

    let cfg = withEnv({ OPENTAB_HOME: home }, () => loadConfig());
    assert.equal(cfg.port, 1234);
    assert.equal(cfg.host, '0.0.0.0');
    assert.equal(cfg.defaultHeadless, false);

    cfg = withEnv(
      { OPENTAB_HOME: home, OPENTAB_PORT: '5678', OPENTAB_PUBLIC_URL: 'https://mini.ts.net' },
      () => loadConfig(),
    );
    assert.equal(cfg.port, 5678); // env beats file
    assert.equal(cfg.host, '0.0.0.0'); // file survives where env is silent
    assert.equal(cfg.publicUrl, 'https://mini.ts.net');

    cfg = withEnv({ OPENTAB_HOME: home, OPENTAB_PORT: '5678' }, () =>
      loadConfig({ port: 9999, chromePath: '/x/chrome' }),
    );
    assert.equal(cfg.port, 9999); // overrides beat env
    assert.equal(cfg.chromePath, '/x/chrome');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('config: malformed config.json throws, bad OPENTAB_PORT throws', () => {
  const home = tempHome();
  try {
    writeFileSync(join(home, 'config.json'), '{not json');
    assert.throws(() => withEnv({ OPENTAB_HOME: home }, () => loadConfig()), /invalid JSON/);
    rmSync(join(home, 'config.json'));
    assert.throws(
      () => withEnv({ OPENTAB_HOME: home, OPENTAB_PORT: 'abc' }, () => loadConfig()),
      /OPENTAB_PORT/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('auth: create, persist, check, rotate', () => {
  const home = tempHome();
  try {
    const cfg = withEnv({ OPENTAB_HOME: home }, () => loadConfig());
    const auth = loadAuth(cfg);
    assert.match(auth.token, /^[0-9a-f]{32}$/);
    assert.equal(statSync(join(home, 'token')).mode & 0o777, 0o600);
    assert.equal(loadAuth(cfg).token, auth.token); // persisted

    assert.equal(auth.check(auth.token), true);
    assert.equal(auth.check(undefined), false);
    assert.equal(auth.check(''), false);
    assert.equal(auth.check('nope'), false);
    assert.equal(auth.check(auth.token.slice(0, -1)), false); // shorter
    assert.equal(auth.check(auth.token + '0'), false); // longer
    const flipped =
      auth.token.slice(0, -1) + (auth.token.endsWith('0') ? '1' : '0');
    assert.equal(auth.check(flipped), false); // same length, one char off

    const rotated = rotateToken(cfg);
    assert.match(rotated, /^[0-9a-f]{32}$/);
    assert.notEqual(rotated, auth.token);
    assert.equal(loadAuth(cfg).token, rotated);
    assert.equal(statSync(join(home, 'token')).mode & 0o777, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function fakeConfig(): Config {
  return {
    port: 9333,
    host: '127.0.0.1',
    publicUrl: null,
    chromePath: null,
    defaultHeadless: true,
    stopIdleInstancesAfter: 300,
    defaultTtl: 0,
    stealth: true,
    extraChromeArgs: [],
    externalBrowsers: {},
    autoAdopt: [],
    windowBounds: null,
    corsOrigin: null,
    home: '/nonexistent-opentab',
    profilesDir: '/nonexistent-opentab/profiles',
  };
}

function fakeCtx(): AppContext {
  return {
    config: fakeConfig(),
    auth: { token: 'tok', check: (c) => c === 'tok' },
    instances: {
      ensure: async () => {
        throw new Error('unexpected ensure');
      },
      get: () => undefined,
      list: () => [],
      adoptExisting: async () => {},
      adoptExternal: async () => {
        throw new Error('unexpected adoptExternal');
      },
      stop: async () => {},
      disconnectAll: async () => {},
      onExit: () => {},
    },
    sessions: {
      create: async () => {
        throw new Error('unexpected create');
      },
      get: () => undefined,
      list: () => [],
      destroy: async () => {},
      destroyAll: async () => {},
      startReaper: () => {},
      stopReaper: () => {},
    },
    publicBase: () => 'https://mini.ts.net',
    wsBase: () => 'wss://mini.ts.net',
    version: '0.0.0-test',
  };
}

function fakeInstance(): ChromeInstance {
  return {
    id: 'i_default_headless',
    profile: 'default',
    headless: true,
    pid: 111,
    adopted: false,
    external: false,
    state: 'running',
    cdpPort: 12345,
    browserWsPath: '/devtools/browser/uuid-1',
    devtoolsHash: 'abc123def',
    startedAt: '2026-08-27T00:00:00.000Z',
    sessionCount: 1,
    cdp: {
      send: async () => ({}),
      on: () => {},
      onClose: () => {},
      attachPageSession: async () => ({ fromClient: () => {}, onMessage: () => {}, onClose: () => {}, detach: () => {} }),
      close: () => {},
    },
  };
}

function fakeSession(): SessionInfo {
  return {
    id: 's_abc123',
    isolation: 'context',
    profile: 'default',
    headless: true,
    instanceId: 'i_default_headless',
    targetId: 'TARGET1',
    browserContextId: 'CTX1',
    url: 'about:blank',
    createdAt: '2026-08-27T00:00:01.000Z',
    expiresAt: null,
  };
}

async function callApi(
  ctx: AppContext,
  method: string,
  path: string,
  body = '',
  query = '',
): Promise<{ status: number; headers: Record<string, unknown>; json: any }> {
  const out = { status: 0, headers: {} as Record<string, unknown>, body: '' };
  const res = {
    writeHead(status: number, headers?: Record<string, unknown>) {
      out.status = status;
      Object.assign(out.headers, headers);
      return res;
    },
    setHeader(k: string, v: unknown) {
      out.headers[k] = v;
    },
    end(chunk?: string) {
      if (chunk) out.body += chunk;
    },
  };
  await handleApi(
    { method, url: path + query } as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    ctx,
    path,
    body,
  );
  return { status: out.status, headers: out.headers, json: out.body ? JSON.parse(out.body) : undefined };
}

function is400With(re: RegExp) {
  return (e: unknown) => e instanceof ApiError && e.status === 400 && re.test(e.message);
}

test('api: validateCreateSession rejects unknown keys, naming the key', () => {
  assert.throws(() => validateCreateSession({ bogus: 1 }), is400With(/bogus/));
  assert.throws(
    () => validateCreateSession({ url: 'https://x.test', extra_key: true }),
    is400With(/extra_key/),
  );
});

test('api: validateCreateSession field validation', () => {
  assert.throws(() => validateCreateSession({ isolation: 'weird' }), is400With(/isolation/));
  assert.throws(() => validateCreateSession({ headless: 'yes' }), is400With(/headless/));
  assert.throws(() => validateCreateSession({ url: '' }), is400With(/url/));
  assert.throws(() => validateCreateSession({ ttl: -5 }), is400With(/ttl/));
  assert.throws(() => validateCreateSession({ ttl: 'soon' }), is400With(/ttl/));
  assert.throws(() => validateCreateSession({ profile: '../evil' }), is400With(/profile/));
  assert.throws(() => validateCreateSession({ profile: 'a/b' }), is400With(/profile/));
  assert.throws(() => validateCreateSession({ isolation: 'profile' }), is400With(/profile/));
  assert.deepEqual(validateCreateSession({}), {});
  assert.deepEqual(
    validateCreateSession({ isolation: 'shared', profile: 'work', headless: false, url: 'about:blank', ttl: 60 }),
    { isolation: 'shared', profile: 'work', headless: false, url: 'about:blank', ttl: 60 },
  );
});

test('api: POST /api/sessions with unknown key → 400 naming it', async () => {
  const ctx = fakeCtx();
  const r = await callApi(ctx, 'POST', '/api/sessions', '{"bogus":1}');
  assert.equal(r.status, 400);
  assert.match(r.json.error, /bogus/);
});

test('api: POST /api/sessions with invalid JSON → 400', async () => {
  const r = await callApi(fakeCtx(), 'POST', '/api/sessions', 'not json');
  assert.equal(r.status, 400);
});

test('api: POST /api/sessions happy path builds exact urls', async () => {
  const ctx = fakeCtx();
  const inst = fakeInstance();
  const info = fakeSession();
  let created: unknown;
  ctx.sessions.create = async (req) => {
    created = req;
    return info;
  };
  ctx.instances.get = (id) => (id === inst.id ? inst : undefined);

  const r = await callApi(ctx, 'POST', '/api/sessions', '{"url":"https://example.com"}');
  assert.equal(r.status, 200);
  assert.deepEqual(created, { url: 'https://example.com' });
  assert.equal(r.json.id, 's_abc123');
  assert.equal(r.json.urls.cdp_ws, 'wss://mini.ts.net/t/tok/s/s_abc123');
  assert.equal(r.json.urls.browser_http, 'https://mini.ts.net/t/tok/i/i_default_headless');
  assert.equal(
    r.json.urls.browser_ws,
    'wss://mini.ts.net/t/tok/i/i_default_headless/devtools/browser/uuid-1',
  );
  // Same-host frontend relay: the token-bearing query must never point at appspot.
  assert.equal(
    r.json.urls.devtools,
    'https://mini.ts.net/t/tok/devtools-frontend/@abc123def/inspector.html?wss=mini.ts.net/t/tok/s/s_abc123',
  );
  assert.equal(r.json.urls.live_view, 'https://mini.ts.net/t/tok/view/s/s_abc123');
});

test('api: GET /api/info returns discovery data resolved to the request host', async () => {
  const ctx = fakeCtx();
  const r = await callApi(ctx, 'GET', '/api/info');
  assert.equal(r.status, 200);
  assert.equal(r.json.service, 'opentab');
  assert.equal(r.json.version, '0.0.0-test');
  assert.equal(r.json.tokenBase, 'https://mini.ts.net/t/tok');
  assert.deepEqual(r.json.isolations, ['shared', 'context', 'profile', 'attached']);
  assert.ok(r.json.endpoints.createSession && r.json.urlTemplates.live_view);
});

test('api: GET /api/instances/:id/tabs returns per-tab control urls', async () => {
  const ctx = fakeCtx();
  const inst = fakeInstance();
  ctx.instances.get = (id) => (id === inst.id ? inst : undefined);
  inst.cdp.send = async (method) =>
    method === 'Target.getTargets'
      ? { targetInfos: [{ targetId: 'T1', type: 'page', title: 'Tab', url: 'https://x.test/' }] }
      : {};
  const r = await callApi(ctx, 'GET', '/api/instances/i_default_headless/tabs');
  assert.equal(r.status, 200);
  const tab = r.json.tabs[0];
  assert.equal(tab.targetId, 'T1');
  assert.equal(tab.urls.cdp_ws, 'wss://mini.ts.net/t/tok/i/i_default_headless/devtools/page/T1');
  assert.equal(tab.urls.live_view, 'https://mini.ts.net/t/tok/view/i/i_default_headless/T1');
  assert.ok(tab.urls.devtools.includes('/devtools-frontend/@abc123def/'));
});

test('api: CORS headers present only when corsOrigin is set', async () => {
  const off = await callApi(fakeCtx(), 'GET', '/api/info');
  assert.equal(off.headers['Access-Control-Allow-Origin'], undefined);
  const ctx = fakeCtx();
  ctx.config.corsOrigin = 'https://app.example.com';
  const on = await callApi(ctx, 'GET', '/api/info');
  assert.equal(on.headers['Access-Control-Allow-Origin'], 'https://app.example.com');
  assert.match(String(on.headers['Access-Control-Allow-Headers']), /authorization/);
});

test('api: buildSessionResponse uses ws= for http public base', () => {
  const ctx = fakeCtx();
  const inst = fakeInstance();
  ctx.instances.get = (id) => (id === inst.id ? inst : undefined);
  ctx.publicBase = () => 'http://127.0.0.1:9333';
  ctx.wsBase = () => 'ws://127.0.0.1:9333';
  const resp = buildSessionResponse(fakeSession(), ctx, {} as IncomingMessage);
  assert.equal(resp.urls.cdp_ws, 'ws://127.0.0.1:9333/t/tok/s/s_abc123');
  assert.equal(
    resp.urls.devtools,
    'http://127.0.0.1:9333/t/tok/devtools-frontend/@abc123def/inspector.html?ws=127.0.0.1:9333/t/tok/s/s_abc123',
  );
});

test('api: session GET/DELETE 404s and list shape', async () => {
  const ctx = fakeCtx();
  let r = await callApi(ctx, 'GET', '/api/sessions');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { sessions: [] });

  r = await callApi(ctx, 'GET', '/api/sessions/s_missing');
  assert.equal(r.status, 404);
  r = await callApi(ctx, 'DELETE', '/api/sessions/s_missing');
  assert.equal(r.status, 404);
  r = await callApi(ctx, 'GET', '/api/nope');
  assert.equal(r.status, 404);
  r = await callApi(ctx, 'PATCH', '/api/sessions');
  assert.equal(r.status, 404);
});

test('api: instances list strips the cdp client, DELETE stops', async () => {
  const ctx = fakeCtx();
  const inst = fakeInstance();
  ctx.instances.list = () => [inst];
  ctx.instances.get = (id) => (id === inst.id ? inst : undefined);
  let stopped: string | undefined;
  ctx.instances.stop = async (id) => {
    stopped = id;
  };

  let r = await callApi(ctx, 'GET', '/api/instances');
  assert.equal(r.status, 200);
  assert.equal(r.json.instances.length, 1);
  assert.equal(r.json.instances[0].id, 'i_default_headless');
  assert.equal(r.json.instances[0].browserWsPath, '/devtools/browser/uuid-1');
  assert.ok(!('cdp' in r.json.instances[0]));

  r = await callApi(ctx, 'DELETE', '/api/instances/i_default_headless');
  assert.equal(r.status, 200);
  assert.equal(stopped, 'i_default_headless');
  r = await callApi(ctx, 'DELETE', '/api/instances/i_missing');
  assert.equal(r.status, 404);
});

test('api: profiles merges dirs and running instances', async () => {
  const ctx = fakeCtx();
  const home = tempHome();
  try {
    ctx.config.profilesDir = join(home, 'profiles');
    mkdirSync(join(ctx.config.profilesDir, 'default'), { recursive: true });
    mkdirSync(join(ctx.config.profilesDir, 'work'), { recursive: true });
    const inst = fakeInstance(); // profile "default", headless
    ctx.instances.list = () => [inst];

    const r = await callApi(ctx, 'GET', '/api/profiles');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {
      profiles: [
        { name: 'default', running: true, headless: true },
        { name: 'work', running: false, headless: null },
      ],
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('config: OPENTAB_DEFAULT_TTL overrides the 48h default; bad values throw', () => {
  const home = tempHome();
  try {
    assert.equal(withEnv({ OPENTAB_HOME: home, OPENTAB_DEFAULT_TTL: '60' }, () => loadConfig()).defaultTtl, 60);
    assert.equal(withEnv({ OPENTAB_HOME: home, OPENTAB_DEFAULT_TTL: '0' }, () => loadConfig()).defaultTtl, 0);
    for (const bad of ['abc', '-1', '1.5', String(MAX_TTL + 1)]) {
      assert.throws(() => withEnv({ OPENTAB_HOME: home, OPENTAB_DEFAULT_TTL: bad }, () => loadConfig()), /OPENTAB_DEFAULT_TTL/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('sessions: ttl defaults to config.defaultTtl; an explicit 0 still means never', () => {
  const home = tempHome();
  try {
    const cfg = loadConfig({ home, defaultTtl: 1234 });
    assert.equal(parseRequest({}, cfg).ttl, 1234);
    assert.equal(parseRequest({ ttl: 0 }, cfg).ttl, 0);
    assert.equal(parseRequest({ ttl: 5 }, cfg).ttl, 5);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('live view: the close button is rendered from the CloseAction, escaped, or omitted', () => {
  const ctx = fakeCtx();
  const req = {} as IncomingMessage;
  const html = renderLiveView(ctx, req, 'context · s_abc123', {
    label: 'demolish', title: 'Close this tab & end the session', method: 'DELETE',
    path: '/api/sessions/s_abc123', confirm: 'Demolish "s_abc123"?', done: 'demolished s_abc123',
  });
  assert.match(html, /<button id="close" class="danger" title="Close this tab &amp; end the session" data-method="DELETE" data-path="\/api\/sessions\/s_abc123" data-confirm="Demolish &quot;s_abc123&quot;\?" data-done="demolished s_abc123">demolish<\/button>/);
  assert.doesNotMatch(renderLiveView(ctx, req, 'x', null), /id="close"/);
});

test('config: OPENTAB_STEALTH toggles stealth off', () => {
  const home = tempHome();
  try {
    for (const v of ['0', 'false', 'no', 'off', 'FALSE']) {
      assert.equal(withEnv({ OPENTAB_HOME: home, OPENTAB_STEALTH: v }, () => loadConfig()).stealth, false, v);
    }
    for (const v of ['1', 'true', 'yes', '']) {
      assert.equal(withEnv({ OPENTAB_HOME: home, OPENTAB_STEALTH: v }, () => loadConfig()).stealth, true, v);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('chrome: seedProfilePreferences sets restore_on_startup, merges, is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opentab-prefs-'));
  try {
    seedProfilePreferences(dir);
    const p = join(dir, 'Default', 'Preferences');
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).session.restore_on_startup, 1);
    // preserves existing keys
    writeFileSync(p, JSON.stringify({ session: { startup_urls: ['x'] }, browser: { keep: true } }));
    seedProfilePreferences(dir);
    const merged = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(merged.session.restore_on_startup, 1);
    assert.deepEqual(merged.session.startup_urls, ['x']);
    assert.equal(merged.browser.keep, true);
    // corrupt file → reseeded, not thrown
    writeFileSync(p, '{not json');
    seedProfilePreferences(dir);
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).session.restore_on_startup, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function cookieCtx(cookies: any[]) {
  const ctx = fakeCtx();
  const inst = fakeInstance();
  const sent: any[] = [];
  inst.cdp.send = (async (method: string, params?: any) => {
    sent.push({ method, params });
    if (method === 'Storage.getCookies') return { cookies };
    if (method === 'Storage.setCookies') return {};
    throw new Error('unexpected ' + method);
  }) as any;
  ctx.instances.get = (id: string) => (id === inst.id ? inst : undefined);
  return { ctx, inst, sent };
}

const CK = (over: any = {}) => ({
  name: 'sid', value: 'v', domain: 'simplify.jobs', path: '/', expires: -1,
  size: 4, httpOnly: false, secure: false, session: true, ...over,
});

test('api: GET cookies sorts by domain then name, and ?domain= filters ignoring a leading dot', async () => {
  const { ctx } = cookieCtx([
    CK({ name: 'b', domain: 'simplify.jobs' }),
    CK({ name: 'a', domain: '.google.com' }),
    CK({ name: 'a', domain: 'simplify.jobs' }),
  ]);
  const all = await callApi(ctx, 'GET', '/api/instances/i_default_headless/cookies');
  assert.equal(all.status, 200);
  assert.equal(all.json.profile, 'default');
  assert.deepEqual(all.json.cookies.map((c: any) => c.domain + ':' + c.name), [
    '.google.com:a', 'simplify.jobs:a', 'simplify.jobs:b',
  ]);
  const one = await callApi(ctx, 'GET', '/api/instances/i_default_headless/cookies', '', '?domain=google.com');
  assert.deepEqual(one.json.cookies.map((c: any) => c.name), ['a']);
});

test('api: PUT cookies validates fields and forwards them to Storage.setCookies', async () => {
  const { ctx, sent } = cookieCtx([]);
  const ok = await callApi(ctx, 'PUT', '/api/instances/i_default_headless/cookies', JSON.stringify({
    cookies: [{ name: 'sid', value: 'v', domain: 'x.test', httpOnly: true, sameSite: 'Lax' }],
  }));
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true, count: 1 });
  assert.deepEqual(sent[0], {
    method: 'Storage.setCookies',
    params: { cookies: [{ name: 'sid', value: 'v', domain: 'x.test', path: '/', httpOnly: true, sameSite: 'Lax' }] },
  });
  const bad = async (cookie: any, re: RegExp) => {
    const r = await callApi(ctx, 'PUT', '/api/instances/i_default_headless/cookies', JSON.stringify({ cookies: [cookie] }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, re);
  };
  await bad({ value: 'v', domain: 'x.test' }, /name/);
  await bad({ name: 'a', value: 'v', domain: '' }, /domain/);
  await bad({ name: 'a', value: 'v', domain: 'x.test', path: 'nope' }, /path/);
  await bad({ name: 'a', value: 'v', domain: 'x.test', expires: 'soon' }, /expires/);
  await bad({ name: 'a', value: 'v', domain: 'x.test', sameSite: 'Nope' }, /sameSite/);
  await bad({ name: 'a', value: 'v', domain: 'x.test', bogus: 1 }, /bogus/);
  const empty = await callApi(ctx, 'PUT', '/api/instances/i_default_headless/cookies', JSON.stringify({ cookies: [] }));
  assert.equal(empty.status, 400);
});

test('api: PUT accepts a getCookies object verbatim; expires -1 stays a session cookie', async () => {
  const { ctx, sent } = cookieCtx([]);
  const r = await callApi(ctx, 'PUT', '/api/instances/i_default_headless/cookies', JSON.stringify({ cookies: [CK()] }));
  assert.equal(r.status, 200);
  // -1 would otherwise expire the cookie at the epoch, deleting it instead of saving it.
  assert.equal('expires' in sent[0].params.cookies[0], false);
});

test('api: DELETE cookies needs a domain and expires the matches in place', async () => {
  const { ctx, sent } = cookieCtx([
    CK({ name: 'sid', domain: 'simplify.jobs' }),
    CK({ name: 'theme', domain: 'simplify.jobs' }),
    CK({ name: 'x', domain: 'other.test' }),
  ]);
  const noDomain = await callApi(ctx, 'DELETE', '/api/instances/i_default_headless/cookies', '', '?name=sid');
  assert.equal(noDomain.status, 400);
  assert.match(noDomain.json.error, /domain/);
  const one = await callApi(ctx, 'DELETE', '/api/instances/i_default_headless/cookies', '', '?domain=simplify.jobs&name=sid');
  assert.deepEqual(one.json, { ok: true, deleted: 1 });
  const wrote = sent.filter((c) => c.method === 'Storage.setCookies').pop();
  assert.equal(wrote.params.cookies.length, 1);
  assert.equal(wrote.params.cookies[0].name, 'sid');
  assert.ok(wrote.params.cookies[0].expires < Date.now() / 1000, 'expiry must be in the past');
  const site = await callApi(ctx, 'DELETE', '/api/instances/i_default_headless/cookies', '', '?domain=simplify.jobs');
  assert.deepEqual(site.json, { ok: true, deleted: 2 });
  const miss = await callApi(ctx, 'DELETE', '/api/instances/i_default_headless/cookies', '', '?domain=nope.test');
  assert.equal(miss.status, 404);
});

test('api: cookies 404 on an unknown instance and 409 when disconnected', async () => {
  const { ctx, inst } = cookieCtx([]);
  const gone = await callApi(ctx, 'GET', '/api/instances/i_nope/cookies');
  assert.equal(gone.status, 404);
  inst.state = 'disconnected';
  const disc = await callApi(ctx, 'GET', '/api/instances/i_default_headless/cookies');
  assert.equal(disc.status, 409);
  assert.match(disc.json.error, /disconnected/);
});

function tabsCtx(targets: any[], external = false) {
  const ctx = fakeCtx();
  const inst = fakeInstance();
  (inst as any).external = external;
  const sent: any[] = [];
  inst.cdp.send = (async (method: string, params?: any) => {
    sent.push({ method, params });
    if (method === 'Target.getTargets') return { targetInfos: targets };
    if (method === 'Target.closeTarget') {
      if (!targets.some((t) => t.targetId === params.targetId)) throw new Error('No such target');
      return {};
    }
    throw new Error('unexpected ' + method);
  }) as any;
  ctx.instances.get = (id: string) => (id === inst.id ? inst : undefined);
  return { ctx, inst, sent };
}

const TGT = (id: string) => ({ targetId: id, type: 'page', title: 't', url: 'https://x.test/' });

test('api: tabs on a launched instance are all closable; DELETE closes one', async () => {
  const { ctx, sent } = tabsCtx([TGT('T1'), TGT('T2')]);
  const list = await callApi(ctx, 'GET', '/api/instances/i_default_headless/tabs');
  assert.deepEqual(list.json.tabs.map((t: any) => t.closable), [true, true]);

  const noId = await callApi(ctx, 'DELETE', '/api/instances/i_default_headless/tabs');
  assert.equal(noId.status, 400);
  assert.match(noId.json.error, /targetId/);

  const ok = await callApi(ctx, 'DELETE', '/api/instances/i_default_headless/tabs', '', '?targetId=T1');
  assert.equal(ok.status, 200);
  assert.deepEqual(sent.pop(), { method: 'Target.closeTarget', params: { targetId: 'T1' } });

  const gone = await callApi(ctx, 'DELETE', '/api/instances/i_default_headless/tabs', '', '?targetId=NOPE');
  assert.equal(gone.status, 404);
});

test('api: on an adopted browser the user\'s own tabs are not closable and DELETE is refused', async () => {
  const { ctx } = tabsCtx([TGT('USERTAB')], true);
  const list = await callApi(ctx, 'GET', '/api/instances/i_default_headless/tabs');
  assert.deepEqual(list.json.tabs.map((t: any) => t.closable), [false]);
  const refused = await callApi(ctx, 'DELETE', '/api/instances/i_default_headless/tabs', '', '?targetId=USERTAB');
  assert.equal(refused.status, 403);
  assert.match(refused.json.error, /did not open that tab/);
});

test('ui: the inline scripts of the dashboard and live view are valid JS', () => {
  // These pages are built inside a TS template literal, where a stray \\n or \\. silently
  // becomes a real newline or a wildcard in the emitted script. Compile them to catch it.
  const ctx = fakeCtx();
  const req = { headers: { host: 'mini.ts.net' } } as unknown as IncomingMessage;
  const pages: Array<[string, string]> = [
    ['dashboard', renderDashboard(ctx, req)],
    ['live view', renderLiveView(ctx, req, 'context · s_abc123', null)],
  ];
  for (const [name, html] of pages) {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0, name + ' has no inline script');
    for (const src of scripts) {
      assert.doesNotThrow(() => new vm.Script(src), name + ' inline script is not valid JS');
    }
  }
});
