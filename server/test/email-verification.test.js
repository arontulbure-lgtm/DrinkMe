import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';

import { startServer } from './helpers/harness.js';

const REQUEST_TIMEOUT_MS = 20_000;
const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const STUB_PRELOAD = new URL('./helpers/firebase-auth-stub-preload.js', import.meta.url).href;
const FAULT_PRELOAD = new URL('./helpers/db-fault-preload.js', import.meta.url).href;
const WARNING = 'REQUIRE_VERIFIED_EMAIL is off';
const UID = 'fb-user';
const EMAIL = 'distinctive.address@example.test';
const OLD_SECONDS = 3600;

// Synthetic credentials. The key exists only in memory, for this test run.
const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const TEST_SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'drinkme-verify-test',
  private_key: privateKey,
  client_email: 'verify-test@drinkme-verify-test.example.test',
});

const firebaseEnv = {
  ALLOW_INSECURE_DEV_AUTH: undefined,
  FIREBASE_SERVICE_ACCOUNT_KEY: TEST_SERVICE_ACCOUNT,
  NODE_OPTIONS: `--import=${STUB_PRELOAD}`,
};
const flagOn = { ...firebaseEnv, REQUIRE_VERIFIED_EMAIL: 'true' };
const flagOnWithSaveFaults = { ...flagOn, NODE_OPTIONS: `--import=${STUB_PRELOAD} --import=${FAULT_PRELOAD}`, DB_FAULT: 'save' };

const startOn = async (t, env, options) => {
  const server = await startServer(env, options);
  t.after(() => server.stop());
  return server;
};

const nowSeconds = (agoSeconds = 0) => Math.floor(Date.now() / 1000) - agoSeconds;
const stubToken = (claims) => `stub:${JSON.stringify(claims)}`;
const passwordClaims = (emailVerified, overrides = {}) => ({
  uid: UID,
  email: EMAIL,
  email_verified: emailVerified,
  iat: nowSeconds(),
  auth_time: nowSeconds(),
  firebase: { sign_in_provider: 'password' },
  ...overrides,
});
// A long-standing sign-in: Google tokens refresh with an old auth_time too.
const googleClaims = () => ({
  uid: UID,
  email: EMAIL,
  email_verified: true,
  name: 'Ana Pop',
  iat: nowSeconds(),
  auth_time: nowSeconds(OLD_SECONDS),
  firebase: { sign_in_provider: 'google.com' },
});

const postJson = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const postAuth = (baseUrl, claims) => postJson(`${baseUrl}/api/auth/mobile`, { idToken: stubToken(claims), uid: claims.uid });
const postDelete = (baseUrl, claims) => postJson(`${baseUrl}/api/account/delete-unverified`, { idToken: stubToken(claims) });

