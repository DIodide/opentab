import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteJsonBody } from '../src/proxy.ts';

// Fixtures mirror real Chrome 152 /json output.
const HASH = '84606a4d2b91b2086d5e12fed8b1d71a06be9dcf';
const PAGE_ID = 'D97AF9D2ED2C29011E1CB55176AFAC28';
const BROWSER_UUID = '1636ab08-8918-4a83-aeba-bd3fa835a76c';
const TOKEN = 'deadbeefdeadbeefdeadbeefdeadbeef';
const INSTANCE = 'i_default_headless';
const PORT = 9222;

const versionFixture = JSON.stringify({
  Browser: 'Chrome/152.0.7977.65',
  'Protocol-Version': '1.3',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  'V8-Version': '15.2.163.5',
  'WebKit-Version': `537.36 (@${HASH})`,
  webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/browser/${BROWSER_UUID}`,
});

const listFixture = JSON.stringify([
  {
    description: '',
    devtoolsFrontendUrl: `https://chrome-devtools-frontend.appspot.com/serve_rev/@${HASH}/inspector.html?ws=127.0.0.1:${PORT}/devtools/page/${PAGE_ID}`,
    id: PAGE_ID,
    title: 'about:blank',
    type: 'page',
    url: 'about:blank',
    webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/${PAGE_ID}`,
  },
]);

const opts = (wsBase: string) => ({
  wsBase,
  token: TOKEN,
  instanceId: INSTANCE,
  cdpPort: PORT,
  devtoolsHash: HASH,
});

test('rewrites /json/version browser websocket url (ws base)', () => {
  const out = JSON.parse(rewriteJsonBody(versionFixture, opts('ws://127.0.0.1:9333')));
  assert.equal(
    out.webSocketDebuggerUrl,
    `ws://127.0.0.1:9333/t/${TOKEN}/i/${INSTANCE}/devtools/browser/${BROWSER_UUID}`,
  );
  assert.equal(out['WebKit-Version'], `537.36 (@${HASH})`);
  assert.equal(out.Browser, 'Chrome/152.0.7977.65');
});

test('rewrites /json/version browser websocket url (wss base)', () => {
  const out = JSON.parse(rewriteJsonBody(versionFixture, opts('wss://mini.ts.net')));
  assert.equal(
    out.webSocketDebuggerUrl,
    `wss://mini.ts.net/t/${TOKEN}/i/${INSTANCE}/devtools/browser/${BROWSER_UUID}`,
  );
});

test('rewrites /json/list page entry (ws base): ws url + frontend ws= param', () => {
  const out = JSON.parse(rewriteJsonBody(listFixture, opts('ws://127.0.0.1:9333')));
  assert.equal(out.length, 1);
  assert.equal(
    out[0].webSocketDebuggerUrl,
    `ws://127.0.0.1:9333/t/${TOKEN}/i/${INSTANCE}/devtools/page/${PAGE_ID}`,
  );
  // The frontend URL points at our same-host relay, never at appspot.
  assert.equal(
    out[0].devtoolsFrontendUrl,
    `http://127.0.0.1:9333/t/${TOKEN}/devtools-frontend/@${HASH}/inspector.html?ws=127.0.0.1:9333/t/${TOKEN}/i/${INSTANCE}/devtools/page/${PAGE_ID}`,
  );
  assert.equal(out[0].id, PAGE_ID);
  assert.equal(out[0].url, 'about:blank');
});

test('rewrites /json/list page entry (wss base): frontend uses wss= param', () => {
  const out = JSON.parse(rewriteJsonBody(listFixture, opts('wss://mini.ts.net')));
  assert.equal(
    out[0].webSocketDebuggerUrl,
    `wss://mini.ts.net/t/${TOKEN}/i/${INSTANCE}/devtools/page/${PAGE_ID}`,
  );
  assert.equal(
    out[0].devtoolsFrontendUrl,
    `https://mini.ts.net/t/${TOKEN}/devtools-frontend/@${HASH}/inspector.html?wss=mini.ts.net/t/${TOKEN}/i/${INSTANCE}/devtools/page/${PAGE_ID}`,
  );
});

test('non-JSON bodies pass through unchanged (/json/close text)', () => {
  const body = 'Target is closing';
  assert.equal(rewriteJsonBody(body, opts('wss://mini.ts.net')), body);
});

test('websocket urls on a different port are left alone', () => {
  const body = JSON.stringify({
    webSocketDebuggerUrl: 'ws://127.0.0.1:9999/devtools/browser/other-uuid',
  });
  const out = JSON.parse(rewriteJsonBody(body, opts('wss://mini.ts.net')));
  assert.equal(out.webSocketDebuggerUrl, 'ws://127.0.0.1:9999/devtools/browser/other-uuid');
});
