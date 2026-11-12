import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import jwt from 'jsonwebtoken';

import { REAL_DATA_DIR, REAL_DB_FILE, startServer } from './helpers/harness.js';

const STUB_PRELOAD = new URL('./helpers/firebase-auth-stub-preload.js', import.meta.url).href;
const FAULT_PRELOAD = new URL('./helpers/db-fault-preload.js', import.meta.url).href;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const DAY_MS = 24 * 60 * 60 * 1000;
// Nothing is readable logged out, so other users' view is read with a confirmed fixture user's JWT.
const viewerToken = (uid) => jwt.sign({ uid }, 'test-only-jwt-secret', { algorithm: 'HS256', expiresIn: '1h' });
const asViewer = (uid) => ({ headers: { Authorization: `Bearer ${viewerToken(uid)}` } });

// Synthetic credentials. The key exists only in memory, for this test run.
const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const firebaseEnv = {
  ALLOW_INSECURE_DEV_AUTH: undefined,
  FIREBASE_SERVICE_ACCOUNT_KEY: JSON.stringify({
    type: 'service_account',
    project_id: 'drinkme-deletion-test',
    private_key: privateKey,
    client_email: 'deletion-test@drinkme-deletion-test.example.test',
  }),
  NODE_OPTIONS: `--import=${STUB_PRELOAD}`,
};

// Distinctive, so a search of the saved file cannot match anything by accident.
const VICTIM = 'victim-uid-7Qx';
const VICTIM_FIRST = 'Zebulon';
const VICTIM_LAST = 'Quixotic';
const VICTIM_NAME = `${VICTIM_FIRST} ${VICTIM_LAST}`;
const VICTIM_EMAIL = 'zebulon.private@example.test';
const VICTIM_TRACES = [
  VICTIM, VICTIM_FIRST, VICTIM_LAST, VICTIM_EMAIL, 'VictimPostName', 'VictimPostBody', 'VictimComment', 'VictimBarItem',
  'VictimReportText', 'CommentOnVictimPost', 'iVBORw0KGgo',
];
const BOB = 'bob-uid';
const CAROL = 'carol-uid';

const recent = () => new Date(Date.now() - 60_000).toISOString();

// Every collection holds the victim, in every role it can have.
const makeFixture = () => ({
  nextDrinkId: 40,
  nextNotificationId: 40,
  nextCommentId: 40,
  nextReportId: 40,
  dbSchemaVersion: 2,
  users: [
    {
      id: VICTIM, email: VICTIM_EMAIL, firstName: VICTIM_FIRST, lastName: VICTIM_LAST, city: 'Victimville', bio: 'VictimBio',
      avatar: TINY_PNG, nameSetByUser: true, ageConfirmedAt: recent(), avatarClearedByAdmin: true, privacyNoticeVersion: 1, privacyNoticeAt: recent(),
    },
    { id: BOB, email: 'bob@example.test', firstName: 'Bob', lastName: 'Keeper', city: '', bio: '', avatar: null, nameSetByUser: true, ageConfirmedAt: recent() },
    { id: CAROL, email: 'carol@example.test', firstName: 'Carol', lastName: 'Keeper', city: '', bio: '', avatar: null, nameSetByUser: true, ageConfirmedAt: recent() },
  ],
  drinks: [
    { id: 10, userId: VICTIM, name: 'VictimPostName', description: 'VictimPostBody', rating: 4, isAlcoholic: false, createdAt: recent(), cheersCount: 1, tags: [], imageUrl: TINY_PNG },
    { id: 20, userId: BOB, name: 'BobPost', description: 'Kept', rating: 4, isAlcoholic: false, createdAt: recent(), cheersCount: 2, tags: [], imageUrl: null },
    { id: 30, userId: CAROL, name: 'CarolPost', description: 'Kept', rating: 4, isAlcoholic: false, createdAt: recent(), cheersCount: 0, tags: [], imageUrl: null },
  ],
  commentsByDrink: {
    10: [{ id: 1, drinkId: 10, userId: BOB, content: 'CommentOnVictimPost', createdAt: recent() }],
    20: [
      { id: 2, drinkId: 20, userId: VICTIM, content: 'VictimComment', createdAt: recent() },
      { id: 3, drinkId: 20, userId: CAROL, content: 'CarolCommentKept', createdAt: recent() },
    ],
  },
  cheersByUser: { [VICTIM]: [20], [BOB]: [10], [CAROL]: [20] },
  savedByUser: { [VICTIM]: [20], [BOB]: [10, 30] },
  smartBarByUser: { [VICTIM]: [{ id: 1, name: 'VictimBarItem', quantity: '1', unit: 'bottle' }], [BOB]: [{ id: 1, name: 'BobBarItem', quantity: '1', unit: 'bottle' }] },
  partnersByUser: { [VICTIM]: [BOB], [BOB]: [VICTIM, CAROL], [CAROL]: [BOB] },
  partnerRequestsByUser: {
    [VICTIM]: [{ fromId: BOB, createdAt: recent() }],
    [CAROL]: [{ fromId: VICTIM, createdAt: recent() }, { fromId: BOB, createdAt: recent() }],
  },
  blocksByUser: { [VICTIM]: [CAROL], [BOB]: [VICTIM], [CAROL]: [VICTIM, 'someone-else'] },
  limitEventsByUser: {
    [VICTIM]: [{ kind: 'post', at: recent(), imageBytes: 10 }],
    [BOB]: [{ kind: 'comment', at: recent() }],
  },
  notificationsByUser: {
    [VICTIM]: [{ id: 1, type: 'cheer', message: 'Bob Keeper cheered your drink VictimPostName.', actorId: BOB, drinkId: 10, read: false, createdAt: recent() }],
    [BOB]: [
      { id: 2, type: 'comment', message: `${VICTIM_NAME} commented on BobPost.`, actorId: VICTIM, drinkId: 20, read: false, createdAt: recent() },
      { id: 3, type: 'cheer', message: `${VICTIM_NAME} cheered your drink BobPost.`, read: false, createdAt: recent() }, // older: no actorId
      { id: 4, type: 'partner_request', message: `${VICTIM_NAME} sent you a drink partner request.`, actorId: VICTIM, read: false, createdAt: recent() },
      { id: 5, type: 'comment', message: 'Carol Keeper commented on BobPost.', actorId: CAROL, drinkId: 20, read: false, createdAt: recent() },
      { id: 6, type: 'cheer', message: 'Someone cheered your drink BobPost.', read: false, createdAt: recent() }, // the fallback names nobody
    ],
    [CAROL]: [{ id: 7, type: 'partner', message: 'Zeb Other accepted your request.', actorId: 'other-zeb', read: false, createdAt: recent() }],
  },
  reports: [
    { id: 1, reporterId: VICTIM, targetType: 'drink', targetId: 20, reason: 'spam', details: 'VictimReportText', status: 'open', createdAt: recent() },
    { id: 2, reporterId: BOB, targetType: 'drink', targetId: 10, reason: 'spam', details: null, status: 'open', createdAt: recent() },
    { id: 3, reporterId: CAROL, targetType: 'comment', targetId: 2, drinkId: 20, reason: 'spam', details: null, status: 'open', createdAt: recent() },
    { id: 4, reporterId: CAROL, targetType: 'comment', targetId: 1, drinkId: 10, reason: 'spam', details: null, status: 'open', createdAt: recent() },
    { id: 5, reporterId: CAROL, targetType: 'user', targetId: VICTIM, reason: 'spam', details: null, status: 'open', createdAt: recent() },
    { id: 6, reporterId: BOB, targetType: 'user', targetId: VICTIM, reason: 'spam', details: null, status: 'resolved', action: 'dismiss', removed: false, resolvedAt: recent(), resolvedBy: CAROL, createdAt: recent() },
    { id: 7, reporterId: BOB, targetType: 'drink', targetId: 30, reason: 'other', details: null, status: 'resolved', action: 'dismiss', removed: false, resolvedAt: recent(), resolvedBy: VICTIM, createdAt: recent() },
    { id: 8, reporterId: CAROL, targetType: 'drink', targetId: 20, reason: 'other', details: 'kept report', status: 'open', createdAt: recent() },
  ],
  pendingAccountDeletions: [],
  // The victim's own entries, an admin action about them, one they took as an admin, and Bob's own entry.
  auditLog: [
    { id: 1, at: recent(), action: 'ack.age_confirmed', actorId: VICTIM, targetId: null },
    { id: 2, at: recent(), action: 'ack.privacy_accepted', actorId: VICTIM, targetId: null, meta: { version: 1 } },
    { id: 3, at: recent(), action: 'auth.session_revoked', actorId: VICTIM, targetId: null },
    { id: 4, at: recent(), action: 'admin.user_suspended', actorId: CAROL, targetId: VICTIM, meta: { permanent: false } },
    { id: 5, at: recent(), action: 'admin.report_resolved', actorId: VICTIM, targetId: BOB, meta: { reportId: 7, action: 'dismiss' } },
    { id: 6, at: recent(), action: 'ack.age_confirmed', actorId: BOB, targetId: null },
  ],
  nextAuditId: 7,
});

