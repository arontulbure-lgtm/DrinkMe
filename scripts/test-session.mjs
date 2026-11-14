#!/usr/bin/env node
// npm run test:ios / npm run test:android: one command for a device test session with Expo Go over the
// LAN. npm run emulator starts the DrinkMe_Pixel8 Android emulator. See docs/DEVICE_TEST_SESSION.md.
//
//   1. Preflight (✓/✗, never a secret value): Node version, port 5000, a Metro port (8081, or the next
//      free one), server/.env with NODE_ENV=development, the Firebase service account, the
//      EXPO_PUBLIC_FIREBASE_* names, the LAN IPv4; for Android also adb, the emulator and a booted device
//      (offers to start DrinkMe_Pixel8). The server must answer /healthz before Expo starts; on Android the
//      script checks that the emulator reaches the API at the LAN address, else uses 10.0.2.2.
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
// Options: --platform ios|android, --capture-metro, --ip <IPv4> (override the detected address),
// --preflight (checks only), --start-emulator, --help.
// No dependencies beyond Node itself and the project's own expo package.
/* global Buffer, setInterval, clearInterval, setTimeout, AbortSignal */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactText } from '../server/dev-log-bridge.js';
import { EXPECTED_PROJECT_ID, envValue, loadServiceAccount } from '../server/scripts/official.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(ROOT, 'server');
const API_PORT = 5000;
const METRO_PORT = 8081;
// When 8081 is taken, the next free port up to 8081 + this is used.
const METRO_PORT_TRIES = 9;
const HEALTH_TIMEOUT_MS = 30_000;
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
// App log text can come from anyone on the Wi-Fi: one line, no terminal controls or direction overrides,
// so it cannot fake a [server], NEW ISSUE or "Session saved" line.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
export const printable = (value, limit) => {
  const text = stripAnsi(String(value ?? '')).replace(/[\r\n]+/g, ' ⏎ ').replace(UNPRINTABLE, '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

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
    names: () => [...values.keys()],
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

const isPortFreeOn = (port, host) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.once('listening', () => probe.close(() => resolve(true)));
  probe.listen(port, host);
});
// Both addresses: on Windows a program can hold 127.0.0.1:<port> (Docker does for 8081) while 0.0.0.0
// still binds, and Expo's own checks on localhost would then reach that program instead of Metro.
const isPortFree = async (port) => (await isPortFreeOn(port, '0.0.0.0')) && isPortFreeOn(port, '127.0.0.1');

// ── Android SDK ───────────────────────────────────────────────────────────────
export const AVD_NAME = 'DrinkMe_Pixel8';
const androidSdkDir = () => process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  || path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Android', 'Sdk');
const sdkTool = (...parts) => {
  const file = path.join(androidSdkDir(), ...parts);
  const withExe = process.platform === 'win32' ? `${file}.exe` : file;
  return fs.existsSync(withExe) ? withExe : null;
};
export const adbPath = () => sdkTool('platform-tools', 'adb');
const emulatorPath = () => sdkTool('emulator', 'emulator');
const runAdb = (args, timeout = 15_000) => {
  const adb = adbPath();
  if (!adb) return { ok: false, out: '' };
  const result = spawnSync(adb, args, { encoding: 'utf8', timeout });
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
};

/** The serial of a booted emulator or device, or null. */
export function findBootedAndroid() {
  const listed = runAdb(['devices']).out.split(/\r?\n/).slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === 'device')
    .map(([serial]) => serial);
  return listed.find((serial) => runAdb(['-s', serial, 'shell', 'getprop', 'sys.boot_completed']).out === '1') ?? null;
}

/** Starts the AVD in its own window (it keeps running after this script) and waits until Android has booted. */
export async function startEmulator({ timeoutMs = 6 * 60 * 1000 } = {}) {
  const emulator = emulatorPath();
  if (!emulator) throw new Error('Android emulator not found: see docs/DEVICE_TEST_SESSION.md, section Android setup.');
  console.log(`Starting ${AVD_NAME}… (first boot can take two minutes)`);
  spawn(emulator, ['-avd', AVD_NAME, '-no-snapshot-save'], { detached: true, stdio: 'ignore', env: { ...process.env, ANDROID_HOME: androidSdkDir() } }).unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const serial = findBootedAndroid();
    if (serial) return serial;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`${AVD_NAME} did not finish booting in ${Math.round(timeoutMs / 60000)} minutes.`);
}

