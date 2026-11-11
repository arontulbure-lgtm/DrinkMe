// The email-takeover path with REQUIRE_VERIFIED_EMAIL off (and one check with it on): someone registers
// the owner's address with a password, unconfirmed, and keeps a JWT for that uid. When the owner signs in
// with Google, Firebase keeps the uid and drops the password; the server's session generation (sg) and auth
// floor must then log the kept JWT out and refuse the kept password session. Firebase is the test stub.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { after, before, test } from 'node:test';

import { REAL_DB_FILE, startServer } from './helpers/harness.js';

const REQUEST_TIMEOUT_MS = 20_000;
const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const STUB_PRELOAD = new URL('./helpers/firebase-auth-stub-preload.js', import.meta.url).href;
const FAULT_PRELOAD = new URL('./helpers/db-fault-preload.js', import.meta.url).href;
const UID = 'victim-uid';
const EMAIL = 'owner.address@example.test';

// Synthetic credentials. The key exists only in memory, for this test run.
const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const TEST_SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'drinkme-takeover-test',
  private_key: privateKey,
  client_email: 'takeover-test@drinkme-takeover-test.example.test',
});

// REQUIRE_VERIFIED_EMAIL is unset: the harness builds the child env from scratch.
const firebaseEnv = {
  ALLOW_INSECURE_DEV_AUTH: undefined,
  FIREBASE_SERVICE_ACCOUNT_KEY: TEST_SERVICE_ACCOUNT,
  NODE_OPTIONS: `--import=${STUB_PRELOAD}`,
};

const startOn = async (t, env = firebaseEnv, options) => {
  const server = await startServer(env, options);
  t.after(() => server.stop());
  return server;
};

const nowSeconds = (agoSeconds = 0) => Math.floor(Date.now() / 1000) - agoSeconds;
const stubToken = (claims) => `stub:${JSON.stringify(claims)}`;

// Each test sends its tokens in iat order, as Firebase issues them: an older iat counts as a kept token.
const nextIat = (agoSeconds) => nowSeconds(agoSeconds);

const passwordToken = ({ uid = UID, verified, iatAgo, authTimeAgo }) => ({
  uid,
  email: EMAIL,
  email_verified: verified,
  iat: nextIat(iatAgo),
  auth_time: nowSeconds(authTimeAgo),
  firebase: { sign_in_provider: 'password' },
});
// Google tokens refresh with their old auth_time, so it does not matter here.
const googleToken = ({ uid = UID, iatAgo = 0 } = {}) => ({
  uid,
  email: EMAIL,
  email_verified: true,
  name: 'Ana Owner',
  iat: nextIat(iatAgo),
  auth_time: nowSeconds(3600),
  firebase: { sign_in_provider: 'google.com' },
});

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
  return res.body.token;
};
// The own profile works before the 18+ confirmation, so it shows whether a JWT is accepted at all.
const jwtStatus = async (baseUrl, token, uid = UID) => (await request(baseUrl, 'GET', `/api/users/${uid}`, token)).status;
const claimsOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

const assertSignInAgain = (res) => {
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'sign_in_again');
  assert.equal(res.body.token, undefined);
};

