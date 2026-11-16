#!/usr/bin/env node
// Development test users in the server's Firebase project (drinkmeapp-a8fea):
//   npm run testusers:create   test1..test3@drinkme.test with random passwords
//   npm run testusers:delete   removes them again, plus any drinkmesocialapp+e2e…@gmail.com account made by
//                              an automated sign-up test. Never touches any other account.
// Passwords are saved only in logs/testusers.local.json (git-ignored) and never printed. The users'
// data on the development server (server/data) is not removed here: delete an account in the app for that.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadServiceAccount } from './official.mjs';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SERVER_DIR, '..');
export const TEST_USERS_FILE = path.join(ROOT, 'logs', 'testusers.local.json');
// test4 is the temporary admin of scripted moderation checks (ADMIN_USER_IDS set for that session only).
export const TEST_EMAILS = ['test1@drinkme.test', 'test2@drinkme.test', 'test3@drinkme.test', 'test4@drinkme.test'];
// Only these addresses may ever be deleted by this script.
export const isDeletableTestEmail = (email) => (
  TEST_EMAILS.includes(email) || /^test\d+@drinkme\.test$/.test(email ?? '') || /^drinkmesocialapp\+e2e[\w-]*@gmail\.com$/.test(email ?? '')
);

/** A random password that meets the app's and Firebase's policy: 16+ chars, upper, lower, digit, '.' and '-'. */
export function randomPassword() {
  const base = crypto.randomBytes(12).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x');
  return `${base}Aa7.-`;
}

async function auth() {
  const serviceAccount = loadServiceAccount(fs.readFileSync(path.join(SERVER_DIR, '.env'), 'utf8'), SERVER_DIR);
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  return { project: serviceAccount.project_id, auth: getAuth(initializeApp({ credential: cert(serviceAccount) }, 'testusers')) };
}

async function create() {
  const { project, auth: firebase } = await auth();
  const saved = [];
  for (const email of TEST_EMAILS) {
    const password = randomPassword();
    let user;
    try {
      user = await firebase.getUserByEmail(email);
      await firebase.updateUser(user.uid, { password, disabled: false });
    } catch (err) {
      if (err.code !== 'auth/user-not-found') throw new Error(`Firebase: ${err.code ?? err.name}`);
      user = await firebase.createUser({ email, password, emailVerified: false });
    }
    saved.push({ email, uid: user.uid, password });
    console.log(`${email}  uid ${user.uid}`);
  }
  fs.mkdirSync(path.dirname(TEST_USERS_FILE), { recursive: true });
  fs.writeFileSync(TEST_USERS_FILE, `${JSON.stringify({ project, createdAt: new Date().toISOString(), users: saved }, null, 2)}\n`);
  console.log(`Project ${project}. Passwords saved in ${path.relative(ROOT, TEST_USERS_FILE)} (git-ignored), not printed.`);
}

// Sets each saved test account's Firebase password back to the one in the file (after a test typed a
// different one). Only addresses isDeletableTestEmail accepts; never prints a password.
async function reset() {
  const { project, auth: firebase } = await auth();
  const { users } = JSON.parse(fs.readFileSync(TEST_USERS_FILE, 'utf8'));
  for (const user of users.filter((item) => isDeletableTestEmail(item.email))) {
    try {
      const found = await firebase.getUserByEmail(user.email);
      await firebase.updateUser(found.uid, { password: user.password });
      console.log(`reset ${user.email}`);
    } catch (err) {
      console.log(`${user.email}: ${err.code ?? err.name}`);
    }
  }
  console.log(`Project ${project}.`);
}

async function remove() {
  const { project, auth: firebase } = await auth();
  const toDelete = new Map();
  let pageToken;
  do {
    const page = await firebase.listUsers(1000, pageToken);
    for (const user of page.users) if (isDeletableTestEmail(user.email)) toDelete.set(user.uid, user.email);
    pageToken = page.pageToken;
  } while (pageToken);
  if (toDelete.size > 0) {
    const result = await firebase.deleteUsers([...toDelete.keys()]);
    if (result.failureCount > 0) throw new Error(`${result.failureCount} test user(s) could not be deleted`);
  }
  [...toDelete.values()].forEach((email) => console.log(`deleted ${email}`));
  if (fs.existsSync(TEST_USERS_FILE)) fs.rmSync(TEST_USERS_FILE);
  console.log(`Project ${project}: ${toDelete.size} test user(s) deleted. No other account was touched.`);
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  const command = process.argv[2];
  (command === 'create' ? create() : command === 'reset' ? reset() : command === 'delete' ? remove() : Promise.reject(new Error('Usage: npm run testusers:create | testusers:delete')))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
