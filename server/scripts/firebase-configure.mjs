#!/usr/bin/env node
// npm run firebase:configure -- <web-config.json> <service-account.json>
//
// Points the app and the server at one Firebase project (owner decision 2026-11-14: drinkmeapp-a8fea).
// Run by the owner; see docs/DEVICE_TEST_SESSION.md, "Firebase project".
//
//   <web-config.json>        the web app config from Firebase console → Project settings → Your apps → Web
//                            app → SDK setup and configuration → Config. Either JSON or the pasted
//                            `const firebaseConfig = { ... }` snippet. measurementId and analytics are ignored.
//   <service-account.json>   Project settings → Service accounts → Generate new private key.
//
// What it changes, nothing else (every other byte of both files stays as it is):
//   .env (project root)  the six EXPO_PUBLIC_FIREBASE_* lines
//   server/.env          FIREBASE_SERVICE_ACCOUNT_KEY=<path to the service-account file>
// A copy of each file before the change is kept as .env.before-firebase-<time> (git-ignored).
// Refuses, writing nothing, when the two files name different projects, when the service-account file is
// inside the repository but not git-ignored, or when a file is not what it should be.
// Prints only the project ids and MATCH / MISMATCH, never a key or any other value.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setEnvLines, writeFileAtomic } from './env-file.mjs';
import { checkProjects } from './official.mjs';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SERVER_DIR, '..');

export const WEB_CONFIG_KEYS = {
  apiKey: 'EXPO_PUBLIC_FIREBASE_API_KEY',
  authDomain: 'EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN',
  projectId: 'EXPO_PUBLIC_FIREBASE_PROJECT_ID',
  storageBucket: 'EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET',
  messagingSenderId: 'EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  appId: 'EXPO_PUBLIC_FIREBASE_APP_ID',
};

