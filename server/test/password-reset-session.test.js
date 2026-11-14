// A Firebase password reset ends the server session (owner decision of 2026-11-12). Firebase moves the
// user's tokensValidAfterTime forward when it revokes the refresh tokens; POST /api/auth/mobile looks the
// user up once per sign-in, refuses an ID token from before that time, and raises sessionGen when the
// value is newer than the one stored, which logs out every earlier JWT. Firebase is the test stub.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { after, before, test } from 'node:test';

import { REAL_DB_FILE, startServer } from './helpers/harness.js';

const REQUEST_TIMEOUT_MS = 20_000;
const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const STUB_PRELOAD = new URL('./helpers/firebase-auth-stub-preload.js', import.meta.url).href;
const FAULT_PRELOAD = new URL('./helpers/db-fault-preload.js', import.meta.url).href;
const UID = 'reset-owner-uid';
const OTHER = 'reset-viewer-uid';
const EMAIL = 'reset.owner@example.test';
const FIELD = 'tokensValidAfterSeen';

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
    project_id: 'drinkme-reset-test',
    private_key: privateKey,
    client_email: 'reset-test@drinkme-reset-test.example.test',
  }),
  NODE_OPTIONS: `--import=${STUB_PRELOAD}`,
};

const startOn = async (t, env = firebaseEnv, options) => {
  const server = await startServer(env, options);
  t.after(() => server.stop());
  return server;
};

const nowSeconds = (agoSeconds = 0) => Math.floor(Date.now() / 1000) - agoSeconds;
// Firebase reports tokensValidAfterTime as a UTC date string with whole seconds.
const utcSecondsAgo = (agoSeconds) => new Date((nowSeconds(agoSeconds)) * 1000).toUTCString();

// Unverified password tokens: the email takeover guard never bumps for them, so every bump here comes from
// the password-reset check.
const passwordClaims = ({ uid = UID, authTimeAgo = 0, iatAgo = 0 } = {}) => ({
  uid,
  email: uid === UID ? EMAIL : `${uid}@example.test`,
  email_verified: false,
  iat: nowSeconds(iatAgo),
  auth_time: nowSeconds(authTimeAgo),
  firebase: { sign_in_provider: 'password' },
});
const stubToken = (claims) => `stub:${JSON.stringify(claims)}`;

const request = async (baseUrl, method, route, token, body) => {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  return { status: res.status, text, body: parsed };
};

const signIn = (baseUrl, claims) => request(baseUrl, 'POST', '/api/auth/mobile', undefined, { idToken: stubToken(claims), uid: claims.uid });
const signInToken = async (baseUrl, claims) => {
  const res = await signIn(baseUrl, claims);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(!res.text.includes(FIELD));
  return res.body.token;
};
// The own profile works before the 18+ confirmation, so it shows whether a JWT is accepted at all.
const jwtStatus = async (baseUrl, token, uid = UID) => (await request(baseUrl, 'GET', `/api/users/${uid}`, token)).status;
const claimsOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const makeJwt = (claims) => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const content = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  const signature = crypto.createHmac('sha256', HARNESS_JWT_SECRET).update(content).digest('base64url');
  return `${content}.${signature}`;
};

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
const readDb = (dbFile) => JSON.parse(readRaw(dbFile));
const storedUser = (dbFile, uid = UID) => readDb(dbFile).users.find((user) => user.id === uid);
const revocations = (dbFile) => (readDb(dbFile).auditLog ?? []).filter((entry) => entry.action === 'auth.session_revoked');

