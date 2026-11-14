#!/usr/bin/env node
// Drives the app on the Android emulator for scripted device tests (development only).
//
//   node scripts/adb-ui.mjs dump                     visible elements: index, text / description, centre
//   node scripts/adb-ui.mjs tap "<text>" [n]         taps the n-th element (default 0) whose text or
//                                                    description contains <text> (case-insensitive);
//                                                    /regex/ also works
//   node scripts/adb-ui.mjs tapxy <x> <y>
//   node scripts/adb-ui.mjs type "<text>"            types into the focused field
//   node scripts/adb-ui.mjs typepw <email>           types that test user's password (never printed)
//   node scripts/adb-ui.mjs clear [n]             deletes n characters (default 60) in the focused field
//   node scripts/adb-ui.mjs key back|enter|tab|del|menu|<keycode>
//   node scripts/adb-ui.mjs swipe up|down|left|right
//   node scripts/adb-ui.mjs wait "<text>" [seconds]  waits until such an element is visible (default 20 s)
//   node scripts/adb-ui.mjs shot <file.png>          screenshot
//   node scripts/adb-ui.mjs has "<text>"             exit 0 when visible, 1 when not
//
// Uses only adb from the Android SDK (ANDROID_HOME or %LOCALAPPDATA%\Android\Sdk). Never types or prints
// anything it is not given on the command line.
/* global setTimeout */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sdk = process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Android', 'Sdk');
const ADB = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');

const adb = (args, { binary = false } = {}) => {
  const result = spawnSync(ADB, args, { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`adb ${args[0]} failed: ${(result.stderr ?? '').toString().trim()}`);
  return result.stdout;
};

const decode = (value) => value.replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Visible nodes from a uiautomator dump: { text, desc, x, y, clickable }. */
export function parseNodes(xml) {
  const nodes = [];
  for (const match of xml.matchAll(/<node\b([^>]*)>/g)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, decode(v)]));
    const bounds = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds ?? '');
    if (!bounds) continue;
    const [x1, y1, x2, y2] = bounds.slice(1).map(Number);
    if (x2 <= x1 || y2 <= y1) continue;
    const text = attrs.text ?? '';
    const desc = attrs['content-desc'] ?? '';
    if (!text && !desc && attrs.clickable !== 'true') continue;
    nodes.push({ text, desc, x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), clickable: attrs.clickable === 'true', focused: attrs.focused === 'true' });
  }
  return nodes;
}

export function matches(node, query) {
  const regex = /^\/(.+)\/([a-z]*)$/.exec(query);
  // /regex/ is case-sensitive unless it ends in /i; plain text is a case-insensitive substring.
  const test = regex ? (value) => new RegExp(regex[1], regex[2]).test(value) : (value) => value.toLowerCase().includes(query.toLowerCase());
  return (node.text && test(node.text)) || (node.desc && test(node.desc));
}

const dump = () => {
  adb(['shell', 'uiautomator', 'dump', '/sdcard/ui.xml']);
  return parseNodes(adb(['exec-out', 'cat', '/sdcard/ui.xml']));
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const KEYS = { back: 'KEYCODE_BACK', enter: 'KEYCODE_ENTER', tab: 'KEYCODE_TAB', del: 'KEYCODE_DEL', menu: 'KEYCODE_MENU', home: 'KEYCODE_HOME' };

// adb shell runs the line through the device shell: quote it, spaces become %s for `input text`.
const shellQuote = (text) => `'${text.replace(/'/g, '\'\\\'\'')}'`;

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'dump': {
      dump().forEach((node, i) => console.log(`${i}\t${node.text || ''}${node.desc ? ` [${node.desc}]` : ''}\t(${node.x},${node.y})${node.clickable ? ' click' : ''}${node.focused ? ' focused' : ''}`));
      return;
    }
    case 'tap': {
      const [query, nth = '0'] = args;
      const found = dump().filter((node) => matches(node, query));
      const node = found[Number(nth)];
      if (!node) throw new Error(`No element matches "${query}" (${found.length} found)`);
      adb(['shell', 'input', 'tap', String(node.x), String(node.y)]);
      console.log(`tapped "${node.text || node.desc}" at (${node.x},${node.y})`);
      return;
    }
    case 'tapxy':
      adb(['shell', 'input', 'tap', args[0], args[1]]);
      return;
    case 'type':
      adb(['shell', `input text ${shellQuote((args[0] ?? '').replace(/ /g, '%s'))}`]);
      return;
    case 'typepw': {
      // The password of a test user from logs/testusers.local.json (npm run testusers:create), typed
      // without ever printing it or putting it on a command line.
      const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs', 'testusers.local.json');
      const user = JSON.parse(fs.readFileSync(file, 'utf8')).users.find((item) => item.email === args[0]);
      if (!user) throw new Error(`No test user ${args[0]} in logs/testusers.local.json`);
      adb(['shell', `input text ${shellQuote(user.password)}`]);
      console.log(`typed the password of ${args[0]}`);
      return;
    }
    case 'hidekb': {
      // Back closes the on-screen keyboard, but leaves the screen when no keyboard is open: check first.
      // mInputShown can stay true after the keyboard closed; the IME window's own visibility is reliable.
      const shown = /mWindowVisible=true|mDecorViewVisible=true/.test(adb(['shell', 'dumpsys', 'input_method']));
      if (shown) adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
      console.log(shown ? 'keyboard hidden' : 'no keyboard open');
      return;
    }
    case 'clear': {
      const count = Number(args[0] ?? 60);
      adb(['shell', 'input', 'keyevent', 'KEYCODE_MOVE_END']);
      adb(['shell', 'input', 'keyevent', ...Array(count).fill('KEYCODE_DEL')]);
      return;
    }
    case 'key':
      adb(['shell', 'input', 'keyevent', KEYS[args[0]] ?? args[0]]);
      return;
    case 'swipe': {
      const moves = { up: [540, 1700, 540, 700], down: [540, 700, 540, 1700], left: [900, 1200, 180, 1200], right: [180, 1200, 900, 1200] };
      const move = moves[args[0]];
      if (!move) throw new Error('swipe up|down|left|right');
      adb(['shell', 'input', 'swipe', ...move.map(String), '300']);
      return;
    }
    case 'wait':
    case 'has': {
      const [query, seconds = command === 'has' ? '0' : '20'] = args;
      const deadline = Date.now() + Number(seconds) * 1000;
      for (;;) {
        const node = dump().find((item) => matches(item, query));
        if (node) {
          console.log(`visible: "${node.text || node.desc}"`);
          return;
        }
        if (Date.now() >= deadline) {
          console.log(`not visible: ${query}`);
          process.exitCode = 1;
          return;
        }
        await sleep(1000);
      }
    }
    case 'shot': {
      const file = path.resolve(args[0] ?? 'screen.png');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, adb(['exec-out', 'screencap', '-p'], { binary: true }));
      console.log(`saved ${file}`);
      return;
    }
    default:
      throw new Error('Usage: node scripts/adb-ui.mjs dump|tap|tapxy|type|clear|key|swipe|wait|has|shot …');
  }
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