/** The six web-config values from JSON or from the console's JS snippet. */
export function parseWebConfig(text) {
  let source = null;
  try {
    const parsed = JSON.parse(text);
    source = parsed && typeof parsed === 'object' ? (parsed.firebaseConfig ?? parsed) : null;
  } catch {
    source = {};
    for (const match of text.matchAll(/["']?(\w+)["']?\s*:\s*["']([^"'\r\n]+)["']/g)) source[match[1]] = match[2];
  }
  const config = {};
  const missing = [];
  for (const key of Object.keys(WEB_CONFIG_KEYS)) {
    const value = typeof source?.[key] === 'string' ? source[key].trim() : '';
    if (value) config[key] = value;
    else missing.push(key);
  }
  if (missing.length > 0) throw new Error(`The web config is missing: ${missing.join(', ')}`);
  if (!/^[a-z0-9-]{4,40}$/.test(config.projectId)) throw new Error('The web config projectId does not look like a Firebase project id');
  return config;
}

/** Checks the service-account file's shape. Returns its project id only. */
export function readServiceAccountProject(text) {
  let account;
  try {
    account = JSON.parse(text);
  } catch (err) {
    throw new Error(`The service-account file is not JSON (${err.name})`);
  }
  if (account?.type !== 'service_account' || !account.project_id || !account.private_key || !account.client_email) {
    throw new Error('The service-account file is not a Firebase service-account key (Project settings → Service accounts → Generate new private key)');
  }
  return account.project_id;
}

/** The FIREBASE_SERVICE_ACCOUNT_KEY value: relative to server/ inside the repository, absolute outside. */
export function serviceAccountSetting(absolutePath, serverDir = SERVER_DIR) {
  const fromRoot = path.relative(path.resolve(serverDir, '..'), absolutePath);
  const insideRepo = fromRoot !== '' && !fromRoot.startsWith('..') && !path.isAbsolute(fromRoot);
  if (!insideRepo) return absolutePath.split(path.sep).join('/');
  // The server reads the key relative to its working folder, server/ (npm run test:*, node server.js).
  const posix = path.relative(serverDir, absolutePath).split(path.sep).join('/');
  return posix.startsWith('.') ? posix : `./${posix}`;
}

const isInsideRepo = (file) => {
  const relative = path.relative(ROOT, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const isGitIgnored = (file) => spawnSync('git', ['check-ignore', '-q', file], { cwd: ROOT }).status === 0;

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// npm run firebase:use-key -- <service-account.json>: points the server at another key file of the same
// project as the app (FIREBASE_SERVICE_ACCOUNT_KEY only). Prints project ids only.
async function useKey(accountArg) {
  const accountFile = path.resolve(process.cwd(), accountArg ?? '');
  if (!accountArg || !fs.existsSync(accountFile)) throw new Error('Usage: npm run firebase:use-key -- <service-account.json>');
  if (isInsideRepo(accountFile) && !isGitIgnored(accountFile)) throw new Error(`${path.relative(ROOT, accountFile)} is not git-ignored. Nothing was changed.`);
  const accountProject = readServiceAccountProject(fs.readFileSync(accountFile, 'utf8'));
  const rootEnvFile = path.join(ROOT, '.env');
  const appProject = fs.existsSync(rootEnvFile)
    ? (fs.readFileSync(rootEnvFile, 'utf8').match(/^\s*EXPO_PUBLIC_FIREBASE_PROJECT_ID\s*=\s*["']?([^"'\s#]+)/m)?.[1] ?? '(not set)')
    : '(not set)';
  console.log(`App project: ${appProject}`);
  console.log(`Key project: ${accountProject}`);
  if (appProject !== accountProject) {
    console.log('MISMATCH: nothing was changed.');
    process.exitCode = 1;
    return;
  }
  const serverEnvFile = path.join(SERVER_DIR, '.env');
  const serverText = fs.readFileSync(serverEnvFile, 'utf8');
  const result = setEnvLines(serverText, { FIREBASE_SERVICE_ACCOUNT_KEY: serviceAccountSetting(accountFile) });
  if (!result.ok) throw new Error(`${result.reason} Nothing was changed.`);
  if (result.changed.length > 0) writeFileAtomic(serverEnvFile, result.text);
  console.log(result.changed.length > 0 ? 'MATCH: server/.env now uses this key (no other line changed).' : 'MATCH: server/.env already uses this key.');
}

async function main() {
  if (process.argv[2] === '--use-key') return useKey(process.argv[3]);
  const [webArg, accountArg] = process.argv.slice(2);
  if (!webArg || !accountArg) {
    throw new Error('Usage: npm run firebase:configure -- <web-config.json> <service-account.json>');
  }
  const webFile = path.resolve(process.cwd(), webArg);
  const accountFile = path.resolve(process.cwd(), accountArg);
  for (const file of [webFile, accountFile]) {
    if (!fs.existsSync(file)) throw new Error(`Not found: ${file}`);
  }
  for (const file of [webFile, accountFile]) {
    if (isInsideRepo(file) && !isGitIgnored(file)) {
      throw new Error(`${path.relative(ROOT, file)} is inside the repository but not git-ignored. Move it, or name it firebase-web-config.json / server/serviceAccount-<name>.json (both ignored).`);
    }
  }

  const config = parseWebConfig(fs.readFileSync(webFile, 'utf8'));
  const accountProject = readServiceAccountProject(fs.readFileSync(accountFile, 'utf8'));
  console.log(`Web config (app) project:        ${config.projectId}`);
  console.log(`Service account (server) project: ${accountProject}`);
  if (config.projectId !== accountProject) {
    console.log('MISMATCH: nothing was changed. Download both files from the same Firebase project.');
    process.exitCode = 1;
    return;
  }

  const rootEnvFile = path.join(ROOT, '.env');
  const serverEnvFile = path.join(SERVER_DIR, '.env');
  const rootText = fs.existsSync(rootEnvFile) ? fs.readFileSync(rootEnvFile, 'utf8') : '';
  const serverText = fs.existsSync(serverEnvFile) ? fs.readFileSync(serverEnvFile, 'utf8') : '';
  const rootResult = setEnvLines(rootText, Object.fromEntries(Object.entries(WEB_CONFIG_KEYS).map(([key, name]) => [name, config[key]])));
  const serverResult = setEnvLines(serverText, { FIREBASE_SERVICE_ACCOUNT_KEY: serviceAccountSetting(accountFile) });
  for (const result of [rootResult, serverResult]) {
    if (!result.ok) throw new Error(`${result.reason} Nothing was changed.`);
  }

  const time = stamp();
  for (const [file, text, result] of [[rootEnvFile, rootText, rootResult], [serverEnvFile, serverText, serverResult]]) {
    if (result.changed.length === 0) continue;
    if (text) fs.writeFileSync(`${file}.before-firebase-${time}`, text);
    writeFileAtomic(file, result.text);
  }

  const check = checkProjects({
    rootEnvText: fs.readFileSync(rootEnvFile, 'utf8'),
    serverEnvText: fs.readFileSync(serverEnvFile, 'utf8'),
    serverDir: SERVER_DIR,
  });
  console.log(check.ok ? 'MATCH' : 'MISMATCH');
  console.log(`Changed: .env (${rootResult.changed.length} line(s)), server/.env (${serverResult.changed.length} line(s)). Copies of the old files: .env.before-firebase-${time}`);
  console.log('Next: restart the test session (Ctrl+C, npm run test:android), then sign up again in the app: users of the old project do not exist in this one.');
  console.log('Google sign-in: EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID still names the old project\'s OAuth client; see "Google sign-in setup" in docs/DEVICE_TEST_SESSION.md.');
  if (!check.ok) process.exitCode = 1;
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