const waitFor = async (check, what, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const setValidAfter = (dbFile, value) => fs.writeFileSync(`${dbFile}.stub-tokens-valid-after`, value);
const getUserCalls = (dbFile) => {
  const file = `${dbFile}.stub-get-user-calls`;
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
};

// An existing, confirmed account from before this check: nothing stored yet.
const existingUser = (overrides = {}) => ({
  id: UID, email: EMAIL, firstName: 'Reset', lastName: 'Owner', city: '', bio: '', avatar: null,
  nameSetByUser: true, ageConfirmedAt: new Date().toISOString(), privacyNoticeVersion: 2, ...overrides,
});
const viewerUser = () => ({
  id: OTHER, email: `${OTHER}@example.test`, firstName: 'Viewer', lastName: 'Person', city: '', bio: '', avatar: null,
  nameSetByUser: true, ageConfirmedAt: new Date().toISOString(), privacyNoticeVersion: 2,
});

// Stat only: the real database must never be read.
const statRealDb = () => {
  const stats = fs.statSync(REAL_DB_FILE, { throwIfNoEntry: false });
  return stats ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
};
let realDbBefore;
before(() => {
  realDbBefore = statRealDb();
});
after(() => {
  assert.deepEqual(statRealDb(), realDbBefore, 'server/data/db.json must stay untouched');
});

// ── The reset ─────────────────────────────────────────────────────────────────
test('after a password reset, the next sign-in logs out every earlier JWT and the new one works', async (t) => {
  const { baseUrl, dbFile } = await startOn(t);
  // Captured once: recomputing it later can land in the next second.
  const createdAt = utcSecondsAgo(3600);
  setValidAfter(dbFile, createdAt);
  const attacker = await signInToken(baseUrl, passwordClaims({ authTimeAgo: 600 }));
  assert.equal(claimsOf(attacker).sg, undefined, 'a new account starts at generation 0');
  assert.equal(await jwtStatus(baseUrl, attacker), 200);
  assert.equal(storedUser(dbFile)[FIELD], Date.parse(createdAt));
  assert.equal(storedUser(dbFile).sessionGen, undefined);

  // The owner resets the password. Until the owner's next sign-in the server cannot know.
  const resetAt = utcSecondsAgo(0);
  setValidAfter(dbFile, resetAt);
  assert.equal(await jwtStatus(baseUrl, attacker), 200);

  const owner = await signInToken(baseUrl, passwordClaims());
  assert.equal(claimsOf(owner).sg, 1);
  assert.equal(await jwtStatus(baseUrl, owner), 200);
  // Same answer as the email takeover guard's bump gives a JWT from an older generation.
  assert.equal(await jwtStatus(baseUrl, attacker), 401);
  assert.equal((await request(baseUrl, 'GET', '/api/notifications', attacker)).status, 401);
  assert.equal(storedUser(dbFile).sessionGen, 1);
  assert.equal(storedUser(dbFile)[FIELD], Date.parse(resetAt));

  const [entry, ...rest] = revocations(dbFile);
  assert.deepEqual(rest, []);
  assert.deepEqual({ actorId: entry.actorId, targetId: entry.targetId, meta: entry.meta }, {
    actorId: UID, targetId: null, meta: { reason: 'tokens_revoked' },
  });
});

test('an ID token issued before the revocation is refused and changes nothing', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [existingUser({ [FIELD]: Date.parse(utcSecondsAgo(3600)) })] } });
  setValidAfter(dbFile, utcSecondsAgo(60));
  const before = readRaw(dbFile);

  // auth_time before tokensValidAfterTime, even with a fresh iat (a refresh keeps auth_time).
  for (const claims of [passwordClaims({ authTimeAgo: 120 }), passwordClaims({ authTimeAgo: 120, iatAgo: 120 }), { ...passwordClaims(), auth_time: undefined }]) {
    const refused = await signIn(baseUrl, claims);
    assert.equal(refused.status, 401);
    assert.equal(refused.body.token, undefined);
  }
  assert.equal(readRaw(dbFile), before, 'nothing was written');

  // At or after the revocation is fine, and bumps once.
  assert.equal(claimsOf(await signInToken(baseUrl, passwordClaims({ authTimeAgo: 60 }))).sg, 1);
});

test('an ID token from before the stored value is refused even when the lookup answered older', async (t) => {
  // The race: this lookup ran before the reset, and a concurrent sign-in stored the newer value meanwhile.
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [existingUser({ [FIELD]: Date.parse(utcSecondsAgo(60)) })] } });
  setValidAfter(dbFile, utcSecondsAgo(3600));
  const refused = await signIn(baseUrl, passwordClaims({ authTimeAgo: 120 }));
  assert.equal(refused.status, 401);
  assert.equal(refused.body.token, undefined);
  assert.equal(claimsOf(await signInToken(baseUrl, passwordClaims())).sg, undefined);
});

