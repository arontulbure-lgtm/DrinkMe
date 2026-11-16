#!/usr/bin/env node
// Development API calls as a test user (scripted device checks, JOHN_TODO section 1c). Test users only.
//
//   npm run testapi -- login <email>                      signs in through Firebase (password from
//                                                         logs/testusers.local.json) and the API; the session
//                                                         token goes to logs/testusers.tokens.local.json
//   npm run testapi -- call <email> <METHOD> <path> [json] calls the API with that session; prints the status
//                                                         and the JSON answer (test data only)
//   npm run testapi -- verify-link <email>                 generates and opens the email verification link
//   npm run testapi -- reset-password <email>              resets through Firebase's oob code (like the email
//                                                         link) to a new random password, saved in the file
//
// API base: TESTAPI_URL (default http://127.0.0.1:5000). Plain http only to this machine or a private LAN
// address (the session token goes with every call); anything else must be https. Never prints a password,
// ID token or session token. Token and password files are written owner-only (0600).
// The Firebase web API key is read from the project's Identity Toolkit config with the service account and
// is never printed either.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadServiceAccount } from './official.mjs';
import { isDeletableTestEmail, randomPassword, TEST_USERS_FILE, writeSecretFile } from './testusers.mjs';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS_FILE = path.join(path.dirname(TEST_USERS_FILE), 'testusers.tokens.local.json');
const API = (process.env.TESTAPI_URL ?? 'http://127.0.0.1:5000').replace(/\/$/, '');

// localhost, loopback, or a private IPv4 LAN address (10/8, 172.16/12, 192.168/16).
const isLocalOrPrivateHost = (hostname) => {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
};

/** Null when the API base may receive a session token, otherwise why not. */
const apiBaseProblem = (base) => {
  let url;
  try {
    url = new URL(base);
  } catch {
    return 'TESTAPI_URL is not a valid URL';
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && isLocalOrPrivateHost(url.hostname)) return null;
  return 'TESTAPI_URL must be https, or http to localhost, 127.0.0.1 or a private LAN address';
};
const IDT = 'https://identitytoolkit.googleapis.com';

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);

async function admin() {
  const serviceAccount = loadServiceAccount(fs.readFileSync(path.join(SERVER_DIR, '.env'), 'utf8'), SERVER_DIR);
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const credential = cert(serviceAccount);
  const app = initializeApp({ credential }, 'testapi');
  const accessToken = (await credential.getAccessToken()).access_token;
  const res = await fetch(`${IDT}/admin/v2/projects/${serviceAccount.project_id}/config`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Identity Toolkit config: HTTP ${res.status}`);
  const apiKey = (await res.json())?.client?.apiKey;
  if (!apiKey) throw new Error('No web API key in the project config');
  return { auth: getAuth(app), apiKey };
}

const testUser = (email) => {
  if (!isDeletableTestEmail(email)) throw new Error('Only test users (testN@drinkme.test, drinkmesocialapp+e2e…@gmail.com).');
  const user = readJson(TEST_USERS_FILE, { users: [] }).users.find((item) => item.email === email);
  if (!user) throw new Error(`${email} is not in logs/testusers.local.json (npm run testusers:create)`);
  return user;
};

const identity = async (apiKey, method, body) => {
  const res = await fetch(`${IDT}/v1/accounts:${method}?key=${apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Firebase ${method}: ${json?.error?.message ?? res.status}`);
  return json;
};

async function login(email) {
  const user = testUser(email);
  const { apiKey } = await admin();
  const signIn = await identity(apiKey, 'signInWithPassword', { email, password: user.password, returnSecureToken: true });
  const res = await fetch(`${API}/api/auth/mobile`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: signIn.idToken, uid: signIn.localId, email }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.token) {
    console.log(`login ${email}: HTTP ${res.status} ${json.code ?? json.error ?? ''}`);
    process.exitCode = 1;
    return;
  }
  const tokens = readJson(TOKENS_FILE, {});
  tokens[email] = { token: json.token, uid: signIn.localId, at: new Date().toISOString() };
  writeSecretFile(TOKENS_FILE, `${JSON.stringify(tokens, null, 2)}\n`);
  console.log(`login ${email}: OK, uid ${signIn.localId} (session saved, not printed)`);
}

async function call(email, method, apiPath, rawBody) {
  // "@file" reads the JSON body from a file (an image body is too long for a command line on Windows).
  const body = rawBody?.startsWith('@') ? fs.readFileSync(rawBody.slice(1), 'utf8') : rawBody;
  const session = readJson(TOKENS_FILE, {})[email];
  if (!session) throw new Error(`No session for ${email}: npm run testapi -- login ${email}`);
  const res = await fetch(`${API}${apiPath}`, {
    method: method.toUpperCase(),
    headers: { Authorization: `Bearer ${session.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body } : {}),
  });
  const text = await res.text();
  console.log(`${method.toUpperCase()} ${apiPath} -> ${res.status}`);
  // TESTAPI_FULL=1 prints the whole answer (for scripts that parse it).
  if (text) console.log(text.length > 3000 && process.env.TESTAPI_FULL !== '1' ? `${text.slice(0, 3000)}…` : text);
  if (!res.ok) process.exitCode = 2;
}

