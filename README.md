# OpenTab

Turn your existing personal MacBook or Mac Mini into a browser server: spin up Chrome tabs through a tiny REST API and hand out copy-pasteable CDP URLs that either agents and humans can drive.

Use your Mac (a Mac Mini in a closet, the laptop on your desk) that is already logged into everything, sits on your tailnet, and idles all day. OpenTab makes it the browser backend for all your agents:

- **Agents** — chrome-devtools-mcp, chrome-devtools-axi, Puppeteer, Playwright, browser-use, chromedp, or anything else that speaks the Chrome DevTools Protocol — get a websocket or browser URL to drive a real Chrome tab.
- **Humans** get a DevTools or Live View link to paste into any browser and watch or take over that same tab, live, while the agent works (CDP supports multiple simultaneous clients per tab).

## Quickstart

```sh
git clone <this repo> && cd opentab
npm install
npm install -g .

opentab serve
```

Now, you can create or connect to existing Chrome sessions and profiles from the dashboard or through the opentab cli.

In another terminal:

```sh
opentab create
```

```
created s_a1b2c3  (context · profile default · headless)

  agent ws (CDP):  ws://127.0.0.1:9333/t/<token>/s/s_a1b2c3
  browser url:     http://127.0.0.1:9333/t/<token>/i/i_default_headless
  browser ws:      ws://127.0.0.1:9333/t/<token>/i/i_default_headless/devtools/browser/<uuid>  (puppeteer/axi/mcp wsEndpoint)
  human devtools:  https://chrome-devtools-frontend.appspot.com/serve_rev/@<hash>/inspector.html?ws=...
```

Requires Node ≥ 22.18 (runs TypeScript directly, no build step) and Google Chrome.

## The three URL types

Every session comes with three kinds of URL. Hand out whichever the consumer expects:

| URL | Shape | Hand it to |
|---|---|---|
| **CDP WebSocket** (`cdp_ws`) | `wss://…/t/<token>/s/<sessionId>` | Anything that speaks raw CDP to **one tab**: custom agents, chromedp, `new WebSocket(...)`. Stable per-session address. |
| **Browser Url** (`browser_http`, `browser_ws`) | `https://…/t/<token>/i/<instanceId>` and `wss://…/i/<instanceId>/devtools/browser/<uuid>` | Tools that want a **whole browser**. `browser_http`: raw `/json/*` over the proxy (`GET /json/version`, `/json/list`, `PUT /json/new`) and Playwright. `browser_ws`: puppeteer-family clients (see below). |
| **Human Devtools** (`devtools`) | hosted DevTools frontend with `ws=`/`wss=` aimed back through OpenTab | Paste into any local browser: full DevTools attached to the tab. |

### Consuming the browser url

> **Puppeteer-family clients** on puppeteer: `puppeteer.connect({browserURL})`

```sh
# chrome-devtools-axi — ws:// URLs route to a direct websocket endpoint
CHROME_DEVTOOLS_AXI_BROWSER_URL=<browser_ws> npx -y chrome-devtools-axi pages

# chrome-devtools-mcp
npx -y chrome-devtools-mcp --wsEndpoint <browser_ws>
```

```js
// puppeteer
const browser = await puppeteer.connect({ browserWSEndpoint: '<browser_ws>' });

// playwright — appends /json/version to the full path, so browser_http works
const browser = await chromium.connectOverCDP('<browser_http>');
```

### Watching (and co-driving) as a human

Every tab in an expanded instance has a **demolish** button, including tabs that have no session — a link you opened with `target=_blank` from Live View shows up in the tab list and can be closed from there. On your adopted real Chrome the button only appears for tabs OpenTab itself opened.

The dashboard also shows **cookies per profile**: expand an instance and switch to *cookies* to browse them grouped by site, with values masked until you reveal them, and add / edit / delete per cookie or per site. Handy for checking whether a profile is still logged in, copying a session across profiles, or clearing one site without touching the rest. Cookies are read over CDP, so the instance has to be running.

Use the opentab live view or devtools url link to control the tab as if you were controlling it directly. The Live View bar has a **demolish** button that closes the tab and ends the session (**release** on an attached session — your own tab stays open). Use tailscale or any other proxy service to do so on a remote machine.

## Isolation modes

`opentab create --isolation <mode>` (default `context`):