// Signed the way JWTs were before the ev claim, or with it for a later one.
const makeJwt = (claims = {}) => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const content = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ uid: UID, ...claims })}`;
  const signature = crypto.createHmac('sha256', HARNESS_JWT_SECRET).update(content).digest('base64url');
  return `${content}.${signature}`;
};

const authedStatus = async (baseUrl, path, token, init = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return res.status;
};

// Confirmed 18+, so the probes below reach their routes: every route but the first-run ones needs it.
const makeUser = (fields = {}) => ({
  id: UID,
  email: EMAIL,
  firstName: 'Fb',
  lastName: '',
  city: '',
  bio: '',
  avatar: null,
  ageConfirmedAt: '2026-01-01T00:00:00.000Z',
  ...fields,
});

const readDb = (dbFile) => JSON.parse(fs.readFileSync(dbFile, 'utf8'));
const storedUser = (dbFile) => readDb(dbFile).users.find((user) => user.id === UID);
const deleteCalls = (dbFile) => (fs.existsSync(`${dbFile}.stub-delete-calls`) ? fs.readFileSync(`${dbFile}.stub-delete-calls`, 'utf8').trim() : '');
const waitFor = async (check, label) => {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const warningCount = (output) => output.split(/\r?\n/).filter((line) => line.includes(WARNING)).length;

for (const [label, value] of [
  ['absent', undefined],
  ['false', 'false'],
  ['TRUE', 'TRUE'],
  ['1', '1'],
  ['padded', ' true'],
  ['empty', ''],
]) {
  test(`flag ${label} is off: an unverified sign-in works, an old JWT works, and the delete route does not exist`, async (t) => {
    const fixture = { users: [makeUser({ emailVerified: false })] };
    const server = await startOn(t, { ...firebaseEnv, REQUIRE_VERIFIED_EMAIL: value }, { dbFixture: fixture });
    const { baseUrl, dbFile } = server;
    assert.equal(await authedStatus(baseUrl, '/api/notifications', makeJwt()), 200);

    // Revocation is not checked with the flag off, and a stale auth_time does not matter.
    fs.writeFileSync(`${dbFile}.stub-revoked`, '');
    const { status, body } = await postAuth(baseUrl, passwordClaims(false, { auth_time: nowSeconds(OLD_SECONDS) }));
    assert.equal(status, 200);
    assert.ok(body.token);
    assert.equal(await authedStatus(baseUrl, '/api/notifications', body.token), 200);
    assert.equal(storedUser(dbFile).emailVerified, false);

    const created = await postAuth(baseUrl, { ...passwordClaims(false), uid: 'brand-new-user' });
    assert.equal(created.status, 200);
    assert.ok(created.body.token);

    assert.equal((await postDelete(baseUrl, passwordClaims(false))).status, 404);
    assert.equal(deleteCalls(dbFile), '');
  });
}

for (const [label, claim] of [['false', false], ['absent', undefined], ['a non-boolean', 'true']]) {
  test(`flag on: email_verified ${label} on an unknown uid gets 403, with no user, no JWT and no save`, async (t) => {
    const { baseUrl, dbFile } = await startOn(t, flagOn);
    const before = fs.readFileSync(dbFile);
    const { status, body } = await postAuth(baseUrl, passwordClaims(claim));
    assert.equal(status, 403);
    assert.equal(body.code, 'email_not_verified');
    assert.equal(body.token, undefined);
    assert.deepEqual(fs.readFileSync(dbFile), before);
    assert.deepEqual(readDb(dbFile).users, []);
  });
}

test('flag on: a refused sign-in logs neither the token nor the email', async (t) => {
  const { baseUrl, getOutput } = await startOn(t, flagOn);
  assert.equal((await postAuth(baseUrl, passwordClaims(false))).status, 403);
  assert.ok(!getOutput().includes(EMAIL));
  assert.ok(!getOutput().includes('stub:'));
});

for (const [label, fields] of [['verified', { emailVerified: true }], ['with no stored value', {}]]) {
  test(`flag on: a refused sign-in of a user stored ${label} stores false, and their JWT stops working`, async (t) => {
    const { baseUrl, dbFile } = await startOn(t, flagOn, { dbFixture: { users: [makeUser(fields)] } });
    assert.equal(await authedStatus(baseUrl, '/api/notifications', makeJwt({ ev: true })), 200);
    const { status, body } = await postAuth(baseUrl, passwordClaims(false));
    assert.equal(status, 403);
    assert.equal(body.code, 'email_not_verified');
    assert.equal(storedUser(dbFile).emailVerified, false);
    assert.equal(await authedStatus(baseUrl, '/api/notifications', makeJwt({ ev: true })), 401);
  });
}

test('flag on: a refused sign-in still gets 403 when the save fails, and access is gone in memory', async (t) => {
  const server = await startOn(t, flagOnWithSaveFaults, { dbFixture: { users: [makeUser({ emailVerified: true })] } });
  fs.writeFileSync(`${server.dbFile}.fail-saves`, '');
  const { status, body } = await postAuth(server.baseUrl, passwordClaims(false));
  assert.equal(status, 403);
  assert.equal(body.code, 'email_not_verified');
  assert.equal(body.token, undefined);
  assert.equal(await authedStatus(server.baseUrl, '/api/notifications', makeJwt({ ev: true })), 401);
});

test('flag on: repeating a refused sign-in saves nothing more', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: false })] } });
  const before = fs.readFileSync(dbFile);
  assert.equal((await postAuth(baseUrl, passwordClaims(false))).status, 403);
  assert.deepEqual(fs.readFileSync(dbFile), before);
});

test('flag on: a JWT with no ev counts as logged out on every kind of route', async (t) => {
  const { baseUrl } = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: false })] } });
  const token = makeJwt();
  assert.equal(await authedStatus(baseUrl, '/api/notifications', token), 401);
  assert.equal(await authedStatus(baseUrl, `/api/users/${UID}/saved-drinks`, token), 401);
  assert.equal(await authedStatus(baseUrl, `/api/users/${UID}`, token, { method: 'PUT', body: '{"bio":"x"}' }), 401);
  assert.equal(await authedStatus(baseUrl, `/api/users/${UID}/delete-account`, token, { method: 'POST', body: '{}' }), 401);

  // Nothing is readable logged out either, so the profile read is refused too.
  const res = await fetch(`${baseUrl}/api/users/${UID}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).email, undefined);
});