test('a real race: a sign-in whose lookup answered before the reset is refused after a newer one stored it', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [existingUser({ [FIELD]: Date.parse(utcSecondsAgo(3600)) })] } });
  setValidAfter(dbFile, utcSecondsAgo(3600));
  // A: an attacker's token (auth_time before the coming reset), its lookup held for 1.5 s with the old value.
  fs.writeFileSync(`${dbFile}.stub-get-user-delay`, '1500');
  const slow = signIn(baseUrl, passwordClaims({ authTimeAgo: 120 }));
  await waitFor(() => !fs.existsSync(`${dbFile}.stub-get-user-delay`), 'the slow lookup to start');

  // The owner resets the password and signs in (B) while A waits.
  setValidAfter(dbFile, utcSecondsAgo(60));
  const owner = await signInToken(baseUrl, passwordClaims());
  assert.equal(claimsOf(owner).sg, 1);

  const refused = await slow;
  assert.equal(refused.status, 401);
  assert.equal(refused.body.token, undefined);
  assert.equal(storedUser(dbFile).sessionGen, 1);
  assert.equal(revocations(dbFile).length, 1);
  assert.equal(await jwtStatus(baseUrl, owner), 200);
});

// ── Disabled or deleted outside the app ───────────────────────────────────────
test('a disabled Firebase user is refused, its API sessions end once, and a new uid writes nothing', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [existingUser()] } });
  const kept = makeJwt({ uid: UID });
  fs.writeFileSync(`${dbFile}.stub-user-disabled`, '');

  const fresh = await signIn(baseUrl, passwordClaims({ uid: 'brand-new-uid' }));
  assert.equal(fresh.status, 401);
  assert.equal(fresh.body.token, undefined);
  assert.ok(!readDb(dbFile).users.some((user) => user.id === 'brand-new-uid'));

  for (let attempt = 0; attempt < 2; attempt++) {
    const refused = await signIn(baseUrl, passwordClaims());
    assert.equal(refused.status, 401);
    assert.deepEqual(refused.body, { error: 'Invalid Firebase ID token' }, 'the same answer as an invalid token');
  }
  assert.equal(await jwtStatus(baseUrl, kept), 401);
  assert.equal(storedUser(dbFile).sessionGen, 1, 'one bump for repeated attempts');
  assert.deepEqual(revocations(dbFile).map((entry) => entry.meta), [{ reason: 'account_disabled' }]);

  // Re-enabled: sign-in works at the new generation, and a later disable ends the sessions again.
  fs.rmSync(`${dbFile}.stub-user-disabled`);
  const back = await signInToken(baseUrl, passwordClaims());
  assert.equal(claimsOf(back).sg, 1);
  fs.writeFileSync(`${dbFile}.stub-user-disabled`, '');
  assert.equal((await signIn(baseUrl, passwordClaims())).status, 401);
  assert.equal(await jwtStatus(baseUrl, back), 401);
  assert.equal(storedUser(dbFile).sessionGen, 2);
});

test('an existing account Firebase no longer knows gets 410 and its API sessions end; a new uid writes nothing', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [existingUser()] } });
  const kept = makeJwt({ uid: UID });
  fs.writeFileSync(`${dbFile}.stub-user-gone`, '');

  const before = readRaw(dbFile);
  const fresh = await signIn(baseUrl, passwordClaims({ uid: 'brand-new-uid' }));
  assert.equal(fresh.status, 410);
  assert.equal(readRaw(dbFile), before, 'nothing was written');

  for (let attempt = 0; attempt < 2; attempt++) {
    const gone = await signIn(baseUrl, passwordClaims());
    assert.equal(gone.status, 410);
    assert.equal(gone.body.code, 'account_deleted');
    assert.equal(gone.body.token, undefined);
  }
  assert.equal(await jwtStatus(baseUrl, kept), 401);
  assert.equal(storedUser(dbFile).sessionGen, 1);
  assert.deepEqual(revocations(dbFile).map((entry) => entry.meta), [{ reason: 'account_gone' }]);
});

// ── A reset seen on a refused sign-in ─────────────────────────────────────────
test('a reset is applied and saved even when the sign-in then gets 403 sign_in_again (auth floor)', async (t) => {
  const fixture = { users: [existingUser({ [FIELD]: Date.parse(utcSecondsAgo(3600)), verifiedAuthFloor: nowSeconds(60) })] };
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: fixture });
  const kept = makeJwt({ uid: UID });
  const resetAt = utcSecondsAgo(600);
  setValidAfter(dbFile, resetAt);
  // After the reset, below the floor.
  const refused = await signIn(baseUrl, passwordClaims({ authTimeAgo: 300 }));
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'sign_in_again');
  assert.equal(storedUser(dbFile).sessionGen, 1);
  assert.equal(storedUser(dbFile)[FIELD], Date.parse(resetAt));
  assert.deepEqual(revocations(dbFile).map((entry) => entry.meta), [{ reason: 'tokens_revoked' }]);
  assert.equal(await jwtStatus(baseUrl, kept), 401);
});