| `isolation` | Meaning | Cookies / storage |
|---|---|---|
| `shared` | plain tab in the named profile's default browser context | shared with that profile |
| `context` *(default)* | tab inside a fresh incognito-style browser context | fully isolated, ephemeral |
| `profile` | plain tab on a dedicated named profile (`--profile` required) | persistent, per-name |
| `attached` | wraps an **existing** tab — creates nothing, and destroying the session never closes the tab (`instance` + `targetId` required; see [Use your real Chrome](#use-your-real-chrome)) | whatever the tab already has |

Launched Chrome runs with `--disable-blink-features=AutomationControlled` (so `navigator.webdriver` is `false`); disable with `stealth: false` / `OPENTAB_STEALTH=0`. The `HeadlessChrome` user-agent tell remains — run `--headful` if a site blocks headless. OpenTab also seeds `restore_on_startup` into each managed profile so a logged-in session survives the instance restarting (on a graceful stop).

`--headful` opens a real window on the server Mac; default is headless. A Chrome instance is entirely headless or headful (keyed by `(profile, mode)`), and a profile can only be locked by one instance at a time — asking for the same profile in the other mode returns a 409 telling you to stop the running instance first (`opentab instances stop <id>`).

## Tailscale setup

The server binds to 127.0.0.1. To share it across your tailnet with TLS:

```sh
opentab tailscale        # prints:  tailscale serve --bg --https=443 http://127.0.0.1:9333
opentab tailscale --run  # runs it for you
```

From then on, `https://<machine>.<tailnet>.ts.net/t/<token>/…` works from any device on your tailnet, and OpenTab emits `https://`/`wss://` URLs automatically (`tailscale serve` preserves the Host header and sets `X-Forwarded-Proto`). `opentab serve` prints the shareable base on boot whenever tailscale is up.

## Logged-in sessions (the Chrome 136+ profile note)

OpenTab keeps its own profiles under `~/.opentab/profiles/<name>` 
With OpenTab you have the option of keeping local cookies, sessionStorage, localStorage, on disk and namespace them with Chrome profiles.

## Use your existing Chrome Profiles

Sometimes you want an agent in *your* actual browser instead — the one with your open tabs, your extensions, and years of logins, OpenTab can **adopt** that browser and serve it through the same tokened URLs as everything else:

1. In your normal Chrome, open `chrome://inspect/#remote-debugging` and turn the toggle **on**.
2. Quit and relaunch Chrome — the toggle takes effect on restart.
3. Adopt it:

```sh
opentab adopt chrome
```

```
adopted x_chrome  (external · running)

  list tabs:      opentab tabs x_chrome
  expose a tab:   opentab expose <targetId> --instance x_chrome
  new real tab:   opentab create --instance x_chrome --isolation shared
```


### Put an agent on your logged-in web

```sh
opentab create --instance x_chrome --isolation shared --url https://example.com
```

A real tab opens in your Chrome window, with your cookies — the agent holding `cdp_ws` is browsing as you, and you watch it happen in your own browser. Use `--isolation context` instead for an incognito-style window in the same Chrome that sees none of your cookies.

### Expose the tab you're looking at (co-driving)

```sh
opentab tabs
```

```
TARGET ID                         TITLE          URL
0F5C10FA22B8D3E7A9C4415F6B208D91  Weekly report  https://docs.example.com/d/weekly
7A93E0C2D14B85F6A0B3C9D8E2F41706  Dashboard      https://grafana.example.com/d/main
```

```sh
opentab expose 0F5C10FA22B8D3E7A9C4415F6B208D91 --ttl 3600
```

This creates an **attached** session wrapping that existing tab and prints the usual URL block. Hand `cdp_ws` to an agent and keep working in the tab.


## Security

**A CDP endpoint is code execution on this machine.** Anyone holding a session URL can run `Runtime.evaluate`, read every cookie in that profile, and download files as your user. Treat the token like an SSH key:

- Keep OpenTab on 127.0.0.1 + your tailnet. Never port-forward it to the internet, and don't use `tailscale funnel`.
- The token rides in URLs — don't paste them into logs, issues, or shared docs.
- Rotate with `opentab token --rotate` (then restart `opentab serve`).

Bad tokens get a plain 404 (no oracle); only `GET /health` is unauthenticated.

## CLI

```
opentab serve [--port N] [--host H] [--headful-default] [--cors]
              [--window-bounds left,top,width,height]        run the server (foreground)
opentab create [--isolation shared|context|profile] [--profile NAME]
               [--instance ID] [--headful] [--new-window] [--url URL]
               [--ttl SECONDS]                              create a tab, print its URLs
opentab adopt [name]                                        adopt your real Chrome (default "chrome")
opentab tabs [instance-id]                                  list open tabs with target ids
opentab expose <targetId> [--instance ID] [--ttl SECONDS]   attached session for an existing tab
opentab ls                                                  sessions table
opentab rm <session-id|all>                                 demolish
opentab instances                                           list Chrome instances
opentab instances stop <id>                                 stop one
opentab url <session-id> [--devtools|--ws|--browser]        print one URL (for $(…) use)
opentab token [--rotate]                                    print/rotate token
opentab tailscale [--run]                                   print (or run) the tailscale serve setup
opentab <verb> --help                                       flags and examples for a verb
```

There is also a dashboard — open the tokened base URL (`…/t/<token>/`) in a browser to list, create, copy, and demolish sessions.

## Configuration

State lives in `~/.opentab` (override the whole directory with `OPENTAB_HOME`): `config.json`, `token`, `profiles/<name>/`. Precedence: defaults ← `config.json` ← env ← CLI flags.

| `config.json` key | Env | Default | Meaning |
|---|---|---|---|
| `port` | `OPENTAB_PORT` | `9333` | listen port |
| `host` | `OPENTAB_HOST` | `127.0.0.1` | bind address |
| `publicUrl` | `OPENTAB_PUBLIC_URL` | `null` | fixed public base for generated URLs; `null` derives it from each request's `Host` / `X-Forwarded-Proto` |
| `chromePath` | `OPENTAB_CHROME_PATH` | `null` | Chrome binary; `null` auto-detects (app bundle, then PATH) |
| `defaultHeadless` | — | `true` | mode when `create` doesn't say |
| `stopIdleInstancesAfter` | — | `300` | seconds an instance may sit with 0 sessions before it is stopped; `0` = never |
| `extraChromeArgs` | — | `[]` | appended to the Chrome command line |
| `externalBrowsers` | — | `{ "chrome": … }` | adoptable external browsers, name → `{ "userDataDir": … }`; `chrome` (the real Google Chrome user data dir) is built in |
| `autoAdopt` | — | `[]` | external browser names to adopt at boot and re-probe from the reaper, e.g. `["chrome"]` |

## API

Auth: path prefix `/t/<token>/…`, or `Authorization: Bearer <token>` for `/api/*`.

| Route | Effect |
|---|---|
| `POST /api/sessions` | create a tab; body `{ isolation?, profile?, headless?, url?, ttl?, instance?, targetId? }` → session + `urls` (unknown body fields are rejected; `instance` routes to a running instance and excludes `profile`/`headless`; `attached` requires `instance` + `targetId`) |
| `GET /api/sessions` | `{ sessions: [...] }` |
| `GET /api/sessions/:id` | one session (404 if gone) |
| `DELETE /api/sessions/:id` | demolish: close the target (and dispose its context); `attached` sessions just unregister — the tab survives |
| `POST /api/adopt` | body `{ name?, userDataDir? }` (default name `chrome`); adopt an external browser, → its instance info; idempotent |
| `GET /api/instances` / `DELETE /api/instances/:id` | list / stop Chrome instances; for external (`x_…`) instances, DELETE closes only OpenTab-created tabs/contexts, then disconnects — never the browser |
| `GET /api/instances/:id/tabs` | live `{ tabs: [{ targetId, title, url, closable }] }` (pages only; works for every instance) |
| `DELETE /api/instances/:id/tabs?targetId=` | close a tab (even one with no session, e.g. a `target=_blank` popup); refused for tabs OpenTab did not open on an adopted browser |
| `GET /api/instances/:id/cookies[?domain=]` | `{ instanceId, profile, external, cookies: [...] }` — the profile's cookies, sorted by site |
| `PUT /api/instances/:id/cookies` | body `{ cookies: [{ name, value, domain, path?, expires?, httpOnly?, secure?, sameSite? }] }`; **upsert** on (name, domain, path), so it both adds and edits |
| `DELETE /api/instances/:id/cookies?domain=[&name=][&path=]` | delete one cookie, or every cookie for a site with `domain` alone |
| `GET /api/profiles` | `{ profiles: [{ name, running, headless }] }` |
| `GET /health` | no auth; `{ ok, version, instances, sessions }` |

Proxy routes (after the token prefix): `/i/<instanceId>/json*` forwards to Chrome's DevTools HTTP API with `webSocketDebuggerUrl`/`devtoolsFrontendUrl` rewritten to public tokened URLs; `WS /i/<instanceId>/devtools/…` and `WS /s/<sessionId>` pipe CDP websockets. `GET /t/<token>/` serves the dashboard. Errors are `{ "error": "message" }` with 400/404/409/500.

Sessions expire after **48 h** by default (`defaultTtl` in `config.json` or `OPENTAB_DEFAULT_TTL`; pass `ttl: 0` for never, or a `ttl` in seconds per session); tabs closed by a human are reaped; instances OpenTab launched are stopped after sitting idle (see `stopIdleInstancesAfter`). Stopping `opentab serve` leaves Chrome running — the next `serve` adopts it.


## License

MIT
