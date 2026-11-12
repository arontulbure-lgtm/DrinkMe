// T6-1 / SEC-H: the GDPR-minimal audit log. One entry per sensitive action, only the allowed keys, written
// in the action's save (and gone with it when that save fails), 90-day retention, separate caps for user
// entries (15,000) and admin entries (20,000), anonymised on account deletion with a stable id, entries
// rebuilt at load, and GET /api/admin/audit for admins only.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import jwt from 'jsonwebtoken';

import { REAL_DATA_DIR, REAL_DB_FILE, startServer } from './helpers/harness.js';

const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const STUB_PRELOAD = new URL('./helpers/firebase-auth-stub-preload.js', import.meta.url).href;
const FAULT_PRELOAD = new URL('./helpers/db-fault-preload.js', import.meta.url).href;
const ADMIN_ENV = { ADMIN_USER_IDS: 'admin' };
const DAY_MS = 24 * 60 * 60 * 1000;
const CONFIRMED_AT = '2026-01-02T03:04:05.000Z';
const ENTRY_KEYS = new Set(['id', 'at', 'action', 'actorId', 'targetId', 'meta']);
const META_KEYS = {
  'ack.age_confirmed': [],
  'ack.privacy_accepted': ['version'],
  'auth.session_revoked': [],
  'account.deletion_requested': [],
  'account.deletion_completed': [],
  'admin.report_resolved': ['action', 'reportId', 'resolvedCount'],
  'admin.user_suspended': ['permanent'],
  'admin.user_unsuspended': ['void'],
};
// Distinctive, so a search of the saved file cannot match anything by accident.
const SECRET_REASON = 'AuditSecretReason9Kq';
const SECRET_DETAILS = 'AuditSecretDetails4Vw';

