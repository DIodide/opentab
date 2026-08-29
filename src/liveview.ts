// Live View: a human-controllable viewport for one tab, served under /t/<token>/view/.
import type { IncomingMessage } from 'node:http';
import type { AppContext } from './types.ts';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The bar's close button: one token-relative request that ends the tab or the session. */
export interface CloseAction {
  label: string;
  title: string;
  method: 'DELETE' | 'GET';
  path: string;
  confirm: string;
  done: string;
}

function closeButton(c: CloseAction | null): string {
  if (!c) return '';
  const attrs = `title="${esc(c.title)}" data-method="${c.method}" data-path="${esc(c.path)}" data-confirm="${esc(c.confirm)}" data-done="${esc(c.done)}"`;
  return `<button id="close" class="danger" ${attrs}>${esc(c.label)}</button>`;
}

export function renderLiveView(_ctx: AppContext, _req: IncomingMessage, label: string, close: CloseAction | null): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>OpenTab — Live View</title>
<style>
:root { color-scheme: light dark; --bg:#0f1216; --bar:#171b21; --fg:#e4e8ee; --muted:#8b95a3; --border:#2a313b; --accent:#4c8dff; --danger:#e5645e; --ok:#4fbf7f; --warn:#e0a340; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
body { display: flex; flex-direction: column; }
.bar { display: flex; align-items: center; gap: .6rem; padding: .4rem .7rem; background: var(--bar); border-bottom: 1px solid var(--border); flex: 0 0 auto; }
.bar .dot { width: .6rem; height: .6rem; border-radius: 50%; background: var(--muted); flex: 0 0 auto; }
.bar.live .dot { background: var(--ok); }
.bar.poll .dot { background: var(--warn); }
.bar.dead .dot { background: var(--danger); }
.bar .label { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar .mode { color: var(--muted); font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; }
.bar .url { flex: 1 1 auto; min-width: 4rem; color: var(--fg); font-family: ui-monospace, Menlo, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar label.chk { color: var(--muted); display: flex; align-items: center; gap: .3rem; user-select: none; cursor: pointer; }
.bar button { font: inherit; color: var(--fg); background: transparent; border: 1px solid var(--border); border-radius: 6px; padding: .2rem .5rem; cursor: pointer; }
.bar button:hover { border-color: var(--accent); }
.bar button.danger { color: var(--danger); border-color: var(--danger); }
.bar button.danger:hover { background: var(--danger); color: #fff; }
.bar button[disabled] { opacity: .5; cursor: default; }
.stage { flex: 1 1 auto; display: grid; place-items: center; overflow: auto; padding: .5rem; }
canvas { max-width: 100%; max-height: 100%; background: #fff; box-shadow: 0 2px 16px rgba(0,0,0,.4); cursor: default; outline: none; }
.msg { position: fixed; inset: 0; display: none; place-items: center; text-align: center; color: var(--muted); pointer-events: none; padding: 2rem; }
.msg.show { display: grid; }
.overlay { position: fixed; inset: 0; display: none; place-items: center; background: rgba(0,0,0,.55); z-index: 20; padding: 1rem; }
.overlay.show { display: grid; }
.card { background: var(--bar); border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.2rem; max-width: 32rem; width: 100%; }
.card .ctitle { font-weight: 600; margin-bottom: .4rem; }
.card .cmsg { color: var(--muted); white-space: pre-wrap; word-break: break-word; margin-bottom: .8rem; max-height: 40vh; overflow: auto; }
.card input[type=text] { width: 100%; font: inherit; padding: .35rem .5rem; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); margin-bottom: .8rem; }
.card .cbtns { display: flex; justify-content: flex-end; gap: .5rem; }
.card button { font: inherit; padding: .3rem .8rem; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--fg); cursor: pointer; }
.card button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
</style>
</head>
<body>
  <div class="bar" id="bar">
    <span class="dot"></span>
    <span class="mode" id="mode"></span>
    <span class="label">${esc(label)}</span>
    <span class="url" id="url"></span>
    <label class="chk" title="Bring the tab to the foreground on connect and when you interact (smoother; foregrounds it on the host screen). Off: control it in the background via screenshots. Only one Live View tab can keep-active at once — the most recent one wins.">
      <input type="checkbox" id="keepactive" checked> keep active
    </label>
    <span class="kanote" id="kanote" style="display:none;color:var(--warn);font-size:.72rem">handed off to a newer tab</span>
    <label class="chk" title="Handle passkey/WebAuthn prompts with a virtual authenticator so the native OS picker never blocks you. Turn off to use the host machine's real passkeys.">
      <input type="checkbox" id="nopasskey" checked> block passkey popups
    </label>
    <button id="reload" title="Reload the page">reload</button>
    <button id="front" title="Bring the tab to the foreground now">bring to front</button>
    <button id="fit" title="Toggle actual size / fit">fit</button>
    ${closeButton(close)}
  </div>
  <div class="stage"><canvas id="screen" tabindex="0" width="1200" height="800"></canvas></div>
  <div class="msg show" id="msg">connecting…</div>
  <input type="file" id="filepick" multiple style="display:none">
  <div class="overlay" id="modal">
    <div class="card">
      <div class="ctitle" id="mtitle"></div>
      <div class="cmsg" id="mmsg"></div>
      <input type="text" id="minput" style="display:none">
      <div class="cbtns">
        <button id="mcancel">Cancel</button>
        <button id="mok" class="primary">OK</button>
      </div>
    </div>
  </div>
<script>
(function () {
  var pathname = location.pathname;
  // /view/s/<id> -> /s/<id>; /view/i/<inst>/<tid> -> /i/<inst>/devtools/page/<tid>
  var cdpPath = pathname
    .replace(/\\/view\\/s\\//, '/s/')
    .replace(/\\/view\\/i\\/([^/]+)\\/([^/]+)\\/?$/, '/i/$1/devtools/page/$2');
  var wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + cdpPath;
  var tokenBase = (pathname.match(/^\\/t\\/[^/]+/) || [''])[0]; // /t/<token>, for /api/upload

  var canvas = document.getElementById('screen');
  var g = canvas.getContext('2d');
  var bar = document.getElementById('bar');
  var msgEl = document.getElementById('msg');
  var urlEl = document.getElementById('url');
  var modeEl = document.getElementById('mode');
  var keepActive = document.getElementById('keepactive');
  var nopasskey = document.getElementById('nopasskey');
  var filepick = document.getElementById('filepick');
  var modalEl = document.getElementById('modal');
  var mtitle = document.getElementById('mtitle');
  var mmsg = document.getElementById('mmsg');
  var minput = document.getElementById('minput');
  var mok = document.getElementById('mok');
  var mcancel = document.getElementById('mcancel');
  var img = new Image();
  var meta = { deviceWidth: 1200, deviceHeight: 800 };
  var fitMode = true;
  var lastActivateAt = 0;   // throttle Page.bringToFront
  var polling = false;      // a captureScreenshot is in flight
  var visible = true;       // Page.screencastVisibilityChanged: false = backgrounded headful tab
  var closed = false;
  var killed = false;       // the close button ended the tab; keep its message over the disconnect one

  function setMsg(t) { if (t) { msgEl.textContent = t; msgEl.classList.add('show'); } else msgEl.classList.remove('show'); }
  function setBar(cls, mode) { bar.className = 'bar' + (cls ? ' ' + cls : ''); modeEl.textContent = mode || ''; }

  var ws = new WebSocket(wsUrl);
  var id = 0;
  var pending = {};
  function send(method, params) {
    return new Promise(function (res) {
      if (ws.readyState !== 1) { res(undefined); return; }
      var i = ++id; pending[i] = res; ws.send(JSON.stringify({ id: i, method: method, params: params || {} }));
    });
  }

  function draw(b64) {
    img.onload = function () {
      if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      }
      g.drawImage(img, 0, 0);
    };
    img.src = 'data:image/jpeg;base64,' + b64;
    setMsg('');
  }

  // Foregrounding a headful tab makes screencast frames flow again; throttled.
  function activate() {
    if (!keepActive.checked) return;
    var now = Date.now();
    if (now - lastActivateAt < 300) return;
    lastActivateAt = now;
    send('Page.bringToFront');
  }

  // Only one Live View may keep-active at a time; the newest claim wins over a BroadcastChannel.
  var viewId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  var myClaim = 0;
  var kanote = document.getElementById('kanote');
  var keepChan = null;
  try { keepChan = new BroadcastChannel('opentab-keepactive'); } catch (e) {}
  function claimKeepActive() {
    myClaim = Date.now();
    if (keepChan) keepChan.postMessage({ viewId: viewId, t: myClaim });
  }
  if (keepChan) {
    keepChan.onmessage = function (e) {
      var d = e.data;
      if (!d || d.viewId === viewId || !keepActive.checked) return;
      // A total order across simultaneous claims: newer time wins, ties break by id.
      var theyWin = d.t > myClaim || (d.t === myClaim && d.viewId > viewId);
      if (theyWin) {
        keepActive.checked = false;
        kanote.style.display = '';
        setTimeout(function () { kanote.style.display = 'none'; }, 4000);
      }
    };
  }
  keepActive.onchange = function () {
    kanote.style.display = 'none';
    if (keepActive.checked) claimKeepActive();
  };
  // Checked by default, so the newest-opened view takes over keep-active.
  if (keepActive.checked) claimKeepActive();

  ws.onopen = async function () {
    setBar('live', 'screencast'); setMsg('starting…');
    await send('Page.enable');
    await send('Runtime.enable');
    await send('DOM.enable');
    // Native dialogs render outside the page; intercept them so the remote user can respond.
    await setupWebAuthn();
    try { await send('Page.setInterceptFileChooserDialog', { enabled: true }); } catch (e) {}
    activate();
    await send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 });
    refreshUrl();
    pollLoop();
  };
  ws.onclose = function () { closed = true; setBar('dead', ''); if (!killed) setMsg('disconnected — the tab may have closed. Reopen from the dashboard.'); };
  ws.onerror = function () { setBar('dead', ''); };

  ws.onmessage = function (e) {
    var m = JSON.parse(e.data);
    if (m.id && pending[m.id]) { pending[m.id](m.result); delete pending[m.id]; return; }
    if (m.method === 'Page.screencastFrame') {
      visible = true;
      setBar('live', 'screencast');
      send('Page.screencastFrameAck', { sessionId: m.params.sessionId });
      meta = m.params.metadata;
      draw(m.params.data);
    } else if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) {
      urlEl.textContent = m.params.frame.url;
    } else if (m.method === 'Page.screencastVisibilityChanged') {
      // A backgrounded headful tab reports visible:false and emits no frames; poll instead.
      visible = m.params.visible !== false;
      if (!visible) { setBar('poll', keepActive.checked ? 'activating…' : 'background'); activate(); }
      else setBar('live', 'screencast');
    } else if (m.method === 'Page.javascriptDialogOpening') {
      showJsDialog(m.params);
    } else if (m.method === 'Page.fileChooserOpened') {
      showFileRequest(m.params);
    }
  };

  function modal(opts) {
    mtitle.textContent = opts.title || '';
    mmsg.textContent = opts.message || '';
    var wantInput = !!opts.input;
    minput.style.display = wantInput ? 'block' : 'none';
    minput.value = opts.inputValue || '';
    mok.textContent = opts.okText || 'OK';
    mcancel.textContent = opts.cancelText || 'Cancel';
    mcancel.style.display = opts.hideCancel ? 'none' : '';
    modalEl.classList.add('show');
    if (wantInput) minput.focus();
    var done = false;
    function close() { done = true; modalEl.classList.remove('show'); canvas.focus(); }
    mok.onclick = function () { if (done) return; var v = minput.value; close(); if (opts.onOk) opts.onOk(v); };
    mcancel.onclick = function () { if (done) return; close(); if (opts.onCancel) opts.onCancel(); };
  }

  // A virtual authenticator answers navigator.credentials so the native passkey picker never appears.
  var authenticatorId = null;
  async function setupWebAuthn() {
    if (!nopasskey.checked) return;
    try {
      await send('WebAuthn.enable', { enableUI: false });
      var r = await send('WebAuthn.addVirtualAuthenticator', {
        options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
      });
      authenticatorId = (r && r.authenticatorId) || null;
    } catch (e) {}
  }
  async function teardownWebAuthn() {
    try { if (authenticatorId) await send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: authenticatorId }); } catch (e) {}
    authenticatorId = null;
    try { await send('WebAuthn.disable'); } catch (e) {}
  }
  nopasskey.onchange = function () { if (nopasskey.checked) setupWebAuthn(); else teardownWebAuthn(); };

  function showJsDialog(p) {
    var titles = { alert: 'Alert', confirm: 'Confirm', prompt: 'Prompt', beforeunload: 'Leave this page?' };
    var isPrompt = p.type === 'prompt';
    modal({
      title: titles[p.type] || 'Dialog',
      message: p.message || '',
      input: isPrompt,
      inputValue: p.defaultPrompt || '',
      okText: p.type === 'beforeunload' ? 'Leave' : 'OK',
      hideCancel: p.type === 'alert',
      onOk: function (v) { send('Page.handleJavaScriptDialog', { accept: true, promptText: isPrompt ? v : undefined }); },
      onCancel: function () { send('Page.handleJavaScriptDialog', { accept: false }); },
    });
  }

  // The remote user picks files in this browser; the bytes are uploaded, then Chrome gets the host paths.
  var pendingChooser = null;
  function showFileRequest(p) {
    pendingChooser = p;
    filepick.multiple = p.mode === 'selectMultiple';
    filepick.value = '';
    modal({
      title: 'File upload',
      message: 'The page is asking for a file. Choose one from THIS machine to upload to the remote browser.',
      okText: 'Choose file…',
      onOk: function () { filepick.click(); }, // inside the click gesture, so the dialog is allowed
      onCancel: function () { cancelChooser(); },
    });
  }
  function cancelChooser() {
    var c = pendingChooser; pendingChooser = null;
    if (c) send('DOM.setFileInputFiles', { backendNodeId: c.backendNodeId, files: [] }).catch(function () {});
  }
  filepick.onchange = async function () {
    var c = pendingChooser; pendingChooser = null;
    if (!c) return;
    var files = Array.prototype.slice.call(filepick.files);
    if (!files.length) { send('DOM.setFileInputFiles', { backendNodeId: c.backendNodeId, files: [] }); return; }
    setMsg('uploading ' + files.length + ' file' + (files.length > 1 ? 's' : '') + '…');
    try {
      var paths = [];
      for (var i = 0; i < files.length; i++) {
        var buf = await files[i].arrayBuffer();
        var r = await fetch(tokenBase + '/api/upload', { method: 'POST', headers: { 'x-upload-name': encodeURIComponent(files[i].name) }, body: buf });
        if (!r.ok) throw new Error('upload failed (' + r.status + ')');
        paths.push((await r.json()).path);
      }
      await send('DOM.setFileInputFiles', { backendNodeId: c.backendNodeId, files: paths });
      setMsg('');
    } catch (e) {
      setMsg('upload error: ' + (e && e.message ? e.message : e));
      send('DOM.setFileInputFiles', { backendNodeId: c.backendNodeId, files: [] });
    }
  };

  // Poll screenshots only while the tab is hidden; a visible tab stays on screencast.
  async function pollLoop() {
    while (!closed) {
      await new Promise(function (r) { setTimeout(r, 250); });
      if (closed || visible || polling) continue;
      polling = true;
      try {
        var lm = await send('Page.getLayoutMetrics');
        if (lm && lm.cssLayoutViewport) meta = { deviceWidth: lm.cssLayoutViewport.clientWidth, deviceHeight: lm.cssLayoutViewport.clientHeight };
        var shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 65, optimizeForSpeed: true });
        if (shot && shot.data) { setBar('poll', keepActive.checked ? 'activating…' : 'background'); draw(shot.data); }
      } catch (e) {}
      polling = false;
    }
  }

  async function refreshUrl() {
    var r = await send('Runtime.evaluate', { expression: 'location.href' });
    if (r && r.result) urlEl.textContent = r.result.value;
  }

  function pt(ev) {
    var r = canvas.getBoundingClientRect();
    return { x: Math.round((ev.clientX - r.left) / r.width * meta.deviceWidth), y: Math.round((ev.clientY - r.top) / r.height * meta.deviceHeight) };
  }
  var BTN = { 0: 'left', 1: 'middle', 2: 'right' };
  function mods(ev) { return (ev.altKey ? 1 : 0) | (ev.ctrlKey ? 2 : 0) | (ev.metaKey ? 4 : 0) | (ev.shiftKey ? 8 : 0); }
  function mouse(type, ev, extra) {
    var q = pt(ev);
    var params = { type: type, x: q.x, y: q.y, button: BTN[ev.button] || 'none', buttons: ev.buttons, clickCount: (type === 'mousePressed' || type === 'mouseReleased') ? 1 : 0, modifiers: mods(ev) };
    if (extra) for (var k in extra) params[k] = extra[k];
    send('Input.dispatchMouseEvent', params);
  }
  // After input on a hidden tab, capture immediately instead of waiting for the next poll.
  async function nudge() {
    if (visible || polling) return;
    polling = true;
    try { var shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 65, optimizeForSpeed: true }); if (shot && shot.data) draw(shot.data); } catch (e) {}
    polling = false;
  }

  var lastMove = 0;
  canvas.addEventListener('mousemove', function (ev) { var t = Date.now(); if (t - lastMove < 16) return; lastMove = t; mouse('mouseMoved', ev); });
  canvas.addEventListener('mousedown', function (ev) { canvas.focus(); activate(); mouse('mousePressed', ev); nudge(); });
  canvas.addEventListener('mouseup', function (ev) { mouse('mouseReleased', ev); nudge(); });
  canvas.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
  canvas.addEventListener('wheel', function (ev) { ev.preventDefault(); activate(); mouse('mouseWheel', ev, { deltaX: ev.deltaX, deltaY: ev.deltaY }); nudge(); }, { passive: false });

  function key(type, ev) {
    var printable = type === 'keyDown' && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey;
    send('Input.dispatchKeyEvent', {
      type: printable ? 'keyDown' : type, key: ev.key, code: ev.code,
      windowsVirtualKeyCode: ev.keyCode, nativeVirtualKeyCode: ev.keyCode,
      text: printable ? ev.key : undefined, modifiers: mods(ev),
    });
  }
  function flash(m) { setMsg(m); setTimeout(function () { setMsg(''); }, 3000); }

  // Separate clipboards: paste injects this machine's clipboard via insertText; copy/cut read the host selection.
  var HOST_SELECTION = '(function(){var e=document.activeElement;' +
    'if(e&&(e.tagName==="INPUT"||e.tagName==="TEXTAREA")&&e.selectionStart!=null&&e.selectionEnd>e.selectionStart)' +
    'return e.value.substring(e.selectionStart,e.selectionEnd);' +
    'return window.getSelection?String(window.getSelection()):"";})()';
  function handleClipboard(ev) {
    if (!(ev.metaKey || ev.ctrlKey) || ev.altKey) return false;
    var k = ev.key.toLowerCase();
    if (k === 'v') {
      ev.preventDefault();
      if (!navigator.clipboard || !navigator.clipboard.readText) { flash('clipboard paste needs an https or localhost page'); return true; }
      navigator.clipboard.readText().then(function (text) {
        if (text) { activate(); send('Input.insertText', { text: text }); nudge(); }
      }, function () { flash('clipboard blocked — allow clipboard access for this page, then retry'); });
      return true;
    }
    if (k === 'c' || k === 'x') {
      ev.preventDefault();
      send('Runtime.evaluate', { expression: HOST_SELECTION, returnByValue: true }).then(function (r) {
        var sel = r && r.result && r.result.value;
        if (sel && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(sel).catch(function () { flash('clipboard blocked — allow clipboard access'); });
        }
        if (k === 'x') { // complete the cut: delete the host's selection
          send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
          send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
          nudge();
        }
      });
      return true;
    }
    return false; // Cmd+A, Cmd+Z, etc. forward as normal keystrokes
  }
  canvas.addEventListener('keydown', function (ev) {
    if (handleClipboard(ev)) return;
    ev.preventDefault(); activate(); key('keyDown', ev); nudge();
  });
  canvas.addEventListener('keyup', function (ev) { ev.preventDefault(); key('keyUp', ev); });

  document.getElementById('reload').onclick = function () { send('Page.reload', {}); };
  document.getElementById('front').onclick = function () { lastActivateAt = 0; send('Page.bringToFront'); canvas.focus(); };
  document.getElementById('fit').onclick = function () {
    fitMode = !fitMode;
    canvas.style.maxWidth = fitMode ? '100%' : 'none';
    canvas.style.maxHeight = fitMode ? '100%' : 'none';
  };
  var closeBtn = document.getElementById('close');
  if (closeBtn) closeBtn.onclick = function () {
    if (!confirm(closeBtn.dataset.confirm)) return;
    closeBtn.disabled = true;
    fetch(tokenBase + closeBtn.dataset.path, { method: closeBtn.dataset.method }).then(async function (r) {
      if (!r.ok) {
        var err = '';
        try { err = (await r.json()).error || ''; } catch (e) {}
        throw new Error(err || ('HTTP ' + r.status));
      }
      killed = true; closed = true;
      setBar('dead', ''); setMsg(closeBtn.dataset.done);
      try { ws.close(); } catch (e) {}
    }).catch(function (e) {
      closeBtn.disabled = false;
      flash('close failed: ' + (e && e.message ? e.message : e));
    });
  };
  canvas.focus();
})();
</script>
</body>
</html>
`;
}