const makeJwt = (claims) => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const content = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ uid: UID, ...claims })}`;
  const signature = crypto.createHmac('sha256', HARNESS_JWT_SECRET).update(content).digest('base64url');
  return `${content}.${signature}`;
};

const readDb = (dbFile) => JSON.parse(fs.readFileSync(dbFile, 'utf8'));
const storedUser = (dbFile, uid = UID) => readDb(dbFile).users.find((user) => user.id === uid);

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

// ── The takeover ──────────────────────────────────────────────────────────────
test('the attacker\'s unverified password JWT stops working once the owner signs in with Google', async (t) => {
  const { baseUrl, dbFile } = await startOn(t);
  const attacker = await signInToken(baseUrl, passwordToken({ verified: false, iatAgo: 3000, authTimeAgo: 3000 }));
  assert.equal(claimsOf(attacker).sg, undefined, 'generation 0 is left out');
  assert.equal(await jwtStatus(baseUrl, attacker), 200);
  // The attacker also confirms 18+ and has data in the account.
  assert.equal((await request(baseUrl, 'POST', `/api/users/${UID}/acknowledgements`, attacker, { type: 'age', confirmed: true })).status, 200);
  assert.equal((await request(baseUrl, 'GET', '/api/notifications', attacker)).status, 200);

  const owner = await signInToken(baseUrl, googleToken({ iatAgo: 100 }));
  assert.equal(claimsOf(owner).sg, 1);
  assert.equal(claimsOf(owner).ev, true);

  assert.equal(await jwtStatus(baseUrl, attacker), 401);
  assert.equal((await request(baseUrl, 'GET', '/api/notifications', attacker)).status, 401);
  assert.equal((await request(baseUrl, 'PUT', `/api/users/${UID}`, attacker, { bio: 'Taken' })).status, 401);
  assert.equal(await jwtStatus(baseUrl, owner), 200);
  assert.equal((await request(baseUrl, 'GET', '/api/notifications', owner)).status, 200);

  const stored = storedUser(dbFile);
  assert.equal(stored.sessionGen, 1);
  assert.equal(stored.emailVerified, true);
  assert.ok(Number.isFinite(stored.verifiedAuthFloor));
  assert.ok(!Number.isNaN(Date.parse(stored.federatedVerifiedAt)));
  // Internal fields never reach the owner view.
  const ownView = await request(baseUrl, 'GET', `/api/users/${UID}`, owner);
  for (const field of ['sessionGen', 'federatedVerifiedAt', 'verifiedAuthFloor']) assert.ok(!ownView.text.includes(field), field);
});

test('the attacker\'s refreshed password token, verified after the relink, then gets sign_in_again', async (t) => {
  const { baseUrl } = await startOn(t);
  await signInToken(baseUrl, passwordToken({ verified: false, iatAgo: 3000, authTimeAgo: 3000 }));
  await signInToken(baseUrl, googleToken({ iatAgo: 100 }));

  // A refresh keeps the attacker's auth_time, which is older than the owner's sign-in.
  assertSignInAgain(await signIn(baseUrl, passwordToken({ verified: true, iatAgo: 0, authTimeAgo: 3000 })));
  assertSignInAgain(await signIn(baseUrl, passwordToken({ verified: false, iatAgo: 0, authTimeAgo: 3000 })));
});

test('race: the attacker\'s refresh arrives first, then the owner\'s Google sign-in still logs it out', async (t) => {
  const { baseUrl, dbFile } = await startOn(t);
  const first = await signInToken(baseUrl, passwordToken({ verified: false, iatAgo: 3000, authTimeAgo: 3000 }));

  // After the relink the refreshed token says verified, but its auth_time is old: not a strong sign-in.
  const refreshed = await signInToken(baseUrl, passwordToken({ verified: true, iatAgo: 200, authTimeAgo: 3000 }));
  assert.equal(claimsOf(refreshed).ev, undefined, 'no ev for a verified but not strong token');
  assert.equal(claimsOf(refreshed).sg, undefined, 'and no new generation');
  assert.notEqual(storedUser(dbFile).emailVerified, true, 'verified is not stored');
  assert.equal(await jwtStatus(baseUrl, refreshed), 200);

  const owner = await signInToken(baseUrl, googleToken({ iatAgo: 100 }));
  assert.equal(await jwtStatus(baseUrl, first), 401);
  assert.equal(await jwtStatus(baseUrl, refreshed), 401);
  assert.equal(await jwtStatus(baseUrl, owner), 200);
  assertSignInAgain(await signIn(baseUrl, passwordToken({ verified: true, iatAgo: 0, authTimeAgo: 3000 })));
});

test('race: a fresh attacker refresh that counts as strong is still logged out by the owner\'s first Google sign-in', async (t) => {
  const { baseUrl, dbFile } = await startOn(t);
  // Registered two minutes ago, so a refresh after the relink still has a recent auth_time.
  const first = await signInToken(baseUrl, passwordToken({ verified: false, iatAgo: 120, authTimeAgo: 120 }));
  const strong = await signInToken(baseUrl, passwordToken({ verified: true, iatAgo: 60, authTimeAgo: 120 }));
  assert.equal(claimsOf(strong).sg, 1, 'the first verified sign-in started a generation');
  assert.equal(storedUser(dbFile).emailVerified, true);
  assert.equal(await jwtStatus(baseUrl, first), 401);
  assert.equal(await jwtStatus(baseUrl, strong), 200);

  // Stored verified already, but no strong federated sign-in on record: the owner's Google starts another.
  const owner = await signInToken(baseUrl, googleToken({ iatAgo: 30 }));
  assert.equal(claimsOf(owner).sg, 2);
  assert.equal(await jwtStatus(baseUrl, strong), 401);
  assert.equal(await jwtStatus(baseUrl, owner), 200);
  assertSignInAgain(await signIn(baseUrl, passwordToken({ verified: true, iatAgo: 0, authTimeAgo: 120 })));
});

test('race: the attacker\'s verified refresh is newer than the owner\'s Google token and arrives first', async (t) => {
  const { baseUrl, dbFile } = await startOn(t);
  const first = await signInToken(baseUrl, passwordToken({ verified: false, iatAgo: 3000, authTimeAgo: 3000 }));
  // Minted after the owner's Google token, so the owner's token is the older one when it arrives.
  const refreshed = await signInToken(baseUrl, passwordToken({ verified: true, iatAgo: 5, authTimeAgo: 3000 }));
  const owner = await signInToken(baseUrl, googleToken({ iatAgo: 10 }));
  assert.equal(claimsOf(owner).sg, 1);
  assert.equal(claimsOf(owner).ev, true);
  assert.equal(storedUser(dbFile).emailVerified, true);
  assert.equal(await jwtStatus(baseUrl, first), 401);
  assert.equal(await jwtStatus(baseUrl, refreshed), 401);
  assert.equal(await jwtStatus(baseUrl, owner), 200);
  assertSignInAgain(await signIn(baseUrl, passwordToken({ verified: true, iatAgo: 0, authTimeAgo: 3000 })));
});

test('the owner relaunching with a cached Google token older than the attacker\'s latest refresh keeps the attacker out', async (t) => {
  const { baseUrl } = await startOn(t);
  await signInToken(baseUrl, passwordToken({ verified: false, iatAgo: 3000, authTimeAgo: 3000 }));
  await signInToken(baseUrl, passwordToken({ verified: true, iatAgo: 30, authTimeAgo: 3000 }));
  await signInToken(baseUrl, passwordToken({ verified: true, iatAgo: 20, authTimeAgo: 3000 }));
  const owner = await signInToken(baseUrl, googleToken({ iatAgo: 40 }));
  // The attacker keeps trying with newer tokens; the owner's next launch reuses its cached token.
  assertSignInAgain(await signIn(baseUrl, passwordToken({ verified: true, iatAgo: 0, authTimeAgo: 3000 })));
  const relaunch = await signInToken(baseUrl, googleToken({ iatAgo: 40 }));
  assert.equal(claimsOf(relaunch).sg, 1, 'no new generation');
  assert.equal(await jwtStatus(baseUrl, owner), 200);
  assert.equal(await jwtStatus(baseUrl, relaunch), 200);
  assertSignInAgain(await signIn(baseUrl, passwordToken({ verified: true, iatAgo: 0, authTimeAgo: 3000 })));
  assertSignInAgain(await signIn(baseUrl, passwordToken({ verified: false, iatAgo: 0, authTimeAgo: 3000 })));
});

test('a new account first made by Google sets the floor, so a password session from before it is refused', async (t) => {
  const { baseUrl, dbFile } = await startOn(t);
  // The attacker registered with a password but never called this server; the owner's Google comes first.
  const owner = await signInToken(baseUrl, googleToken({ iatAgo: 100 }));
  assert.equal(claimsOf(owner).sg, undefined, 'a new account needs no new generation');
  assert.ok(Number.isFinite(storedUser(dbFile).verifiedAuthFloor));
  assertSignInAgain(await signIn(baseUrl, passwordToken({ verified: true, iatAgo: 0, authTimeAgo: 3000 })));
  assert.equal(await jwtStatus(baseUrl, owner), 200);
});

test('the owner\'s JWT survives the owner\'s later sign-ins', async (t) => {
  const { baseUrl } = await startOn(t);
  await signInToken(baseUrl, passwordToken({ verified: false, iatAgo: 3000, authTimeAgo: 3000 }));
  const owner = await signInToken(baseUrl, googleToken({ iatAgo: 300 }));
  for (const iatAgo of [200, 100, 0]) {
    const again = await signInToken(baseUrl, googleToken({ iatAgo }));
    assert.equal(claimsOf(again).sg, 1, 'no new generation');
    assert.equal(await jwtStatus(baseUrl, again), 200);
  }
  assert.equal(await jwtStatus(baseUrl, owner), 200);
  // A password the owner sets later, typed after the floor, works too and changes nothing.
  const password = await signInToken(baseUrl, passwordToken({ verified: true, iatAgo: 0, authTimeAgo: 0 }));
  assert.equal(claimsOf(password).sg, 1);
  assert.equal(await jwtStatus(baseUrl, owner), 200);
});

// ── Normal users ──────────────────────────────────────────────────────────────
test('a password user who verifies by link long after signing up keeps working, with no new generation', async (t) => {
  const { baseUrl, dbFile } = await startOn(t);
  const unverified = await signInToken(baseUrl, passwordToken({ verified: false, iatAgo: 3000, authTimeAgo: 3000 }));
  // The app re-exchanges on launch: a refreshed token, verified, with the old auth_time.
  const reexchanged = await signInToken(baseUrl, passwordToken({ verified: true, iatAgo: 0, authTimeAgo: 3000 }));
  assert.equal(await jwtStatus(baseUrl, unverified), 200);
  assert.equal(await jwtStatus(baseUrl, reexchanged), 200);
  assert.equal(storedUser(dbFile).sessionGen, undefined);
});

test('a password user who verifies within minutes gets a new generation, and one re-exchange is enough', async (t) => {
  const { baseUrl } = await startOn(t);
  const unverified = await signInToken(baseUrl, passwordToken({ verified: false, iatAgo: 120, authTimeAgo: 120 }));
  const reexchanged = await signInToken(baseUrl, passwordToken({ verified: true, iatAgo: 0, authTimeAgo: 120 }));
  assert.equal(claimsOf(reexchanged).sg, 1);
  assert.equal(await jwtStatus(baseUrl, reexchanged), 200);
  assert.equal(await jwtStatus(baseUrl, unverified), 401, 'the old JWT is logged out; the app re-exchanges');
  // Later refreshes of the same session stay at or above the floor and keep the generation.
  const later = await signInToken(baseUrl, passwordToken({ verified: true, iatAgo: 0, authTimeAgo: 120 }));
  assert.equal(claimsOf(later).sg, 1);
  assert.equal(await jwtStatus(baseUrl, reexchanged), 200);
});

test('a second uid with the same email gets its own account and nothing of the first one', async (t) => {
  const { baseUrl, dbFile } = await startOn(t);
  const owner = await signInToken(baseUrl, googleToken({ iatAgo: 100 }));
  assert.equal((await request(baseUrl, 'POST', `/api/users/${UID}/acknowledgements`, owner, { type: 'age', confirmed: true })).status, 200);
  assert.equal((await request(baseUrl, 'PUT', `/api/users/${UID}`, owner, { bio: 'Owner bio' })).status, 200);
  assert.equal((await request(baseUrl, 'POST', '/api/smart-bar', owner, { name: 'Owner gin', quantity: '1' })).status, 201);

  const other = await signInToken(baseUrl, googleToken({ uid: 'other-uid' }));
  assert.equal(claimsOf(other).uid, 'other-uid');
  const db = readDb(dbFile);
  assert.deepEqual(db.users.map((user) => user.id).sort(), ['other-uid', UID].sort());
  assert.equal(storedUser(dbFile).sessionGen, undefined, 'the first account is untouched');
  assert.equal(await jwtStatus(baseUrl, owner), 200);

  assert.equal((await request(baseUrl, 'POST', '/api/users/other-uid/acknowledgements', other, { type: 'age', confirmed: true })).status, 200);
  const ownerView = await request(baseUrl, 'GET', `/api/users/${UID}`, other);
  assert.equal(ownerView.status, 200);
  assert.ok(!ownerView.text.includes(EMAIL), 'no owner view for the second uid');
  assert.equal((await request(baseUrl, 'PUT', `/api/users/${UID}`, other, { bio: 'Taken' })).status, 403);
  assert.equal((await request(baseUrl, 'GET', `/api/users/${UID}/saved-drinks`, other)).status, 403);
  assert.ok(!(await request(baseUrl, 'GET', '/api/smart-bar', other)).text.includes('Owner gin'));
  assert.equal(storedUser(dbFile).bio, 'Owner bio');
});

// ── Session generation in the JWT ─────────────────────────────────────────────
test('a legacy JWT with no sg works for a user at generation 0, and only the current generation works', async (t) => {
  const user = { id: UID, email: EMAIL, firstName: 'Ana', lastName: '', city: '', bio: '', avatar: null };
  const server = await startOn(t, firebaseEnv, { dbFixture: { users: [user, { ...user, id: 'later-uid', sessionGen: 2 }] } });
  const { baseUrl } = server;
  assert.equal(await jwtStatus(baseUrl, makeJwt({})), 200);
  assert.equal(await jwtStatus(baseUrl, makeJwt({ sg: 0 })), 200);
  assert.equal(await jwtStatus(baseUrl, makeJwt({ sg: 1 })), 401);

  const later = (claims) => makeJwt({ uid: 'later-uid', ...claims });
  assert.equal(await jwtStatus(baseUrl, later({}), 'later-uid'), 401);
  assert.equal(await jwtStatus(baseUrl, later({ sg: 1 }), 'later-uid'), 401);
  assert.equal(await jwtStatus(baseUrl, later({ sg: '2' }), 'later-uid'), 401);
  assert.equal(await jwtStatus(baseUrl, later({ sg: 2 }), 'later-uid'), 200);
});

test('a failed save during the owner\'s sign-in keeps the attacker logged out, and a retry works', async (t) => {
  const env = { ...firebaseEnv, DB_FAULT: 'save', NODE_OPTIONS: `--import=${STUB_PRELOAD} --import=${FAULT_PRELOAD}` };
  const server = await startOn(t, env);
  const { baseUrl, dbFile } = server;
  const attacker = await signInToken(baseUrl, passwordToken({ verified: false, iatAgo: 3000, authTimeAgo: 3000 }));

  fs.writeFileSync(`${dbFile}.fail-saves`, '');
  const failed = await signIn(baseUrl, googleToken({ iatAgo: 100 }));
  assert.equal(failed.status, 503);
  assert.equal(failed.body.token, undefined);
  // Not rolled back: memory already holds the new generation, the file does not.
  assert.equal(await jwtStatus(baseUrl, attacker), 401);
  assert.equal(storedUser(dbFile).sessionGen, undefined);
  fs.rmSync(`${dbFile}.fail-saves`);

  const owner = await signInToken(baseUrl, googleToken({ iatAgo: 50 }));
  assert.equal(claimsOf(owner).sg, 1);
  assert.equal(storedUser(dbFile).sessionGen, 1);
  await server.restart();
  assert.equal(await jwtStatus(baseUrl, owner), 200);
  assert.equal(await jwtStatus(baseUrl, attacker), 401);
});

test('a restart keeps the generation and the floor', async (t) => {
  const server = await startOn(t);
  const { baseUrl } = server;
  const attacker = await signInToken(baseUrl, passwordToken({ verified: false, iatAgo: 3000, authTimeAgo: 3000 }));
  const owner = await signInToken(baseUrl, googleToken({ iatAgo: 100 }));
  await server.restart();
  assert.equal(await jwtStatus(baseUrl, attacker), 401);
  assert.equal(await jwtStatus(baseUrl, owner), 200);
  assertSignInAgain(await signIn(baseUrl, passwordToken({ verified: true, iatAgo: 0, authTimeAgo: 3000 })));
});

test('dev mode never starts a generation', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, {});
  const res = await request(baseUrl, 'POST', '/api/auth/mobile', undefined, { idToken: 'dev-fallback-token', uid: UID, email: EMAIL });
  assert.equal(res.status, 200);
  const again = await request(baseUrl, 'POST', '/api/auth/mobile', undefined, { idToken: 'dev-fallback-token', uid: UID, email: EMAIL });
  assert.equal(claimsOf(again.body.token).sg, undefined);
  assert.equal(await jwtStatus(baseUrl, res.body.token), 200);
  assert.equal(storedUser(dbFile).sessionGen, undefined);
});

test('a password session whose auth_time is in the same second as the owner\'s Google sign-in is refused', async (t) => {
  const { baseUrl } = await startOn(t);
  await signInToken(baseUrl, passwordToken({ verified: false, iatAgo: 3000, authTimeAgo: 3000 }));
  // The owner's token was issued in the very second the attacker signed in.
  const owner = await signInToken(baseUrl, googleToken({ iatAgo: 3000 }));
  assert.equal(claimsOf(owner).sg, 1);
  assertSignInAgain(await signIn(baseUrl, passwordToken({ verified: true, iatAgo: 0, authTimeAgo: 3000 })));
  // The owner's own password, typed afterwards, still works.
  assert.equal((await signIn(baseUrl, passwordToken({ verified: true, iatAgo: 0, authTimeAgo: 0 }))).status, 200);
});

test('flag off: an unverified token after the owner\'s Google sign-in cannot lower the stored verified state', async (t) => {
  const { baseUrl, dbFile } = await startOn(t);
  await signInToken(baseUrl, passwordToken({ verified: false, iatAgo: 3000, authTimeAgo: 3000 }));
  await signInToken(baseUrl, googleToken({ iatAgo: 100 }));
  // An unverified token above the floor can only be the owner's own, but it still must not undo the
  // confirmation a provider gave.
  const unverified = await signInToken(baseUrl, passwordToken({ verified: false, iatAgo: 0, authTimeAgo: 0 }));
  assert.equal(claimsOf(unverified).ev, undefined);
  assert.equal(storedUser(dbFile).emailVerified, true);
});

// ── With REQUIRE_VERIFIED_EMAIL on ────────────────────────────────────────────
test('flag on (V8): a replayed unverified attacker token is refused by the floor before it can change anything', async (t) => {
  // The record comes from the flag-off era: the attacker's unverified sign-in created it.
  const unverified = passwordToken({ verified: false, iatAgo: 50, authTimeAgo: 3000 });
  let fixture;
  const flagOff = await startServer(firebaseEnv);
  try {
    assert.equal((await signIn(flagOff.baseUrl, unverified)).status, 200);
    fixture = readDb(flagOff.dbFile);
  } finally {
    await flagOff.stop();
  }

  const { baseUrl, dbFile } = await startOn(t, { ...firebaseEnv, REQUIRE_VERIFIED_EMAIL: 'true' }, { dbFixture: fixture });
  // The owner's cached Google token is older than the attacker's latest token.
  const owner = await signInToken(baseUrl, googleToken({ iatAgo: 100 }));
  assert.equal(claimsOf(owner).sg, 1);
  for (let i = 0; i < 2; i++) {
    const before = fs.readFileSync(dbFile, 'utf8');
    assertSignInAgain(await signIn(baseUrl, unverified));
    assert.equal(fs.readFileSync(dbFile, 'utf8'), before, 'nothing is written');
    assert.equal(storedUser(dbFile).emailVerified, true);
    assert.equal(await jwtStatus(baseUrl, owner), 200, 'the owner stays signed in');
    assert.equal(claimsOf(await signInToken(baseUrl, googleToken({ iatAgo: 100 }))).sg, 1, 'no further generations');
  }
});

test('flag on: the owner\'s Google sign-in also logs out a JWT the attacker got from a strong refresh', async (t) => {
  const { baseUrl } = await startOn(t, { ...firebaseEnv, REQUIRE_VERIFIED_EMAIL: 'true' });
  // Unverified: no JWT at all with the flag on.
  assert.equal((await signIn(baseUrl, passwordToken({ verified: false, iatAgo: 120, authTimeAgo: 120 }))).status, 403);
  const strong = await signInToken(baseUrl, passwordToken({ verified: true, iatAgo: 60, authTimeAgo: 120 }));
  assert.equal(await jwtStatus(baseUrl, strong), 200);

  const owner = await signInToken(baseUrl, googleToken({ iatAgo: 30 }));
  assert.equal(await jwtStatus(baseUrl, strong), 401);
  assert.equal(await jwtStatus(baseUrl, owner), 200);
  assertSignInAgain(await signIn(baseUrl, passwordToken({ verified: true, iatAgo: 0, authTimeAgo: 120 })));
});