// Synthetic credentials. The key exists only in memory, for this test run.
const { privateKey: TEST_PRIVATE_KEY } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const FIREBASE_ENV = {
  ALLOW_INSECURE_DEV_AUTH: undefined,
  FIREBASE_SERVICE_ACCOUNT_KEY: JSON.stringify({
    type: 'service_account', project_id: 'drinkme-audit-test', private_key: TEST_PRIVATE_KEY, client_email: 'audit-test@drinkme-audit-test.example.test',
  }),
  NODE_OPTIONS: `--import=${STUB_PRELOAD}`,
};
const GOOGLE_UID = 'google-owner';
// A Google sign-in for a stored unverified account starts a new session generation.
const googleClaims = (iatOffset = 0) => {
  const now = Math.floor(Date.now() / 1000) + iatOffset;
  return {
    uid: GOOGLE_UID, email: 'google.owner@example.test', email_verified: true, name: 'Google Owner',
    iat: now, auth_time: now - 3600, firebase: { sign_in_provider: 'google.com' },
  };
};
const signInWith = (server, idToken) => fetch(`${server.baseUrl}/api/auth/mobile`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken, uid: GOOGLE_UID }),
});
const googleSignIn = (server, claims) => signInWith(server, `stub:${JSON.stringify(claims)}`);

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const tokenFor = (uid) => jwt.sign({ uid }, HARNESS_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

const TRANSIENT_READ_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const readRaw = (dbFile) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.readFileSync(dbFile, 'utf8');
    } catch (err) {
      if (attempt >= 40 || !TRANSIENT_READ_CODES.has(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
};
const readDb = (server) => JSON.parse(readRaw(server.dbFile));
const auditOf = (server) => readDb(server).auditLog ?? [];

const person = (id, extra = {}) => ({
  id, email: `${id}@example.test`, firstName: `Name-${id}`, lastName: 'Test', city: 'Cluj', bio: '',
  nameSetByUser: true, avatar: null, ageConfirmedAt: CONFIRMED_AT, privacyNoticeVersion: 2, ...extra,
});
const post = (id, userId) => ({
  id, userId, name: `Post ${id}`, description: 'Plain', rating: 4, location: 'Cluj', isAlcoholic: false,
  createdAt: ago(DAY_MS), cheersCount: 0, tags: [], imageUrl: null,
});
const openReport = (id, reporterId, targetType, targetId) => ({
  id, reporterId, targetType, targetId, reason: 'spam', details: SECRET_DETAILS, status: 'open', createdAt: ago(60_000),
});
const auditEntry = (id, at, action = 'ack.age_confirmed', actorId = 'member') => ({ id, at, action, actorId, targetId: null });

const baseFixture = (extra = {}) => ({
  dbSchemaVersion: 2,
  users: [
    person('admin'), person('member'), person('owner'),
    person('newcomer', { ageConfirmedAt: undefined, privacyNoticeVersion: 1 }),
  ],
  drinks: [post(1, 'owner'), post(2, 'owner')],
  nextDrinkId: 3,
  reports: [openReport(1, 'member', 'drink', 1), openReport(2, 'member', 'drink', 2)],
  nextReportId: 3,
  ...extra,
});

const googleFixture = () => {
  const fixture = baseFixture();
  fixture.users.push(person(GOOGLE_UID, { email: 'google.owner@example.test', emailVerified: false }));
  return fixture;
};

const call = async (server, method, route, uid, body) => {
  const res = await fetch(`${server.baseUrl}${route}`, {
    method,
    headers: {
      ...(uid && { Authorization: `Bearer ${tokenFor(uid)}` }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  return { status: res.status, body: parsed };
};

const start = async (t, fixture, env = {}) => {
  const server = await startServer({ ...ADMIN_ENV, ...env }, { dbFixture: fixture });
  t.after(() => server.stop());
  return server;
};

// Only the keys the action allows, nothing more, and no personal data.
const assertEntryShape = (entry) => {
  for (const key of Object.keys(entry)) assert.ok(ENTRY_KEYS.has(key), `unexpected key ${key} in ${entry.action}`);
  assert.ok(Number.isSafeInteger(entry.id));
  assert.ok(Number.isFinite(Date.parse(entry.at)));
  assert.ok('actorId' in entry && 'targetId' in entry);
  const allowed = META_KEYS[entry.action];
  assert.ok(allowed, `unknown action ${entry.action}`);
  if (allowed.length === 0) assert.equal(entry.meta, undefined, `${entry.action} carries meta`);
  else if (entry.meta !== undefined) {
    // Each test checks the exact meta; here only that nothing outside the allowed keys is there.
    for (const key of Object.keys(entry.meta)) assert.ok(allowed.includes(key), `unexpected meta key ${key} in ${entry.action}`);
  }
  const raw = JSON.stringify(entry);
  for (const forbidden of ['@', SECRET_REASON, SECRET_DETAILS, 'Name-', '127.0.0.1', 'Bearer']) {
    assert.ok(!raw.includes(forbidden), `${entry.action} holds ${forbidden}`);
  }
};

// Runs the action and returns the entries it added. Exactly expectedCount of them.
const added = async (server, action, expectedCount = 1) => {
  const beforeIds = new Set(auditOf(server).map((entry) => entry.id));
  await action();
  const fresh = auditOf(server).filter((entry) => !beforeIds.has(entry.id));
  assert.equal(fresh.length, expectedCount, JSON.stringify(fresh));
  fresh.forEach(assertEntryShape);
  return fresh;
};

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

describe('each action writes exactly one entry with only its allowed keys', () => {
  test('age and privacy acknowledgements; a repeat writes nothing', async (t) => {
    const server = await start(t, baseFixture());
    const [age] = await added(server, async () => {
      assert.equal((await call(server, 'POST', '/api/users/newcomer/acknowledgements', 'newcomer', { type: 'age', confirmed: true })).status, 200);
    });
    assert.deepEqual({ ...age, at: undefined, id: undefined }, { at: undefined, id: undefined, action: 'ack.age_confirmed', actorId: 'newcomer', targetId: null });

    const [privacy] = await added(server, async () => {
      assert.equal((await call(server, 'POST', '/api/users/newcomer/acknowledgements', 'newcomer', { type: 'privacy', version: 2 })).status, 200);
    });
    assert.equal(privacy.action, 'ack.privacy_accepted');
    assert.equal(privacy.actorId, 'newcomer');
    assert.deepEqual(privacy.meta, { version: 2 });
    assert.ok(privacy.id > age.id);

    await added(server, async () => {
      assert.equal((await call(server, 'POST', '/api/users/newcomer/acknowledgements', 'newcomer', { type: 'age', confirmed: true })).status, 200);
      assert.equal((await call(server, 'POST', '/api/users/newcomer/acknowledgements', 'newcomer', { type: 'privacy', version: 2 })).status, 200);
      assert.equal((await call(server, 'POST', '/api/users/newcomer/acknowledgements', 'member', { type: 'age', confirmed: true })).status, 403);
    }, 0);
  });

  test('suspend, unsuspend and resolve; the reason text is never logged', async (t) => {
    const server = await start(t, baseFixture());
    const [suspended] = await added(server, async () => {
      assert.equal((await call(server, 'POST', '/api/admin/users/owner/suspend', 'admin', { reason: SECRET_REASON })).status, 200);
    });
    assert.deepEqual(
      { action: suspended.action, actorId: suspended.actorId, targetId: suspended.targetId, meta: suspended.meta },
      { action: 'admin.user_suspended', actorId: 'admin', targetId: 'owner', meta: { permanent: false } },
    );
    // A double tap changes nothing, so it logs nothing.
    await added(server, async () => {
      assert.equal((await call(server, 'POST', '/api/admin/users/owner/suspend', 'admin', {})).status, 409);
    }, 0);

    const [unsuspended] = await added(server, async () => {
      assert.equal((await call(server, 'POST', '/api/admin/users/owner/unsuspend', 'admin', { void: true })).status, 200);
    });
    assert.deepEqual(
      { action: unsuspended.action, actorId: unsuspended.actorId, targetId: unsuspended.targetId, meta: unsuspended.meta },
      { action: 'admin.user_unsuspended', actorId: 'admin', targetId: 'owner', meta: { void: true } },
    );
    await added(server, async () => {
      assert.equal((await call(server, 'POST', '/api/admin/users/owner/unsuspend', 'admin', {})).status, 200);
    }, 0);

    const [resolved] = await added(server, async () => {
      assert.equal((await call(server, 'POST', '/api/admin/reports/1/resolve', 'admin', { action: 'dismiss' })).status, 200);
    });
    assert.deepEqual(
      { action: resolved.action, actorId: resolved.actorId, targetId: resolved.targetId, meta: resolved.meta },
      { action: 'admin.report_resolved', actorId: 'admin', targetId: 'owner', meta: { reportId: 1, action: 'dismiss', resolvedCount: 1 } },
    );

    // A resolve that also suspends is two actions, so two entries. The voided suspension does not count,
    // so this one lasts 7 days.
    const pair = await added(server, async () => {
      assert.equal((await call(server, 'POST', '/api/admin/reports/2/resolve', 'admin', { action: 'remove_content', suspend: true })).status, 200);
    }, 2);
    assert.deepEqual(pair.map(({ action, targetId, meta }) => ({ action, targetId, meta })), [
      { action: 'admin.report_resolved', targetId: 'owner', meta: { reportId: 2, action: 'remove_content', resolvedCount: 1 } },
      { action: 'admin.user_suspended', targetId: 'owner', meta: { permanent: false } },
    ]);

    const raw = readRaw(server.dbFile);
    const auditRaw = JSON.stringify(readDb(server).auditLog);
    assert.ok(raw.includes(SECRET_REASON), 'the reason stays in the suspension history');
    assert.ok(!auditRaw.includes(SECRET_REASON) && !auditRaw.includes(SECRET_DETAILS));
  });

  test('account deletion: the request entry is in the first save, then only the anonymous completion stays', async (t) => {
    // A test-only preload keeps a copy of every file the server saves, so the save that holds the request
    // entry can be seen although the cascade removes it in the next save.
    const preloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drinkme-audit-preload-'));
    t.after(() => fs.rmSync(preloadDir, { recursive: true, force: true }));
    const preload = path.join(preloadDir, 'snapshot-saves.mjs');
    fs.writeFileSync(preload, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      'const dbFile = path.resolve(process.env.DB_FILE);',
      'const realRename = fs.renameSync;',
      'let count = 0;',
      'fs.renameSync = (from, to) => {',
      '  if (path.resolve(String(to)) === dbFile) fs.copyFileSync(from, `${dbFile}.snapshot-${++count}`);',
      '  return realRename(from, to);',
      '};',
    ].join('\n'));
    const uid = 'audit-requester';
    const fixture = baseFixture();
    fixture.users.push(person(uid));
    const server = await start(t, fixture, { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
    const snapshotCount = () => fs.readdirSync(path.dirname(server.dbFile)).filter((name) => name.includes('.snapshot-')).length;
    const snapshot = (n) => JSON.parse(fs.readFileSync(`${server.dbFile}.snapshot-${n}`, 'utf8'));
    const savesBefore = snapshotCount();

    assert.equal((await call(server, 'POST', `/api/users/${uid}/delete-account`, uid, {})).status, 200);
    // The first save of the request holds the pending entry and the request entry together.
    const first = snapshot(savesBefore + 1);
    assert.equal(first.pendingAccountDeletions.length, 1);
    assert.equal(first.auditLog.length, 1);
    assertEntryShape(first.auditLog[0]);
    assert.deepEqual(
      { action: first.auditLog[0].action, actorId: first.auditLog[0].actorId, targetId: first.auditLog[0].targetId },
      { action: 'account.deletion_requested', actorId: uid, targetId: null },
    );

    // Afterwards the request entry is gone with the user's other own entries, and the completion carries
    // the anonymous id chosen with the request.
    const log = auditOf(server);
    assert.equal(log.length, 1);
    assertEntryShape(log[0]);
    assert.equal(log[0].action, 'account.deletion_completed');
    assert.equal(log[0].actorId, null);
    assert.equal(log[0].targetId, first.pendingAccountDeletions[0].anonId);
    assert.match(log[0].targetId, /^deleted-[0-9a-f]{16}$/);
    assert.ok(!readRaw(server.dbFile).includes(uid));
  });

  test('a cascade that fails after the reports and is retried keeps one anonymous id everywhere', async (t) => {
    // The cascade fault throws after the reports and the audit log were anonymised, and that state is saved.
    const uid = 'fault-injected-user';
    const fixture = baseFixture({
      auditLog: [
        { id: 1, at: ago(60_000), action: 'admin.user_suspended', actorId: 'admin', targetId: uid, meta: { permanent: false } },
        { id: 2, at: ago(30_000), action: 'ack.age_confirmed', actorId: uid, targetId: null },
      ],
      nextAuditId: 3,
    });
    fixture.users.push(person(uid));
    fixture.cheersByUser = { [uid]: [] };
    fixture.reports.push(openReport(3, uid, 'drink', 1));
    fixture.nextReportId = 4;
    const server = await start(t, fixture, { DB_FAULT: 'cascade', NODE_OPTIONS: `--import=${FAULT_PRELOAD}` });
    fs.writeFileSync(`${server.dbFile}.fail-cascade`, '');
    assert.equal((await call(server, 'POST', `/api/users/${uid}/delete-account`, uid, {})).status, 500);

    const partial = readDb(server);
    const [pending] = partial.pendingAccountDeletions;
    assert.match(pending.anonId, /^deleted-[0-9a-f]{16}$/);
    assert.equal(partial.reports.find((report) => report.id === 3).reporterId, pending.anonId);
    assert.deepEqual(partial.auditLog.map(({ id, targetId }) => ({ id, targetId })), [{ id: 1, targetId: pending.anonId }]);

    // The retry at the next start uses the saved id, so the completion matches the reports and the admin entry.
    fs.rmSync(`${server.dbFile}.fail-cascade`);
    await server.restart();
    const db = readDb(server);
    assert.equal(db.reports.find((report) => report.id === 3).reporterId, pending.anonId);
    assert.deepEqual(db.auditLog.map(({ id, action, actorId, targetId }) => ({ id, action, actorId, targetId })), [
      { id: 1, action: 'admin.user_suspended', actorId: 'admin', targetId: pending.anonId },
      { id: 4, action: 'account.deletion_completed', actorId: null, targetId: pending.anonId },
    ]);
  });

  test('a session revocation (sessionGen bump) writes one entry; a refused sign-in writes none', async (t) => {
    const server = await start(t, googleFixture(), FIREBASE_ENV);
    await added(server, async () => {
      assert.equal((await signInWith(server, 'not-a-stub-token')).status, 401);
    }, 0);
    const [revoked] = await added(server, async () => {
      assert.equal((await googleSignIn(server, googleClaims())).status, 200);
    });
    assert.deepEqual(
      { action: revoked.action, actorId: revoked.actorId, targetId: revoked.targetId },
      { action: 'auth.session_revoked', actorId: GOOGLE_UID, targetId: null },
    );
    assert.equal(readDb(server).users.find((user) => user.id === GOOGLE_UID).sessionGen, 1);
    // The next sign-in starts no new generation, so it logs nothing.
    await added(server, async () => {
      assert.equal((await googleSignIn(server, googleClaims(1))).status, 200);
    }, 0);
  });

  test('a resolve with suspend: true on an owner already suspended writes only the resolve', async (t) => {
    const server = await start(t, baseFixture());
    assert.equal((await call(server, 'POST', '/api/admin/users/owner/suspend', 'admin', {})).status, 200);
    const [resolved] = await added(server, async () => {
      const res = await call(server, 'POST', '/api/admin/reports/1/resolve', 'admin', { action: 'dismiss', suspend: true });
      assert.equal(res.status, 200);
      assert.equal(res.body.suspension.applied, false);
    });
    assert.equal(resolved.action, 'admin.report_resolved');
    assert.deepEqual(resolved.meta, { reportId: 1, action: 'dismiss', resolvedCount: 1 });
  });
});

test('a failed save leaves no entry, in memory or on disk', async (t) => {
  const fixture = baseFixture();
  fixture.users.push(person('leaver'));
  const server = await start(t, fixture, { DB_FAULT: 'save', NODE_OPTIONS: `--import=${FAULT_PRELOAD}` });
  const marker = `${server.dbFile}.fail-saves`;
  fs.writeFileSync(marker, '');
  try {
    assert.equal((await call(server, 'POST', '/api/users/newcomer/acknowledgements', 'newcomer', { type: 'age', confirmed: true })).status, 503);
    assert.equal((await call(server, 'POST', '/api/users/newcomer/acknowledgements', 'newcomer', { type: 'privacy', version: 2 })).status, 503);
    assert.equal((await call(server, 'POST', '/api/admin/users/owner/suspend', 'admin', { reason: SECRET_REASON })).status, 503);
    assert.equal((await call(server, 'POST', '/api/admin/reports/1/resolve', 'admin', { action: 'dismiss', suspend: true })).status, 503);
    assert.equal((await call(server, 'POST', '/api/users/leaver/delete-account', 'leaver', {})).status, 503);
  } finally {
    fs.rmSync(marker);
  }
  const listed = await call(server, 'GET', '/api/admin/audit', 'admin');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, { items: [], nextCursor: null });
  assert.deepEqual(auditOf(server), []);

  // The suspension was undone too, so unsuspend has nothing in force and logs nothing.
  assert.equal((await call(server, 'POST', '/api/admin/users/owner/unsuspend', 'admin', {})).status, 200);
  // The next successful action gets the first id: the failed ones left no gap in the counter.
  assert.equal((await call(server, 'POST', '/api/users/newcomer/acknowledgements', 'newcomer', { type: 'age', confirmed: true })).status, 200);
  const db = readDb(server);
  assert.deepEqual(db.auditLog.map(({ id, action }) => ({ id, action })), [{ id: 1, action: 'ack.age_confirmed' }]);
  assert.equal(db.nextAuditId, 2);
});

test('a failed save after a sessionGen bump keeps the entry, and the next save writes it', async (t) => {
  const server = await start(t, googleFixture(), {
    ...FIREBASE_ENV, DB_FAULT: 'save', NODE_OPTIONS: `--import=${STUB_PRELOAD} --import=${FAULT_PRELOAD}`,
  });
  const marker = `${server.dbFile}.fail-saves`;
  fs.writeFileSync(marker, '');
  try {
    assert.equal((await googleSignIn(server, googleClaims())).status, 503);
  } finally {
    fs.rmSync(marker);
  }
  assert.deepEqual(auditOf(server), [], 'nothing reached the file');
  // The bump stays in memory (see the sign-in route), so its entry stays too and the next save writes both.
  assert.equal((await call(server, 'POST', '/api/users/newcomer/acknowledgements', 'newcomer', { type: 'age', confirmed: true })).status, 200);
  const db = readDb(server);
  assert.deepEqual(db.auditLog.map(({ id, action, actorId }) => ({ id, action, actorId })), [
    { id: 1, action: 'auth.session_revoked', actorId: GOOGLE_UID },
    { id: 2, action: 'ack.age_confirmed', actorId: 'newcomer' },
  ]);
  assert.equal(db.users.find((user) => user.id === GOOGLE_UID).sessionGen, 1);
});

describe('retention', () => {
  test('entries older than 90 days, or with an unreadable date or id, are pruned at start and leave the file', async (t) => {
    const fixture = baseFixture({
      auditLog: [
        auditEntry(1, ago(91 * DAY_MS)),
        auditEntry(2, 'not a date'),
        { ...auditEntry(3, ago(DAY_MS)), id: 'three' },
        auditEntry(4, ago(89 * DAY_MS)),
        auditEntry(5, ago(60_000), 'admin.user_suspended', 'admin'),
      ],
      nextAuditId: 2, // behind the stored entries: the counter moves ahead of them
    });
    const server = await start(t, fixture);
    const db = readDb(server);
    assert.deepEqual(db.auditLog.map((entry) => entry.id), [4, 5]);
    assert.equal(db.nextAuditId, 6);
    const listed = await call(server, 'GET', '/api/admin/audit', 'admin');
    assert.deepEqual(listed.body.items.map((entry) => entry.id), [5, 4]);
  });

  test('a file without auditLog loads as an empty log', async (t) => {
    const server = await start(t, baseFixture());
    assert.deepEqual((await call(server, 'GET', '/api/admin/audit', 'admin')).body, { items: [], nextCursor: null });
    assert.equal((await call(server, 'POST', '/api/users/newcomer/acknowledgements', 'newcomer', { type: 'age', confirmed: true })).status, 200);
    assert.deepEqual(auditOf(server).map((entry) => entry.id), [1]);
  });

  test('entries are rebuilt at load with only the known fields and allowed meta keys', async (t) => {
    const at = ago(60_000);
    const fixture = baseFixture({
      auditLog: [
        {
          id: 1, at, action: 'admin.user_suspended', actorId: 'admin', targetId: 'owner',
          meta: { permanent: true, reason: SECRET_REASON, email: 'leak@example.test' }, ip: '10.1.2.3', userAgent: 'SecretAgent/1.0',
        },
        { id: 2, at, action: 'unknown.action', actorId: 'admin', targetId: null },
        { id: 3, at, action: 'ack.age_confirmed', actorId: 42, targetId: null },
        { id: 4, at, action: 'ack.age_confirmed', actorId: 'member' }, // no targetId
        { id: 5, at, action: 'ack.privacy_accepted', actorId: 'member', targetId: null, meta: { version: 2, extra: 1 } },
        { id: 6, at, action: 'ack.age_confirmed', actorId: 'member', targetId: null, meta: { version: 2 } },
        { id: 7, at, action: 'admin.report_resolved', actorId: 'admin', targetId: null, meta: { reportId: 1, action: 'dismiss', resolvedCount: 2, details: SECRET_DETAILS } },
        { id: 8, at, action: 'admin.user_unsuspended', actorId: 'admin', targetId: 'owner', meta: { void: { nested: true } } },
      ],
      nextAuditId: 9,
    });
    const server = await start(t, fixture);
    const db = readDb(server);
    assert.deepEqual(db.auditLog, [
      { id: 1, at, action: 'admin.user_suspended', actorId: 'admin', targetId: 'owner', meta: { permanent: true } },
      { id: 5, at, action: 'ack.privacy_accepted', actorId: 'member', targetId: null, meta: { version: 2 } },
      { id: 6, at, action: 'ack.age_confirmed', actorId: 'member', targetId: null },
      { id: 7, at, action: 'admin.report_resolved', actorId: 'admin', targetId: null, meta: { reportId: 1, action: 'dismiss', resolvedCount: 2 } },
      { id: 8, at, action: 'admin.user_unsuspended', actorId: 'admin', targetId: 'owner' },
    ]);
    db.auditLog.forEach(assertEntryShape);
    // The audit part only: the fixture's reports hold their own details text.
    const savedLog = JSON.stringify(db.auditLog);
    for (const leak of [SECRET_REASON, SECRET_DETAILS, 'leak@example.test', '10.1.2.3', 'SecretAgent', 'unknown.action']) {
      assert.ok(!savedLog.includes(leak), `the saved audit log still holds ${leak}`);
    }
  });

  test('the purge timer removes entries that expire while the server runs', async (t) => {
    // Expires about 2 seconds after the start; the timer runs every second here.
    const fixture = baseFixture({ auditLog: [auditEntry(1, ago(90 * DAY_MS - 2_000)), auditEntry(2, ago(60_000))], nextAuditId: 3 });
    const server = await start(t, fixture, { DB_BACKUP_PURGE_INTERVAL_MS: '1000' });
    const deadline = Date.now() + 15_000;
    while (auditOf(server).some((entry) => entry.id === 1)) {
      if (Date.now() > deadline) assert.fail('the expired entry was not purged');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.deepEqual(auditOf(server).map((entry) => entry.id), [2]);
    assert.match(server.getOutput(), /\[audit\] Removed 1 entry past the 90-day retention/);
  });
});

describe('caps', () => {
  // One admin entry, the oldest, then a full user budget of acknowledgements.
  const fullUserBudget = () => {
    const recent = ago(60_000);
    const auditLog = [
      { id: 1, at: recent, action: 'admin.user_suspended', actorId: 'admin', targetId: 'member', meta: { permanent: false } },
      ...Array.from({ length: 15_000 }, (_, index) => auditEntry(index + 2, recent)),
    ];
    return { auditLog, nextAuditId: 15_002 };
  };

  test('15,001+ user entries evict the oldest user entries, never an admin entry, also while storage is full', async (t) => {
    const server = await start(t, baseFixture(fullUserBudget()), { DB_GROWTH_MAX_BYTES: '100' });
    // Storage is full: growth is refused, but acknowledgements and their entries still go through.
    assert.equal((await call(server, 'POST', '/api/reports', 'member', { targetType: 'user', targetId: 'owner', reason: 'spam' })).status, 507);
    assert.equal((await call(server, 'POST', '/api/users/newcomer/acknowledgements', 'newcomer', { type: 'age', confirmed: true })).status, 200);
    assert.equal((await call(server, 'POST', '/api/users/newcomer/acknowledgements', 'newcomer', { type: 'privacy', version: 2 })).status, 200);
    const log = auditOf(server);
    assert.equal(log.length, 15_001);
    assert.deepEqual({ id: log[0].id, action: log[0].action }, { id: 1, action: 'admin.user_suspended' });
    assert.equal(log.filter((entry) => entry.action.startsWith('ack.')).length, 15_000);
    assert.deepEqual(log.slice(1, 3).map((entry) => entry.id), [4, 5], 'the two oldest user entries went');
    assert.deepEqual(log.slice(-2).map(({ id, action }) => ({ id, action })), [
      { id: 15_002, action: 'ack.age_confirmed' },
      { id: 15_003, action: 'ack.privacy_accepted' },
    ]);
  });

  test('a load over a budget keeps the newest entries of that budget only', async (t) => {
    const { auditLog } = fullUserBudget();
    auditLog.push(auditEntry(15_002, ago(30_000)));
    const server = await start(t, baseFixture({ auditLog, nextAuditId: 15_003 }));
    const log = auditOf(server);
    assert.equal(log.length, 15_001);
    assert.deepEqual(log.slice(0, 2).map((entry) => entry.id), [1, 3]);
  });

  test('admin entries have their own cap of 20,000, which user entries do not count towards', async (t) => {
    const recent = ago(60_000);
    const auditLog = [
      ...Array.from({ length: 20_000 }, (_, index) => ({
        id: index + 1, at: recent, action: 'admin.user_unsuspended', actorId: 'admin', targetId: 'member', meta: { void: false },
      })),
      auditEntry(20_001, recent),
    ];
    const server = await start(t, baseFixture({ auditLog, nextAuditId: 20_002 }));
    assert.equal((await call(server, 'POST', '/api/admin/users/owner/suspend', 'admin', {})).status, 200);
    const log = auditOf(server);
    assert.equal(log.length, 20_001);
    assert.equal(log[0].id, 2, 'the oldest admin entry went');
    assert.ok(log.some((entry) => entry.id === 20_001), 'the user entry stays');
    assert.deepEqual({ id: log.at(-1).id, action: log.at(-1).action }, { id: 20_002, action: 'admin.user_suspended' });
  });

  test('a failed save at the cap puts the evicted entries back, in order, with no id gap', async (t) => {
    const fixture = baseFixture(fullUserBudget());
    const server = await start(t, fixture, { DB_FAULT: 'save', NODE_OPTIONS: `--import=${FAULT_PRELOAD}` });
    const marker = `${server.dbFile}.fail-saves`;
    fs.writeFileSync(marker, '');
    try {
      assert.equal((await call(server, 'POST', '/api/users/newcomer/acknowledgements', 'newcomer', { type: 'age', confirmed: true })).status, 503);
    } finally {
      fs.rmSync(marker);
    }
    // An admin entry evicts nothing from the user budget, so the saved file shows exactly what memory holds.
    assert.equal((await call(server, 'POST', '/api/admin/users/owner/suspend', 'admin', {})).status, 200);
    const log = auditOf(server);
    assert.deepEqual(log.slice(0, -1), fixture.auditLog);
    assert.deepEqual({ id: log.at(-1).id, action: log.at(-1).action }, { id: 15_002, action: 'admin.user_suspended' });
    // The user budget is still full, so the next acknowledgement evicts the oldest user entry (id 2) only.
    assert.equal((await call(server, 'POST', '/api/users/newcomer/acknowledgements', 'newcomer', { type: 'age', confirmed: true })).status, 200);
    const next = auditOf(server);
    assert.deepEqual(next.slice(0, 2).map((entry) => entry.id), [1, 3]);
    assert.equal(next.at(-1).id, 15_003);
  });
});

test('account deletion: neither the uid nor the email stays in the saved file', async (t) => {
  const uid = 'audit-leaver-Zq81';
  const email = 'audit.leaver.private@example.test';
  const fixture = baseFixture();
  fixture.users.push(person(uid, { email, ageConfirmedAt: undefined, privacyNoticeVersion: undefined }));
  fixture.reports.push(openReport(3, uid, 'drink', 1));
  fixture.nextReportId = 4;
  const server = await start(t, fixture);
  // Entries in every role: the user's own, an admin action about them, and one where the target was theirs.
  assert.equal((await call(server, 'POST', `/api/users/${uid}/acknowledgements`, uid, { type: 'age', confirmed: true })).status, 200);
  assert.equal((await call(server, 'POST', `/api/users/${uid}/acknowledgements`, uid, { type: 'privacy', version: 2 })).status, 200);
  assert.equal((await call(server, 'POST', `/api/admin/users/${uid}/suspend`, 'admin', { reason: SECRET_REASON })).status, 200);
  assert.equal((await call(server, 'POST', `/api/admin/users/${uid}/unsuspend`, 'admin', {})).status, 200);
  assert.ok(readRaw(server.dbFile).includes(uid));

  assert.equal((await call(server, 'POST', `/api/users/${uid}/delete-account`, uid, {})).status, 200);
  const raw = readRaw(server.dbFile);
  assert.ok(!raw.includes(uid), 'the uid stays in the saved file');
  assert.ok(!raw.includes(email), 'the email stays in the saved file');

  const db = JSON.parse(raw);
  const anonymousId = db.reports.find((report) => report.id === 3).reporterId;
  assert.match(anonymousId, /^deleted-[0-9a-f]{16}$/);
  assert.deepEqual(db.auditLog.map(({ action, actorId, targetId }) => ({ action, actorId, targetId })), [
    { action: 'admin.user_suspended', actorId: 'admin', targetId: anonymousId },
    { action: 'admin.user_unsuspended', actorId: 'admin', targetId: anonymousId },
    { action: 'account.deletion_completed', actorId: null, targetId: anonymousId },
  ]);
  db.auditLog.forEach(assertEntryShape);
});

describe('GET /api/admin/audit', () => {
  const pagedFixture = () => baseFixture({
    auditLog: [
      auditEntry(1, ago(5_000)),
      auditEntry(2, ago(4_000), 'admin.user_suspended', 'admin'),
      auditEntry(3, ago(3_000)),
      auditEntry(4, ago(2_000), 'admin.user_suspended', 'admin'),
      auditEntry(5, ago(1_000)),
    ],
    nextAuditId: 6,
  });

  test('401 logged out and 403 for a signed-in non-admin', async (t) => {
    const server = await start(t, pagedFixture());
    assert.equal((await call(server, 'GET', '/api/admin/audit')).status, 401);
    // An admin's uid without a valid JWT is logged out too, however it is named.
    const forged = jwt.sign({ uid: 'admin' }, 'not-the-server-secret', { algorithm: 'HS256', expiresIn: '1h' });
    assert.equal((await fetch(`${server.baseUrl}/api/admin/audit`, { headers: { Authorization: `Bearer ${forged}` } })).status, 401);
    assert.equal((await fetch(`${server.baseUrl}/api/admin/audit?uid=admin`, { headers: { 'X-User-Id': 'admin' } })).status, 401);
    assert.equal((await call(server, 'GET', '/api/admin/audit', 'member')).status, 403);
    assert.equal((await call(server, 'GET', '/api/admin/audit?action=ack.age_confirmed', 'member')).status, 403);
  });

  test('an admin without the 18+ confirmation gets 403 age_required', async (t) => {
    const fixture = pagedFixture();
    fixture.users = fixture.users.map((user) => (user.id === 'admin' ? person('admin', { ageConfirmedAt: undefined }) : user));
    const server = await start(t, fixture);
    const res = await call(server, 'GET', '/api/admin/audit', 'admin');
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'age_required');
  });

  test('pages newest first and filters by action', async (t) => {
    const server = await start(t, pagedFixture());
    const first = await call(server, 'GET', '/api/admin/audit?limit=2', 'admin');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.items.map((entry) => entry.id), [5, 4]);
    assert.equal(first.body.nextCursor, 4);
    const second = await call(server, 'GET', `/api/admin/audit?limit=2&before=${first.body.nextCursor}`, 'admin');
    assert.deepEqual(second.body.items.map((entry) => entry.id), [3, 2]);
    const last = await call(server, 'GET', `/api/admin/audit?limit=2&before=${second.body.nextCursor}`, 'admin');
    assert.deepEqual(last.body, { items: [auditEntry(1, last.body.items[0].at)], nextCursor: null });

    const filtered = await call(server, 'GET', '/api/admin/audit?action=admin.user_suspended', 'admin');
    assert.deepEqual(filtered.body.items.map((entry) => entry.id), [4, 2]);
    assert.equal(filtered.body.nextCursor, null);
    const filteredPage = await call(server, 'GET', '/api/admin/audit?action=ack.age_confirmed&limit=1&before=5', 'admin');
    assert.deepEqual(filteredPage.body, { items: [auditEntry(3, filteredPage.body.items[0].at)], nextCursor: 3 });
    const none = await call(server, 'GET', '/api/admin/audit?action=account.deletion_completed', 'admin');
    assert.deepEqual(none.body, { items: [], nextCursor: null });
  });

  test('an unknown action or invalid page parameters give 400', async (t) => {
    const server = await start(t, pagedFixture());
    for (const query of ['action=nope', 'action=', 'action=ack.age_confirmed&action=ack.privacy_accepted', 'limit=0', 'limit=51', 'before=abc']) {
      assert.equal((await call(server, 'GET', `/api/admin/audit?${query}`, 'admin')).status, 400, query);
    }
  });
});