for (const [label, fields] of [['with no stored value', {}], ['stored as verified', { emailVerified: true }]]) {
  test(`flag on: for a user ${label}, a JWT from before the flag gets 401 and a new one works`, async (t) => {
    const { baseUrl } = await startOn(t, flagOn, { dbFixture: { users: [makeUser(fields)] } });
    assert.equal(await authedStatus(baseUrl, '/api/notifications', makeJwt()), 401);
    const { status, body } = await postAuth(baseUrl, passwordClaims(true));
    assert.equal(status, 200);
    assert.equal(await authedStatus(baseUrl, '/api/notifications', body.token), 200);
    assert.equal(await authedStatus(baseUrl, '/api/notifications', makeJwt()), 401);
  });
}

// The first verified sign-in also starts a new session generation, which logs out the unverified JWT
// (account-takeover.test.js). The own profile is the probe: it works before the 18+ confirmation.
test('flag off: only a verified sign-in JWT carries ev, and it replaces the unverified one', async (t) => {
  const server = await startOn(t, firebaseEnv);
  const { body } = await postAuth(server.baseUrl, passwordClaims(false));
  const payload = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString());
  assert.equal(payload.ev, undefined);
  assert.equal(await authedStatus(server.baseUrl, `/api/users/${UID}`, body.token), 200);
  const verified = await postAuth(server.baseUrl, passwordClaims(true));
  assert.equal(JSON.parse(Buffer.from(verified.body.token.split('.')[1], 'base64url').toString()).ev, true);
  assert.equal(await authedStatus(server.baseUrl, `/api/users/${UID}`, verified.body.token), 200);
  assert.equal(await authedStatus(server.baseUrl, `/api/users/${UID}`, body.token), 401);
});

test('flag on: a verified new user gets a working JWT', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, flagOn);
  const { status, body } = await postAuth(baseUrl, passwordClaims(true));
  assert.equal(status, 200);
  // The own profile: a new user has not confirmed 18+ yet, and this route does not need it.
  assert.equal(await authedStatus(baseUrl, `/api/users/${UID}`, body.token), 200);
  assert.equal(storedUser(dbFile).emailVerified, true);
});

test('flag on: verifying clears a stored false, without reviving a JWT issued before it', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: false })] } });
  assert.equal((await postAuth(baseUrl, passwordClaims(false))).status, 403);
  assert.equal(await authedStatus(baseUrl, '/api/notifications', makeJwt()), 401);

  const { status, body } = await postAuth(baseUrl, passwordClaims(true));
  assert.equal(status, 200);
  assert.equal(storedUser(dbFile).emailVerified, true);
  assert.equal(await authedStatus(baseUrl, '/api/notifications', body.token), 200);
  assert.equal(await authedStatus(baseUrl, '/api/notifications', makeJwt()), 401);
});

test('flag on: a failed save while verifying returns 503, and the next sign-in stores it', async (t) => {
  const server = await startOn(t, flagOnWithSaveFaults, { dbFixture: { users: [makeUser({ emailVerified: false })] } });
  const marker = `${server.dbFile}.fail-saves`;
  fs.writeFileSync(marker, '');
  const failed = await postAuth(server.baseUrl, passwordClaims(true));
  assert.equal(failed.status, 503);
  assert.equal(failed.body.token, undefined);
  assert.equal(storedUser(server.dbFile).emailVerified, false);

  fs.rmSync(marker);
  const retried = await postAuth(server.baseUrl, passwordClaims(true));
  assert.equal(retried.status, 200);
  assert.ok(retried.body.token);
  assert.equal(storedUser(server.dbFile).emailVerified, true);

  await server.restart();
  assert.equal(await authedStatus(server.baseUrl, '/api/notifications', retried.body.token), 200);
});

test('flag on: a Google sign-in works for a new user, whatever its auth_time', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, flagOn);
  const { status, body } = await postAuth(baseUrl, googleClaims());
  assert.equal(status, 200);
  assert.equal(await authedStatus(baseUrl, `/api/users/${UID}`, body.token), 200);
  assert.equal(storedUser(dbFile).emailVerified, true);
});

test('flag on: a Google sign-in corrects a stored false from an earlier sign-in', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: false })] } });
  const { status, body } = await postAuth(baseUrl, googleClaims());
  assert.equal(status, 200);
  assert.equal(storedUser(dbFile).emailVerified, true);
  assert.equal(await authedStatus(baseUrl, '/api/notifications', body.token), 200);
});

test('flag on: dev mode has no stored value and passes', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, { REQUIRE_VERIFIED_EMAIL: 'true' });
  const { status, body } = await postJson(`${baseUrl}/api/auth/mobile`, { idToken: 'dev-fallback-token', uid: UID, email: EMAIL });
  assert.equal(status, 200);
  assert.equal(storedUser(dbFile).emailVerified, undefined);
  assert.equal(await authedStatus(baseUrl, `/api/users/${UID}`, body.token), 200);
});