const oobCode = (link) => new URL(link).searchParams.get('oobCode');

async function verifyLink(email) {
  testUser(email);
  const { auth, apiKey } = await admin();
  const link = await auth.generateEmailVerificationLink(email);
  await identity(apiKey, 'update', { oobCode: oobCode(link) });
  console.log(`verify-link ${email}: email verified through the verification link`);
}

async function resetPassword(email) {
  testUser(email);
  const { auth, apiKey } = await admin();
  const link = await auth.generatePasswordResetLink(email);
  const password = randomPassword();
  await identity(apiKey, 'resetPassword', { oobCode: oobCode(link), newPassword: password });
  const data = readJson(TEST_USERS_FILE, { users: [] });
  data.users.find((item) => item.email === email).password = password;
  writeSecretFile(TEST_USERS_FILE, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`reset-password ${email}: reset through the reset link; new password saved, not printed`);
}

// Disables or enables the test user in Firebase (JOHN_TODO 2.9).
async function setDisabled(email, disabled) {
  testUser(email);
  const { auth } = await admin();
  const user = await auth.getUserByEmail(email);
  await auth.updateUser(user.uid, { disabled });
  console.log(`${disabled ? 'disabled' : 'enabled'} ${email} in Firebase`);
}

// The Verify Email screen's "Delete account" (JOHN_TODO 2.10): a fresh Firebase sign-in, then the API.
async function deleteUnverified(email) {
  const user = testUser(email);
  const { auth, apiKey } = await admin();
  const signIn = await identity(apiKey, 'signInWithPassword', { email, password: user.password, returnSecureToken: true });
  const res = await fetch(`${API}/api/account/delete-unverified`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: signIn.idToken }),
  });
  const json = await res.json().catch(() => ({}));
  let inFirebase = true;
  try { await auth.getUserByEmail(email); } catch (err) { if (err.code === 'auth/user-not-found') inFirebase = false; }
  console.log(`delete-unverified ${email}: HTTP ${res.status} ${json.code ?? ''}; still in Firebase: ${inFirebase}`);
}

const [command, email, ...rest] = process.argv.slice(2);
const run = {
  login: () => login(email),
  call: () => call(email, rest[0], rest[1], rest[2]),
  'verify-link': () => verifyLink(email),
  'reset-password': () => resetPassword(email),
  disable: () => setDisabled(email, true),
  enable: () => setDisabled(email, false),
  'delete-unverified': () => deleteUnverified(email),
}[command];
const baseProblem = apiBaseProblem(API);
(baseProblem ? Promise.reject(new Error(baseProblem)) : run ? run() : Promise.reject(new Error('Usage: npm run testapi -- login|call|verify-link|reset-password <email> …')))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