test('flag on: a reset is applied and saved even when the sign-in then gets 403 email_not_verified', async (t) => {
  const env = { ...firebaseEnv, REQUIRE_VERIFIED_EMAIL: 'true' };
  const fixture = { users: [existingUser({ emailVerified: false, [FIELD]: Date.parse(utcSecondsAgo(3600)) })] };
  const { baseUrl, dbFile } = await startOn(t, env, { dbFixture: fixture });
  setValidAfter(dbFile, utcSecondsAgo(600));
  const refused = await signIn(baseUrl, passwordClaims());
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'email_not_verified');
  assert.equal(storedUser(dbFile).sessionGen, 1);
  assert.equal(revocations(dbFile).length, 1);
});

// ── Rollout ───────────────────────────────────────────────────────────────────
test('the first lookup of an existing account with no reset since its last sign-in stores the value without a bump', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [existingUser({ lastIdTokenIat: nowSeconds(300) })] } });
  const kept = makeJwt({ uid: UID });
  assert.equal(await jwtStatus(baseUrl, kept), 200);

  const validAfter = utcSecondsAgo(600);
  setValidAfter(dbFile, validAfter);
  const fresh = await signInToken(baseUrl, passwordClaims());
  assert.equal(claimsOf(fresh).sg, undefined);
  assert.equal(await jwtStatus(baseUrl, kept), 200, 'the deploy logs nobody out');
  assert.equal(storedUser(dbFile)[FIELD], Date.parse(validAfter));
  assert.deepEqual(revocations(dbFile), []);
});

test('the first lookup bumps when Firebase revoked the tokens after the last accepted sign-in', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [existingUser({ lastIdTokenIat: nowSeconds(1200) })] } });
  const kept = makeJwt({ uid: UID });
  const validAfter = utcSecondsAgo(600);
  setValidAfter(dbFile, validAfter);
  const fresh = await signInToken(baseUrl, passwordClaims());
  assert.equal(claimsOf(fresh).sg, 1);
  assert.equal(await jwtStatus(baseUrl, kept), 401);
  assert.equal(storedUser(dbFile)[FIELD], Date.parse(validAfter));
  assert.deepEqual(revocations(dbFile).map((entry) => entry.meta), [{ reason: 'tokens_revoked' }]);
  // Seen once: the next sign-in bumps nothing.
  assert.equal(claimsOf(await signInToken(baseUrl, passwordClaims())).sg, 1);
});

test('a lookup that reports no value stores 0, so a later value counts as a revocation', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [existingUser()] } });
  const kept = await signInToken(baseUrl, passwordClaims({ authTimeAgo: 600 }));
  assert.equal(storedUser(dbFile)[FIELD], 0);

  setValidAfter(dbFile, utcSecondsAgo(0));
  assert.equal(claimsOf(await signInToken(baseUrl, passwordClaims())).sg, 1);
  assert.equal(await jwtStatus(baseUrl, kept), 401);
});

test('repeated sign-ins after one reset bump once', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [existingUser({ [FIELD]: Date.parse(utcSecondsAgo(3600)) })] } });
  setValidAfter(dbFile, utcSecondsAgo(0));
  const first = await signInToken(baseUrl, passwordClaims());
  const second = await signInToken(baseUrl, passwordClaims());
  const [a, b] = await Promise.all([signIn(baseUrl, passwordClaims()), signIn(baseUrl, passwordClaims())]);
  for (const token of [first, second, a.body.token, b.body.token]) {
    assert.equal(claimsOf(token).sg, 1);
    assert.equal(await jwtStatus(baseUrl, token), 200);
  }
  assert.equal(storedUser(dbFile).sessionGen, 1);
  assert.equal(revocations(dbFile).length, 1);

  // An older value (a restored Firebase state or clock change) never lowers the stored one or bumps.
  const storedAfterReset = storedUser(dbFile)[FIELD];
  setValidAfter(dbFile, utcSecondsAgo(7200));
  assert.equal(claimsOf(await signInToken(baseUrl, passwordClaims())).sg, 1);
  assert.equal(storedUser(dbFile)[FIELD], storedAfterReset);
  assert.equal(revocations(dbFile).length, 1);
});

