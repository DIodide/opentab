import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './types.ts';

// 10 years; keeps now + ttl a representable Date so toISOString() can't throw.
export const MAX_TTL = 10 * 365 * 24 * 3600;

const DEFAULTS: Omit<Config, 'home' | 'profilesDir' | 'externalBrowsers'> = {
  port: 9333,
  host: '127.0.0.1',
  publicUrl: null,
  chromePath: null,
  defaultHeadless: true,
  stealth: true,
  // 0 = never: idle-reaping a logged-in profile reads as a surprise logout.
  stopIdleInstancesAfter: 0,
  defaultTtl: 48 * 3600,
  extraChromeArgs: [],
  autoAdopt: [],
  windowBounds: null,
  corsOrigin: null,
};

/** Parse "left,top,width,height" (env) into WindowBounds; throws on malformed input. */
function parseWindowBounds(raw: string): Config['windowBounds'] {
  const n = raw.split(',').map((s) => Number(s.trim()));
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) {
    throw new Error(`invalid OPENTAB_WINDOW_BOUNDS: ${raw} (want "left,top,width,height")`);
  }
  return { left: n[0], top: n[1], width: n[2], height: n[3] };
}

/** Built-in adoptable browsers (fresh objects per call; user entries merge by name). */
function builtinExternalBrowsers(): Config['externalBrowsers'] {
  return {
    chrome: { userDataDir: join(homedir(), 'Library/Application Support/Google/Chrome') },
  };
}

function defined<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

/** defaults ← ~/.opentab/config.json ← env ← explicit overrides. */
export function loadConfig(overrides: Partial<Config> = {}): Config {
  const home = overrides.home ?? process.env.OPENTAB_HOME ?? join(homedir(), '.opentab');

  let fileCfg: Partial<Config> = {};
  const cfgPath = join(home, 'config.json');
  if (existsSync(cfgPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(cfgPath, 'utf8'));
    } catch (err) {
      throw new Error(`invalid JSON in ${cfgPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${cfgPath} must contain a JSON object`);
    }
    fileCfg = parsed as Partial<Config>;
    // home/profilesDir are resolved before the file can be found; never from it.
    delete (fileCfg as Record<string, unknown>).home;
    delete (fileCfg as Record<string, unknown>).profilesDir;
  }

  const env: Partial<Config> = {};
  if (process.env.OPENTAB_PORT) {
    const port = Number(process.env.OPENTAB_PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`invalid OPENTAB_PORT: ${process.env.OPENTAB_PORT}`);
    }
    env.port = port;
  }
  if (process.env.OPENTAB_DEFAULT_TTL) {
    const ttl = Number(process.env.OPENTAB_DEFAULT_TTL);
    if (!Number.isInteger(ttl) || ttl < 0 || ttl > MAX_TTL) {
      throw new Error(`invalid OPENTAB_DEFAULT_TTL: ${process.env.OPENTAB_DEFAULT_TTL}`);
    }
    env.defaultTtl = ttl;
  }
  if (process.env.OPENTAB_STEALTH !== undefined) {
    env.stealth = !/^(0|false|no|off)$/i.test(process.env.OPENTAB_STEALTH);
  }
  if (process.env.OPENTAB_HOST) env.host = process.env.OPENTAB_HOST;
  if (process.env.OPENTAB_PUBLIC_URL) env.publicUrl = process.env.OPENTAB_PUBLIC_URL;
  if (process.env.OPENTAB_CHROME_PATH) env.chromePath = process.env.OPENTAB_CHROME_PATH;
  if (process.env.OPENTAB_WINDOW_BOUNDS) env.windowBounds = parseWindowBounds(process.env.OPENTAB_WINDOW_BOUNDS);
  if (process.env.OPENTAB_CORS_ORIGIN) env.corsOrigin = process.env.OPENTAB_CORS_ORIGIN;

  const merged = { ...DEFAULTS, ...defined(fileCfg), ...env, ...defined(overrides) };
  const config: Config = {
    ...merged,
    // Merged by name: a user "chrome" entry replaces the built-in; other names are added.
    externalBrowsers: {
      ...builtinExternalBrowsers(),
      ...fileCfg.externalBrowsers,
      ...overrides.externalBrowsers,
    },
    home,
    profilesDir: overrides.profilesDir ?? join(home, 'profiles'),
  };
  mkdirSync(config.home, { recursive: true });
  mkdirSync(config.profilesDir, { recursive: true });
  return config;
}
