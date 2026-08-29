// Shared contracts between modules; every other file codes against these. Change with care.

export interface Config {
  port: number;
  host: string;
  /** e.g. "https://mini.tailXXXX.ts.net"; null = derive from request Host header. */
  publicUrl: string | null;
  /** Absolute path to the Chrome binary; null = auto-detect. */
  chromePath: string | null;
  defaultHeadless: boolean;
  /** Hide automation tells on launched Chrome (navigator.webdriver=false). Default true. */
  stealth: boolean;
  /** Seconds an OpenTab-launched instance may sit with 0 sessions before being stopped. 0 = never. */
  stopIdleInstancesAfter: number;
  /** Seconds a new session lives when the request omits `ttl`. 0 = never. */
  defaultTtl: number;
  extraChromeArgs: string[];
  /** Adoptable external browsers by name; "chrome" is built in (real Chrome user data dir). */
  externalBrowsers: Record<string, { userDataDir: string }>;
  /** External browser names to auto-adopt at boot and re-probe from the reaper. */
  autoAdopt: string[];
  /** Access-Control-Allow-Origin for /api (e.g. "*"); null = no CORS headers. */
  corsOrigin: string | null;
  /** Screen region (global coords) to park session windows on; null = leave them where Chrome puts them. */
  windowBounds: WindowBounds | null;
  /** Base state dir (OPENTAB_HOME), default ~/.opentab */
  home: string;
  /** `${home}/profiles` */
  profilesDir: string;
}

export interface WindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Isolation = 'shared' | 'context' | 'profile' | 'attached';

export interface CreateSessionRequest {
  isolation?: Isolation; // default 'context'
  profile?: string; // default 'default'; required when isolation === 'profile'
  headless?: boolean; // default config.defaultHeadless
  url?: string; // default 'about:blank'
  ttl?: number; // seconds; 0/undefined = no expiry
  /** Open the tab in its own window; defaults to true when windowBounds is set. Ignored for 'attached'. */
  newWindow?: boolean;
  /** Route onto an existing instance by id; excludes profile/headless. Required for 'attached'. */
  instance?: string;
  /** For isolation 'attached': wrap this existing target instead of creating one. */
  targetId?: string;
}

export interface SessionInfo {
  id: string; // "s_" + 6 hex
  isolation: Isolation;
  profile: string;
  headless: boolean;
  instanceId: string;
  targetId: string;
  browserContextId: string | null;
  url: string;
  createdAt: string; // ISO
  expiresAt: string | null; // ISO
}

export interface SessionUrls {
  /** Per-tab CDP websocket: hand to an agent that drives one tab. */
  cdp_ws: string;
  /** Instance-level HTTP base ("/json/version" etc.). */
  browser_http: string;
  /** Instance-level browser websocket (whole-browser control). */
  browser_ws: string;
  /** Hosted DevTools frontend (same-host relay) aimed at this tab — open in a browser. */
  devtools: string;
  /** OpenTab's clean human-control viewport for this tab — open in a browser. */
  live_view: string;
}

export interface SessionResponse extends SessionInfo {
  urls: SessionUrls;
}

/** A tab from GET /api/instances/:id/tabs, with control URLs; no session needed. */
export interface TabInfo {
  targetId: string;
  title: string;
  url: string;
  /** False for the user's own tabs on an adopted browser: OpenTab refuses to close those. */
  closable: boolean;
  urls: {
    cdp_ws: string;
    devtools: string;
    live_view: string;
  };
}

export interface CookieInfo {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; -1 for a session cookie (gone when the browser exits). */
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface InstanceInfo {
  id: string; // launched: `i_${profile}_${headless ? 'headless' : 'headful'}`; external: `x_${name}`
  profile: string;
  headless: boolean;
  pid: number | null; // null for adopted instances
  adopted: boolean;
  /** An adopted external browser (the user's real Chrome): never launched, stopped or closed by us. */
  external: boolean;
  state: 'running' | 'disconnected';
  cdpPort: number;
  browserWsPath: string; // "/devtools/browser/<uuid>"
  /** DevTools frontend revision hash parsed from /json/version WebKit-Version "@<hash>". */
  devtoolsHash: string;
  startedAt: string; // ISO
  sessionCount: number;
}

/** A flattened CDP page session multiplexed over one shared browser websocket. */
export interface PageSession {
  /** Feed one raw client CDP frame; ids are remapped and unsafe methods dropped. */
  fromClient(text: string): void;
  /** Upstream frames for this client, ids mapped back and the root sessionId stripped. */
  onMessage(cb: (text: string) => void): void;
  /** Fires when the target or the shared connection goes away; not on detach(). */
  onClose(cb: (code: number, reason: string) => void): void;
  /** Detach this session and free its routing state; never closes the shared connection. */
  detach(): void;
}

/** Promise-based CDP client over one browser-level websocket (cdp.ts). */
export interface CdpClient {
  /** Resolves with the command result; rejects with Error(message) on CDP error response. */
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  on(event: string, handler: (params: any) => void): void;
  onClose(handler: () => void): void;
  /** Attach a flattened page session for targetId; rejects if the attach fails or times out. */
  attachPageSession(targetId: string): Promise<PageSession>;
  close(): void;
}

export interface ChromeInstance extends InstanceInfo {
  cdp: CdpClient;
}

export interface InstanceManager {
  /** Launch or reuse the (profile, headless) instance; 409 if the profile is locked in the other mode. */
  ensure(profile: string, headless: boolean): Promise<ChromeInstance>;
  get(id: string): ChromeInstance | undefined;
  list(): ChromeInstance[];
  /** Adopt still-running instances from previous serve runs. Called once at boot. */
  adoptExisting(): Promise<void>;
  /** Adopt an external browser by name or userDataDir. Idempotent; errors say what to fix. */
  adoptExternal(name: string, userDataDir?: string): Promise<ChromeInstance>;
  stop(id: string): Promise<void>;
  disconnectAll(): Promise<void>;
  /** Handler is called with the instance id after an instance exits or crashes. */
  onExit(handler: (id: string) => void): void;
}

export interface SessionManager {
  create(req: CreateSessionRequest): Promise<SessionInfo>;
  get(id: string): SessionInfo | undefined;
  list(): SessionInfo[];
  destroy(id: string): Promise<void>;
  destroyAll(): Promise<void>;
  /** Start/stop the 30s reaper (TTL expiry, dead-target reconcile, idle instances). */
  startReaper(): void;
  stopReaper(): void;
}

/** Thrown by any layer; api.ts maps it to the HTTP response. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Auth {
  token: string;
  /** Constant-time comparison; false for undefined/empty/mismatched. */
  check(candidate: string | undefined): boolean;
}

/** Everything request handlers need; built once in server.ts. */
export interface AppContext {
  config: Config;
  auth: Auth;
  instances: InstanceManager;
  sessions: SessionManager;
  /** HTTP public base for URL construction, e.g. "https://mini.ts.net" (no trailing slash). */
  publicBase(req: import('node:http').IncomingMessage): string;
  /** Same but ws/wss scheme. */
  wsBase(req: import('node:http').IncomingMessage): string;
  version: string;
}