test('a reset together with the email takeover guard\'s bump raises the generation once', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [existingUser({ emailVerified: false, [FIELD]: Date.parse(utcSecondsAgo(3600)) })] } });
  setValidAfter(dbFile, utcSecondsAgo(0));
  const google = {
    uid: UID, email: EMAIL, email_verified: true, iat: nowSeconds(), auth_time: nowSeconds(), firebase: { sign_in_provider: 'google.com' },
  };
  assert.equal(claimsOf(await signInToken(baseUrl, google)).sg, 1);
  const entries = revocations(dbFile);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].meta, { reason: 'tokens_revoked' });
});

// ── Failures ──────────────────────────────────────────────────────────────────
test('when the Firebase lookup fails, sign-in answers 503 auth_unavailable, issues no JWT and writes nothing', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [existingUser({ [FIELD]: Date.parse(utcSecondsAgo(3600)) })] } });
  fs.writeFileSync(`${dbFile}.stub-user-gone`, 'outage');
  const before = readRaw(dbFile);
  for (const uid of [UID, 'brand-new-uid']) {
    const res = await signIn(baseUrl, passwordClaims({ uid }));
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'auth_unavailable');
    assert.equal(res.body.token, undefined);
  }
  assert.equal(readRaw(dbFile), before, 'nothing was written');
});

test('an unreadable tokensValidAfterTime fails closed', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [existingUser()] } });
  setValidAfter(dbFile, 'not a date');
  const res = await signIn(baseUrl, passwordClaims());
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'auth_unavailable');
});

test('one Firebase lookup per sign-in', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [existingUser()] } });
  await signInToken(baseUrl, passwordClaims());
  assert.equal(getUserCalls(dbFile), 1);
  await signInToken(baseUrl, passwordClaims({ uid: 'brand-new-uid' }));
  assert.equal(getUserCalls(dbFile), 2);
});

test('a failed save keeps the bump, and the retry does not bump again', async (t) => {
  const env = { ...firebaseEnv, DB_FAULT: 'save', NODE_OPTIONS: `--import=${STUB_PRELOAD} --import=${FAULT_PRELOAD}` };
  const { baseUrl, dbFile } = await startOn(t, env, { dbFixture: { users: [existingUser({ [FIELD]: Date.parse(utcSecondsAgo(3600)) })] } });
  const kept = makeJwt({ uid: UID });
  setValidAfter(dbFile, utcSecondsAgo(0));
  fs.writeFileSync(`${dbFile}.fail-saves`, '');
  try {
    const failed = await signIn(baseUrl, passwordClaims());
    assert.equal(failed.status, 503);
    assert.equal(failed.body.token, undefined);
  } finally {
    fs.rmSync(`${dbFile}.fail-saves`);
  }
  assert.equal(await jwtStatus(baseUrl, kept), 401, 'the bump stays in memory');
  assert.equal(claimsOf(await signInToken(baseUrl, passwordClaims())).sg, 1);
  assert.equal(storedUser(dbFile).sessionGen, 1);
  assert.equal(revocations(dbFile).length, 1);
});

// ── Privacy ───────────────────────────────────────────────────────────────────
test('the stored value reaches no response and no log line', async (t) => {
  const server = await startOn(t, firebaseEnv, { dbFixture: { users: [existingUser(), viewerUser()] } });
  const { baseUrl, dbFile } = server;
  const resetAt = utcSecondsAgo(0);
  setValidAfter(dbFile, resetAt);
  const owner = await signInToken(baseUrl, passwordClaims());
  const viewer = await signInToken(baseUrl, passwordClaims({ uid: OTHER }));
  const storedValue = String(storedUser(dbFile)[FIELD]);
  assert.ok(Number(storedValue) > 0);

  const responses = [
    await request(baseUrl, 'GET', `/api/users/${UID}`, owner),
    await request(baseUrl, 'GET', `/api/users/${UID}`, viewer),
    await request(baseUrl, 'GET', '/api/users/search?q=Reset', viewer),
    await request(baseUrl, 'PUT', `/api/users/${UID}`, owner, { bio: 'Hello' }),
  ];
  for (const res of responses) {
    assert.equal(res.status, 200, res.text);
    assert.ok(!res.text.includes(FIELD), res.text);
    assert.ok(!res.text.includes(storedValue), res.text);
  }
  const output = server.getOutput();
  assert.ok(!output.includes(resetAt) && !output.includes(storedValue) && !output.includes(FIELD));
});