/** Whether the emulator gets an answer from the API at host:port (toybox nc; the image has no curl). */
export function canAndroidReach(serial, host, port) {
  const probe = `printf 'GET /healthz HTTP/1.0\\r\\n\\r\\n' | nc -w 3 ${host} ${port}`;
  return /"status"\s*:\s*"ok"/.test(runAdb(['-s', serial, 'shell', probe], 10_000).out);
}

const askYesNo = (question) => new Promise((resolve) => {
  if (!process.stdin.isTTY) return resolve(false);
  process.stdout.write(question);
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', (answer) => {
    process.stdin.pause();
    resolve(!/^\s*n/i.test(answer));
  });
  process.stdin.resume();
});

/** The Firebase project ids of the app (.env) and of the server's service account, or an error text. */
function firebaseProjects() {
  try {
    const rootEnv = path.join(ROOT, '.env');
    const app = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID
      || (fs.existsSync(rootEnv) ? envValue(fs.readFileSync(rootEnv, 'utf8'), 'EXPO_PUBLIC_FIREBASE_PROJECT_ID') : undefined);
    const serverEnv = path.join(SERVER_DIR, '.env');
    const server = loadServiceAccount(fs.existsSync(serverEnv) ? fs.readFileSync(serverEnv, 'utf8') : '', SERVER_DIR).project_id;
    return { app: app || '(not set)', server: server || '(not set)' };
  } catch (err) {
    return { error: err.message };
  }
}

/** A .env name that looks like a secret and is not one of the app's EXPO_PUBLIC_ settings. Names only. */
export const isSecretLookingName = (name) => (
  !name.startsWith('EXPO_PUBLIC_') && /KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH/i.test(name)
);