test('flag on: in dev mode a stored false and a JWT with no ev both pass', async (t) => {
  const { baseUrl } = await startOn(t, { REQUIRE_VERIFIED_EMAIL: 'true' }, { dbFixture: { users: [makeUser({ emailVerified: false })] } });
  assert.equal(await authedStatus(baseUrl, '/api/notifications', makeJwt()), 200);
  assert.equal((await postDelete(baseUrl, passwordClaims(false))).status, 404);
});

test('flag on: a revoked token gets 401 and no JWT, for a verified token too', async (t) => {
  const server = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: true })] } });
  fs.writeFileSync(`${server.dbFile}.stub-revoked`, '');
  const { status, body } = await postAuth(server.baseUrl, passwordClaims(true));
  assert.equal(status, 401);
  assert.equal(body.token, undefined);
});

test('flag on: 410 comes before the revocation answer on a deleted account', async (t) => {
  const server = await startOn(t, flagOn, { dbFixture: { users: [], pendingAccountDeletions: [{ uid: UID, until: Date.now() + 3_600_000 }] } });
  fs.writeFileSync(`${server.dbFile}.stub-revoked`, '');
  const { status, body } = await postAuth(server.baseUrl, passwordClaims(false, { iat: 1 }));
  assert.equal(status, 410);
  assert.equal(body.code, 'account_deleted');
});

for (const [label, overrides] of [
  ['an old auth_time', { auth_time: nowSeconds(OLD_SECONDS) }],
  ['no auth_time', { auth_time: undefined }],
]) {
  test(`flag on: a verified password token with ${label} and a stored false must sign in again, once`, async (t) => {
    const { baseUrl, dbFile } = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: false })] } });
    const refused = await postAuth(baseUrl, passwordClaims(true, overrides));
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'sign_in_again');
    assert.equal(refused.body.token, undefined);
    assert.equal(storedUser(dbFile).emailVerified, false);

    // What the client does next: a real sign-in, then later launches with a refreshed token.
    const signedIn = await postAuth(baseUrl, passwordClaims(true));
    assert.equal(signedIn.status, 200);
    assert.equal(storedUser(dbFile).emailVerified, true);
    // The kept token stays refused, which is what the floor is for.
    assert.equal((await postAuth(baseUrl, passwordClaims(true, overrides))).body.code, 'sign_in_again');
  });
}

test('flag on: an unknown uid with a verified token and an old auth_time creates nobody', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, flagOn);
  const { status, body } = await postAuth(baseUrl, passwordClaims(true, { auth_time: nowSeconds(OLD_SECONDS) }));
  assert.equal(status, 403);
  assert.equal(body.code, 'sign_in_again');
  assert.deepEqual(readDb(dbFile).users, []);
});

test('flag on: an unverified token with an old auth_time is asked to verify, not to sign in', async (t) => {
  const { baseUrl } = await startOn(t, flagOn);
  const { body } = await postAuth(baseUrl, passwordClaims(false, { auth_time: nowSeconds(OLD_SECONDS) }));
  assert.equal(body.code, 'email_not_verified');
});

const KEPT_AUTH_TIME_AGO = 2 * OLD_SECONDS;
const keptToken = (overrides = {}) => passwordClaims(true, { auth_time: nowSeconds(KEPT_AUTH_TIME_AGO), ...overrides });
const assertSignInAgain = (result) => {
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'sign_in_again');
  assert.equal(result.body.token, undefined);
};

for (const [label, iatAgo] of [['a newer', -5], ['an older', 100]]) {
  test(`floor: after the owner's password sign-in, a kept password token with ${label} iat is refused`, async (t) => {
    const { baseUrl } = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: false })] } });
    assert.equal((await postAuth(baseUrl, passwordClaims(true))).status, 200);
    assertSignInAgain(await postAuth(baseUrl, keptToken({ iat: nowSeconds(iatAgo) })));
  });

  test(`floor: after the owner's Google sign-in, a kept password token with ${label} iat is refused`, async (t) => {
    const { baseUrl } = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: false })] } });
    assert.equal((await postAuth(baseUrl, googleClaims())).status, 200);
    assertSignInAgain(await postAuth(baseUrl, keptToken({ iat: nowSeconds(iatAgo) })));
  });

  test(`floor: a kept password token with ${label} iat is refused before the owner signs in, and again after`, async (t) => {
    const { baseUrl, dbFile } = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: false })] } });
    assertSignInAgain(await postAuth(baseUrl, keptToken({ iat: nowSeconds(iatAgo) })));
    assert.equal(storedUser(dbFile).verifiedAuthFloor, undefined);
    assert.equal((await postAuth(baseUrl, googleClaims())).status, 200);
    assertSignInAgain(await postAuth(baseUrl, keptToken({ iat: nowSeconds(iatAgo) })));
  });
}