test('account deletion removes the stored value', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [existingUser(), viewerUser()] } });
  setValidAfter(dbFile, utcSecondsAgo(600));
  const owner = await signInToken(baseUrl, passwordClaims());
  await signInToken(baseUrl, passwordClaims({ uid: OTHER }));
  assert.ok(Number.isFinite(storedUser(dbFile)[FIELD]));

  const deleted = await request(baseUrl, 'POST', `/api/users/${UID}/delete-account`, owner, { idToken: stubToken(passwordClaims()) });
  assert.equal(deleted.status, 200, deleted.text);
  const db = readDb(dbFile);
  assert.equal(db.users.some((user) => user.id === UID), false);
  assert.ok(Number.isFinite(storedUser(dbFile, OTHER)[FIELD]), 'other accounts keep theirs');
  assert.equal(db.users.filter((user) => FIELD in user).length, 1);
});

// ── Dev mode ──────────────────────────────────────────────────────────────────
test('dev mode (ALLOW_INSECURE_DEV_AUTH, no Firebase) is unchanged: no lookup, nothing stored', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, {}, { dbFixture: { users: [existingUser()] } });
  const res = await request(baseUrl, 'POST', '/api/auth/mobile', undefined, { idToken: 'dev-token', uid: UID });
  assert.equal(res.status, 200, res.text);
  assert.equal(claimsOf(res.body.token).sg, undefined);
  assert.equal(storedUser(dbFile)[FIELD], undefined);
  assert.equal(getUserCalls(dbFile), 0);
});

// ── Audit budget (lead decision, fix loop 1) ──────────────────────────────────
// auth.session_revoked shares the users' 15,000-entry budget, so one account resetting its password over
// and over must not push other users' consent records out: the bump always happens, the entry at most once
// per account and reason per 24 hours.
test('50 resets in a row bump the generation each time but write one audit entry, and keep other users\' entries', async (t) => {
  const otherAck = { id: 1, at: new Date().toISOString(), action: 'ack.age_confirmed', actorId: OTHER, targetId: null };
  const fixture = {
    users: [existingUser({ [FIELD]: Date.parse(utcSecondsAgo(7200)) }), viewerUser()],
    auditLog: [otherAck],
    nextAuditId: 2,
  };
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: fixture });
  const base = nowSeconds(3600);
  for (let cycle = 1; cycle <= 50; cycle++) {
    setValidAfter(dbFile, new Date((base + cycle * 10) * 1000).toUTCString());
    let res = await signIn(baseUrl, passwordClaims());
    // Sign-in runs through the per-IP mutation limiter (30 / minute).
    if (res.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 61_000));
      res = await signIn(baseUrl, passwordClaims());
    }
    assert.equal(res.status, 200, `cycle ${cycle}: ${res.text}`);
    assert.equal(claimsOf(res.body.token).sg, cycle);
  }
  assert.equal(storedUser(dbFile).sessionGen, 50);
  const entries = revocations(dbFile).filter((entry) => entry.actorId === UID);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].meta, { reason: 'tokens_revoked' });
  assert.ok(readDb(dbFile).auditLog.some((entry) => entry.action === 'ack.age_confirmed' && entry.actorId === OTHER));
});

test('an entry older than 24 hours does not stop a new one', async (t) => {
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const fixture = {
    users: [existingUser({ [FIELD]: Date.parse(utcSecondsAgo(7200)) })],
    auditLog: [{ id: 1, at: old, action: 'auth.session_revoked', actorId: UID, targetId: null, meta: { reason: 'tokens_revoked' } }],
    nextAuditId: 2,
  };
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: fixture });
  setValidAfter(dbFile, utcSecondsAgo(600));
  assert.equal(claimsOf(await signInToken(baseUrl, passwordClaims())).sg, 1);
  assert.equal(revocations(dbFile).filter((entry) => entry.actorId === UID).length, 2);
});