// ── Preflight ─────────────────────────────────────────────────────────────────
export async function runPreflight({ ipOverride, platform = 'ios' } = {}) {
  const results = [];
  const check = (ok, label, hint) => results.push({ ok, label, hint });
  // Shown with a yellow "!", never blocks the session.
  const warn = (label, hint) => results.push({ ok: true, warn: true, label, hint });

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  check(nodeMajor >= MIN_NODE_MAJOR, `Node ${process.versions.node} (need ${MIN_NODE_MAJOR}+)`, 'Install Node 22 LTS from nodejs.org.');

  check(await isPortFree(API_PORT), `Port ${API_PORT} free (API server)`,
    `Something already listens on ${API_PORT}: close the old server window, or find it with: Get-NetTCPConnection -LocalPort ${API_PORT} | Select OwningProcess`);
  let metroPort = null;
  for (let port = METRO_PORT; port <= METRO_PORT + METRO_PORT_TRIES; port += 1) {
    if (await isPortFree(port)) { metroPort = port; break; }
  }
  check(metroPort !== null, metroPort === METRO_PORT
    ? `Port ${METRO_PORT} free (Metro)`
    : `Metro port: ${metroPort ?? 'none free'}${metroPort ? dim(`  (${METRO_PORT} is used by another program, for example Docker)`) : ''}`,
  `Ports ${METRO_PORT} to ${METRO_PORT + METRO_PORT_TRIES} are all in use: close old Expo windows.`);

  if (platform === 'android') {
    check(Boolean(adbPath()), 'adb found (Android platform-tools)', 'Install the Android SDK: docs/DEVICE_TEST_SESSION.md, section Android setup.');
    check(Boolean(emulatorPath()), 'Android emulator installed', 'sdkmanager "emulator" (docs/DEVICE_TEST_SESSION.md).');
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
  // Which Firebase project the app signs in to, and which one the server checks tokens against. Project
  // ids are not secrets; nothing else from either file or the key is printed.
  const projectCheck = firebaseProjects();
  if (projectCheck.error) {
    check(false, 'Firebase project', projectCheck.error);
  } else {
    const same = projectCheck.app === projectCheck.server;
    check(same, same
      ? `Firebase project: ${projectCheck.app} (app and server)${projectCheck.app === EXPECTED_PROJECT_ID ? '' : yellow(`  expected ${EXPECTED_PROJECT_ID}`)}`
      : `Firebase project: app ${projectCheck.app}, server ${projectCheck.server} (MISMATCH)`,
    'Sign-in fails until both use the same project: npm run firebase:configure (docs/DEVICE_TEST_SESSION.md, "Firebase project").');
  }
  // Expo loads every name in the root .env files into Metro's process. Only EXPO_PUBLIC_ names reach the
  // app, but a server or personal secret has no business there. Names only, never values.
  const misplaced = [...new Set(clientEnvFiles.flatMap((file) => file.names()))].filter(isSecretLookingName);
  if (misplaced.length > 0) {
    warn(`Root .env holds secret-looking names that the app does not use: ${misplaced.join(', ')}`,
      'Move them out of the project .env (for example to your user environment or a password manager). The app reads only EXPO_PUBLIC_ names; see docs/DEVICE_TEST_SESSION.md.');
  }

  const ranked = rankLanAddresses();
  const lanIp = ipOverride || ranked[0]?.address;
  const ipIsValid = Boolean(lanIp) && net.isIPv4(lanIp);
  const others = ranked.filter((item) => item.address !== lanIp).map((item) => `${item.address} (${item.name})`);
  check(ipIsValid, ipIsValid
    ? `LAN IPv4: ${lanIp}${ipOverride ? ' (from --ip)' : ` (${ranked[0].name})`}${others.length ? dim(`  other: ${others.join(', ')}`) : ''}`
    : 'LAN IPv4 found', 'Connect the PC to the same Wi-Fi as the phone, or pass --ip <address>.');

  return { results, ok: results.every((item) => item.ok), lanIp: ipIsValid ? lanIp : null, metroPort, firebaseProject: projectCheck.error ? null : { app: projectCheck.app, server: projectCheck.server } };
}

const printPreflight = ({ results }) => {
  console.log(bold('\nPreflight'));
  for (const { ok, warn, label, hint } of results) {
    console.log(`  ${warn ? yellow('!') : ok ? green('✓') : red('✗')} ${warn ? yellow(label) : label}`);
    if ((!ok || warn) && hint) console.log(`      ${dim(hint)}`);
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

// Clock difference allowed between the app (emulator or phone) and this PC.
const CLOCK_SKEW_MS = 5000;

/**
 * Where a client.jsonl entry comes from: 'new' (this session), 'carried-over' (made before the session
 * started, queued by the app while no server ran), or 'duplicate' (the same appSession + seq again, when a
 * batch was resent). seen collects the ids of this session.
 */
export function clientEntryOrigin(entry, sessionStartMs, seen) {
  if (entry?.appSession && Number.isInteger(entry.seq)) {
    const id = `${entry.appSession}:${entry.seq}`;
    if (seen.has(id)) return 'duplicate';
    seen.add(id);
  }
  const made = Date.parse(entry?.clientTs ?? '');
  if (!Number.isNaN(made) && made < sessionStartMs - CLOCK_SKEW_MS) return 'carried-over';
  return 'new';
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
      // The ErrorBoundary also sends a 'boundary' entry with the details: one issue, not two.
      if (String(entry.message ?? '').startsWith('[ErrorBoundary]')) return null;
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
    console.log([
      'Usage: npm run test:ios | npm run test:android  [-- --capture-metro] [-- --ip 192.168.x.y] [-- --preflight]',
      '       npm run emulator   (start the DrinkMe_Pixel8 Android emulator and wait for it)',
      'See docs/DEVICE_TEST_SESSION.md.',
    ].join('\n'));
    return;
  }
  if (args.includes('--start-emulator')) {
    const already = findBootedAndroid();
    const serial = already ?? await startEmulator();
    console.log(green(`${already ? 'Already running' : 'Booted'}: ${serial}. Next: npm run test:android`));
    return;
  }
  const platformIndex = args.indexOf('--platform');
  const platform = platformIndex >= 0 ? args[platformIndex + 1] : 'ios';
  if (!['ios', 'android'].includes(platform)) {
    console.error(red('--platform must be ios or android'));
    process.exitCode = 1;
    return;
  }
  const npmCommand = `npm run test:${platform}`;
  const ipIndex = args.indexOf('--ip');
  const ipOverride = ipIndex >= 0 ? args[ipIndex + 1] : undefined;
  if (ipIndex >= 0 && (!ipOverride || ipOverride.startsWith('--'))) {
    console.error(red('--ip needs an address, for example: npm run test:ios -- --ip 192.168.0.115'));
    process.exitCode = 1;
    return;
  }
  const captureMetro = args.includes('--capture-metro');

  const preflight = await runPreflight({ ipOverride, platform });
  let androidSerial = null;
  if (platform === 'android' && preflight.ok) {
    androidSerial = findBootedAndroid();
    const onlyChecks = args.includes('--preflight');
    preflight.results.push({
      ok: Boolean(androidSerial) || !onlyChecks,
      label: androidSerial
        ? `Android emulator booted (${androidSerial})`
        : `Android emulator booted${onlyChecks ? '' : dim('  (not yet: you will be asked to start it)')}`,
      hint: 'Start it with: npm run emulator',
    });
    preflight.ok = preflight.results.every((item) => item.ok);
  }
  printPreflight(preflight);
  if (!preflight.ok) {
    console.log(red(`\nFix the ✗ items above, then run ${npmCommand} again.\n`));
    process.exitCode = 1;
    return;
  }
  if (args.includes('--preflight')) {
    console.log(green('\nAll checks passed.\n'));
    return;
  }
  if (platform === 'android' && !androidSerial) {
    const start = await askYesNo(`No booted Android emulator. Start ${AVD_NAME} now? (Y/n) `);
    if (!start) {
      console.log(red('\nStart one with: npm run emulator\n'));
      process.exitCode = 1;
      return;
    }
    androidSerial = await startEmulator();
    console.log(green(`  ✓ ${androidSerial} booted`));
  }

  const lanIp = preflight.lanIp;
  const metroPort = preflight.metroPort;
  // The phone uses the LAN address. The emulator usually reaches it too; if not, 10.0.2.2 (the emulator's
  // name for this PC) is used instead, decided once the server answers (see below).
  let apiUrl = `http://${lanIp}:${API_PORT}`;
  const sessionDir = path.join(ROOT, 'logs', 'sessions', timestamp());
  fs.mkdirSync(sessionDir, { recursive: true });
  const serverLog = fs.createWriteStream(path.join(sessionDir, 'server.log'), { flags: 'a' });
  const metroLog = captureMetro ? fs.createWriteStream(path.join(sessionDir, 'metro.log'), { flags: 'a' }) : null;
  const issuesLog = fs.createWriteStream(path.join(sessionDir, 'live-issues.txt'), { flags: 'a' });
  const clientFile = path.join(sessionDir, 'client.jsonl');
  const meta = {
    startedAt: new Date().toISOString(),
    platform,
    ...(androidSerial && { androidDevice: androidSerial, avd: AVD_NAME }),
    firebaseProject: preflight.firebaseProject,
    lanIp,
    apiUrl,
    metroPort,
    captureMetro,
    node: process.versions.node,
    host: `${os.platform()} ${os.release()}`,
    ...gitInfo(),
  };
  const writeMeta = () => fs.writeFileSync(path.join(sessionDir, 'session.json'), `${JSON.stringify(meta, null, 2)}\n`);
  writeMeta();

  console.log(bold(`\nSession folder: ${sessionDir}`));
  if (metroPort !== METRO_PORT) {
    console.log(yellow(`! Metro uses port ${metroPort}, not ${METRO_PORT} (another program holds ${METRO_PORT}). Expo Go connects to exp://${lanIp}:${metroPort}; a phone needs the firewall rule for ports ${METRO_PORT}-${METRO_PORT + METRO_PORT_TRIES} (docs/DEVICE_TEST_SESSION.md).`));
  }

  // Live watcher.
  const seen = new Map();
  let noteCount = 0;
  const report = (source, found, rawScreen) => {
    if (!found || issuesLog.writableEnded) return;
    const screen = printable(rawScreen, 80);
    const where = screen ? ` (${screen})` : '';
    if (found.kind === 'note') {
      noteCount += 1;
      const line = `NOTE #${noteCount}${where}: ${printable(found.message, 300)}`;
      console.log(bold(paint('35', line)));
      issuesLog.write(`${new Date().toISOString()} ${line}\n`);
      return;
    }
    const key = `${source}|${found.kind}|${found.signature}`;
    const known = seen.get(key);
    if (known) { known.count += 1; return; }
    const number = seen.size + 1;
    seen.set(key, { number, count: 1 });
    const line = `NEW ISSUE #${number} [${source}] ${found.kind}: ${printable(found.message.split('\n')[0], 200)}${where}`;
    console.log(found.kind === 'warning' || found.kind === 'failed request' ? yellow(bold(line)) : red(bold(line)));
    issuesLog.write(`${new Date().toISOString()} ${stripAnsi(line)}\n`);
  };

  // API server.
  const server = spawn(process.execPath, ['server.js'], {
    cwd: SERVER_DIR,
    // PORT and HOST fixed here, so a value in server/.env cannot make the server unreachable from the phone.
    env: { ...process.env, NODE_ENV: 'development', PORT: String(API_PORT), HOST: '0.0.0.0', DEV_SESSION_DIR: sessionDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const onServerLine = (line) => {
    if (serverLog.writableEnded) return;
    console.log(`${dim('[server]')} ${line}`);
    // Same redaction as client.jsonl: 5xx stack traces and request paths can hold user data.
    serverLog.write(`${new Date().toISOString()} ${redactText(stripAnsi(line))}\n`);
    report('server', classifyLogLine('server', line));
  };
  onLines(server.stdout, onServerLine);
  onLines(server.stderr, onServerLine);

  // App log bridge output, written by the server.
  const sessionStartMs = Date.parse(meta.startedAt);
  const sentEntries = new Set();
  let carriedOverCount = 0;
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
        const kind = clientEntryOrigin(entry, sessionStartMs, sentEntries);
        if (kind === 'duplicate') continue;
        if (kind === 'carried-over') {
          // Queued by the app while no session was running; it belongs to the previous one.
          carriedOverCount += 1;
          if (carriedOverCount === 1) console.log(dim('  (app log entries from before this session arrived; they are not counted as new issues)'));
          continue;
        }
        report('app', classifyClientEntry(entry), entry.screen);
      }
    } finally {
      fs.closeSync(fd);
    }
  };
  const clientTimer = setInterval(readClientLog, CLIENT_POLL_MS);

  // Wait for the server before Expo, so the app's first requests find it.
  const healthDeadline = Date.now() + HEALTH_TIMEOUT_MS;
  let isHealthy = false;
  while (!isHealthy && Date.now() < healthDeadline && server.exitCode === null) {
    try {
      isHealthy = (await fetch(`http://127.0.0.1:${API_PORT}/healthz`, { signal: AbortSignal.timeout(2000) })).ok;
    } catch { /* not listening yet */ }
    if (!isHealthy) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!isHealthy) {
    console.error(red(`\nThe API server did not answer on port ${API_PORT}; see ${path.join(sessionDir, 'server.log')}.`));
    if (server.exitCode === null) server.kill();
    clearInterval(clientTimer);
    process.exitCode = 1;
    return;
  }
  if (androidSerial) {
    if (canAndroidReach(androidSerial, lanIp, API_PORT)) {
      console.log(green(`  ✓ The emulator reaches the API at ${apiUrl}`));
    } else if (canAndroidReach(androidSerial, '10.0.2.2', API_PORT)) {
      apiUrl = `http://10.0.2.2:${API_PORT}`;
      console.log(yellow(`  ! The emulator cannot reach ${lanIp}:${API_PORT}; using ${apiUrl} (the emulator's address for this PC).`));
    } else {
      console.log(yellow(`  ! The emulator reached neither ${lanIp}:${API_PORT} nor 10.0.2.2:${API_PORT}; keeping ${apiUrl}. Check the firewall (docs/DEVICE_TEST_SESSION.md).`));
    }
    meta.apiUrl = apiUrl;
    writeMeta();
  }
  console.log(`API for the app: ${apiUrl}${dim('  (set for Expo only; .env is unchanged)')}\n`);

  // Expo. With --android, Expo installs the matching Expo Go on the emulator and opens the app there.
  const expoCli = createRequire(path.join(ROOT, 'package.json')).resolve('expo/bin/cli');
  const expoEnv = { ...process.env, EXPO_PUBLIC_API_URL: apiUrl, REACT_NATIVE_PACKAGER_HOSTNAME: lanIp };
  delete expoEnv.NODE_ENV; // Expo picks its own mode
  if (androidSerial) expoEnv.ANDROID_SERIAL = androidSerial;
  if (captureMetro && platform === 'ios') printQrCode(`exp://${lanIp}:${metroPort}`);
  const expoArgs = [expoCli, 'start', '--lan', '--port', String(metroPort), ...(platform === 'android' ? ['--android'] : [])];
  const expo = spawn(process.execPath, expoArgs, {
    cwd: ROOT,
    env: expoEnv,
    stdio: captureMetro ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (captureMetro) {
    const onMetroLine = (line) => {
      if (metroLog.writableEnded) return;
      console.log(`${dim('[metro]')} ${line}`);
      metroLog.write(`${new Date().toISOString()} ${redactText(stripAnsi(line))}\n`);
      report('metro', classifyLogLine('metro', line));
    };
    onLines(expo.stdout, onMetroLine);
    onLines(expo.stderr, onMetroLine);
  }

  // Shutdown.
  // 'close', not 'exit': by then the child's last output (often a stack trace) has been read.
  const closed = new Map([[expo, false], [server, false]]);
  for (const child of closed.keys()) child.once('close', () => closed.set(child, true));
  const exited = (child) => new Promise((resolve) => {
    if (closed.get(child)) return resolve();
    child.once('close', resolve);
    child.once('error', resolve);
  });
  // On Windows kill() ends only that process and Metro's workers keep running; taskkill /T ends the tree.
  const killTree = (child) => {
    if (closed.get(child) || child.pid === undefined) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill();
  };
  let isStopping = false;
  const stop = async (reason, exitCode = 0) => {
    if (isStopping) return;
    isStopping = true;
    console.log(dim(`\nStopping (${reason})…`));
    for (const child of [expo, server]) killTree(child);
    await Promise.race([
      Promise.all([exited(expo), exited(server)]),
      new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
    ]);
    clearInterval(clientTimer);
    readClientLog();
    meta.endedAt = new Date().toISOString();
    meta.issueCount = seen.size;
    meta.noteCount = noteCount;
    meta.carriedOverCount = carriedOverCount;
    writeMeta();
    await Promise.all([serverLog, metroLog, issuesLog].filter(Boolean).map((stream) => new Promise((resolve) => stream.end(resolve))));
    console.log(bold(`\nSession saved: ${sessionDir}`));
    console.log(`  ${seen.size} distinct issue(s), ${noteCount} note(s).`);
    console.log('  Next: ask Claude Code to "run the log-triage agent on the latest test session".\n');
    // A killed Expo cannot hand the terminal back: leave it in normal mode.
    if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
    process.exit(exitCode);
  };

  process.on('SIGINT', () => { void stop('Ctrl+C'); });
  process.on('SIGTERM', () => { void stop('SIGTERM'); });
  // Expo reads Ctrl+C itself while it owns the terminal, then exits: that ends the session too.
  expo.once('exit', (code) => { void stop(`Expo exited${code ? ` with code ${code}` : ''}`, code ? 1 : 0); });
  // With --capture-metro, Ctrl+C reaches the server too: give the parent's SIGINT handler a moment and
  // ignore Windows' Ctrl+C exit code, so a normal stop is not reported as a crash.
  const STATUS_CONTROL_C_EXIT = 3221225786;
  server.once('exit', (code) => {
    setTimeout(() => {
      if (isStopping || code === null || code === STATUS_CONTROL_C_EXIT) return;
      report('server', { kind: 'crash', message: `API server exited with code ${code}`, signature: `server exit ${code}` });
      void stop('the API server exited', 1);
    }, 300);
  });
  for (const [child, name] of [[server, 'API server'], [expo, 'Expo']]) {
    child.once('error', (err) => {
      report('session', { kind: 'crash', message: `${name} could not start: ${err.code ?? err.message}`, signature: `spawn ${name}` });
      void stop(`${name} could not start`, 1);
    });
  }
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().catch((err) => {
    console.error(red(`test-session failed: ${err?.message ?? err}`));
    process.exit(1);
  });
}
