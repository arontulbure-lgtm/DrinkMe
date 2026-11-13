#!/usr/bin/env node
// npm run test:ios — one command for a device test session with Expo Go over the LAN.
// See docs/IOS_TEST_SESSION.md.
//
//   1. Preflight (✓/✗, never a secret value): Node version, ports 5000 and 8081, server/.env with
//      NODE_ENV=development, the Firebase service account, the EXPO_PUBLIC_FIREBASE_* names, the LAN IPv4.
//   2. logs/sessions/<timestamp>/ (git-ignored) with server.log, client.jsonl (the app's dev log bridge),
//      metro.log (only with --capture-metro), live-issues.txt and session.json.
//   3. The API server (NODE_ENV=development, DEV_SESSION_DIR=<session folder>), mirrored to the console.
//   4. Expo with --lan and EXPO_PUBLIC_API_URL=http://<LAN IP>:5000 in its own environment only
//      (.env is never edited). By default Expo keeps the terminal, so its QR code and keys (r, j, ?) work;
//      Metro's output is then not captured (Expo hides its QR code when its output is piped), and app
//      errors arrive through client.jsonl. --capture-metro pipes Metro to metro.log too and prints the QR
//      code from this script, without Expo's keys.
//   5. A live watcher prints "NEW ISSUE #n [source] message (screen)" for each new error/warning signature.
//   6. Ctrl+C (or quitting Expo) stops everything and prints the session folder.
//
// Options: --capture-metro, --ip <IPv4> (override the detected address), --preflight (checks only), --help.
// No dependencies beyond Node itself and the project's own expo package.
/* global Buffer, setInterval, clearInterval, setTimeout */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(ROOT, 'server');
const API_PORT = 5000;
const METRO_PORT = 8081;
const MIN_NODE_MAJOR = 20;
const FIREBASE_CLIENT_NAMES = ['API_KEY', 'AUTH_DOMAIN', 'PROJECT_ID', 'STORAGE_BUCKET', 'MESSAGING_SENDER_ID', 'APP_ID']
  .map((suffix) => `EXPO_PUBLIC_FIREBASE_${suffix}`);
// Expo reads these, in this order; a later file never overrides a name set earlier or in the shell.
const CLIENT_ENV_FILES = ['.env.development.local', '.env.local', '.env.development', '.env'];
const CLIENT_POLL_MS = 1000;
const STOP_TIMEOUT_MS = 5000;

// ── Output helpers ────────────────────────────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (text) => paint('32', text);
const red = (text) => paint('31', text);
const yellow = (text) => paint('33', text);
const bold = (text) => paint('1', text);
const dim = (text) => paint('2', text);
const ANSI =/\u001b\[[0-9;?]*[A-Za-z]/g;
export const stripAnsi = (text) => text.replace(ANSI, '');

// ── .env reading: names and comparisons only, values are never returned or printed ─────────────
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const unquote = (raw) => {
  const value = raw.trim();
  const quote = value[0];
  if ((quote === '"' || quote === '\'' || quote === '`') && value.indexOf(quote, 1) > 0) {
    return value.slice(1, value.indexOf(quote, 1));
  }
  return value.replace(/\s+#.*$/, '').trim();
};

/**
 * Reads a dotenv file and returns checks over it. Nothing it returns contains a value.
 * @returns {{ exists: boolean, isSet: (name: string) => boolean, equals: (name: string, expected: string) => boolean,
 *   valueKind: (name: string) => 'unset' | 'inline-json' | 'text' }}
 */
export function readEnvFile(file) {
  const values = new Map();
  const exists = fs.existsSync(file);
  if (exists) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = ENV_LINE.exec(line);
      if (match && !values.has(match[1])) values.set(match[1], unquote(match[2]));
    }
  }
  return {
    exists,
    isSet: (name) => Boolean(values.get(name)),
    equals: (name, expected) => values.get(name) === expected,
    valueKind: (name) => {
      const value = values.get(name);
      if (!value) return 'unset';
      return value.startsWith('{') ? 'inline-json' : 'text';
    },
    // Only for a setting that holds a file path; the caller checks the file exists and never prints it.
    resolvePath: (name, baseDir) => {
      const value = values.get(name);
      return value && !value.startsWith('{') ? path.resolve(baseDir, value) : null;
    },
  };
}