// A Google floor is one second past the iat, so an auth_time in the same second is below it.
test('floor: the first verified sign-in sets it from auth_time for password and iat + 1 for Google', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, flagOn);
  const authTime = nowSeconds(30);
  await postAuth(baseUrl, passwordClaims(true, { auth_time: authTime }));
  assert.equal(storedUser(dbFile).verifiedAuthFloor, authTime);

  const iat = nowSeconds(10);
  await postAuth(baseUrl, { ...googleClaims(), uid: 'google-user', iat });
  assert.equal(readDb(dbFile).users.find((user) => user.id === 'google-user').verifiedAuthFloor, iat + 1);
});

test('floor: the owner stays in on later refreshes and new sign-ins, and the floor does not move', async (t) => {
  // An hour after that sign-in, the refreshed token keeps the same auth_time, far outside the fresh window.
  const oldAuthTime = nowSeconds(OLD_SECONDS);
  const server = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: true, verifiedAuthFloor: oldAuthTime })] } });
  for (const overrides of [{ auth_time: oldAuthTime }, { auth_time: oldAuthTime, iat: nowSeconds() + 5 }, { auth_time: nowSeconds() }]) {
    const { status, body } = await postAuth(server.baseUrl, passwordClaims(true, overrides));
    assert.equal(status, 200);
    assert.ok(body.token);
  }
  assert.equal(storedUser(server.dbFile).verifiedAuthFloor, oldAuthTime);
});

test('floor: a device signed in before the floor is asked once, and a new sign-in clears it for good', async (t) => {
  const floor = nowSeconds(60);
  const { baseUrl } = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: true, verifiedAuthFloor: floor })] } });
  assertSignInAgain(await postAuth(baseUrl, passwordClaims(true, { auth_time: floor - 1 })));
  const authTime = nowSeconds();
  assert.equal((await postAuth(baseUrl, passwordClaims(true, { auth_time: authTime }))).status, 200);
  assert.equal((await postAuth(baseUrl, passwordClaims(true, { auth_time: authTime, iat: nowSeconds() + 5 }))).status, 200);
});

test('floor: a stored true with no floor needs one fresh sign-in, which sets it', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: true })] } });
  assertSignInAgain(await postAuth(baseUrl, keptToken()));
  assert.equal(storedUser(dbFile).verifiedAuthFloor, undefined);
  const authTime = nowSeconds();
  assert.equal((await postAuth(baseUrl, passwordClaims(true, { auth_time: authTime }))).status, 200);
  assert.equal(storedUser(dbFile).verifiedAuthFloor, authTime);
});

test('floor: a stored true with no floor and a Google token passes and gets one', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: true })] } });
  assert.equal((await postAuth(baseUrl, googleClaims())).status, 200);
  assert.ok(Number.isFinite(storedUser(dbFile).verifiedAuthFloor));
});

test('floor: Google tokens are not held to it', async (t) => {
  const { baseUrl } = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: true, verifiedAuthFloor: nowSeconds() + 100 })] } });
  assert.equal((await postAuth(baseUrl, googleClaims())).status, 200);
});

test('floor: it survives a restart', async (t) => {
  const server = await startOn(t, flagOn);
  assert.equal((await postAuth(server.baseUrl, passwordClaims(true))).status, 200);
  await server.restart();
  assertSignInAgain(await postAuth(server.baseUrl, keptToken()));
});