const statReal = (target) => {
  const stats = fs.statSync(target, { throwIfNoEntry: false });
  return stats ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
};

let realBefore;
before(() => {
  realBefore = [statReal(REAL_DATA_DIR), statReal(REAL_DB_FILE)];
});
after(() => {
  assert.deepEqual([statReal(REAL_DATA_DIR), statReal(REAL_DB_FILE)], realBefore, 'server/data must stay untouched');
});

// DELETION_TEST_PORT lets this file run beside another test run, which uses the harness default.
const startOn = async (t, env = {}, options = {}) => {
  const portEnv = process.env.DELETION_TEST_PORT ? { PORT: process.env.DELETION_TEST_PORT } : {};
  const server = await startServer({ ...portEnv, ...env }, options);
  t.after(() => server.stop());
  return server;
};

const post = async (baseUrl, route, body, token) => {
  const res = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const get = async (baseUrl, route, token) => {
  const res = await fetch(`${baseUrl}${route}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const devSignIn = async (baseUrl, uid) => {
  const { status, body } = await post(baseUrl, '/api/auth/mobile', { idToken: 'dev-fallback-token', uid });
  assert.equal(status, 200);
  return body.token;
};

const nowSeconds = (offsetMs = 0) => Math.floor((Date.now() + offsetMs) / 1000);
const stubToken = (uid, overrides = {}) => `stub:${JSON.stringify({
  uid, iat: nowSeconds(), auth_time: nowSeconds(), firebase: { sign_in_provider: 'password' }, ...overrides,
})}`;

const firebaseSignIn = (baseUrl, uid, overrides) => post(baseUrl, '/api/auth/mobile', { idToken: stubToken(uid, overrides), uid });

const deleteAccount = (baseUrl, uid, token, idToken) => (
  post(baseUrl, `/api/users/${uid}/delete-account`, idToken === undefined ? {} : { idToken }, token)
);

// On Windows a read can meet the server's rename of the file (EPERM and friends), and the server's own
// rename can meet this read. Both retry, so a brief clash costs a few milliseconds instead of a failure.
const TRANSIENT_READ_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const READ_RETRY_WAIT_MS = 25;
const READ_RETRIES = 40;
const readDb = (dbFile) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    } catch (err) {
      if (attempt >= READ_RETRIES || !TRANSIENT_READ_CODES.has(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, READ_RETRY_WAIT_MS);
    }
  }
};
const marker = (dbFile, suffix) => `${dbFile}${suffix}`;
const setDeleteMode = (dbFile, mode) => {
  if (mode) fs.writeFileSync(marker(dbFile, '.stub-delete-user'), mode);
  else fs.rmSync(marker(dbFile, '.stub-delete-user'), { force: true });
};
const deleteCalls = (dbFile) => {
  const file = marker(dbFile, '.stub-delete-calls');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
};

const waitFor = async (check, label) => {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

// Polls the saved file for a state, opening it only after its size or mtime changed (and once at the
// start), so the test holds the file as little as possible while the server saves.
const waitForDb = async (dbFile, check, label) => {
  let lastSeen = null;
  let result = false;
  await waitFor(() => {
    let stats;
    try {
      stats = fs.statSync(dbFile, { throwIfNoEntry: false });
    } catch (err) {
      if (TRANSIENT_READ_CODES.has(err.code)) return false;
      throw err;
    }
    const seen = stats ? `${stats.size}:${stats.mtimeMs}` : 'missing';
    if (seen !== lastSeen && stats) {
      lastSeen = seen;
      result = check(readDb(dbFile));
    }
    return result;
  }, label);
};

// An unfinished entry made by the route carries the anonymous id its cascade uses; checked, then left out.
const pendingWithoutAnonId = (db) => db.pendingAccountDeletions.map(({ anonId, ...entry }) => {
  if (entry.until === undefined) assert.match(anonId, /^deleted-[0-9a-f]{16}$/);
  else assert.equal(anonId, undefined, 'a tombstone keeps no anonymous id');
  return entry;
});
const isSettledDb = (db) => db.pendingAccountDeletions.every((entry) => entry.until !== undefined);

// The pending list is checked apart: a tombstone holds the uid and until, and nothing else; an unfinished
// entry holds the uid and the anonymous id its cascade uses (anonId).
const assertNoTrace = (dbFile, traces = VICTIM_TRACES) => {
  const { pendingAccountDeletions, ...rest } = readDb(dbFile);
  for (const entry of pendingAccountDeletions) {
    if (entry.until !== undefined) assert.deepEqual(Object.keys(entry).sort(), ['uid', 'until']);
    else assert.deepEqual(Object.keys(entry).filter((key) => key !== 'anonId'), ['uid']);
  }
  const raw = JSON.stringify(rest);
  for (const trace of traces) assert.ok(!raw.includes(trace), `the saved file still holds ${trace}`);
};

const assertOthersIntact = (dbFile, extraUserIds = []) => {
  const db = readDb(dbFile);
  assert.deepEqual(db.users.map((u) => u.id).sort(), [BOB, CAROL, ...extraUserIds].sort());
  assert.deepEqual(db.drinks.map((d) => d.id).sort(), [20, 30]);
  assert.equal(db.drinks.find((d) => d.id === 20).cheersCount, 1, 'only the victim\'s cheer goes');
  assert.deepEqual(db.commentsByDrink['20'].map((c) => c.id), [3]);
  assert.equal(db.commentsByDrink['10'], undefined);
  assert.deepEqual(db.cheersByUser[CAROL], [20]);
  assert.deepEqual(db.cheersByUser[BOB], []);
  assert.deepEqual(db.savedByUser[BOB], [30]);
  assert.deepEqual(db.smartBarByUser[BOB].map((i) => i.name), ['BobBarItem']);
  assert.deepEqual(db.partnersByUser[BOB], [CAROL]);
  assert.deepEqual(db.partnersByUser[CAROL], [BOB]);
  assert.deepEqual(db.partnerRequestsByUser[CAROL].map((r) => r.fromId), [BOB]);
  assert.equal(db.blocksByUser[BOB], undefined);
  assert.deepEqual(db.blocksByUser[CAROL], ['someone-else']);
  assert.equal(db.limitEventsByUser[BOB].length, 1);
  assert.deepEqual(db.notificationsByUser[BOB].map((n) => n.id), [5, 6]);
  assert.deepEqual(db.notificationsByUser[CAROL].map((n) => n.id), [7]);
  // Report 1, the victim's open report about Bob's post, stays under an anonymous id with no details,
  // so it still counts towards the auto-hide until an admin resolves it (owner decision of 2026-11-10).
  assert.deepEqual(db.reports.map((r) => r.id).sort(), [1, 7, 8]);
  const victimsOpenReport = db.reports.find((r) => r.id === 1);
  assert.match(victimsOpenReport.reporterId, /^deleted-[0-9a-f]{16}$/);
  assert.equal(victimsOpenReport.details, null);
  assert.equal(victimsOpenReport.status, 'open');
  const resolvedByVictim = db.reports.find((r) => r.id === 7);
  assert.equal(resolvedByVictim.reporterId, BOB);
  assert.ok(!('resolvedBy' in resolvedByVictim));
  assert.equal(db.reports.find((r) => r.id === 8).details, 'kept report');
};

// ── The cascade ───────────────────────────────────────────────────────────────
test('dev mode: every trace of the user goes, other users\' data stays correct, and nothing is logged', async (t) => {
  // A reader with no block on either side, so a 404 below can only come from the deletion.
  const fixture = makeFixture();
  fixture.users.push({ id: 'reader-uid', email: 'reader@example.test', firstName: 'Reader', lastName: 'Keeper', city: '', bio: '', avatar: null, nameSetByUser: true, ageConfirmedAt: new Date().toISOString() });
  const server = await startOn(t, {}, { dbFixture: fixture });
  const { baseUrl, dbFile, getOutput } = server;
  const token = await devSignIn(baseUrl, VICTIM);

  // Served once first, so both are in the image cache. The 404s below show no cached copy is served
  // afterwards; they do not show the memory was freed. Their log lines arrive before the marker.
  assert.equal((await fetch(`${baseUrl}/media/avatars/${VICTIM}`, asViewer('reader-uid'))).status, 200);
  assert.equal((await fetch(`${baseUrl}/media/drinks/10`, asViewer('reader-uid'))).status, 200);
  await waitFor(() => getOutput().includes('/media/drinks/10'), 'the media log lines');
  const outputBefore = getOutput().length;

  const result = await deleteAccount(baseUrl, VICTIM, token);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { deleted: true, firebaseDeleted: false }, 'no Firebase user was deleted in this mode');

  const db = readDb(dbFile);
  assert.deepEqual(db.pendingAccountDeletions, []);
  assertNoTrace(dbFile);
  assertOthersIntact(dbFile, ['reader-uid']);
  // Audit log (SEC-H): the victim's own entries go, the deletion request included. Admin entries keep the
  // anonymous id of their open report, and the completion names that id only.
  const anonymousId = db.reports.find((r) => r.id === 1).reporterId;
  assert.deepEqual(db.auditLog.map(({ id, action, actorId, targetId }) => ({ id, action, actorId, targetId })), [
    { id: 4, action: 'admin.user_suspended', actorId: CAROL, targetId: anonymousId },
    { id: 5, action: 'admin.report_resolved', actorId: anonymousId, targetId: BOB },
    { id: 6, action: 'ack.age_confirmed', actorId: BOB, targetId: null },
    { id: 8, action: 'account.deletion_completed', actorId: null, targetId: anonymousId },
  ]);

  await waitFor(() => getOutput().includes('delete-account'), 'the request log line');
  const output = getOutput().slice(outputBefore);
  for (const trace of [VICTIM, VICTIM_FIRST, VICTIM_LAST, VICTIM_EMAIL]) assert.ok(!output.includes(trace), `the log holds ${trace}`);

  assert.equal((await fetch(`${baseUrl}/media/avatars/${VICTIM}`, asViewer('reader-uid'))).status, 404);
  assert.equal((await fetch(`${baseUrl}/media/drinks/10`, asViewer('reader-uid'))).status, 404);
  assert.equal((await get(baseUrl, `/api/users/${VICTIM}`, viewerToken('reader-uid'))).status, 404);

  // The old JWT now counts as logged out, on this route too.
  assert.equal((await get(baseUrl, '/api/smart-bar', token)).status, 401);
  assert.equal((await deleteAccount(baseUrl, VICTIM, token)).status, 401);

  // And the file stays clean across a restart.
  await server.restart();
  assertNoTrace(dbFile);
  assertOthersIntact(dbFile, ['reader-uid']);
});

test('another user with the same name keeps a notification that has their own actorId', async (t) => {
  const fixture = makeFixture();
  fixture.notificationsByUser[CAROL] = [
    { id: 7, type: 'partner', message: `${VICTIM_NAME} accepted your request.`, actorId: 'namesake-uid', read: false, createdAt: recent() },
  ];
  const { baseUrl, dbFile } = await startOn(t, {}, { dbFixture: fixture });
  const token = await devSignIn(baseUrl, VICTIM);
  assert.equal((await deleteAccount(baseUrl, VICTIM, token)).status, 200);
  assert.deepEqual(readDb(dbFile).notificationsByUser[CAROL].map((n) => n.id), [7]);
});

test('deleting Ana leaves an older notification from Ana Pop, and takes her own', async (t) => {
  const fixture = makeFixture();
  fixture.users[0].firstName = 'Ana';
  fixture.users[0].lastName = '';
  fixture.notificationsByUser[BOB] = [
    { id: 8, type: 'comment', message: 'Ana Pop commented on BobPost.', read: false, createdAt: recent() },
    { id: 9, type: 'comment', message: 'Ana commented on BobPost.', read: false, createdAt: recent() },
  ];
  const { baseUrl, dbFile } = await startOn(t, {}, { dbFixture: fixture });
  const token = await devSignIn(baseUrl, VICTIM);
  assert.equal((await deleteAccount(baseUrl, VICTIM, token)).status, 200);
  assert.deepEqual(readDb(dbFile).notificationsByUser[BOB].map((n) => n.id), [8]);
});

// Sends part of the body, deletes the account while it is held, then finishes it.
const sendBodySlowly = (baseUrl, route, token, body, whileHeld) => new Promise((resolve, reject) => {
  const { hostname, port } = new URL(baseUrl);
  const bytes = Buffer.from(JSON.stringify(body));
  const req = http.request({
    hostname, port, path: route, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': bytes.length, Authorization: `Bearer ${token}` },
  }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', reject);
  req.write(bytes.subarray(0, 10));
  setTimeout(async () => {
    try {
      await whileHeld();
      req.end(bytes.subarray(10));
    } catch (err) {
      reject(err);
    }
  }, 300);
});

for (const [label, route, body] of [
  ['post', '/api/drinks', { name: 'SlowPost', description: 'SlowBody', rating: 4, isAlcoholic: false, imageData: TINY_PNG }],
  ['avatar', `/api/users/${VICTIM}/avatar`, { imageData: TINY_PNG }],
]) {
  test(`a ${label} body that finishes after the deletion writes nothing`, async (t) => {
    const fixture = makeFixture();
    fixture.users[0].avatar = null;
    const { baseUrl, dbFile } = await startOn(t, {}, { dbFixture: fixture });
    const token = await devSignIn(baseUrl, VICTIM);
    const status = await sendBodySlowly(baseUrl, route, token, body, async () => {
      assert.equal((await deleteAccount(baseUrl, VICTIM, token)).status, 200);
    });
    assert.equal(status, 401);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assertNoTrace(dbFile, [...VICTIM_TRACES, 'SlowPost']);
    assert.equal(readDb(dbFile).limitEventsByUser[VICTIM], undefined);
  });
}

test('the deletion path is masked in the log whatever its case', async (t) => {
  const { baseUrl, getOutput } = await startOn(t, {}, { dbFixture: makeFixture() });
  const token = await devSignIn(baseUrl, VICTIM);
  const res = await post(baseUrl, `/API/USERS/${VICTIM}/DELETE-ACCOUNT`, {}, token);
  assert.equal(res.status, 200);
  await waitFor(() => /DELETE-ACCOUNT/.test(getOutput()), 'the request log line');
  assert.ok(!getOutput().includes(VICTIM));
});

test('a user with no name and old "Someone" notifications loses only what names them', async (t) => {
  const fixture = makeFixture();
  fixture.users[0].firstName = '';
  fixture.users[0].lastName = '';
  fixture.notificationsByUser[BOB] = [
    { id: 6, type: 'cheer', message: 'Someone cheered your drink BobPost.', read: false, createdAt: recent() },
  ];
  const { baseUrl, dbFile } = await startOn(t, {}, { dbFixture: fixture });
  const token = await devSignIn(baseUrl, VICTIM);
  assert.equal((await deleteAccount(baseUrl, VICTIM, token)).status, 200);
  assert.deepEqual(readDb(dbFile).notificationsByUser[BOB].map((n) => n.id), [6]);
});

test('the same uid signing in again starts clean, with no partner link or request coming back', async (t) => {
  const server = await startOn(t, {}, { dbFixture: makeFixture() });
  const { baseUrl, dbFile } = server;
  const token = await devSignIn(baseUrl, VICTIM);
  assert.equal((await deleteAccount(baseUrl, VICTIM, token)).status, 200);

  await server.restart();
  const newToken = await devSignIn(baseUrl, VICTIM);
  const stored = readDb(dbFile).users.find((u) => u.id === VICTIM);
  assert.equal(stored.bio, '');
  assert.equal(stored.avatar, null);
  assert.equal(stored.firstName, '');
  assert.ok(!('ageConfirmedAt' in stored));
  assert.ok(!('avatarClearedByAdmin' in stored));
  assert.ok(!('privacyNoticeVersion' in stored));
  assert.ok(!('privacyNoticeAt' in stored));

  // A new account: the 18+ confirmation comes first, as for anyone.
  assert.equal((await post(baseUrl, `/api/users/${VICTIM}/acknowledgements`, { type: 'age', confirmed: true }, newToken)).status, 200);
  assert.equal((await get(baseUrl, '/api/friends/count', newToken)).body, 0);
  assert.deepEqual((await get(baseUrl, '/api/drink-partners', newToken)).body, []);
  assert.deepEqual((await get(baseUrl, '/api/drink-partners/requests', newToken)).body, { incoming: [], outgoing: [] });
  assert.deepEqual((await get(baseUrl, '/api/smart-bar', newToken)).body, []);
  assert.deepEqual((await get(baseUrl, '/api/notifications', newToken)).body, { notifications: [], unreadCount: 0 });
  assert.deepEqual((await get(baseUrl, '/api/blocks', newToken)).body, []);
  assert.deepEqual((await get(baseUrl, `/api/users/${VICTIM}/saved-drinks`, newToken)).body.items, []);
  assert.deepEqual((await get(baseUrl, `/api/drinks/user/${VICTIM}`, newToken)).body.items, []);

  const bobToken = await devSignIn(baseUrl, BOB);
  assert.deepEqual((await get(baseUrl, '/api/drink-partners', bobToken)).body.map((u) => u.id), [CAROL]);
  const db = readDb(dbFile);
  assert.ok(!db.partnersByUser[BOB].includes(VICTIM));
  assert.deepEqual(db.partnersByUser[VICTIM], []);
});

// ── Who may delete ────────────────────────────────────────────────────────────
test('logged out gets 401 and another user gets 403, and nothing changes', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, {}, { dbFixture: makeFixture() });
  const bobToken = await devSignIn(baseUrl, BOB);
  const before = fs.readFileSync(dbFile, 'utf8');

  assert.equal((await deleteAccount(baseUrl, VICTIM)).status, 401);
  assert.equal((await deleteAccount(baseUrl, VICTIM, bobToken)).status, 403);
  assert.equal((await deleteAccount(baseUrl, VICTIM, 'not-a-jwt')).status, 401);
  assert.equal(fs.readFileSync(dbFile, 'utf8'), before);
});

test('Firebase mode: the JWT alone is not enough, and a missing, bad or future-dated ID token is refused', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: makeFixture() });
  const signedIn = await firebaseSignIn(baseUrl, VICTIM);
  assert.equal(signedIn.status, 200);
  const token = signedIn.body.token;
  const before = fs.readFileSync(dbFile, 'utf8');

  // Exactly the per-account limit of 5. The next test covers an old and a foreign token.
  for (const idToken of [undefined, '', 42, 'not-a-stub-token', stubToken(VICTIM, { iat: nowSeconds(5 * 60 * 1000) })]) {
    assert.equal((await deleteAccount(baseUrl, VICTIM, token, idToken)).status, 401, String(idToken));
  }
  assert.equal(fs.readFileSync(dbFile, 'utf8'), before);
  assert.deepEqual(deleteCalls(dbFile), []);
});

test('Firebase mode: an old or foreign ID token is refused', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: makeFixture() });
  const { token } = (await firebaseSignIn(baseUrl, VICTIM)).body;
  const before = fs.readFileSync(dbFile, 'utf8');
  const oldToken = stubToken(VICTIM, { iat: Math.floor((Date.now() - 6 * 60 * 1000) / 1000) });

  const old = await deleteAccount(baseUrl, VICTIM, token, oldToken);
  assert.equal(old.status, 401);
  assert.equal(old.body.code, 'reauth_required');
  assert.equal((await deleteAccount(baseUrl, VICTIM, token, stubToken(BOB))).status, 403);
  assert.equal(fs.readFileSync(dbFile, 'utf8'), before);
  assert.deepEqual(deleteCalls(dbFile), []);
});

test('Firebase mode: a password account needs a recent sign-in, and a revoked session is refused', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: makeFixture() });
  const { token } = (await firebaseSignIn(baseUrl, VICTIM)).body;
  const before = fs.readFileSync(dbFile, 'utf8');
  const old = nowSeconds(-6 * 60 * 1000);

  const refusedOldSignIn = await deleteAccount(baseUrl, VICTIM, token, stubToken(VICTIM, { auth_time: old }));
  assert.equal(refusedOldSignIn.status, 401);
  assert.equal(refusedOldSignIn.body.code, 'reauth_required');
  assert.equal((await deleteAccount(baseUrl, VICTIM, token, stubToken(VICTIM, { auth_time: undefined }))).status, 401);
  assert.equal((await deleteAccount(baseUrl, VICTIM, token, stubToken(VICTIM, { firebase: undefined }))).status, 401);

  fs.writeFileSync(marker(dbFile, '.stub-revoked'), '');
  assert.equal((await deleteAccount(baseUrl, VICTIM, token, stubToken(VICTIM))).status, 401);
  assert.equal(fs.readFileSync(dbFile, 'utf8'), before);
  assert.deepEqual(deleteCalls(dbFile), []);
});

test('Firebase mode: a Google account cannot sign in again from here, so a fresh token with an old sign-in passes', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: makeFixture() });
  const { token } = (await firebaseSignIn(baseUrl, VICTIM)).body;
  const result = await deleteAccount(baseUrl, VICTIM, token, stubToken(VICTIM, {
    auth_time: nowSeconds(-30 * 24 * 60 * 60 * 1000),
    firebase: { sign_in_provider: 'google.com' },
  }));
  assert.equal(result.status, 200);
  assert.deepEqual(deleteCalls(dbFile), [VICTIM]);
});

test('the route is limited per account, and another user\'s attempts do not use up the limit', async (t) => {
  const { baseUrl } = await startOn(t, firebaseEnv, { dbFixture: makeFixture() });
  const { token } = (await firebaseSignIn(baseUrl, VICTIM)).body;
  const bob = (await firebaseSignIn(baseUrl, BOB)).body.token;
  for (let i = 0; i < 6; i++) assert.equal((await deleteAccount(baseUrl, VICTIM, bob, 'bad')).status, 403);
  for (let i = 0; i < 5; i++) assert.equal((await deleteAccount(baseUrl, VICTIM, token, 'bad')).status, 401);
  assert.equal((await deleteAccount(baseUrl, VICTIM, token, 'bad')).status, 429);
});

test('it works at the storage limit', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, { DB_GROWTH_MAX_BYTES: '100' }, { dbFixture: makeFixture() });
  const token = await devSignIn(baseUrl, VICTIM);
  assert.equal((await deleteAccount(baseUrl, VICTIM, token)).status, 200);
  assertNoTrace(dbFile);
});

// ── Firebase steps ────────────────────────────────────────────────────────────
test('Firebase mode: success removes the data and the Firebase user, and clears the entry', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: makeFixture() });
  const { token } = (await firebaseSignIn(baseUrl, VICTIM)).body;

  const result = await deleteAccount(baseUrl, VICTIM, token, stubToken(VICTIM));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { deleted: true, firebaseDeleted: true });
  assert.deepEqual(deleteCalls(dbFile), [VICTIM]);
  const [tombstone, ...others] = readDb(dbFile).pendingAccountDeletions;
  assert.deepEqual(others, []);
  assert.equal(tombstone.uid, VICTIM);
  // One second of slack: the server and this process read the clock separately, and on Windows the
  // server's read, made earlier, has been seen a few milliseconds ahead of this one.
  const checkedAt = Date.now();
  assert.ok(tombstone.until > checkedAt && tombstone.until <= checkedAt + 60 * 60 * 1000 + 1000, JSON.stringify({ tombstone, checkedAt }));
  assertNoTrace(dbFile);
  assertOthersIntact(dbFile);
});

test('Firebase reporting the user as not found counts as success', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: makeFixture() });
  const { token } = (await firebaseSignIn(baseUrl, VICTIM)).body;
  setDeleteMode(dbFile, 'not-found');

  const result = await deleteAccount(baseUrl, VICTIM, token, stubToken(VICTIM));
  assert.deepEqual(result.body, { deleted: true, firebaseDeleted: true });
  assert.ok(isSettledDb(readDb(dbFile)));
});

test('a Firebase failure says so, keeps the entry, refuses sign-in, and a sign-in retry clears it', async (t) => {
  const { baseUrl, dbFile, getOutput } = await startOn(t, firebaseEnv, { dbFixture: makeFixture() });
  const { token } = (await firebaseSignIn(baseUrl, VICTIM)).body;
  setDeleteMode(dbFile, 'fail');

  const result = await deleteAccount(baseUrl, VICTIM, token, stubToken(VICTIM));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { deleted: true, firebaseDeleted: false }, 'never a false success');
  assert.deepEqual(pendingWithoutAnonId(readDb(dbFile)), [{ uid: VICTIM }]);
  assertOthersIntact(dbFile);
  assertNoTrace(dbFile, VICTIM_TRACES.filter((trace) => trace !== VICTIM));
  await waitFor(() => getOutput().includes('deleteUser failed'), 'the failure log line');
  assert.ok(!getOutput().includes(VICTIM), 'the stub puts the uid in its error message, which must not be logged');

  // Still failing: 410, no user created, and the entry stays.
  const refused = await firebaseSignIn(baseUrl, VICTIM);
  assert.equal(refused.status, 410);
  assert.equal(refused.body.code, 'account_deleted');
  await waitFor(() => deleteCalls(dbFile).length === 2, 'the retry');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!readDb(dbFile).users.some((u) => u.id === VICTIM));
  assert.deepEqual(pendingWithoutAnonId(readDb(dbFile)), [{ uid: VICTIM }]);

  // An unverified token learns nothing and causes no retry.
  assert.equal((await post(baseUrl, '/api/auth/mobile', { idToken: 'bad', uid: VICTIM })).status, 401);
  assert.equal(deleteCalls(dbFile).length, 2);

  // Firebase is back: this sign-in is still refused, and its retry finishes the job.
  setDeleteMode(dbFile, null);
  assert.equal((await firebaseSignIn(baseUrl, VICTIM)).status, 410);
  await waitForDb(dbFile, isSettledDb, 'the entry to clear');
  assertNoTrace(dbFile);
});

test('a Firebase failure is retried periodically, with nobody restarting or signing in', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, { ...firebaseEnv, ACCOUNT_DELETION_RETRY_INTERVAL_MS: '300' }, { dbFixture: makeFixture() });
  const { token } = (await firebaseSignIn(baseUrl, VICTIM)).body;
  setDeleteMode(dbFile, 'fail');
  assert.equal((await deleteAccount(baseUrl, VICTIM, token, stubToken(VICTIM))).body.firebaseDeleted, false);
  await waitFor(() => deleteCalls(dbFile).length >= 2, 'a periodic attempt');
  assert.ok(!isSettledDb(readDb(dbFile)));
  setDeleteMode(dbFile, null);
  await waitForDb(dbFile, isSettledDb, 'the entry to clear');
});

test('a tombstone is pruned once it expires, and then holds nothing', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, { ...firebaseEnv, ACCOUNT_TOMBSTONE_MS: '500', ACCOUNT_DELETION_RETRY_INTERVAL_MS: '200' }, { dbFixture: makeFixture() });
  const { token } = (await firebaseSignIn(baseUrl, VICTIM)).body;
  assert.equal((await deleteAccount(baseUrl, VICTIM, token, stubToken(VICTIM))).status, 200);
  await waitForDb(dbFile, (db) => db.pendingAccountDeletions.length === 0, 'the prune');
  assert.ok(!fs.readFileSync(dbFile, 'utf8').includes(VICTIM));
});

test('an expired tombstone in the file is pruned at startup', async (t) => {
  const fixture = makeFixture();
  fixture.pendingAccountDeletions = [{ uid: 'long-gone-uid', until: Date.now() - 1000 }];
  const { dbFile } = await startOn(t, firebaseEnv, { dbFixture: fixture });
  assert.deepEqual(readDb(dbFile).pendingAccountDeletions, []);
});

test('a Firebase failure is retried at the next start', async (t) => {
  const server = await startOn(t, firebaseEnv, { dbFixture: makeFixture() });
  const { baseUrl, dbFile } = server;
  const { token } = (await firebaseSignIn(baseUrl, VICTIM)).body;
  setDeleteMode(dbFile, 'fail');
  assert.equal((await deleteAccount(baseUrl, VICTIM, token, stubToken(VICTIM))).body.firebaseDeleted, false);

  // Still failing at this start: nothing is lost.
  await server.restart();
  await waitFor(() => deleteCalls(dbFile).length === 2, 'the startup retry');
  assert.deepEqual(pendingWithoutAnonId(readDb(dbFile)), [{ uid: VICTIM }]);
  assert.equal((await firebaseSignIn(baseUrl, VICTIM)).status, 410);

  setDeleteMode(dbFile, null);
  await server.restart();
  await waitForDb(dbFile, isSettledDb, 'the entry to clear');
  assertNoTrace(dbFile);
});

test('a token issued before the deletion cannot bring the account back, even during a Firebase outage', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: makeFixture() });
  const { token } = (await firebaseSignIn(baseUrl, VICTIM)).body;
  assert.equal((await deleteAccount(baseUrl, VICTIM, token, stubToken(VICTIM))).status, 200);

  // The tombstone decides, whatever the user lookup would say.
  fs.writeFileSync(marker(dbFile, '.stub-user-gone'), 'outage');
  const refused = await firebaseSignIn(baseUrl, VICTIM);
  assert.equal(refused.status, 410);
  assert.equal(refused.body.code, 'account_deleted');
  assert.equal((await firebaseSignIn(baseUrl, VICTIM, { iat: undefined })).status, 410);
  assertNoTrace(dbFile);

  // A genuinely new user is not held up by the outage.
  assert.equal((await firebaseSignIn(baseUrl, 'brand-new-uid')).status, 200);

  // Within the clock margin the delete route accepts, a token still counts as from before.
  assert.equal((await firebaseSignIn(baseUrl, VICTIM, { iat: nowSeconds(30_000) })).status, 410);

  // A later token with no tombstone reason, for a user Firebase says is gone: still refused.
  fs.writeFileSync(marker(dbFile, '.stub-user-gone'), '');
  assert.equal((await firebaseSignIn(baseUrl, VICTIM, { iat: nowSeconds(65_000) })).status, 410);
  assertNoTrace(dbFile);

  // A new account that has this uid is a different matter: it signs in and starts clean.
  fs.rmSync(marker(dbFile, '.stub-user-gone'));
  const signedIn = await firebaseSignIn(baseUrl, VICTIM, { iat: nowSeconds(65_000) });
  assert.equal(signedIn.status, 200);
  const stored = readDb(dbFile).users.find((u) => u.id === VICTIM);
  assert.equal(stored.bio, '');
  assert.deepEqual(readDb(dbFile).partnersByUser[VICTIM], []);
  assert.ok(!readDb(dbFile).partnersByUser[BOB].includes(VICTIM));
});

test('a sign-in waiting in the user lookup while a deletion finishes creates nothing', async (t) => {
  const uid = 'racer-uid';
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: makeFixture() });

  fs.writeFileSync(marker(dbFile, '.stub-get-user-delay'), '1500');
  const slowSignIn = firebaseSignIn(baseUrl, uid);
  await waitFor(() => !fs.existsSync(marker(dbFile, '.stub-get-user-delay')), 'the slow lookup to start');

  const { token } = (await firebaseSignIn(baseUrl, uid)).body;
  assert.equal((await deleteAccount(baseUrl, uid, token, stubToken(uid))).status, 200);

  const slow = await slowSignIn;
  assert.equal(slow.status, 410);
  assert.equal(slow.body.code, 'account_deleted');
  assert.ok(!readDb(dbFile).users.some((user) => user.id === uid));
});

test('a tombstone loaded with a far-off expiry cannot outlast the retention', async (t) => {
  const fixture = makeFixture();
  fixture.pendingAccountDeletions = [{ uid: 'long-gone-uid', until: Date.now() + 90 * DAY_MS }];
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: fixture });
  assert.equal((await firebaseSignIn(baseUrl, BOB)).status, 200);
  const [entry] = readDb(dbFile).pendingAccountDeletions;
  assert.ok(entry.until <= Date.now() + 60 * 60 * 1000);
});

test('while a uid is pending it reads as not found to others, as a user and as a target', async (t) => {
  const uid = 'fault-injected-user';
  const fixture = JSON.parse(JSON.stringify(makeFixture()).replaceAll(VICTIM, uid));
  fixture.users.push({ id: 'dana-uid', email: 'dana@example.test', firstName: 'Dana', lastName: 'Keeper', city: '', bio: '', avatar: null, nameSetByUser: true, ageConfirmedAt: new Date().toISOString() });
  const env = { ...firebaseEnv, DB_FAULT: 'cascade', NODE_OPTIONS: `--import=${STUB_PRELOAD} --import=${FAULT_PRELOAD}` };
  const { baseUrl, dbFile } = await startOn(t, env, { dbFixture: fixture });
  const { token } = (await firebaseSignIn(baseUrl, uid)).body;
  const dana = (await firebaseSignIn(baseUrl, 'dana-uid')).body.token;
  const send = async (method, route) => (await fetch(`${baseUrl}${route}`, {
    method, headers: { Authorization: `Bearer ${dana}`, 'Content-Type': 'application/json' },
  })).status;
  assert.equal((await get(baseUrl, `/api/users/${uid}`, dana)).status, 200, 'the fixture is visible before');
  assert.equal((await get(baseUrl, `/api/users/search?q=${VICTIM_FIRST}`, dana)).body.length, 1, 'and searchable');

  fs.writeFileSync(marker(dbFile, '.fail-cascade'), '');
  assert.equal((await deleteAccount(baseUrl, uid, token, stubToken(uid))).status, 500);
  assert.ok(readDb(dbFile).users.some((user) => user.id === uid), 'the record is still there');

  assert.equal((await get(baseUrl, `/api/users/${uid}`, dana)).status, 404);
  assert.equal((await fetch(`${baseUrl}/media/avatars/${uid}`, { headers: { Authorization: `Bearer ${dana}` } })).status, 404);
  assert.deepEqual((await get(baseUrl, `/api/users/search?q=${VICTIM_FIRST}`, dana)).body, []);
  assert.equal((await get(baseUrl, `/api/users/${uid}/partners`, dana)).status, 404);
  assert.equal(await send('POST', `/api/drink-partners/${uid}`), 404);
  assert.equal(await send('DELETE', `/api/drink-partners/${uid}`), 404);
  assert.equal(await send('POST', `/api/blocks/${uid}`), 404);
  assert.equal((await post(baseUrl, '/api/reports', { targetType: 'user', targetId: uid, reason: 'spam' }, dana)).status, 404);
  assert.ok(!(await get(baseUrl, '/api/drink-partners', (await firebaseSignIn(baseUrl, BOB)).body.token)).body.some((user) => user.id === uid));
});

test('an existing user\'s sign-in does not depend on the Firebase user lookup', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: makeFixture() });
  fs.writeFileSync(marker(dbFile, '.stub-user-gone'), '');
  assert.equal((await firebaseSignIn(baseUrl, BOB)).status, 200);
});

// ── Failed saves and crashes ──────────────────────────────────────────────────
const faultEnv = { DB_FAULT: 'save', NODE_OPTIONS: `--import=${FAULT_PRELOAD}` };

test('a failed first save returns 503 and changes nothing', async (t) => {
  const server = await startOn(t, faultEnv, { dbFixture: makeFixture() });
  const { baseUrl, dbFile } = server;
  const token = await devSignIn(baseUrl, VICTIM);
  const before = fs.readFileSync(dbFile, 'utf8');

  fs.writeFileSync(marker(dbFile, '.fail-saves'), '');
  const failed = await deleteAccount(baseUrl, VICTIM, token);
  assert.equal(failed.status, 503);
  fs.rmSync(marker(dbFile, '.fail-saves'));
  assert.equal(fs.readFileSync(dbFile, 'utf8'), before);

  // The account still works, and the entry is gone from memory too.
  assert.equal((await get(baseUrl, '/api/smart-bar', token)).status, 200);
  assert.equal((await post(baseUrl, '/api/notifications/read', {}, token)).status, 200);
  const db = readDb(dbFile);
  assert.deepEqual(db.pendingAccountDeletions, []);
  assert.ok(db.users.some((u) => u.id === VICTIM));
  assert.equal(db.drinks.length, 3);
});

test('a crash after the entry was saved finishes the cascade at startup, before any request', async (t) => {
  const fixture = makeFixture();
  fixture.pendingAccountDeletions = [{ uid: VICTIM }];
  const { baseUrl, dbFile, getOutput } = await startOn(t, {}, { dbFixture: fixture });

  assertNoTrace(dbFile, VICTIM_TRACES.filter((trace) => trace !== VICTIM));
  assertOthersIntact(dbFile);
  assert.ok(!getOutput().includes(VICTIM));
  assert.equal((await get(baseUrl, `/api/users/${VICTIM}`, viewerToken(BOB))).status, 404);

  // With no Firebase here the sign-in account cannot be removed, so only the route may clear the entry.
  assert.deepEqual(readDb(dbFile).pendingAccountDeletions, [{ uid: VICTIM }]);
  assert.equal((await post(baseUrl, '/api/auth/mobile', { idToken: 'dev-fallback-token', uid: VICTIM })).status, 410);
  assert.deepEqual(readDb(dbFile).pendingAccountDeletions, [{ uid: VICTIM }]);
});

test('Firebase mode: a crash mid-way finishes at startup, and repeating the cascade is harmless', async (t) => {
  const fixture = makeFixture();
  fixture.pendingAccountDeletions = [{ uid: VICTIM }];
  const server = await startOn(t, firebaseEnv, { dbFixture: fixture });
  const { dbFile } = server;
  await waitForDb(dbFile, isSettledDb, 'the entry to clear');
  assert.deepEqual(deleteCalls(dbFile), [VICTIM]);
  assertNoTrace(dbFile);
  assertOthersIntact(dbFile);

  // The crash came after the cascade was saved: the entry alone is left, and the counts must not move again.
  const cascaded = readDb(dbFile);
  cascaded.pendingAccountDeletions = [{ uid: VICTIM }];
  await server.restart({ dbFixture: cascaded });
  await waitForDb(dbFile, isSettledDb, 'the entry to clear');
  assertOthersIntact(dbFile);
});

test('a failed save after Firebase succeeded keeps the entry on disk, and the next start finishes', async (t) => {
  const server = await startOn(t, { ...firebaseEnv, DB_FAULT: 'save', NODE_OPTIONS: `--import=${STUB_PRELOAD} --import=${FAULT_PRELOAD}` }, { dbFixture: makeFixture() });
  const { baseUrl, dbFile } = server;
  const { token } = (await firebaseSignIn(baseUrl, VICTIM)).body;
  setDeleteMode(dbFile, 'fail-saves');

  const result = await deleteAccount(baseUrl, VICTIM, token, stubToken(VICTIM));
  assert.deepEqual(result.body, { deleted: true, firebaseDeleted: true });
  assert.deepEqual(pendingWithoutAnonId(readDb(dbFile)), [{ uid: VICTIM }]);

  fs.rmSync(marker(dbFile, '.fail-saves'));
  setDeleteMode(dbFile, 'not-found');
  await server.restart();
  await waitForDb(dbFile, isSettledDb, 'the entry to clear');
  assertNoTrace(dbFile);
});

// The fault preload throws on this uid only. Everything else about the fixture is the usual one.
const makeCascadeFaultFixture = () => JSON.parse(JSON.stringify(makeFixture()).replaceAll(VICTIM, 'fault-injected-user'));

const cascadeFaultEnv = { ...firebaseEnv, DB_FAULT: 'cascade', NODE_OPTIONS: `--import=${STUB_PRELOAD} --import=${FAULT_PRELOAD}` };

test('Firebase mode: a cascade that fails says so and blocks the JWT, and the sign-in branch finishes it', async (t) => {
  const uid = 'fault-injected-user';
  const { baseUrl, dbFile } = await startOn(t, cascadeFaultEnv, { dbFixture: makeCascadeFaultFixture() });
  const { token } = (await firebaseSignIn(baseUrl, uid)).body;
  fs.writeFileSync(marker(dbFile, '.fail-cascade'), '');

  const failed = await deleteAccount(baseUrl, uid, token, stubToken(uid));
  assert.equal(failed.status, 500);
  assert.equal(failed.body.code, 'account_deletion_incomplete');
  assert.ok(!('deleted' in failed.body));
  assert.deepEqual(pendingWithoutAnonId(readDb(dbFile)), [{ uid }], 'the entry must survive');

  // The record is still there, but the old JWT reads and writes nothing, and cannot repeat the request.
  assert.equal((await get(baseUrl, '/api/smart-bar', token)).status, 401);
  assert.equal((await post(baseUrl, '/api/smart-bar', { name: 'x', quantity: '1' }, token)).status, 401);
  assert.equal((await deleteAccount(baseUrl, uid, token, stubToken(uid))).status, 401);

  // Still failing: refused, and the entry stays even though Firebase accepted the deletion.
  assert.equal((await firebaseSignIn(baseUrl, uid)).status, 410);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(pendingWithoutAnonId(readDb(dbFile)), [{ uid }], 'an unfinished cascade must not clear');

  fs.rmSync(marker(dbFile, '.fail-cascade'));
  assert.equal((await firebaseSignIn(baseUrl, uid)).status, 410);
  await waitForDb(dbFile, isSettledDb, 'the sign-in branch to finish it');
  assertNoTrace(dbFile, [uid, ...VICTIM_TRACES.filter((trace) => trace !== VICTIM)]);
  assertOthersIntact(dbFile);
});

test('Firebase mode: a cascade that failed finishes on the periodic retry, with no token needed', async (t) => {
  const uid = 'fault-injected-user';
  const { baseUrl, dbFile } = await startOn(t, { ...cascadeFaultEnv, ACCOUNT_DELETION_RETRY_INTERVAL_MS: '300' }, { dbFixture: makeCascadeFaultFixture() });
  const { token } = (await firebaseSignIn(baseUrl, uid)).body;
  fs.writeFileSync(marker(dbFile, '.fail-cascade'), '');
  assert.equal((await deleteAccount(baseUrl, uid, token, stubToken(uid))).status, 500);

  fs.rmSync(marker(dbFile, '.fail-cascade'));
  await waitForDb(dbFile, isSettledDb, 'the periodic retry');
  assertNoTrace(dbFile, [uid, ...VICTIM_TRACES.filter((trace) => trace !== VICTIM)]);
  assertOthersIntact(dbFile);
});

test('Firebase mode: a cascade that failed finishes at the next start', async (t) => {
  const uid = 'fault-injected-user';
  const server = await startOn(t, cascadeFaultEnv, { dbFixture: makeCascadeFaultFixture() });
  const { baseUrl, dbFile } = server;
  const { token } = (await firebaseSignIn(baseUrl, uid)).body;
  fs.writeFileSync(marker(dbFile, '.fail-cascade'), '');
  assert.equal((await deleteAccount(baseUrl, uid, token, stubToken(uid))).status, 500);

  fs.rmSync(marker(dbFile, '.fail-cascade'));
  await server.restart();
  await waitForDb(dbFile, isSettledDb, 'the entry to clear');
  assertNoTrace(dbFile, [uid, ...VICTIM_TRACES.filter((trace) => trace !== VICTIM)]);
  assertOthersIntact(dbFile);
});

test('a malformed pending list keeps the server up: bad entries are dropped, duplicates merged', async (t) => {
  const fixture = makeFixture();
  fixture.pendingAccountDeletions = [{ uid: 42 }, {}, { uid: VICTIM }, { uid: VICTIM }];
  const { dbFile } = await startOn(t, {}, { dbFixture: fixture });
  assert.deepEqual(readDb(dbFile).pendingAccountDeletions, [{ uid: VICTIM }]);
  assertNoTrace(dbFile, VICTIM_TRACES.filter((trace) => trace !== VICTIM));
});

// ── Backup retention ──────────────────────────────────────────────────────────
const DB_NAME = 'db.json';

const KEEPER = { id: 'keeper-uid', email: 'keeper@example.test', firstName: 'Keeper', lastName: '', city: '', bio: '', avatar: null };
const makeDbDir = (t, fixture = { nextDrinkId: 1, dbSchemaVersion: 2, users: [KEEPER] }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drinkme-retention-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const dbFile = path.join(dir, DB_NAME);
  if (typeof fixture === 'string') fs.writeFileSync(dbFile, fixture);
  else fs.writeFileSync(dbFile, JSON.stringify(fixture));
  return { dir, dbFile };
};

const place = (dir, name) => {
  fs.writeFileSync(path.join(dir, name), 'backup bytes');
  return name;
};
const exists = (dir, name) => fs.existsSync(path.join(dir, name));
const daysAgo = (days) => Date.now() - days * DAY_MS;

test('old backups go by their exact name, and everything else stays', async (t) => {
  const { dir, dbFile } = makeDbDir(t);
  const expired = [
    place(dir, `${DB_NAME}.corrupt-${daysAgo(22)}`),
    place(dir, `${DB_NAME}.pre-migration-${daysAgo(400)}`),
  ];
  const kept = [
    place(dir, `${DB_NAME}.corrupt-${daysAgo(20)}`),
    place(dir, `${DB_NAME}.pre-migration-${daysAgo(1)}`),
    place(dir, `${DB_NAME}.corrupt-${Date.now() + 90 * DAY_MS}`), // in the future
    // Old timestamps, but not a backup's exact name.
    place(dir, `${DB_NAME}.corrupt-${daysAgo(90)}.bak`),
    place(dir, `${DB_NAME}.corrupt-${daysAgo(90)}x`),
    place(dir, `x${DB_NAME}.corrupt-${daysAgo(90)}`),
    place(dir, `other.json.corrupt-${daysAgo(90)}`),
    place(dir, `${DB_NAME}.CORRUPT-${daysAgo(90)}`),
    place(dir, `${DB_NAME}.corrupted-${daysAgo(90)}`),
    place(dir, `${DB_NAME}.corrupt-`),
    place(dir, `${DB_NAME}.corrupt-1`),
    place(dir, `${DB_NAME}.corrupt-0${daysAgo(90)}`),
    place(dir, `${DB_NAME}.corrupt--${daysAgo(90)}`),
    place(dir, `${DB_NAME}.bak`),
    place(dir, 'notes.txt'),
  ];
  // A directory with a backup's name.
  const directoryName = `${DB_NAME}.corrupt-${daysAgo(50)}`;
  fs.mkdirSync(path.join(dir, directoryName));
  place(path.join(dir, directoryName), 'inside.txt');

  const { getOutput } = await startOn(t, { DB_FILE: dbFile });

  for (const name of expired) assert.equal(exists(dir, name), false, name);
  for (const name of kept) assert.equal(exists(dir, name), true, name);
  assert.equal(exists(dir, path.join(directoryName, 'inside.txt')), true);
  assert.equal(exists(dir, DB_NAME), true);
  // Three real backups stay: the directory does not count.
  assert.match(getOutput(), /Removed an expired backup, 4 backup\(s\) remain, the last expiring \d{4}-/);
  assert.match(getOutput(), /Removed an expired backup, 3 backup\(s\) remain, the last expiring \d{4}-/);
});

test('a symlink with a backup\'s name is left alone, and so is what it points to', async (t) => {
  const { dir, dbFile } = makeDbDir(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'drinkme-retention-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const target = path.join(outside, 'precious.json');
  fs.writeFileSync(target, 'keep me');
  const linkName = `${DB_NAME}.corrupt-${daysAgo(90)}`;
  try {
    fs.symlinkSync(target, path.join(dir, linkName), 'file');
  } catch (err) {
    // Creating a file symlink needs a privilege on Windows, while a junction does not.
    if (err.code !== 'EPERM') throw err;
    fs.symlinkSync(outside, path.join(dir, linkName), 'junction');
  }

  await startOn(t, { DB_FILE: dbFile });

  assert.ok(fs.lstatSync(path.join(dir, linkName)).isSymbolicLink());
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep me');
});

for (const value of ['0', '-5', 'abc', '1.5', '1e3', '30days']) {
  test(`CORRUPT_BACKUP_RETENTION_DAYS=${value} falls back to 21 days`, async (t) => {
    const { dir, dbFile } = makeDbDir(t);
    const recentBackup = place(dir, `${DB_NAME}.corrupt-${daysAgo(20)}`);
    const oldBackup = place(dir, `${DB_NAME}.corrupt-${daysAgo(22)}`);
    const { getOutput } = await startOn(t, { DB_FILE: dbFile, CORRUPT_BACKUP_RETENTION_DAYS: value });
    assert.equal(exists(dir, recentBackup), true);
    assert.equal(exists(dir, oldBackup), false);
    assert.match(getOutput(), /CORRUPT_BACKUP_RETENTION_DAYS must be a whole number from 1 to 21/);
  });
}

// Owner decision (2026-11-10): deleted accounts are gone from backups within 30 days, so 21 plus the 7-day hold.
for (const value of ['22', '30', '60', '36501']) {
  test(`CORRUPT_BACKUP_RETENTION_DAYS=${value} is capped at 21 days with a warning`, async (t) => {
    const { dir, dbFile } = makeDbDir(t);
    const recentBackup = place(dir, `${DB_NAME}.corrupt-${daysAgo(20)}`);
    const oldBackup = place(dir, `${DB_NAME}.corrupt-${daysAgo(22)}`);
    const { getOutput } = await startOn(t, { DB_FILE: dbFile, CORRUPT_BACKUP_RETENTION_DAYS: value });
    assert.equal(exists(dir, recentBackup), true);
    assert.equal(exists(dir, oldBackup), false, 'the cap applies, not the value given');
    assert.match(getOutput(), /CORRUPT_BACKUP_RETENTION_DAYS is above 21 — using 21\. The app tells users backups are removed within 30 days/);
  });
}

test('a valid CORRUPT_BACKUP_RETENTION_DAYS up to 21 is used without a warning', async (t) => {
  const { dir, dbFile } = makeDbDir(t);
  const within = place(dir, `${DB_NAME}.corrupt-${daysAgo(5)}`);
  const beyond = place(dir, `${DB_NAME}.corrupt-${daysAgo(8)}`);
  const server = await startOn(t, { DB_FILE: dbFile, CORRUPT_BACKUP_RETENTION_DAYS: '7' });
  assert.equal(exists(dir, within), true);
  assert.equal(exists(dir, beyond), false);
  assert.doesNotMatch(server.getOutput(), /CORRUPT_BACKUP_RETENTION_DAYS/);
  await server.stop();

  const atMax = await startOn(t, { DB_FILE: dbFile, CORRUPT_BACKUP_RETENTION_DAYS: '21' });
  assert.doesNotMatch(atMax.getOutput(), /CORRUPT_BACKUP_RETENTION_DAYS/);
  assert.equal(exists(dir, within), true);
});

test('a corrupt start purges nothing within the 30-day ceiling, then or on the timer', async (t) => {
  const { dir, dbFile } = makeDbDir(t, '{ not json');
  const oldBackup = place(dir, `${DB_NAME}.corrupt-${daysAgo(25)}`);
  const oldMigration = place(dir, `${DB_NAME}.pre-migration-${daysAgo(25)}`);

  const { getOutput } = await startOn(t, { DB_FILE: dbFile, DB_BACKUP_PURGE_INTERVAL_MS: '200' });
  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.equal(exists(dir, oldBackup), true);
  assert.equal(exists(dir, oldMigration), true);
  assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith(`${DB_NAME}.corrupt-`)).length, 2, 'the new backup is there too');
  assert.doesNotMatch(getOutput(), /Removed an expired backup/);
});

test('a start with no database file purges nothing, and neither do the restarts that follow', async (t) => {
  const { dir, dbFile } = makeDbDir(t);
  fs.rmSync(dbFile);
  const oldBackup = place(dir, `${DB_NAME}.corrupt-${daysAgo(25)}`);
  const server = await startOn(t, { DB_FILE: dbFile });
  assert.equal(exists(dir, oldBackup), true);
  assert.equal(typeof readDb(dbFile).recoveryStartedAt, 'number');

  // Restarted while still empty: the same hold goes on.
  const startedAt = readDb(dbFile).recoveryStartedAt;
  await server.restart();
  assert.equal(exists(dir, oldBackup), true);
  assert.equal(readDb(dbFile).recoveryStartedAt, startedAt);
  assert.match(server.getOutput(), /purge held after a recovery start/);

  // Users have signed up since, and the hold still protects the backup.
  await devSignIn(server.baseUrl, 'new-user');
  await server.restart();
  assert.equal(exists(dir, oldBackup), true);
  assert.match(server.getOutput(), /purge held after a recovery start, until \d{4}-/);
});

test('a corrupt start holds the purge across a restart, once real data exists', async (t) => {
  const { dir, dbFile } = makeDbDir(t, '{ not json');
  const oldBackup = place(dir, `${DB_NAME}.corrupt-${daysAgo(25)}`);
  const server = await startOn(t, { DB_FILE: dbFile });
  await devSignIn(server.baseUrl, 'new-user');
  assert.equal(typeof readDb(dbFile).recoveryStartedAt, 'number');

  await server.restart();
  assert.equal(exists(dir, oldBackup), true);
  assert.match(server.getOutput(), /purge held after a recovery start/);
});

test('the recovery hold releases by itself after 7 days', async (t) => {
  const oldName = `${DB_NAME}.corrupt-${daysAgo(25)}`;
  const { dir, dbFile } = makeDbDir(t, { dbSchemaVersion: 2, users: [KEEPER], recoveryStartedAt: daysAgo(6) });
  place(dir, oldName);
  const server = await startOn(t, { DB_FILE: dbFile });
  assert.equal(exists(dir, oldName), true);

  await server.restart({ dbFixture: { dbSchemaVersion: 2, users: [KEEPER], recoveryStartedAt: daysAgo(8) } });
  assert.equal(exists(dir, oldName), false);
  assert.match(server.getOutput(), /hold after a recovery start has ended/);

  // Gone from the file with the next save.
  await devSignIn(server.baseUrl, KEEPER.id);
  assert.ok(!('recoveryStartedAt' in readDb(dbFile)));
});

test('a file with no users gets a saved hold, and expired backups still go once it lapses', async (t) => {
  const oldName = `${DB_NAME}.corrupt-${daysAgo(25)}`;
  const { dir, dbFile } = makeDbDir(t, { dbSchemaVersion: 2, users: [] });
  place(dir, oldName);
  const server = await startOn(t, { DB_FILE: dbFile });
  assert.equal(exists(dir, oldName), true);
  assert.equal(typeof readDb(dbFile).recoveryStartedAt, 'number');

  const lapsed = daysAgo(8);
  await server.restart({ dbFixture: { dbSchemaVersion: 2, users: [], recoveryStartedAt: lapsed } });
  assert.equal(exists(dir, oldName), false);

  // A restart does not start a new hold, so the next expired backup goes too.
  const nextName = place(dir, `${DB_NAME}.corrupt-${daysAgo(80)}`);
  await server.restart();
  assert.equal(exists(dir, nextName), false);
});

test('the last user deleting their account starts a saved hold on a running server', async (t) => {
  const oldName = `${DB_NAME}.corrupt-${Date.now() - 21 * DAY_MS + 3000}`;
  const { dir, dbFile } = makeDbDir(t);
  place(dir, oldName);
  const { baseUrl } = await startOn(t, { DB_FILE: dbFile, DB_BACKUP_PURGE_INTERVAL_MS: '200' });
  const token = await devSignIn(baseUrl, KEEPER.id);
  assert.equal((await deleteAccount(baseUrl, KEEPER.id, token)).status, 200);
  await waitFor(() => readDb(dbFile).recoveryStartedAt !== undefined, 'the hold');
  await new Promise((resolve) => setTimeout(resolve, 3500));
  assert.equal(exists(dir, oldName), true);
});

for (const [label, prepare] of [
  ['corrupt', (file) => fs.writeFileSync(file, '{ not json')],
  ['missing-file', (file) => fs.rmSync(file)],
]) {
  test(`a ${label} start looks at the backups when its hold ends`, async (t) => {
    const { dir, dbFile } = makeDbDir(t);
    prepare(dbFile);
    const oldName = place(dir, `${DB_NAME}.corrupt-${daysAgo(25)}`);
    await startOn(t, { DB_FILE: dbFile, DB_RECOVERY_PURGE_HOLD_MS: '4000' });
    assert.equal(exists(dir, oldName), true, 'held');
    await waitFor(() => !exists(dir, oldName), 'the hold to end');
  });
}

const heldUntilIn = (output) => {
  const match = /purge held after a recovery start, until (\S+?)\.\s/.exec(output);
  assert.ok(match, 'the hold must be logged');
  return new Date(match[1]).getTime();
};

test('the recovery hold is 7 days by default, to the millisecond', async (t) => {
  const startedAt = daysAgo(3);
  const { dir, dbFile } = makeDbDir(t, { dbSchemaVersion: 2, users: [KEEPER], recoveryStartedAt: startedAt });
  const oldName = place(dir, `${DB_NAME}.corrupt-${daysAgo(25)}`);
  const { getOutput } = await startOn(t, { DB_FILE: dbFile });
  assert.equal(heldUntilIn(getOutput()), startedAt + 7 * DAY_MS);
  assert.equal(exists(dir, oldName), true);
});

test('a recoveryStartedAt ahead of the clock is clamped to now, so it cannot hold the purge for longer', async (t) => {
  const { dir, dbFile } = makeDbDir(t, { dbSchemaVersion: 2, users: [KEEPER], recoveryStartedAt: Date.now() + 365 * DAY_MS });
  const oldName = place(dir, `${DB_NAME}.corrupt-${daysAgo(25)}`);
  const startedBefore = Date.now();
  const { baseUrl, getOutput } = await startOn(t, { DB_FILE: dbFile });
  const startedAfter = Date.now();

  // Still a hold, but one counted from this start.
  assert.equal(exists(dir, oldName), true);
  const heldUntil = heldUntilIn(getOutput());
  assert.ok(heldUntil >= startedBefore + 7 * DAY_MS && heldUntil <= startedAfter + 7 * DAY_MS, 'at most 7 days from now');

  // And the clamped value is what the next save writes.
  await devSignIn(baseUrl, KEEPER.id);
  assert.ok(readDb(dbFile).recoveryStartedAt <= Date.now());
});

test('a backup timestamp ahead of the clock is kept and logged', async (t) => {
  const { dir, dbFile } = makeDbDir(t);
  const ahead = place(dir, `${DB_NAME}.corrupt-${Date.now() + 90 * DAY_MS}`);
  const { getOutput } = await startOn(t, { DB_FILE: dbFile });
  assert.equal(exists(dir, ahead), true);
  assert.match(getOutput(), /1 backup\(s\) have a timestamp ahead of the current time/);
});

test('only temp files of the exact form are removed at load', async (t) => {
  const { dir, dbFile } = makeDbDir(t);
  const stale = place(dir, `${DB_NAME}.tmp-123-0123456789abcdef`);
  const similar = [
    place(dir, `${DB_NAME}.tmp-notes`),
    place(dir, `${DB_NAME}.tmp-456-0123456789ABCDEF`),
    place(dir, `${DB_NAME}.tmp-123-0123456789abcdef.bak`),
  ];
  await startOn(t, { DB_FILE: dbFile });
  assert.equal(exists(dir, stale), false);
  for (const name of similar) assert.equal(exists(dir, name), true, name);
});

test('a start that just migrated keeps its backups until the timer', async (t) => {
  const { dir, dbFile } = makeDbDir(t, { nextDrinkId: 1, users: [KEEPER] }); // no version: the migration runs
  const oldBackup = place(dir, `${DB_NAME}.corrupt-${daysAgo(25)}`);

  await startOn(t, { DB_FILE: dbFile, DB_BACKUP_PURGE_INTERVAL_MS: '3000' });

  assert.equal(exists(dir, oldBackup), true);
  const backups = fs.readdirSync(dir).filter((name) => name.startsWith(`${DB_NAME}.pre-migration-`));
  assert.equal(backups.length, 1);

  await waitFor(() => !exists(dir, oldBackup), 'the timer');
  assert.equal(exists(dir, backups[0]), true, 'the new backup is not expired');
});

test('the timer removes a backup at the moment it expires, not up to a day later', async (t) => {
  const { dir, dbFile } = makeDbDir(t);
  const soon = place(dir, `${DB_NAME}.corrupt-${Date.now() - 21 * DAY_MS + 15_000}`);
  const later = place(dir, `${DB_NAME}.corrupt-${daysAgo(10)}`);

  await startOn(t, { DB_FILE: dbFile });
  assert.equal(exists(dir, soon), true, 'not yet expired');
  await waitFor(() => !exists(dir, soon), 'the expiry');
  assert.equal(exists(dir, later), true);
});

test('a backup that cannot be removed is logged and does not stop the server', async (t) => {
  const { dir, dbFile } = makeDbDir(t);
  const stuck = place(dir, `${DB_NAME}.corrupt-${daysAgo(90)}`);
  const preload = path.join(dir, 'fail-unlink.mjs');
  fs.writeFileSync(preload, `
    import fs from 'node:fs';
    const realUnlink = fs.unlinkSync;
    fs.unlinkSync = (file) => {
      if (String(file).includes('.corrupt-')) throw Object.assign(new Error('injected'), { code: 'EBUSY' });
      return realUnlink(file);
    };
  `);
  const { baseUrl, getOutput } = await startOn(t, { DB_FILE: dbFile, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
  assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
  assert.equal(exists(dir, stuck), true);
  assert.match(getOutput(), /Could not remove an expired backup: EBUSY/);
});
