// `serve` runs the server in-process; every other verb is an HTTP client of it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Command, CommanderError } from 'commander';
import type { Option } from 'commander';
import { loadConfig } from './config.ts';
import { rotateToken } from './auth.ts';
import type { Config, SessionResponse, InstanceInfo } from './types.ts';

const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function fail(msg: string): never {
  console.error(`opentab: ${msg}`);
  process.exit(1);
}

function int(name: string, v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) fail(`--${name} must be a non-negative integer`);
  return n;
}

function tokenPath(home: string): string {
  return join(home, 'token');
}

function readToken(home: string): string {
  try {
    return readFileSync(tokenPath(home), 'utf8').trim();
  } catch {
    fail(`no token at ${tokenPath(home)} — run \`opentab serve\` once to create it`);
  }
}

function isRefused(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string; errors?: { code?: string }[] } } | null)?.cause;
  if (!cause) return false;
  if (cause.code === 'ECONNREFUSED') return true;
  return Array.isArray(cause.errors) && cause.errors.some((e) => e?.code === 'ECONNREFUSED');
}

type ApiCall = (method: string, path: string, body?: unknown) => Promise<any>;

function client(): ApiCall {
  const config: Config = loadConfig();
  const token = readToken(config.home);
  const base = `http://127.0.0.1:${config.port}`;
  return async (method, path, body) => {
    let res: Response;
    try {
      res = await fetch(base + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (isRefused(err)) fail(`cannot reach ${base} — is \`opentab serve\` running?`);
      fail(`request to ${base} failed: ${(err as { cause?: Error })?.cause?.message ?? (err as Error).message}`);
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) fail(data?.error ?? `${res.status} ${res.statusText}`);
    return data;
  };
}

function table(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  console.log(line(headers));
  for (const r of rows) console.log(line(r));
}

function age(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function trunc(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

const TAILSCALE_BINS = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

function tailscaleDns(): string | null {
  for (const bin of TAILSCALE_BINS) {
    try {
      const out = execFileSync(bin, ['status', '--json'], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const status = JSON.parse(out);
      if (status?.BackendState && status.BackendState !== 'Running') return null;
      const dns: unknown = status?.Self?.DNSName;
      return typeof dns === 'string' && dns.length > 0 ? dns.replace(/\.$/, '') : null;
    } catch {
      continue;
    }
  }
  return null;
}

interface ServeOpts {
  port?: string;
  host?: string;
  headfulDefault?: boolean;
  cors?: boolean;
  windowBounds?: string;
}

async function cmdServe(opts: ServeOpts): Promise<void> {
  // Lazy so client verbs (token, ls, …) never load the server stack.
  const { startServer } = await import('./server.ts');
  const overrides: Partial<Config> = {};
  if (opts.port !== undefined) overrides.port = int('port', opts.port);
  if (opts.host !== undefined) overrides.host = opts.host;
  if (opts.headfulDefault) overrides.defaultHeadless = false;
  if (opts.windowBounds !== undefined) {
    const n = opts.windowBounds.split(',').map((s) => Number(s.trim()));
    if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) {
      fail('--window-bounds wants "left,top,width,height" (e.g. --window-bounds 2200,150,1000,700)');
    }
    overrides.windowBounds = { left: n[0], top: n[1], width: n[2], height: n[3] };
  }
  // --cors is permissive ("*"); a specific origin comes from config.json or OPENTAB_CORS_ORIGIN.
  if (opts.cors) overrides.corsOrigin = '*';
  const config: Config = loadConfig(overrides);
  const { ctx } = await startServer(config);
  const token = ctx.auth.token;
  const displayHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const base = `http://${displayHost}:${config.port}`;
  console.log(`opentab v${ctx.version} — listening on ${config.host}:${config.port}`);
  console.log('');
  console.log(`  api base:    ${base}  (Authorization: Bearer ${token})`);
  console.log(`  token base:  ${base}/t/${token}  (dashboard + proxy)`);
  const dns = tailscaleDns();
  if (dns) {
    console.log(`  tailnet:     https://${dns}/t/${token}`);
    console.log(`               shareable once \`tailscale serve\` is on — run: opentab tailscale`);
  }
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') {
    console.log('');
    console.log(
      `  WARNING: bound to ${config.host} — the token-gated API/proxy is reachable from the network, not just this machine`,
    );
  }
  console.log('');
}

function printUrls(s: SessionResponse): void {
  console.log('');
  console.log(`  agent ws (CDP):  ${s.urls.cdp_ws}`);
  console.log(`  browser url:     ${s.urls.browser_http}`);
  console.log(`  browser ws:      ${s.urls.browser_ws}  (puppeteer/axi/mcp wsEndpoint)`);
  console.log(`  human devtools:  ${s.urls.devtools}`);
  console.log('');
}

/** Default instance for tabs/expose: x_chrome if adopted, else the only one running. */
async function pickInstance(api: ApiCall): Promise<string> {
  const { instances } = (await api('GET', '/api/instances')) as { instances: InstanceInfo[] };
  const chrome = instances.find((i) => i.id === 'x_chrome');
  if (chrome) return chrome.id;
  if (instances.length === 1) return instances[0].id;
  if (instances.length === 0) {
    fail('no instances running — `opentab adopt` your Chrome or `opentab create` a session first');
  }
  fail(`several instances running — pass one of: ${instances.map((i) => i.id).join(', ')}`);
}

interface CreateOpts {
  isolation?: string;
  profile?: string;
  instance?: string;
  headful?: boolean;
  newWindow?: boolean;
  url?: string;
  ttl?: string;
}

async function cmdCreate(opts: CreateOpts): Promise<void> {
  const body: Record<string, unknown> = {};
  if (opts.isolation !== undefined) {
    const iso = opts.isolation;
    if (iso !== 'shared' && iso !== 'context' && iso !== 'profile') {
      fail(`--isolation must be shared, context or profile (got "${iso}")`);
    }
    body.isolation = iso;
  }
  if (opts.profile !== undefined) body.profile = opts.profile;
  if (opts.instance !== undefined) body.instance = opts.instance;
  if (opts.headful) body.headless = false;
  if (opts.newWindow) body.newWindow = true;
  if (opts.url !== undefined) body.url = opts.url;
  if (opts.ttl !== undefined) body.ttl = int('ttl', opts.ttl);
  const api = client();
  const s: SessionResponse = await api('POST', '/api/sessions', body);
  console.log(`created ${s.id}  (${s.isolation} · profile ${s.profile} · ${s.headless ? 'headless' : 'headful'})`);
  printUrls(s);
}

async function cmdAdopt(name?: string): Promise<void> {
  const api = client();
  const body: Record<string, unknown> = {};
  if (name !== undefined) body.name = name;
  const inst: InstanceInfo = await api('POST', '/api/adopt', body);
  console.log(`adopted ${inst.id}  (external · ${inst.state})`);
  console.log('');
  console.log(`  list tabs:      opentab tabs ${inst.id}`);
  console.log(`  expose a tab:   opentab expose <targetId> --instance ${inst.id}`);
  console.log(`  new real tab:   opentab create --instance ${inst.id} --isolation shared`);
  console.log('');
}

async function cmdTabs(instanceId?: string): Promise<void> {
  const api = client();
  const id = instanceId ?? (await pickInstance(api));
  const { tabs } = (await api('GET', `/api/instances/${id}/tabs`)) as {
    tabs: { targetId: string; title: string; url: string }[];
  };
  if (tabs.length === 0) {
    console.log(`no open tabs on ${id}`);
    return;
  }
  table(
    ['TARGET ID', 'TITLE', 'URL'],
    tabs.map((tab) => [tab.targetId, trunc(tab.title || '(untitled)', 40), trunc(tab.url, 60)]),
  );
}

async function cmdExpose(targetId: string, opts: { instance?: string; ttl?: string }): Promise<void> {
  const ttl = opts.ttl === undefined ? undefined : int('ttl', opts.ttl);
  const api = client();
  const instance = opts.instance ?? (await pickInstance(api));
  const body: Record<string, unknown> = { isolation: 'attached', instance, targetId };
  if (ttl !== undefined) body.ttl = ttl;
  const s: SessionResponse = await api('POST', '/api/sessions', body);
  console.log(`exposed ${s.targetId} as ${s.id}  (attached · ${s.instanceId} · destroying never closes the tab)`);
  printUrls(s);
}

async function cmdLs(): Promise<void> {
  const api = client();
  const { sessions } = (await api('GET', '/api/sessions')) as { sessions: SessionResponse[] };
  if (sessions.length === 0) {
    console.log('no sessions — create one with `opentab create`');
    return;
  }
  table(
    ['ID', 'ISOLATION', 'PROFILE', 'HEADLESS', 'URL', 'AGE'],
    sessions.map((s) => [s.id, s.isolation, s.profile, s.headless ? 'yes' : 'no', trunc(s.url, 60), age(s.createdAt)]),
  );
}

async function cmdRm(target: string): Promise<void> {
  const api = client();
  if (target === 'all') {
    const { sessions } = (await api('GET', '/api/sessions')) as { sessions: SessionResponse[] };
    for (const s of sessions) await api('DELETE', `/api/sessions/${s.id}`);
    console.log(`demolished ${sessions.length} session${sessions.length === 1 ? '' : 's'}`);
  } else {
    await api('DELETE', `/api/sessions/${target}`);
    console.log(`demolished ${target}`);
  }
}

async function cmdUrl(id: string, opts: { devtools?: boolean; ws?: boolean; browser?: boolean }): Promise<void> {
  const picked = [opts.devtools, opts.ws, opts.browser].filter(Boolean);
  if (picked.length > 1) fail('pass at most one of --devtools, --ws, --browser');
  const api = client();
  const s: SessionResponse = await api('GET', `/api/sessions/${id}`);
  if (opts.devtools) console.log(s.urls.devtools);
  else if (opts.browser) console.log(s.urls.browser_http);
  else console.log(s.urls.cdp_ws);
}

async function cmdInstances(): Promise<void> {
  const api = client();
  const { instances } = (await api('GET', '/api/instances')) as { instances: InstanceInfo[] };
  if (instances.length === 0) {
    console.log('no chrome instances running');
    return;
  }
  table(
    ['ID', 'PROFILE', 'MODE', 'STATE', 'PID', 'SESSIONS', 'CDP PORT', 'AGE'],
    instances.map((i) => [
      i.id,
      i.profile,
      i.headless ? 'headless' : 'headful',
      i.state ?? 'running',
      i.external ? 'external' : i.pid === null ? 'adopted' : String(i.pid),
      String(i.sessionCount),
      String(i.cdpPort),
      age(i.startedAt),
    ]),
  );
}

async function cmdInstancesStop(id: string): Promise<void> {
  const api = client();
  await api('DELETE', `/api/instances/${id}`);
  console.log(`stopped ${id}`);
}

function cmdToken(opts: { rotate?: boolean }): void {
  const config: Config = loadConfig();
  if (opts.rotate) {
    console.log(rotateToken(config));
    console.error('token rotated — restart `opentab serve` to apply it');
  } else {
    console.log(readToken(config.home));
  }
}

function cmdTailscale(opts: { run?: boolean }): void {
  const config: Config = loadConfig();
  const args = ['serve', '--bg', '--https=443', `http://127.0.0.1:${config.port}`];
  console.log(`tailscale ${args.join(' ')}`);
  if (!opts.run) {
    console.log('');
    console.log('run it now with: opentab tailscale --run');
    return;
  }
  let ran = false;
  for (const bin of TAILSCALE_BINS) {
    try {
      execFileSync(bin, args, { stdio: 'inherit' });
      ran = true;
      break;
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') continue;
      fail(`tailscale serve failed (${(err as Error).message})`);
    }
  }
  if (!ran) fail('tailscale CLI not found — install Tailscale first');
  const dns = tailscaleDns();
  if (dns) {
    console.log('');
    console.log(`serving — share: https://${dns}/t/${readToken(config.home)}`);
  }
}

/** Parse-error texts are a CLI contract; Commander's defaults are replaced here. */
class OpentabCommand extends Command {
  createCommand(name?: string): OpentabCommand {
    return new OpentabCommand(name);
  }
  usageLine(): string {
    return this.createHelp().commandUsage(this);
  }
  unknownOption(flag: string): never {
    const eq = flag.indexOf('=');
    const name = eq === -1 ? flag : flag.slice(0, eq);
    if (eq !== -1 && this.options.some((o) => o.long === name)) this.error(`${name} takes no value`);
    this.error(`unknown flag ${name}\n\n${this.helpInformation({ error: true })}`);
  }
  unknownCommand(verb: string = this.args[0]): never {
    this.error(`unknown command "${verb}"\n\n${this.helpInformation({ error: true })}`);
  }
  _excessArguments(received: string[]): never {
    this.error(`unexpected argument: ${received[this.registeredArguments.length]}\n\n${this.helpInformation({ error: true })}`);
  }
  missingArgument(): never {
    this.error(`usage: ${this.usageLine()}`);
  }
  optionMissingArgument(option: Option): never {
    this.error(`${option.long} requires a value`);
  }
}

function buildProgram(): OpentabCommand {
  const program = new OpentabCommand('opentab')
    .description('personal browser server (Chrome over CDP, for agents and humans)')
    .usage('<verb> [options]')
    .version(VERSION, '-v, --version', 'print the version')
    .enablePositionalOptions()
    .configureOutput({ outputError: (str, write) => write(`opentab: ${str}`) })
    .exitOverride()
    .addHelpText('after', '\nRun `opentab <verb> --help` for flags and examples.');

  // Commander only treats null as a missing positional; '' (`rm "$UNSET"`) must fail the same way.
  program.hook('preAction', (_root, cmd) => {
    cmd.registeredArguments.forEach((a, i) => {
      if (a.required && cmd.args[i] === '') (cmd as OpentabCommand).missingArgument();
    });
  });

  program
    .command('serve')
    .summary('run the server in the foreground')
    .option('--port <n>', 'listen port (default: config.json / OPENTAB_PORT / 9333)')
    .option('--host <host>', 'bind address (default: 127.0.0.1)')
    .option('--headful-default', 'new sessions get a window unless they ask for headless')
    .option('--cors', 'allow any origin on /api (Access-Control-Allow-Origin: *)')
    .option('--window-bounds <left,top,width,height>', 'park session windows on this screen region (e.g. a virtual display)')
    .addHelpText('after', '\nExamples:\n  opentab serve\n  opentab serve --port 9444 --window-bounds 2200,150,1000,700')
    .action(cmdServe);

  program
    .command('create')
    .summary('open a tab in a new session and print its URLs')
    .option('--isolation <mode>', 'shared, context (default) or profile')
    .option('--profile <name>', 'Chrome profile to use (default "default")')
    .option('--instance <id>', 'open on an existing instance (see `opentab instances`)')
    .option('--headful', 'open a real window instead of headless')
    .option('--new-window', 'open the tab in its own window')
    .option('--url <url>', 'navigate to URL (default about:blank)')
    .option('--ttl <seconds>', 'destroy the session after SECONDS (server default 48h; 0 = never)')
    .addHelpText(
      'after',
      '\nExamples:\n  opentab create\n  opentab create --instance x_chrome --isolation shared --url https://example.com',
    )
    .action(cmdCreate);

  program
    .command('adopt')
    .summary('adopt your real Chrome (default "chrome")')
    .usage('[name]')
    .argument('[name]', 'external browser name (default "chrome")')
    .action(cmdAdopt);

  program
    .command('tabs')
    .summary('list open tabs with their target ids')
    .usage('[instance-id]')
    .argument('[instance-id]', 'default: x_chrome, else the only instance running')
    .action(cmdTabs);

  program
    .command('expose')
    .summary('wrap an existing tab in an attached session')
    .usage('<targetId> [--instance ID] [--ttl SECONDS]')
    .argument('<targetId>', 'target id from `opentab tabs`')
    .option('--instance <id>', 'instance owning the tab (default: x_chrome, else the only one running)')
    .option('--ttl <seconds>', 'release the tab after SECONDS (server default 48h; 0 = never)')
    .addHelpText('after', '\nExamples:\n  opentab expose 0F5C10FA22B8D3E7A9C4415F6B208D91 --ttl 3600')
    .action(cmdExpose);

  program.command('ls').summary('list sessions').action(cmdLs);

  program
    .command('rm')
    .summary('destroy a session, or all of them')
    .usage('<session-id|all>')
    .argument('<session-id|all>', 'session id, or "all"')
    .action(cmdRm);

  program
    .command('url')
    .summary('print one URL of a session, for $(…) use')
    .usage('<session-id> [--devtools|--ws|--browser]')
    .argument('<session-id>')
    .option('--devtools', 'hosted DevTools URL')
    .option('--ws', 'per-tab CDP websocket (the default)')
    .option('--browser', 'instance-level HTTP base')
    .addHelpText('after', '\nExamples:\n  $(opentab url s_a1b2c3)\n  $(opentab url s_a1b2c3 --browser)')
    .action(cmdUrl);

  const instances = program
    .command('instances')
    .summary('list Chrome instances (or: instances stop <id>)')
    .usage('[stop <id>]')
    .action(cmdInstances);
  instances
    .command('stop')
    .summary('stop a Chrome instance')
    .usage('<id>')
    .argument('<id>', 'instance id from `opentab instances`')
    .action(cmdInstancesStop);

  program
    .command('token')
    .summary('print the API token (--rotate replaces it)')
    .usage('[--rotate]')
    .option('--rotate', 'write a fresh token; restart `opentab serve` to apply it')
    .action(cmdToken);

  program
    .command('tailscale')
    .summary('print (or --run) the tailscale serve command')
    .usage('[--run]')
    .option('--run', 'run it now')
    .action(cmdTailscale);

  program
    .command('help')
    .summary('show help for a verb')
    .usage('[verb]')
    .argument('[verb]')
    .action((verb?: string) => (program.commands.find((c) => c.name() === verb) ?? program).help());

  return program;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const program = buildProgram();
  if (argv.length === 0) return program.outputHelp();
  try {
    // Reject an unknown verb before Commander can honour a trailing -v/-h (`bogus -v` must fail).
    const verb = argv[0];
    if ((verb === '--' || !verb.startsWith('-')) && !program.commands.some((c) => c.name() === verb)) {
      program.unknownCommand(verb);
    }
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (!(err instanceof CommanderError)) throw err;
    process.exitCode = err.exitCode;
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
