// Spawns the CLI with a scratch OPENTAB_HOME and no server: help, parse errors and exit codes are a contract.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version: string = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const VERBS = ['serve', 'create', 'adopt', 'tabs', 'expose', 'ls', 'rm', 'url', 'instances', 'token', 'tailscale', 'help'];
const ROOT_USAGE = 'Usage: opentab <verb> [options]';

const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('OPENTAB_')));

const homes: string[] = [];
function freshHome(): string {
  const h = mkdtempSync(join(tmpdir(), 'opentab-cli-'));
  homes.push(h);
  return h;
}
after(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

const sharedHome = freshHome();

function run(args: string[], env: { home?: string; port?: string } = {}) {
  const r = spawnSync(process.execPath, ['src/cli.ts', ...args], {
    cwd: root,
    env: { ...baseEnv, OPENTAB_HOME: env.home ?? sharedHome, OPENTAB_PORT: env.port ?? '1' },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function expectLine(args: string[], msg: string, env?: { home?: string; port?: string }): void {
  const r = run(args, env);
  const label = args.join(' ');
  assert.equal(r.status, 1, label);
  assert.equal(r.stdout, '', label);
  assert.equal(r.stderr, `opentab: ${msg}\n`, label);
}

function expectHelpError(args: string[], first: string, usage: string): void {
  const r = run(args);
  const label = args.join(' ');
  const lines = r.stderr.split('\n');
  assert.equal(r.status, 1, label);
  assert.equal(r.stdout, '', label);
  assert.equal(lines[0], `opentab: ${first}`, label);
  assert.equal(lines[1], '', label);
  assert.equal(lines[2], usage, label);
  assert.ok(r.stderr.endsWith('\n\n'), `${label}: trailing blank line`);
}

test('cli: bare invocation prints root help with every verb, exit 0', () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.ok(r.stdout.startsWith(`${ROOT_USAGE}\n`));
  for (const verb of VERBS) assert.match(r.stdout, new RegExp(`^  ${verb}\\b`, 'm'), verb);
  assert.ok(r.stdout.endsWith('\nRun `opentab <verb> --help` for flags and examples.\n'));
});

test('cli: help, -h and --help print root help on stdout whatever follows', () => {
  for (const args of [['help'], ['-h'], ['--help'], ['--help', '--bogus'], ['-h', 'serve'], ['help', 'bogus']]) {
    const r = run(args);
    assert.equal(r.status, 0, args.join(' '));
    assert.equal(r.stderr, '', args.join(' '));
    assert.ok(r.stdout.startsWith(`${ROOT_USAGE}\n`), args.join(' '));
  }
});

test('cli: -v and --version print the bare package.json version', () => {
  for (const args of [['-v'], ['--version'], ['-v', 'extra']]) {
    const r = run(args);
    assert.equal(r.status, 0, args.join(' '));
    assert.equal(r.stdout, `${version}\n`);
    assert.equal(r.stderr, '');
  }
});

test('cli: help and version touch nothing under OPENTAB_HOME', () => {
  const home = freshHome();
  run(['-h'], { home });
  run(['-v'], { home });
  run(['help', 'create'], { home });
  assert.deepEqual(readdirSync(home), []);
});

test('cli: per-verb help via --help, -h and help <verb>', () => {
  const cases: [string[], string][] = [
    [['ls', '--help'], 'Usage: opentab ls [options]'],
    [['create', '-h'], 'Usage: opentab create [options]'],
    [['help', 'create'], 'Usage: opentab create [options]'],
    [['url', '-h'], 'Usage: opentab url <session-id> [--devtools|--ws|--browser]'],
    [['instances', '--help'], 'Usage: opentab instances [stop <id>]'],
    [['instances', 'stop', '--help'], 'Usage: opentab instances stop <id>'],
    [['expose', '--help'], 'Usage: opentab expose <targetId> [--instance ID] [--ttl SECONDS]'],
  ];
  for (const [args, usage] of cases) {
    const r = run(args);
    assert.equal(r.status, 0, args.join(' '));
    assert.equal(r.stderr, '', args.join(' '));
    assert.ok(r.stdout.startsWith(`${usage}\n`), `${args.join(' ')}: ${r.stdout.split('\n')[0]}`);
  }
  assert.match(run(['create', '--help']).stdout, /\nExamples:\n {2}opentab create\n/);
});

test('cli: unknown command appends root help, even with a trailing -v or -h', () => {
  expectHelpError(['bogus'], 'unknown command "bogus"', ROOT_USAGE);
  expectHelpError([''], 'unknown command ""', ROOT_USAGE);
  expectHelpError(['--'], 'unknown command "--"', ROOT_USAGE);
  for (const flag of ['-v', '--version', '-h', '--help']) {
    expectHelpError(['bogus', flag], 'unknown command "bogus"', ROOT_USAGE);
  }
});

test('cli: unknown flag appends the erroring command help', () => {
  expectHelpError(['ls', '--bogus'], 'unknown flag --bogus', 'Usage: opentab ls [options]');
  expectHelpError(['ls', '--bogus=1'], 'unknown flag --bogus', 'Usage: opentab ls [options]');
  expectHelpError(['ls', '-v'], 'unknown flag -v', 'Usage: opentab ls [options]');
  expectHelpError(['create', '-x'], 'unknown flag -x', 'Usage: opentab create [options]');
  expectHelpError(['ls', 'extra', '--bogus'], 'unknown flag --bogus', 'Usage: opentab ls [options]');
  expectHelpError(['--port', '1', 'serve'], 'unknown flag --port', ROOT_USAGE);
  expectHelpError(['help', '--bogus'], 'unknown flag --bogus', 'Usage: opentab help [verb]');
});

test('cli: unexpected positional appends the erroring command help', () => {
  expectHelpError(['ls', 'extra'], 'unexpected argument: extra', 'Usage: opentab ls [options]');
  expectHelpError(['adopt', 'a', 'b'], 'unexpected argument: b', 'Usage: opentab adopt [name]');
  expectHelpError(['expose', 'a', 'b'], 'unexpected argument: b', 'Usage: opentab expose <targetId> [--instance ID] [--ttl SECONDS]');
  expectHelpError(['instances', 'foo'], 'unexpected argument: foo', 'Usage: opentab instances [stop <id>]');
  expectHelpError(['instances', 'stop', 'a', 'b'], 'unexpected argument: b', 'Usage: opentab instances stop <id>');
  expectHelpError(['create', '--url', '--ttl', '5'], 'unexpected argument: 5', 'Usage: opentab create [options]');
  expectHelpError(['help', 'a', 'b'], 'unexpected argument: b', 'Usage: opentab help [verb]');
});

test('cli: boolean flags reject values, value flags need one', () => {
  expectLine(['create', '--headful=yes'], '--headful takes no value');
  expectLine(['token', '--rotate=1'], '--rotate takes no value');
  expectLine(['create', '--ttl'], '--ttl requires a value');
  expectLine(['expose', 'T', '--instance'], '--instance requires a value');
});

test('cli: numeric, isolation and window-bounds validation', () => {
  expectLine(['create', '--ttl', '1.5'], '--ttl must be a non-negative integer');
  expectLine(['create', '--ttl', '-1'], '--ttl must be a non-negative integer');
  expectLine(['create', '--ttl', '1', '--ttl', 'abc'], '--ttl must be a non-negative integer');
  expectLine(['expose', 'T', '--ttl', 'abc'], '--ttl must be a non-negative integer');
  expectLine(['create', '--isolation', 'attached'], '--isolation must be shared, context or profile (got "attached")');
  expectLine(['serve', '--port', 'abc'], '--port must be a non-negative integer');
  expectLine(
    ['serve', '--window-bounds', '1,2'],
    '--window-bounds wants "left,top,width,height" (e.g. --window-bounds 2200,150,1000,700)',
  );
});

test('cli: missing required positional prints the usage line only', () => {
  expectLine(['expose'], 'usage: opentab expose <targetId> [--instance ID] [--ttl SECONDS]');
  expectLine(['rm'], 'usage: opentab rm <session-id|all>');
  expectLine(['url'], 'usage: opentab url <session-id> [--devtools|--ws|--browser]');
  expectLine(['instances', 'stop'], 'usage: opentab instances stop <id>');
});

test('cli: an empty positional counts as missing, before the token read', () => {
  const home = freshHome();
  expectLine(['expose', ''], 'usage: opentab expose <targetId> [--instance ID] [--ttl SECONDS]', { home });
  expectLine(['rm', ''], 'usage: opentab rm <session-id|all>', { home });
  expectLine(['url', '', '--devtools'], 'usage: opentab url <session-id> [--devtools|--ws|--browser]', { home });
  expectLine(['instances', 'stop', ''], 'usage: opentab instances stop <id>', { home });
});

test('cli: url accepts at most one selector flag', () => {
  expectLine(['url', 's_1', '--devtools', '--ws'], 'pass at most one of --devtools, --ws, --browser');
});

test('cli: client verbs fail on a missing token before any request', () => {
  const home = freshHome();
  const msg = `no token at ${join(home, 'token')} — run \`opentab serve\` once to create it`;
  expectLine(['ls'], msg, { home });
  expectLine(['create', '--ttl='], msg, { home });
  expectLine(['create', '--ttl', 'abc', '--ttl', '1'], msg, { home });
  expectLine(['create', '--'], msg, { home });
  expectLine(['url', '--devtools', 's_1'], msg, { home });
  expectLine(['token'], msg, { home });
});

test('cli: loadConfig errors surface as one line', () => {
  expectLine(['ls'], 'invalid OPENTAB_PORT: abc', { port: 'abc' });
});

test('cli: token --rotate writes and prints a new token, then token reads it back', () => {
  const home = freshHome();
  const r = run(['token', '--rotate'], { home });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^[0-9a-f]{32}\n$/);
  assert.equal(r.stderr, 'token rotated — restart `opentab serve` to apply it\n');
  const again = run(['token'], { home });
  assert.equal(again.status, 0);
  assert.equal(again.stdout, r.stdout);
  assert.equal(again.stderr, '');
});

test('cli: tailscale without --run only prints the command', () => {
  const r = run(['tailscale'], { port: '9333' });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, 'tailscale serve --bg --https=443 http://127.0.0.1:9333\n\nrun it now with: opentab tailscale --run\n');
});
