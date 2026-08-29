import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Auth, Config } from './types.ts';

function tokenPath(config: Config): string {
  return join(config.home, 'token');
}

function writeToken(config: Config): string {
  const token = randomBytes(16).toString('hex');
  const path = tokenPath(config);
  writeFileSync(path, token + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

function makeAuth(token: string): Auth {
  const expected = Buffer.from(token);
  return {
    token,
    check(candidate: string | undefined): boolean {
      if (!candidate) return false;
      const got = Buffer.from(candidate);
      if (got.length !== expected.length) return false;
      return timingSafeEqual(got, expected);
    },
  };
}

/** Read the token at `${home}/token`, creating it (chmod 600) on first run. */
export function loadAuth(config: Config): Auth {
  let token = '';
  try {
    token = readFileSync(tokenPath(config), 'utf8').trim();
  } catch {
    // missing: create below
  }
  if (!token) token = writeToken(config);
  return makeAuth(token);
}

/** Replace the token file with a fresh secret; returns the new token. */
export function rotateToken(config: Config): string {
  return writeToken(config);
}