// ── LAN address ───────────────────────────────────────────────────────────────
const isPrivateIpv4 = (address) => (
  /^10\./.test(address) || /^192\.168\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address)
);
const VIRTUAL_ADAPTER = /vethernet|virtual|vmware|virtualbox|vbox|hyper-v|wsl|docker|loopback|bluetooth|tailscale|zerotier|vpn|hamachi|npcap|tap-|tun/i;

/** IPv4 candidates for the phone to reach, best first: private, Wi-Fi before Ethernet, virtual adapters last. */
export function rankLanAddresses(interfaces = os.networkInterfaces()) {
  const candidates = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const item of addresses ?? []) {
      const isIpv4 = item.family === 'IPv4' || item.family === 4;
      if (!isIpv4 || item.internal || item.address.startsWith('169.254.')) continue;
      let score = isPrivateIpv4(item.address) ? 10 : 0;
      if (/wi-?fi|wlan|wireless/i.test(name)) score += 3;
      else if (/ethernet|^eth|^en\d/i.test(name)) score += 2;
      if (VIRTUAL_ADAPTER.test(name)) score -= 20;
      candidates.push({ name, address: item.address, score });
    }
  }
  return candidates.sort((a, b) => b.score - a.score);
}

const isPortFree = (port) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.once('listening', () => probe.close(() => resolve(true)));
  probe.listen(port, '0.0.0.0');
});

// ── Preflight ─────────────────────────────────────────────────────────────────
export async function runPreflight({ ipOverride } = {}) {
  const results = [];
  const check = (ok, label, hint) => results.push({ ok, label, hint });

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  check(nodeMajor >= MIN_NODE_MAJOR, `Node ${process.versions.node} (need ${MIN_NODE_MAJOR}+)`, 'Install Node 22 LTS from nodejs.org.');

  for (const [port, what] of [[API_PORT, 'API server'], [METRO_PORT, 'Metro']]) {
    check(await isPortFree(port), `Port ${port} free (${what})`,
      `Something already listens on ${port}: close the old server/Expo window, or find it with: Get-NetTCPConnection -LocalPort ${port} | Select OwningProcess`);
  }

  const serverEnv = readEnvFile(path.join(SERVER_DIR, '.env'));
  check(serverEnv.exists, 'server/.env exists', 'Create server/.env (see server/README.md).');
  check(serverEnv.equals('NODE_ENV', 'development'), 'server/.env has NODE_ENV=development',
    'Set NODE_ENV=development in server/.env: other values apply production rules and turn the app log bridge off.');

  const keyKind = serverEnv.valueKind('FIREBASE_SERVICE_ACCOUNT_KEY');
  const keyPath = serverEnv.resolvePath('FIREBASE_SERVICE_ACCOUNT_KEY', SERVER_DIR);
  const hasServiceAccount = keyKind === 'inline-json'
    || (keyPath ? fs.existsSync(keyPath) : fs.existsSync(path.join(SERVER_DIR, 'serviceAccount.json')));
  check(hasServiceAccount && keyKind !== 'unset', 'Firebase service account found (FIREBASE_SERVICE_ACCOUNT_KEY)',
    'Put the Firebase Admin key at server/serviceAccount.json and set FIREBASE_SERVICE_ACCOUNT_KEY=./serviceAccount.json in server/.env. Without it sign-in answers 503.');

  const clientEnvFiles = CLIENT_ENV_FILES.map((name) => readEnvFile(path.join(ROOT, name)));
  for (const name of FIREBASE_CLIENT_NAMES) {
    const isSet = Boolean(process.env[name]) || clientEnvFiles.some((file) => file.isSet(name));
    check(isSet, `${name} is set`, 'Add it to .env in the project root (values from the Firebase console, Project settings).');
  }

  const ranked = rankLanAddresses();
  const lanIp = ipOverride || ranked[0]?.address;
  const ipIsValid = Boolean(lanIp) && net.isIPv4(lanIp);
  const others = ranked.filter((item) => item.address !== lanIp).map((item) => `${item.address} (${item.name})`);
  check(ipIsValid, ipIsValid
    ? `LAN IPv4: ${lanIp}${ipOverride ? ' (from --ip)' : ` (${ranked[0].name})`}${others.length ? dim(`  other: ${others.join(', ')}`) : ''}`
    : 'LAN IPv4 found', 'Connect the PC to the same Wi-Fi as the iPhone, or pass --ip <address>.');

  return { results, ok: results.every((item) => item.ok), lanIp: ipIsValid ? lanIp : null };
}

