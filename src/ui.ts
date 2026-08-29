// Single-file dashboard at GET /t/<token>/; the client derives the token prefix from its own pathname.
import type { IncomingMessage } from 'node:http';
import type { AppContext } from './types.ts';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderDashboard(ctx: AppContext, req: IncomingMessage): string {
  const base = ctx.publicBase(req);
  const nInstances = ctx.instances.list().length;
  const nSessions = ctx.sessions.list().length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>OpenTab</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --panel: #ffffff; --fg: #1b1f24; --muted: #5b6472;
  --border: #d5dae2; --accent: #2f6feb; --accent-fg: #ffffff;
  --danger: #c93c37; --ok: #2b7a4b; --row-hover: #eef1f5; --sub: #f0f2f6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216; --panel: #171b21; --fg: #e4e8ee; --muted: #8b95a3;
    --border: #2a313b; --accent: #4c8dff; --accent-fg: #0b1220;
    --danger: #e5645e; --ok: #4fbf7f; --row-hover: #1d232b; --sub: #10151b;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 1.5rem; background: var(--bg); color: var(--fg);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.wrap { max-width: 72rem; margin: 0 auto; }
header { display: flex; align-items: baseline; gap: .75rem; flex-wrap: wrap; margin-bottom: 1rem; }
header h1 { font-size: 1.3rem; margin: 0; }
header .meta { color: var(--muted); font-size: .85rem; }
.panel {
  background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
  padding: 1rem; margin-bottom: 1rem; overflow-x: auto;
}
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin-bottom: .75rem; }
h2 { font-size: .95rem; margin: 0; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { color: var(--muted); font-weight: 600; font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
tbody tr:hover { background: var(--row-hover); }
tr.inst-row { cursor: pointer; }
tr.inst-row .twist { display: inline-block; width: 1rem; color: var(--muted); transition: transform .12s; }
tr.inst-row.open .twist { transform: rotate(90deg); }
tr.tabs-row > td { background: var(--sub); padding: 0; }
tr.tabs-row table { width: 100%; }
tr.tabs-row th, tr.tabs-row td { border-bottom: 1px solid var(--border); }
tr.tabs-row tr:last-child td { border-bottom: none; }
td.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; }
td.url { max-width: 22rem; overflow: hidden; text-overflow: ellipsis; }
td.empty { color: var(--muted); text-align: center; padding: 1.2rem; }
td.actions { display: flex; gap: .35rem; flex-wrap: wrap; }
.pill { font-size: .7rem; padding: .05rem .4rem; border-radius: 99px; border: 1px solid var(--border); color: var(--muted); }
.pill.ext { border-color: var(--accent); color: var(--accent); }
.pill.disc { border-color: var(--danger); color: var(--danger); }
button, a.btn {
  font: inherit; font-size: .8rem; padding: .25rem .6rem; border-radius: 6px;
  border: 1px solid var(--border); background: var(--panel); color: var(--fg);
  cursor: pointer; text-decoration: none; display: inline-block; line-height: 1.4;
}
button:hover, a.btn:hover { border-color: var(--accent); }
button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
a.btn.primary-ghost { border-color: var(--accent); color: var(--accent); font-weight: 600; }
button.danger { color: var(--danger); }
button.danger:hover { border-color: var(--danger); }
button:disabled { opacity: .5; cursor: wait; }
form.create { display: flex; gap: .75rem; align-items: end; flex-wrap: wrap; }
form.create label { display: flex; flex-direction: column; gap: .2rem; font-size: .78rem; color: var(--muted); }
form.create label.check { flex-direction: row; align-items: center; gap: .4rem; padding-bottom: .35rem; }
form.create label.hidden { display: none; }
input[type=text], select {
  font: inherit; padding: .3rem .5rem; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg); color: var(--fg); min-width: 8rem;
}
input[type=text]:focus, select:focus { outline: 1px solid var(--accent); }
.hint { color: var(--muted); font-size: .8rem; margin-top: .5rem; }
.hint b { color: var(--fg); font-weight: 600; }
#status { min-height: 1.4rem; color: var(--muted); font-size: .85rem; margin-top: .5rem; }
#status.err { color: var(--danger); }
footer { color: var(--muted); font-size: .78rem; }
.subhead { display: flex; align-items: center; gap: .5rem; padding: .5rem .6rem; flex-wrap: wrap; border-bottom: 1px solid var(--border); }
.subhead .seg { display: flex; gap: .25rem; }
.subhead .seg button.on { border-color: var(--accent); color: var(--accent); }
.subhead input.filter { font: inherit; font-size: .8rem; padding: .2rem .45rem; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); min-width: 12rem; }
.subhead .spacer { flex: 1 1 auto; }
.ck-site { padding: .35rem .6rem; display: flex; align-items: center; gap: .5rem; background: var(--bg); border-bottom: 1px solid var(--border); }
.ck-site .dom { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82rem; font-weight: 600; }
.ck-site .count { color: var(--muted); font-size: .75rem; }
td.val { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82rem; max-width: 20rem; overflow: hidden; text-overflow: ellipsis; }
td.val .mask { color: var(--muted); letter-spacing: .1em; }
.ck-edit td { background: var(--sub); }
.ck-edit .grid { display: flex; gap: .5rem; flex-wrap: wrap; align-items: end; padding: .3rem 0; }
.ck-edit label { display: flex; flex-direction: column; gap: .15rem; font-size: .72rem; color: var(--muted); }
.ck-edit label.chk { flex-direction: row; align-items: center; gap: .3rem; padding-bottom: .4rem; }
.ck-edit input[type=text], .ck-edit select { font: inherit; font-size: .8rem; padding: .2rem .4rem; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); }
.warn { color: var(--danger); font-size: .75rem; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>OpenTab</h1>
    <span class="meta">v${esc(ctx.version)} · ${esc(base)} · ${nInstances} instance${nInstances === 1 ? '' : 's'} · ${nSessions} session${nSessions === 1 ? '' : 's'} at page load</span>
  </header>

  <div class="panel">
    <div class="panel-head">
      <h2>Instances</h2>
      <button id="btn-adopt" title="Adopt your real Chrome running with chrome://inspect/#remote-debugging enabled">Adopt Chrome</button>
    </div>
    <table>
      <thead>
        <tr><th></th><th>id</th><th>type</th><th>state</th><th>sessions</th><th>tabs</th></tr>
      </thead>
      <tbody id="inst-rows"><tr><td class="empty" colspan="6">loading…</td></tr></tbody>
    </table>
  </div>

  <div class="panel">
    <h2>Sessions</h2>
    <table>
      <thead>
        <tr><th>id</th><th>isolation</th><th>profile</th><th>headless</th><th>url</th><th>age</th><th></th></tr>
      </thead>
      <tbody id="rows"><tr><td class="empty" colspan="7">loading…</td></tr></tbody>
    </table>
  </div>

  <div class="panel">
    <h2>Create tab</h2>
    <form class="create" id="create">
      <label>target
        <select id="f-instance"><option value="">launch managed profile</option></select>
      </label>
      <label>isolation
        <select id="f-isolation">
          <option value="shared" selected>shared</option>
          <option value="context">context</option>
          <option value="profile">profile</option>
        </select>
      </label>
      <label id="l-profile">profile
        <input type="text" id="f-profile" value="default">
      </label>
      <label class="check" id="l-headless">
        <input type="checkbox" id="f-headless" checked> headless
      </label>
      <label>url
        <input type="text" id="f-url" placeholder="about:blank" size="30">
      </label>
      <button type="submit" class="primary" id="btn-create">Create</button>
    </form>
    <div id="iso-hint" class="hint"></div>
    <div id="status"></div>
  </div>

  <footer>auto-refreshes every 5&thinsp;s · click an instance for its live tabs and cookies · "expose" hands an agent an existing tab without ever closing it · "demolish" closes OpenTab-created tabs only</footer>
</div>
<script>
(function () {
  var m = location.pathname.match(/^\\/t\\/[^/]+/);
  var base = m ? m[0] : '';
  var isHttps = location.protocol === 'https:';
  var wsOrigin = (isHttps ? 'wss://' : 'ws://') + location.host;
  var rowsEl = document.getElementById('rows');
  var instRowsEl = document.getElementById('inst-rows');
  var statusEl = document.getElementById('status');
  var form = document.getElementById('create');
  var btnCreate = document.getElementById('btn-create');
  var btnAdopt = document.getElementById('btn-adopt');
  var instSel = document.getElementById('f-instance');
  var isoSel = document.getElementById('f-isolation');
  var lProfile = document.getElementById('l-profile');
  var lHeadless = document.getElementById('l-headless');
  var open = {};   // instanceId -> true when its tab list is expanded
  var view = {};   // instanceId -> 'tabs' | 'cookies'
  var ckFilter = {};
  var revealed = {};
  var busy = 0;    // >0 while a cookie editor is open: pauses the 5 s refresh so typing survives
  var instById = {};

  function api(path, opts) { return fetch(base + '/api' + path, opts); }

  function setStatus(msg, isErr) {
    statusEl.textContent = msg || '';
    statusEl.className = isErr ? 'err' : '';
  }

  function age(iso) {
    var s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // Per-tab URLs in the same shapes the server builds for sessions (buildSessionResponse).
  function tabWs(instId, targetId) {
    return wsOrigin + base + '/i/' + instId + '/devtools/page/' + targetId;
  }
  function tabDevtools(inst, targetId) {
    var wsNoScheme = location.host + base + '/i/' + inst.id + '/devtools/page/' + targetId;
    var param = isHttps ? 'wss' : 'ws';
    return location.origin + base + '/devtools-frontend/@' + inst.devtoolsHash +
      '/inspector.html?' + param + '=' + wsNoScheme;
  }

  function copy(text, b) {
    function done() {
      var old = b.textContent;
      b.textContent = 'copied!';
      setTimeout(function () { b.textContent = old; }, 1200);
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); done(); });
    } else { fallback(); done(); }
  }

  function demolish(id) {
    api('/sessions/' + id, { method: 'DELETE' }).then(function (r) {
      if (!r.ok) {
        return r.json().then(function (d) { setStatus(d.error || ('HTTP ' + r.status), true); }, function () { setStatus('HTTP ' + r.status, true); });
      }
      setStatus('demolished ' + id);
      refresh();
    }, function (e) { setStatus(String(e), true); });
  }

  function expose(instId, targetId, btn) {
    btn.disabled = true;
    setStatus('exposing tab…');
    api('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isolation: 'attached', instance: instId, targetId: targetId })
    }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; });
    }).then(function (x) {
      btn.disabled = false;
      if (!x.ok) { setStatus(x.d.error || ('HTTP ' + x.status), true); return; }
      setStatus('exposed as ' + x.d.id + ' — see Sessions for its links');
      refresh();
    }, function (e) { btn.disabled = false; setStatus(String(e), true); });
  }

  function actionBtns(td, wsUrl, devtoolsUrl, viewUrl) {
    var v = el('a', 'btn primary-ghost', 'live view');
    v.href = viewUrl;
    v.target = '_blank';
    v.rel = 'noopener noreferrer';
    v.title = 'Watch and control this tab as a human';
    v.onclick = function (ev) { ev.stopPropagation(); };
    td.appendChild(v);
    var b1 = el('button', '', 'copy ws');
    b1.title = wsUrl;
    b1.onclick = function (ev) { ev.stopPropagation(); copy(wsUrl, b1); };
    td.appendChild(b1);
    var a = el('a', 'btn', 'devtools');
    a.href = devtoolsUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.onclick = function (ev) { ev.stopPropagation(); };
    td.appendChild(a);
  }

  function render(sessions) {
    rowsEl.textContent = '';
    if (!sessions.length) {
      var tr0 = el('tr');
      var td0 = el('td', 'empty', 'no sessions — create one below, or expose a tab above');
      td0.colSpan = 7;
      tr0.appendChild(td0);
      rowsEl.appendChild(tr0);
      return;
    }
    sessions.forEach(function (s) {
      var tr = el('tr');
      tr.appendChild(el('td', 'mono', s.id));
      tr.appendChild(el('td', '', s.isolation));
      tr.appendChild(el('td', '', s.profile));
      tr.appendChild(el('td', '', s.headless ? 'yes' : 'no'));
      var tdUrl = el('td', 'mono url', s.url);
      tdUrl.title = s.url;
      tr.appendChild(tdUrl);
      tr.appendChild(el('td', '', age(s.createdAt)));
      var td = el('td', 'actions');
      actionBtns(td, s.urls.cdp_ws, s.urls.devtools, base + '/view/s/' + s.id);
      var b2 = el('button', '', 'browser url');
      b2.title = s.urls.browser_http;
      b2.onclick = function () { copy(s.urls.browser_http, b2); };
      td.appendChild(b2);
      var b3 = el('button', 'danger', s.isolation === 'attached' ? 'release' : 'demolish');
      b3.title = s.isolation === 'attached' ? 'detach the agent; the real tab stays open' : 'close this tab';
      b3.onclick = function () { demolish(s.id); };
      td.appendChild(b3);
      tr.appendChild(td);
      rowsEl.appendChild(tr);
    });
  }

  function renderTabs(inst, container, tabs) {
    container.textContent = '';
    var t = el('table');
    var thead = el('thead');
    var htr = el('tr');
    ['title', 'url', ''].forEach(function (h) { htr.appendChild(el('th', '', h)); });
    thead.appendChild(htr);
    t.appendChild(thead);
    var tb = el('tbody');
    if (!tabs.length) {
      var tr0 = el('tr');
      var td0 = el('td', 'empty', 'no open tabs');
      td0.colSpan = 3;
      tr0.appendChild(td0);
      tb.appendChild(tr0);
    }
    tabs.forEach(function (tab) {
      var tr = el('tr');
      var tdTitle = el('td', '', tab.title || '(untitled)');
      tdTitle.style.maxWidth = '18rem';
      tdTitle.style.overflow = 'hidden';
      tdTitle.style.textOverflow = 'ellipsis';
      tdTitle.title = tab.title || '';
      tr.appendChild(tdTitle);
      var tdUrl = el('td', 'mono url', tab.url);
      tdUrl.title = tab.url;
      tr.appendChild(tdUrl);
      var td = el('td', 'actions');
      actionBtns(td, tabWs(inst.id, tab.targetId), tabDevtools(inst, tab.targetId), base + '/view/i/' + inst.id + '/' + tab.targetId);
      var be = el('button', '', 'expose');
      be.title = 'create a tracked attached session for this tab';
      be.onclick = function (ev) { ev.stopPropagation(); expose(inst.id, tab.targetId, be); };
      td.appendChild(be);
      if (tab.closable) {
        var bd = el('button', 'danger', 'demolish');
        bd.title = 'close this tab';
        bd.onclick = function (ev) {
          ev.stopPropagation();
          if (!confirm('Demolish this tab?\\n\\n' + (tab.title || tab.url))) return;
          bd.disabled = true;
          api('/instances/' + inst.id + '/tabs?targetId=' + encodeURIComponent(tab.targetId), { method: 'DELETE' }).then(function (r) {
            return r.json().then(function (d) { return { ok: r.ok, d: d }; }, function () { return { ok: r.ok, d: {} }; });
          }).then(function (x) {
            setStatus(x.ok ? 'demolished tab' : (x.d.error || 'failed'), !x.ok);
            if (!x.ok) bd.disabled = false;
            // Re-renders the instance rows and reloads this panel; the tab count updates too.
            refreshInstances();
          }, function (e) { bd.disabled = false; setStatus(String(e), true); });
        };
        td.appendChild(bd);
      }
      tr.appendChild(td);
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    container.appendChild(t);
  }

  function loadTabs(inst, container) {
    container.textContent = '';
    container.appendChild(el('div', 'empty', 'loading tabs…'));
    api('/instances/' + inst.id + '/tabs').then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, d: d }; });
    }).then(function (x) {
      if (!x.ok) { container.textContent = ''; container.appendChild(el('div', 'empty', x.d.error || 'tabs unavailable')); return; }
      renderTabs(inst, container, x.d.tabs);
    }, function (e) { container.textContent = ''; container.appendChild(el('div', 'empty', String(e))); });
  }

  function ckKey(c) { return JSON.stringify([c.domain, c.name, c.path]); }
  function normDom(d) { return String(d).replace(/^\\./, '').toLowerCase(); }

  function expiryText(c) {
    if (c.session || !c.expires || c.expires < 0) return 'session';
    var d = new Date(c.expires * 1000);
    if (d.getTime() < Date.now()) return 'expired';
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }

  function ckRequest(inst, opts) {
    return api('/instances/' + inst.id + '/cookies' + (opts.query || ''), opts.init).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, d: d }; }, function () { return { ok: r.ok, d: {} }; });
    });
  }

  function putCookie(inst, cookie) {
    return ckRequest(inst, {
      init: { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cookies: [cookie] }) },
    });
  }

  function delCookie(inst, domain, name, path) {
    var q = '?domain=' + encodeURIComponent(domain);
    if (name != null) q += '&name=' + encodeURIComponent(name) + '&path=' + encodeURIComponent(path);
    return ckRequest(inst, { query: q, init: { method: 'DELETE' } });
  }

  function loadCookies(inst, box) {
    box.textContent = '';
    box.appendChild(el('div', 'empty', 'loading cookies…'));
    ckRequest(inst, {}).then(function (x) {
      box.textContent = '';
      if (!x.ok) { box.appendChild(el('div', 'empty', x.d.error || 'cookies unavailable')); return; }
      renderCookies(inst, box, x.d.cookies || []);
    }, function (e) { box.textContent = ''; box.appendChild(el('div', 'empty', String(e))); });
  }

  function cookieEditor(inst, tr, existing, box) {
    busy++;
    var c = existing || { name: '', value: '', domain: '', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: '' };
    var td = el('td');
    td.colSpan = 6;
    var grid = el('div', 'grid');
    function field(label, value, size) {
      var l = el('label', '', label);
      var i = document.createElement('input');
      i.type = 'text'; i.value = value == null ? '' : String(value); i.size = size || 14;
      l.appendChild(i); grid.appendChild(l); return i;
    }
    var fName = field('name', c.name, 12);
    var fVal = field('value', c.value, 26);
    var fDom = field('domain', c.domain, 16);
    var fPath = field('path', c.path, 8);
    var fExp = field('expires (unix s, blank = session)', c.expires > 0 ? c.expires : '', 14);
    function check(label, on) {
      var l = el('label', 'chk');
      var i = document.createElement('input'); i.type = 'checkbox'; i.checked = !!on;
      l.appendChild(i); l.appendChild(document.createTextNode(label)); grid.appendChild(l); return i;
    }
    var fHttp = check('httpOnly', c.httpOnly);
    var fSec = check('secure', c.secure);
    var lSame = el('label', '', 'sameSite');
    var fSame = document.createElement('select');
    ['', 'Strict', 'Lax', 'None'].forEach(function (v) { fSame.appendChild(new Option(v || '(unset)', v)); });
    fSame.value = c.sameSite || '';
    lSame.appendChild(fSame); grid.appendChild(lSame);

    var save = el('button', 'primary', existing ? 'Save' : 'Add');
    var cancel = el('button', '', 'Cancel');
    grid.appendChild(save); grid.appendChild(cancel);
    var err = el('div', 'warn');
    td.appendChild(grid); td.appendChild(err);
    tr.appendChild(td);

    function close() { busy--; loadCookies(inst, box); }
    cancel.onclick = function () { busy--; tr.parentNode.removeChild(tr); };
    save.onclick = function () {
      var next = {
        name: fName.value, value: fVal.value, domain: fDom.value, path: fPath.value || '/',
        httpOnly: fHttp.checked, secure: fSec.checked,
      };
      if (fExp.value.trim()) {
        var n = Number(fExp.value.trim());
        if (!isFinite(n)) { err.textContent = 'expires must be a number of unix seconds'; return; }
        next.expires = n;
      }
      if (fSame.value) next.sameSite = fSame.value;
      save.disabled = true; err.textContent = '';
      putCookie(inst, next).then(function (x) {
        if (!x.ok) { save.disabled = false; err.textContent = x.d.error || 'failed'; return; }
        var renamed = existing && ckKey(existing) !== ckKey(next);
        if (!renamed) { setStatus('saved ' + next.domain + ' / ' + next.name); close(); return; }
        // Upsert keys on (name, domain, path): a rename leaves the old cookie behind.
        delCookie(inst, existing.domain, existing.name, existing.path).then(function () {
          setStatus('saved ' + next.domain + ' / ' + next.name); close();
        });
      }, function (e) { save.disabled = false; err.textContent = String(e); });
    };
    fName.focus();
  }

  function renderCookies(inst, box, cookies) {
    var filter = (ckFilter[inst.id] || '').toLowerCase();
    var shown = cookies.filter(function (c) {
      return !filter || normDom(c.domain).indexOf(filter) >= 0 || c.name.toLowerCase().indexOf(filter) >= 0;
    });

    var head = el('div', 'subhead');
    var fi = document.createElement('input');
    fi.type = 'text'; fi.className = 'filter'; fi.placeholder = 'filter by site or cookie name'; fi.value = ckFilter[inst.id] || '';
    fi.oninput = function () { ckFilter[inst.id] = fi.value; renderCookies(inst, box, cookies); };
    head.appendChild(fi);
    head.appendChild(el('span', 'count', shown.length + ' of ' + cookies.length + ' cookie' + (cookies.length === 1 ? '' : 's')));
    head.appendChild(el('div', 'spacer'));
    var bAdd = el('button', '', '+ add cookie');
    var bReload = el('button', '', 'reload');
    head.appendChild(bAdd); head.appendChild(bReload);
    box.textContent = '';
    box.appendChild(head);
    bReload.onclick = function () { loadCookies(inst, box); };

    if (inst.external) {
      var w = el('div', 'ck-site');
      w.appendChild(el('span', 'warn', 'These are your real Chrome profile\u2019s cookies — editing or deleting them signs you out for real.'));
      box.appendChild(w);
    }

    var wrap = el('div');
    box.appendChild(wrap);

    var tblAdd = el('table');
    var addBody = document.createElement('tbody');
    tblAdd.appendChild(addBody);
    box.insertBefore(tblAdd, wrap);
    bAdd.onclick = function () {
      addBody.textContent = '';
      var tr = el('tr', 'ck-edit');
      addBody.appendChild(tr);
      cookieEditor(inst, tr, null, box);
    };

    if (!shown.length) {
      wrap.appendChild(el('div', 'empty', cookies.length ? 'no cookie matches that filter' : 'no cookies in this profile yet'));
      return;
    }

    var sites = {};
    shown.forEach(function (c) {
      var d = normDom(c.domain);
      (sites[d] = sites[d] || []).push(c);
    });
    Object.keys(sites).sort().forEach(function (dom) {
      var list = sites[dom];
      var sh = el('div', 'ck-site');
      sh.appendChild(el('span', 'dom', dom));
      sh.appendChild(el('span', 'count', list.length + ' cookie' + (list.length === 1 ? '' : 's')));
      sh.appendChild(el('div', 'spacer'));
      var bDel = el('button', 'danger', 'delete site');
      bDel.onclick = function () {
        if (!confirm('Delete all ' + list.length + ' cookie(s) for ' + dom + '? This signs this profile out of that site.')) return;
        bDel.disabled = true;
        delCookie(inst, dom, null, null).then(function (x) {
          setStatus(x.ok ? ('deleted ' + x.d.deleted + ' cookie(s) for ' + dom) : (x.d.error || 'failed'), !x.ok);
          loadCookies(inst, box);
        });
      };
      sh.appendChild(bDel);
      wrap.appendChild(sh);

      var tbl = el('table');
      var thead = document.createElement('thead');
      var htr = el('tr');
      ['name', 'value', 'path', 'expires', 'flags', ''].forEach(function (h) { htr.appendChild(el('th', '', h)); });
      thead.appendChild(htr); tbl.appendChild(thead);
      var tb = document.createElement('tbody');
      list.forEach(function (c) {
        var tr = el('tr');
        tr.appendChild(el('td', 'mono', c.name));
        var tdv = el('td', 'val');
        var key = ckKey(c);
        if (revealed[key]) tdv.appendChild(document.createTextNode(c.value));
        else tdv.appendChild(el('span', 'mask', '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'));
        tdv.title = revealed[key] ? c.value : 'hidden — click reveal';
        tr.appendChild(tdv);
        tr.appendChild(el('td', 'mono', c.path));
        tr.appendChild(el('td', '', expiryText(c)));
        var flags = [];
        if (c.httpOnly) flags.push('httpOnly');
        if (c.secure) flags.push('secure');
        if (c.sameSite) flags.push(c.sameSite);
        tr.appendChild(el('td', '', flags.join(' ') || '–'));
        var td = el('td', 'actions');
        var bRev = el('button', '', revealed[key] ? 'hide' : 'reveal');
        bRev.onclick = function () { revealed[key] = !revealed[key]; renderCookies(inst, box, cookies); };
        var bEdit = el('button', '', 'edit');
        bEdit.onclick = function () {
          var etr = el('tr', 'ck-edit');
          tr.parentNode.insertBefore(etr, tr.nextSibling);
          cookieEditor(inst, etr, c, box);
        };
        var bX = el('button', 'danger', 'delete');
        bX.onclick = function () {
          if (!confirm('Delete cookie ' + c.name + ' for ' + dom + '?')) return;
          bX.disabled = true;
          delCookie(inst, c.domain, c.name, c.path).then(function (x) {
            setStatus(x.ok ? ('deleted ' + c.name) : (x.d.error || 'failed'), !x.ok);
            loadCookies(inst, box);
          });
        };
        td.appendChild(bRev); td.appendChild(bEdit); td.appendChild(bX);
        tr.appendChild(td);
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      wrap.appendChild(tbl);
    });
  }

  function loadPanel(inst, box) {
    var mode = view[inst.id] || 'tabs';
    box.textContent = '';
    var head = el('div', 'subhead');
    var seg = el('div', 'seg');
    [['tabs', 'tabs'], ['cookies', 'cookies']].forEach(function (p) {
      var b = el('button', mode === p[0] ? 'on' : '', p[1]);
      b.onclick = function () { view[inst.id] = p[0]; loadPanel(inst, box); };
      seg.appendChild(b);
    });
    head.appendChild(seg);
    box.appendChild(head);
    var inner = el('div');
    box.appendChild(inner);
    if (mode === 'cookies') loadCookies(inst, inner);
    else loadTabs(inst, inner);
  }

  function renderInstances(list, tabCounts) {
    instRowsEl.textContent = '';
    instById = {};
    if (!list.length) {
      var tr0 = el('tr');
      var td0 = el('td', 'empty', 'no chrome instances — create a tab below, or Adopt Chrome');
      td0.colSpan = 6;
      tr0.appendChild(td0);
      instRowsEl.appendChild(tr0);
      return;
    }
    list.forEach(function (inst, idx) {
      instById[inst.id] = inst;
      var tr = el('tr', 'inst-row' + (open[inst.id] ? ' open' : ''));
      tr.appendChild(el('td', 'twist', '▸'));
      tr.appendChild(el('td', 'mono', inst.id));
      var tdType = el('td');
      tdType.appendChild(el('span', 'pill' + (inst.external ? ' ext' : ''), inst.external ? 'external' : 'launched'));
      tr.appendChild(tdType);
      var tdState = el('td');
      var disc = inst.state === 'disconnected';
      tdState.appendChild(el('span', 'pill' + (disc ? ' disc' : ''), inst.state || 'running'));
      tr.appendChild(tdState);
      tr.appendChild(el('td', '', String(inst.sessionCount)));
      tr.appendChild(el('td', '', tabCounts[idx] === null ? '–' : String(tabCounts[idx])));

      var tabsTr = el('tr', 'tabs-row');
      var tabsTd = el('td');
      tabsTd.colSpan = 6;
      var box = el('div');
      tabsTd.appendChild(box);
      tabsTr.appendChild(tabsTd);
      tabsTr.style.display = open[inst.id] ? '' : 'none';

      tr.onclick = function () {
        open[inst.id] = !open[inst.id];
        tr.classList.toggle('open', open[inst.id]);
        tabsTr.style.display = open[inst.id] ? '' : 'none';
        if (open[inst.id]) loadPanel(inst, box);
      };
      instRowsEl.appendChild(tr);
      instRowsEl.appendChild(tabsTr);
      if (open[inst.id]) loadPanel(inst, box);
    });
  }

  var instExternal = {}; // instanceId -> true when it's an adopted real browser
  function syncInstancePicker(list) {
    var prev = instSel.value;
    instExternal = {};
    instSel.textContent = '';
    instSel.appendChild(new Option('launch managed profile', ''));
    list.forEach(function (inst) {
      if (inst.state === 'disconnected') return;
      if (inst.external) instExternal[inst.id] = true;
      instSel.appendChild(new Option(inst.id + (inst.external ? ' (your real chrome)' : ''), inst.id));
    });
    instSel.value = prev;
    if (instSel.value !== prev) instSel.value = '';
    applyTargetMode();
  }

  var hintEl = document.getElementById('iso-hint');
  // 'profile' isolation and launch params only apply when launching a managed instance.
  function applyTargetMode() {
    var target = instSel.value;
    var launching = target === '';
    lProfile.classList.toggle('hidden', !launching);
    lHeadless.classList.toggle('hidden', !launching);
    var profOpt = isoSel.querySelector('option[value=profile]');
    if (profOpt) profOpt.disabled = !launching;
    if (!launching && isoSel.value === 'profile') isoSel.value = 'shared';
    updateHint();
  }
  function updateHint() {
    var target = instSel.value;
    var ext = !!instExternal[target];
    var iso = isoSel.value;
    var msg;
    if (iso === 'shared' && ext) {
      msg = '<b>shared → your real Chrome profile.</b> This tab runs in your actual profile — your extensions, logins and cookies are all present. (Note: Google blocks its <i>login flow</i> in a CDP-driven tab; log in with remote debugging off first, then reuse the session.)';
    } else if (iso === 'shared') {
      msg = '<b>shared</b> — a tab in this profile\\'s main browser context (shares its cookies/logins).';
    } else if (iso === 'context') {
      msg = '<b>context</b> — an isolated, incognito-style session: clean cookies, <b>logged out of every site</b>, <b>no extensions</b>, nothing persisted. To reuse a profile you logged into (e.g. a Simplify/extension login), pick <b>shared</b> or <b>profile</b> instead.';
    } else {
      msg = '<b>profile</b> — a separate, persistent managed profile of its own (its own logins, kept across runs).';
    }
    hintEl.innerHTML = msg;
  }
  // The dashboard defaults to 'shared' (use the profile's logins); the REST/CLI default stays 'context'.
  instSel.addEventListener('change', function () {
    if (instExternal[instSel.value] && isoSel.value === 'context') isoSel.value = 'shared';
    applyTargetMode();
  });
  isoSel.addEventListener('change', updateHint);

  function refreshInstances() {
    return api('/instances').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      syncInstancePicker(d.instances);
      // Tab counts come from the live tabs endpoint; '–' when unreachable.
      return Promise.all(d.instances.map(function (inst) {
        return api('/instances/' + inst.id + '/tabs').then(function (r) {
          if (!r.ok) return null;
          return r.json().then(function (t) { return t.tabs.length; }, function () { return null; });
        }, function () { return null; });
      })).then(function (counts) { renderInstances(d.instances, counts); });
    }).catch(function (e) { setStatus('refresh failed: ' + e.message, true); });
  }

  function refresh() {
    if (busy) return;
    api('/sessions').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) { render(d.sessions); }, function (e) { setStatus('refresh failed: ' + e.message, true); });
    refreshInstances();
  }

  btnAdopt.addEventListener('click', function () {
    btnAdopt.disabled = true;
    setStatus('adopting real Chrome… approve the connection dialog in Chrome if it appears');
    api('/adopt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'chrome' })
    }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; });
    }).then(function (x) {
      btnAdopt.disabled = false;
      if (!x.ok) { setStatus(x.d.error || ('HTTP ' + x.status), true); return; }
      setStatus('adopted ' + x.d.id);
      refresh();
    }, function (e) { btnAdopt.disabled = false; setStatus(String(e), true); });
  });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var body = { isolation: isoSel.value };
    var target = instSel.value;
    if (target) {
      body.instance = target;
    } else {
      body.profile = document.getElementById('f-profile').value || 'default';
      body.headless = document.getElementById('f-headless').checked;
    }
    var u = document.getElementById('f-url').value.trim();
    if (u) body.url = u;
    btnCreate.disabled = true;
    setStatus('creating… (first launch of an instance takes a few seconds)');
    api('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; });
    }).then(function (x) {
      btnCreate.disabled = false;
      if (!x.ok) { setStatus(x.d.error || ('HTTP ' + x.status), true); return; }
      setStatus('created ' + x.d.id);
      refresh();
    }, function (e) {
      btnCreate.disabled = false;
      setStatus(String(e), true);
    });
  });

  applyTargetMode();
  setInterval(refresh, 5000);
  refresh();
})();
</script>
</body>
</html>
`;
}