test('floor: it stays out of every response and goes with the record', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, flagOn);
  const { body } = await postAuth(baseUrl, passwordClaims(true));
  assert.ok(Number.isFinite(storedUser(dbFile).verifiedAuthFloor));
  for (const token of [body.token, null]) {
    const res = await fetch(`${baseUrl}/api/users/${UID}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    assert.ok(!(await res.text()).includes('verifiedAuthFloor'));
  }

  // The verified route needs a fresh token too, and removes the record with the floor on it.
  const deleted = await fetch(`${baseUrl}/api/users/${UID}/delete-account`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: stubToken(passwordClaims(true)) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assert.equal(deleted.status, 200);
  assert.ok(!fs.readFileSync(dbFile, 'utf8').includes('verifiedAuthFloor'));
});

// The takeover guard checks and sets the floor whatever the flag (account-takeover.test.js).
test('floor: with the flag off it is still checked, and a strong sign-in of a new user sets it', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [makeUser({ emailVerified: true, verifiedAuthFloor: nowSeconds() })] } });
  assertSignInAgain(await postAuth(baseUrl, keptToken()));
  assert.equal((await postAuth(baseUrl, passwordClaims(true))).status, 200);

  const authTime = nowSeconds();
  const created = await postAuth(baseUrl, passwordClaims(true, { uid: 'brand-new-user', auth_time: authTime }));
  assert.equal(created.status, 200);
  assert.equal(readDb(dbFile).users.find((user) => user.id === 'brand-new-user').verifiedAuthFloor, authTime);
  // An unconfirmed new user sets none.
  assert.equal((await postAuth(baseUrl, passwordClaims(false, { uid: 'unconfirmed-user' }))).status, 200);
  assert.equal(readDb(dbFile).users.find((user) => user.id === 'unconfirmed-user').verifiedAuthFloor, undefined);
});

test('an auth_time ahead of the margin logs one warning with no uid, and is refused', async (t) => {
  const { baseUrl, getOutput } = await startOn(t, flagOn);
  const ahead = passwordClaims(true, { auth_time: nowSeconds() + OLD_SECONDS });
  assertSignInAgain(await postAuth(baseUrl, ahead));
  assertSignInAgain(await postAuth(baseUrl, ahead));
  const lines = getOutput().split(/\r?\n/).filter((line) => line.includes('auth_time is ahead'));
  assert.equal(lines.length, 1);
  assert.ok(!getOutput().includes(UID));
});

test('an auth_time within the margin logs nothing and is accepted', async (t) => {
  const { baseUrl, getOutput } = await startOn(t, flagOn);
  assert.equal((await postAuth(baseUrl, passwordClaims(true, { auth_time: nowSeconds() + 30 }))).status, 200);
  assert.ok(!getOutput().includes('auth_time is ahead'));
});

test('delete-unverified: a stale token claiming unverified cannot delete a verified owner', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, flagOn);
  assert.equal((await postAuth(baseUrl, passwordClaims(true))).status, 200);
  const { status, body } = await postDelete(baseUrl, passwordClaims(false, { iat: nowSeconds(100) }));
  assert.equal(status, 403);
  assert.equal(body.code, 'email_already_verified');
  assert.equal(readDb(dbFile).users.length, 1);
  assert.equal(deleteCalls(dbFile), '');
});

test('delete-unverified: a stored true refuses a newer token too, until a sign-in stores false', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: true })] } });
  const refused = await postDelete(baseUrl, passwordClaims(false));
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'email_already_verified');
  assert.equal(readDb(dbFile).users.length, 1);

  assert.equal((await postAuth(baseUrl, passwordClaims(false))).status, 403);
  assert.equal(storedUser(dbFile).emailVerified, false);
  assert.equal((await postDelete(baseUrl, passwordClaims(false))).status, 200);
  assert.deepEqual(readDb(dbFile).users, []);
});

test('delete-unverified: a token older than a stored false is refused', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: false, lastIdTokenIat: nowSeconds() })] } });
  const { status, body } = await postDelete(baseUrl, passwordClaims(false, { iat: nowSeconds(100) }));
  assert.equal(status, 403);
  assert.equal(body.code, 'email_already_verified');
  assert.equal(readDb(dbFile).users.length, 1);
});

test('delete-unverified: with no record, Firebase reporting a confirmed address refuses', async (t) => {
  const server = await startOn(t, flagOn);
  fs.writeFileSync(`${server.dbFile}.stub-user-email-verified`, '');
  const { status, body } = await postDelete(server.baseUrl, passwordClaims(false));
  assert.equal(status, 403);
  assert.equal(body.code, 'email_already_verified');
  assert.equal(deleteCalls(server.dbFile), '');
});

for (const [label, content] of [['an outage', 'outage'], ['a missing user', '']]) {
  test(`delete-unverified: with no record, a lookup failing with ${label} deletes nothing`, async (t) => {
    const server = await startOn(t, flagOn);
    fs.writeFileSync(`${server.dbFile}.stub-user-gone`, content);
    const { status } = await postDelete(server.baseUrl, passwordClaims(false));
    assert.equal(status, 503);
    assert.equal(deleteCalls(server.dbFile), '');
  });
}

test('flag off: a token older than the last accepted one changes neither email nor emailVerified', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv);
  assert.equal((await postAuth(baseUrl, passwordClaims(true, { iat: nowSeconds() }))).status, 200);
  const stale = await postAuth(baseUrl, passwordClaims(false, { iat: nowSeconds(100), email: 'old.address@example.test' }));
  assert.equal(stale.status, 200);
  assert.equal(storedUser(dbFile).email, EMAIL);
  assert.equal(storedUser(dbFile).emailVerified, true);

  // Same second, or newer, still applies.
  await postAuth(baseUrl, passwordClaims(false, { iat: nowSeconds() + 5, email: 'new.address@example.test' }));
  assert.equal(storedUser(dbFile).email, 'new.address@example.test');
  assert.equal(storedUser(dbFile).emailVerified, false);
});

test('a token with no iat is not treated as older', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [makeUser({ lastIdTokenIat: nowSeconds(), emailVerified: false })] } });
  await postAuth(baseUrl, passwordClaims(true, { iat: undefined }));
  assert.equal(storedUser(dbFile).emailVerified, true);
});

test('flag on: an older unverified token gets no profit from a later verification, and changes nothing', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, flagOn);
  assert.equal((await postAuth(baseUrl, passwordClaims(true, { iat: nowSeconds() }))).status, 200);
  const stale = await postAuth(baseUrl, passwordClaims(false, { iat: nowSeconds(100), email: 'old.address@example.test' }));
  assert.equal(stale.status, 403);
  assert.equal(stale.body.token, undefined);
  assert.equal(storedUser(dbFile).emailVerified, true);
  assert.equal(storedUser(dbFile).email, EMAIL);
});

test('flag on: an older verified token cannot undo a later loss of verification', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: true })] } });
  assert.equal((await postAuth(baseUrl, passwordClaims(false, { iat: nowSeconds() }))).status, 403);
  assert.equal(storedUser(dbFile).emailVerified, false);
  const stale = await postAuth(baseUrl, passwordClaims(true, { iat: nowSeconds(100) }));
  assert.equal(stale.status, 403);
  assert.equal(stale.body.code, 'email_not_verified');
  assert.equal(storedUser(dbFile).emailVerified, false);
});

test('flag on: 410 comes first for an unverified token on a pending deletion', async (t) => {
  // The start resumes this deletion, so it can already be a tombstone by the sign-in. Both answer 410.
  const fixture = { users: [makeUser({ emailVerified: false })], pendingAccountDeletions: [{ uid: UID }] };
  const server = await startOn(t, flagOn, { dbFixture: fixture });
  const { status, body } = await postAuth(server.baseUrl, passwordClaims(false, { iat: undefined }));
  assert.equal(status, 410);
  assert.equal(body.code, 'account_deleted');
  assert.equal(body.token, undefined);
});

test('flag on: 410 comes first for an unverified token older than a finished deletion', async (t) => {
  const fixture = { users: [], pendingAccountDeletions: [{ uid: UID, until: Date.now() + 3_600_000 }] };
  const { baseUrl, dbFile } = await startOn(t, flagOn, { dbFixture: fixture });
  const { status, body } = await postAuth(baseUrl, passwordClaims(false, { iat: 1 }));
  assert.equal(status, 410);
  assert.equal(body.code, 'account_deleted');
  assert.deepEqual(readDb(dbFile).users, []);
});

test('flag on: 410 comes first for an unverified token whose Firebase user is gone', async (t) => {
  const server = await startOn(t, flagOn);
  fs.writeFileSync(`${server.dbFile}.stub-user-gone`, '');
  const { status, body } = await postAuth(server.baseUrl, passwordClaims(false));
  assert.equal(status, 410);
  assert.equal(body.code, 'account_deleted');
});

test('flag on: a UID mismatch keeps its 401 for an unverified token', async (t) => {
  const { baseUrl } = await startOn(t, flagOn);
  const { status } = await postJson(`${baseUrl}/api/auth/mobile`, { idToken: stubToken(passwordClaims(false)), uid: 'someone-else' });
  assert.equal(status, 401);
});

test('delete-unverified: a stored unverified account goes through the whole deletion', async (t) => {
  const fixture = {
    users: [makeUser({ emailVerified: false })],
    drinks: [{ id: 10, userId: UID, name: 'UnverifiedPost', description: '', rating: 4, isAlcoholic: false, createdAt: new Date().toISOString(), cheersCount: 0, tags: [], imageUrl: null }],
  };
  const { baseUrl, dbFile } = await startOn(t, flagOn, { dbFixture: fixture });
  const { status, body } = await postDelete(baseUrl, passwordClaims(false));
  assert.equal(status, 200);
  assert.deepEqual(body, { deleted: true, firebaseDeleted: true });

  const db = readDb(dbFile);
  assert.deepEqual(db.users, []);
  assert.ok(!JSON.stringify(db.drinks).includes('UnverifiedPost'));
  assert.equal(db.pendingAccountDeletions.length, 1);
  assert.notEqual(db.pendingAccountDeletions[0].until, undefined);
  assert.equal(deleteCalls(dbFile), UID);
  assert.equal((await postAuth(baseUrl, passwordClaims(false, { iat: 1 }))).status, 410);
});

test('delete-unverified: a failed Firebase delete leaves the entry pending and is reported', async (t) => {
  const server = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: false })] } });
  fs.writeFileSync(`${server.dbFile}.stub-delete-user`, 'fail');
  const { status, body } = await postDelete(server.baseUrl, passwordClaims(false));
  assert.equal(status, 200);
  assert.deepEqual(body, { deleted: true, firebaseDeleted: false });
  const [{ anonId, ...pending }] = readDb(server.dbFile).pendingAccountDeletions;
  assert.deepEqual(pending, { uid: UID });
  assert.match(anonId, /^deleted-[0-9a-f]{16}$/, 'the anonymous id of the cascade is saved with the entry');
  assert.equal((await postDelete(server.baseUrl, passwordClaims(false))).body.code, 'account_deleted');
});

test('delete-unverified: with no record only the Firebase user is deleted', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, flagOn);
  const before = fs.readFileSync(dbFile);
  const { status, body } = await postDelete(baseUrl, passwordClaims(false));
  assert.equal(status, 200);
  assert.deepEqual(body, { deleted: true, firebaseDeleted: true });
  await waitFor(() => deleteCalls(dbFile) === UID, 'the Firebase delete');
  assert.deepEqual(fs.readFileSync(dbFile), before);
});

test('delete-unverified: with no record a failed Firebase delete is reported as incomplete', async (t) => {
  const server = await startOn(t, flagOn);
  fs.writeFileSync(`${server.dbFile}.stub-delete-user`, 'fail');
  const { status, body } = await postDelete(server.baseUrl, passwordClaims(false));
  assert.equal(status, 500);
  assert.equal(body.code, 'account_deletion_incomplete');
});

for (const [label, overrides] of [
  ['an old iat', { iat: nowSeconds(OLD_SECONDS) }],
  ['an old auth_time on a password account', { auth_time: nowSeconds(OLD_SECONDS) }],
  ['no sign-in provider', { firebase: undefined }],
]) {
  test(`delete-unverified: ${label} gets 401 and deletes nothing`, async (t) => {
    const { baseUrl, dbFile } = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: false })] } });
    const { status, body } = await postDelete(baseUrl, passwordClaims(false, overrides));
    assert.equal(status, 401);
    assert.equal(body.code, 'reauth_required');
    assert.equal(readDb(dbFile).users.length, 1);
    assert.equal(deleteCalls(dbFile), '');
  });
}

test('delete-unverified: a revoked token gets 401 and deletes nothing', async (t) => {
  const server = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: false })] } });
  fs.writeFileSync(`${server.dbFile}.stub-revoked`, '');
  const { status, body } = await postDelete(server.baseUrl, passwordClaims(false));
  assert.equal(status, 401);
  assert.equal(body.code, 'reauth_required');
  assert.equal(readDb(server.dbFile).users.length, 1);
});

test('delete-unverified: a missing or invalid token gets 401', async (t) => {
  const { baseUrl } = await startOn(t, flagOn);
  for (const body of [{}, { idToken: 42 }, { idToken: 'not-a-stub-token' }]) {
    assert.equal((await postJson(`${baseUrl}/api/account/delete-unverified`, body)).status, 401);
  }
});

test('delete-unverified: a verified token is refused and deletes nothing', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: false })] } });
  const { status, body } = await postDelete(baseUrl, passwordClaims(true));
  assert.equal(status, 403);
  assert.equal(body.code, 'email_already_verified');
  assert.equal(readDb(dbFile).users.length, 1);
  assert.equal(deleteCalls(dbFile), '');
});

test('delete-unverified: the sixth attempt in the window gets 429', async (t) => {
  const { baseUrl, dbFile } = await startOn(t, flagOn, { dbFixture: { users: [makeUser({ emailVerified: false })] } });
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await postDelete(baseUrl, passwordClaims(true))).status, 403);
  }
  assert.equal((await postDelete(baseUrl, passwordClaims(false))).status, 429);
  assert.equal(readDb(dbFile).users.length, 1);
});

const productionEnv = (overrides = {}) => ({
  NODE_ENV: 'production',
  AI_PROVIDER: 'off', // production requires an explicit choice
  JWT_SECRET: 'abcdefghijklmnopqrstuvwxyz012345',
  FIREBASE_SERVICE_ACCOUNT_KEY: TEST_SERVICE_ACCOUNT,
  ALLOW_INSECURE_DEV_AUTH: undefined,
  ...overrides,
});

test('production with the flag off logs one warning, with no user data', async (t) => {
  const { getOutput } = await startOn(t, productionEnv(), { dbFixture: { users: [makeUser({ emailVerified: false })] } });
  assert.equal(warningCount(getOutput()), 1);
  assert.ok(!getOutput().includes(EMAIL));
  assert.ok(!getOutput().includes(UID));
});

test('production with the flag on logs no warning', async (t) => {
  const { getOutput } = await startOn(t, productionEnv({ REQUIRE_VERIFIED_EMAIL: 'true' }), { dbFixture: { users: [] } });
  assert.equal(warningCount(getOutput()), 0);
});

test('outside production the flag being off logs no warning', async (t) => {
  const { getOutput } = await startOn(t, firebaseEnv);
  assert.equal(warningCount(getOutput()), 0);
});