const printPreflight = ({ results }) => {
  console.log(bold('\nPreflight'));
  for (const { ok, label, hint } of results) {
    console.log(`  ${ok ? green('✓') : red('✗')} ${label}`);
    if (!ok && hint) console.log(`      ${dim(hint)}`);
  }
};

// ── Issue signatures ─────────────────────────────────────────────────────────
/** A message reduced to what stays the same between repeats of one problem. */
export function signatureOf(message) {
  return stripAnsi(String(message))
    .split('\n')[0]
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<time>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/(["'`]).*?\1/g, '"…"')
    .replace(/\/[\w-]{20,}(?=\/|\b)/g, '/:id')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

const SERVER_REQUEST_LINE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\S+) (\d{3}) /;
const PROBLEM_WORDS = /\b(error|exception|fatal|unhandled|uncaught|warn(ing)?|refus\w*|failed|cannot|could not|EADDRINUSE|ECONNREFUSED)\b|⚠|❌|TypeError|ReferenceError|SyntaxError|RangeError/i;

/** A server or Metro log line that is a problem, or null. */
export function classifyLogLine(source, rawLine) {
  const line = stripAnsi(rawLine).trim();
  if (!line || /^at\s/.test(line) || line.startsWith('[dev-log] Development only')) return null;
  const request = SERVER_REQUEST_LINE.exec(line);
  if (request) {
    const status = Number(request[3]);
    if (status < 400) return null;
    return { kind: 'failed request', message: `${request[1]} ${request[2]} → ${status}`, signature: `${request[1]} ${signatureOf(request[2])} ${status}` };
  }
  if (source === 'metro' && /^(Android|iOS|Web) Bundled|^› |^Logs for your project|^Starting Metro|^Waiting on/.test(line)) return null;
  if (!PROBLEM_WORDS.test(line)) return null;
  const kind = /warn|⚠/i.test(line) && !/error|fatal|❌/i.test(line) ? 'warning' : 'error';
  return { kind, message: line.slice(0, 300), signature: signatureOf(line) };
}

/** A client.jsonl entry that is a problem, or null. Notes are returned with kind 'note'. */
export function classifyClientEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  switch (entry.kind) {
    case 'api': {
      const message = `${entry.method} ${entry.path} → ${entry.status === 0 ? 'no answer' : entry.status}${entry.code ? ` ${entry.code}` : ''}`;
      return { kind: 'failed request', message, signature: `${entry.method} ${entry.path} ${entry.status} ${entry.code ?? ''}` };
    }
    case 'error':
      return { kind: entry.fatal ? 'crash' : 'error', message: entry.message ?? '', signature: signatureOf(entry.message ?? '') };
    case 'boundary':
      return { kind: 'crash', message: `ErrorBoundary: ${entry.message ?? ''}`, signature: `boundary ${signatureOf(entry.message ?? '')}` };
    case 'rejection':
      return { kind: 'error', message: entry.message ?? '', signature: `rejection ${signatureOf(entry.message ?? '')}` };
    case 'console':
      return { kind: entry.level === 'warn' ? 'warning' : 'error', message: entry.message ?? '', signature: signatureOf(entry.message ?? '') };
    case 'note':
      return { kind: 'note', message: entry.message ?? '', signature: null };
    default:
      return null;
  }
}

// ── Session ───────────────────────────────────────────────────────────────────
const timestamp = () => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
};

