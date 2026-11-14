#!/usr/bin/env node
// Official DrinkMe account helpers, run by the owner (docs/DEVICE_TEST_SESSION.md, section 5):
//
//   npm run official:check            the Firebase project of the app (.env) and of the server's service
//                                     account: prints the two project ids and MATCH or MISMATCH
//   npm run official:find -- <email>  the Firebase user for that email: uid, email, created date
//   npm run official:set -- <uid>     sets OFFICIAL_USER_IDS=<uid> in server/.env; every other byte stays
//                                     as it is. Refused when the uid is also in ADMIN_USER_IDS.
//
// Never prints a secret: not the service-account key, not any other line or value of either .env file
// (project ids, the uid and the email you typed are not secrets). Exits 1 on any refusal or error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SERVER_DIR, '..');
export const EXPECTED_PROJECT_ID = 'drinkmeapp-a8fea';
const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

const unquote = (raw) => {
  const value = raw.trim();
  const quote = value[0];
  if ((quote === '"' || quote === '\'') && value.indexOf(quote, 1) > 0) return value.slice(1, value.indexOf(quote, 1));
  return value.replace(/\s+#.*$/, '').trim();
};

/** The value of one name in a dotenv text (the first assignment, as dotenv reads it), or undefined. */
export function envValue(text, name) {
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const match = ENV_LINE.exec(line);
    if (match && match[1] === name) return unquote(match[2]);
  }
  return undefined;
}

const idList = (value) => (value ?? '').split(',').map((id) => id.trim()).filter(Boolean);

/** The service account object from server/.env's FIREBASE_SERVICE_ACCOUNT_KEY (inline JSON or a path). */
export function loadServiceAccount(serverEnvText, serverDir) {
  const key = envValue(serverEnvText, 'FIREBASE_SERVICE_ACCOUNT_KEY');
  if (!key) throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY is not set in server/.env');
  try {
    return key.startsWith('{') ? JSON.parse(key) : JSON.parse(fs.readFileSync(path.resolve(serverDir, key), 'utf8'));
  } catch (err) {
    // A JSON error message can quote the key: only the error type.
    throw new Error(`FIREBASE_SERVICE_ACCOUNT_KEY could not be read (${err.code ?? err.name})`);
  }
}

/** Compares the two project ids. Returns the lines to print. */
export function checkProjects({ rootEnvText, serverEnvText, serverDir }) {
  const appProject = envValue(rootEnvText, 'EXPO_PUBLIC_FIREBASE_PROJECT_ID') || '(not set)';
  const serverProject = loadServiceAccount(serverEnvText, serverDir).project_id || '(not set)';
  const match = appProject === serverProject && appProject !== '(not set)';
  return {
    ok: match,
    lines: [
      `App (.env EXPO_PUBLIC_FIREBASE_PROJECT_ID):   ${appProject}`,
      `Server (service account project_id):         ${serverProject}`,
      match ? 'MATCH' : 'MISMATCH',
      ...(match && appProject !== EXPECTED_PROJECT_ID ? [`Note: expected ${EXPECTED_PROJECT_ID}; both use ${appProject}.`] : []),
      ...(!match ? ['The app signs users in to one Firebase project and the server checks tokens against the other: sign-in fails. Fix .env or the service account first.'] : []),
    ],
  };
}

/**
 * Sets OFFICIAL_USER_IDS=<uid> in a dotenv text. Everything else stays byte for byte, line endings included.
 * @returns {{ ok: true, text: string, changed: boolean } | { ok: false, reason: string }}
 */
export function setOfficialUid(text, uid) {
  if (!UID_PATTERN.test(uid ?? '')) return { ok: false, reason: 'That does not look like a Firebase uid (letters, digits, - and _ only).' };
  if (idList(envValue(text, 'ADMIN_USER_IDS')).includes(uid)) {
    return { ok: false, reason: 'This uid is also in ADMIN_USER_IDS. The official account must not be an admin (it could no longer be suspended). Remove it there first.' };
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const parts = text.split(/(\r?\n)/); // keeps each line's own ending
  const indexes = [];
  for (let i = 0; i < parts.length; i += 2) {
    const match = ENV_LINE.exec(parts[i]);
    if (match && match[1] === 'OFFICIAL_USER_IDS') indexes.push(i);
  }
  if (indexes.length > 1) return { ok: false, reason: 'server/.env has more than one OFFICIAL_USER_IDS line. Keep one by hand, then run this again.' };
  const line = `OFFICIAL_USER_IDS=${uid}`;
  if (indexes.length === 1) {
    if (parts[indexes[0]] === line) return { ok: true, text, changed: false };
    parts[indexes[0]] = line;
    return { ok: true, text: parts.join(''), changed: true };
  }
  const needsBreak = text.length > 0 && !text.endsWith('\n');
  return { ok: true, text: `${text}${needsBreak ? eol : ''}${line}${eol}`, changed: true };
}

const readText = (file, label) => {
  if (!fs.existsSync(file)) throw new Error(`${label} not found`);
  return fs.readFileSync(file, 'utf8');
};

async function main() {
  const [command, arg] = process.argv.slice(2);
  const serverEnvFile = path.join(SERVER_DIR, '.env');

  if (command === 'check') {
    const result = checkProjects({
      rootEnvText: readText(path.join(ROOT, '.env'), '.env (project root)'),
      serverEnvText: readText(serverEnvFile, 'server/.env'),
      serverDir: SERVER_DIR,
    });
    result.lines.forEach((line) => console.log(line));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'find') {
    if (!arg || !arg.includes('@')) throw new Error('Usage: npm run official:find -- <email>');
    const serviceAccount = loadServiceAccount(readText(serverEnvFile, 'server/.env'), SERVER_DIR);
    const { initializeApp, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const app = initializeApp({ credential: cert(serviceAccount) }, 'official-find');
    try {
      const user = await getAuth(app).getUserByEmail(arg.trim());
      console.log(`uid:     ${user.uid}`);
      console.log(`email:   ${user.email}`);
      console.log(`created: ${user.metadata.creationTime}`);
      console.log(`project: ${serviceAccount.project_id}`);
      console.log(`Next: npm run official:set -- ${user.uid}`);
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        console.log('not found – sign up in the app first');
        process.exitCode = 1;
        return;
      }
      throw new Error(`Firebase lookup failed (${err.code ?? err.name})`);
    }
    return;
  }

  if (command === 'set') {
    // Checked before the file is opened.
    if (!UID_PATTERN.test(arg?.trim() ?? '')) throw new Error('Usage: npm run official:set -- <uid>  (letters, digits, - and _ only)');
    const result = setOfficialUid(readText(serverEnvFile, 'server/.env'), arg.trim());
    if (!result.ok) {
      console.error(result.reason);
      process.exitCode = 1;
      return;
    }
    if (!result.changed) {
      console.log('OFFICIAL_USER_IDS already has exactly this uid. Nothing changed.');
      return;
    }
    const temp = `${serverEnvFile}.tmp-${process.pid}`;
    fs.writeFileSync(temp, result.text);
    fs.renameSync(temp, serverEnvFile);
    console.log('OFFICIAL_USER_IDS set in server/.env (no other line changed).');
    console.log('Next: restart the test session (Ctrl+C, then npm run test:android), then set the name "DrinkMe" in Edit Profile.');
    return;
  }

  throw new Error('Usage: npm run official:check | npm run official:find -- <email> | npm run official:set -- <uid>');
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