const gitInfo = () => {
  const run = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() || null;
  return { branch: run(['rev-parse', '--abbrev-ref', 'HEAD']), commit: run(['rev-parse', '--short', 'HEAD']) };
};

/** Splits a stream into lines and calls onLine for each complete one. */
const onLines = (stream, onLine) => {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) onLine(line);
  });
  stream.on('end', () => { if (pending) onLine(pending); });
};

const printQrCode = (url) => {
  try {
    const requireFromRoot = createRequire(path.join(ROOT, 'package.json'));
    const requireFromExpo = createRequire(requireFromRoot.resolve('expo/package.json'));
    const requireFromCli = createRequire(requireFromExpo.resolve('@expo/cli/package.json'));
    requireFromCli('qrcode-terminal').generate(url, { small: true }, (code) => console.log(code));
  } catch {
    console.log(yellow('  (No QR code printer found. In Expo Go, tap "Enter URL manually" and type the address below.)'));
  }
  console.log(`  ${bold(url)}  ${dim('scan with the iPhone Camera app')}\n`);
};

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: npm run test:ios [-- --capture-metro] [-- --ip 192.168.x.y] [-- --preflight]\nSee docs/IOS_TEST_SESSION.md.');
    return;
  }
  const ipIndex = args.indexOf('--ip');
  const ipOverride = ipIndex >= 0 ? args[ipIndex + 1] : undefined;
  const captureMetro = args.includes('--capture-metro');

  const preflight = await runPreflight({ ipOverride });
  printPreflight(preflight);
  if (!preflight.ok) {
    console.log(red('\nFix the ✗ items above, then run npm run test:ios again.\n'));
    process.exitCode = 1;
    return;
  }
  if (args.includes('--preflight')) {
    console.log(green('\nAll checks passed.\n'));
    return;
  }

  const lanIp = preflight.lanIp;
  const apiUrl = `http://${lanIp}:${API_PORT}`;
  const sessionDir = path.join(ROOT, 'logs', 'sessions', timestamp());
  fs.mkdirSync(sessionDir, { recursive: true });
  const serverLog = fs.createWriteStream(path.join(sessionDir, 'server.log'), { flags: 'a' });
  const metroLog = captureMetro ? fs.createWriteStream(path.join(sessionDir, 'metro.log'), { flags: 'a' }) : null;
  const issuesLog = fs.createWriteStream(path.join(sessionDir, 'live-issues.txt'), { flags: 'a' });
  const clientFile = path.join(sessionDir, 'client.jsonl');
  const meta = {
    startedAt: new Date().toISOString(),
    lanIp,
    apiUrl,
    captureMetro,
    node: process.versions.node,
    platform: `${os.platform()} ${os.release()}`,
    ...gitInfo(),
  };
  const writeMeta = () => fs.writeFileSync(path.join(sessionDir, 'session.json'), `${JSON.stringify(meta, null, 2)}\n`);
  writeMeta();

  console.log(bold(`\nSession folder: ${sessionDir}`));
  console.log(`API for the app: ${apiUrl}${dim('  (set for Expo only; .env is unchanged)')}\n`);

  // Live watcher.
  const seen = new Map();
  let noteCount = 0;
  const report = (source, found, screen) => {
    if (!found) return;
    const where = screen ? ` (${screen})` : '';
    if (found.kind === 'note') {
      noteCount += 1;
      const line = `NOTE #${noteCount}${where}: ${found.message}`;
      console.log(bold(paint('35', line)));
      issuesLog.write(`${new Date().toISOString()} ${line}\n`);
      return;
    }
    const key = `${source}|${found.kind}|${found.signature}`;
    const known = seen.get(key);
    if (known) { known.count += 1; return; }
    const number = seen.size + 1;
    seen.set(key, { number, count: 1 });
    const line = `NEW ISSUE #${number} [${source}] ${found.kind}: ${found.message.split('\n')[0].slice(0, 200)}${where}`;
    console.log(found.kind === 'warning' || found.kind === 'failed request' ? yellow(bold(line)) : red(bold(line)));
    issuesLog.write(`${new Date().toISOString()} ${stripAnsi(line)}\n`);
  };

  // API server.
  const server = spawn(process.execPath, ['server.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, NODE_ENV: 'development', DEV_SESSION_DIR: sessionDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const onServerLine = (line) => {
    console.log(`${dim('[server]')} ${line}`);
    serverLog.write(`${new Date().toISOString()} ${stripAnsi(line)}\n`);
    report('server', classifyLogLine('server', line));
  };
  onLines(server.stdout, onServerLine);
  onLines(server.stderr, onServerLine);

  // App log bridge output, written by the server.
  let clientOffset = 0;
  let clientPending = '';
  const readClientLog = () => {
    const size = fs.statSync(clientFile, { throwIfNoEntry: false })?.size ?? 0;
    if (size <= clientOffset) return;
    const fd = fs.openSync(clientFile, 'r');
    try {
      const buffer = Buffer.alloc(size - clientOffset);
      fs.readSync(fd, buffer, 0, buffer.length, clientOffset);
      clientOffset = size;
      const lines = (clientPending + buffer.toString('utf8')).split('\n');
      clientPending = lines.pop();
      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        report('app', classifyClientEntry(entry), entry.screen);
      }
    } finally {
      fs.closeSync(fd);
    }
  };
  const clientTimer = setInterval(readClientLog, CLIENT_POLL_MS);

  // Expo.
  const expoCli = createRequire(path.join(ROOT, 'package.json')).resolve('expo/bin/cli');
  const expoEnv = { ...process.env, EXPO_PUBLIC_API_URL: apiUrl, REACT_NATIVE_PACKAGER_HOSTNAME: lanIp };
  delete expoEnv.NODE_ENV; // Expo picks its own mode
  if (captureMetro) printQrCode(`exp://${lanIp}:${METRO_PORT}`);
  const expo = spawn(process.execPath, [expoCli, 'start', '--lan', '--port', String(METRO_PORT)], {
    cwd: ROOT,
    env: expoEnv,
    stdio: captureMetro ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (captureMetro) {
    const onMetroLine = (line) => {
      console.log(`${dim('[metro]')} ${line}`);
      metroLog.write(`${new Date().toISOString()} ${stripAnsi(line)}\n`);
      report('metro', classifyLogLine('metro', line));
    };
    onLines(expo.stdout, onMetroLine);
    onLines(expo.stderr, onMetroLine);
  }

  // Shutdown.
  const exited = (child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    child.once('error', resolve);
  });
  let isStopping = false;
  const stop = async (reason) => {
    if (isStopping) return;
    isStopping = true;
    console.log(dim(`\nStopping (${reason})…`));
    for (const child of [expo, server]) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.race([
      Promise.all([exited(expo), exited(server)]),
      new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
    ]);
    clearInterval(clientTimer);
    readClientLog();
    meta.endedAt = new Date().toISOString();
    meta.issueCount = seen.size;
    meta.noteCount = noteCount;
    writeMeta();
    await Promise.all([serverLog, metroLog, issuesLog].filter(Boolean).map((stream) => new Promise((resolve) => stream.end(resolve))));
    console.log(bold(`\nSession saved: ${sessionDir}`));
    console.log(`  ${seen.size} distinct issue(s), ${noteCount} note(s).`);
    console.log('  Next: ask Claude Code to "run the log-triage agent on the latest test session".\n');
    process.exit(0);
  };

  process.on('SIGINT', () => { void stop('Ctrl+C'); });
  process.on('SIGTERM', () => { void stop('SIGTERM'); });
  // Expo reads Ctrl+C itself while it owns the terminal, then exits: that ends the session too.
  expo.once('exit', (code) => { void stop(`Expo exited${code ? ` with code ${code}` : ''}`); });
  server.once('exit', (code) => {
    if (isStopping) return;
    report('server', { kind: 'crash', message: `API server exited with code ${code}`, signature: `server exit ${code}` });
    void stop('the API server exited');
  });
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().catch((err) => {
    console.error(red(`test-session failed: ${err?.message ?? err}`));
    process.exit(1);
  });
}
