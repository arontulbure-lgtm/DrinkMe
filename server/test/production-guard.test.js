import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import jwt from 'jsonwebtoken';

import { REAL_DB_FILE, assertRefusesToStart, startServer } from './helpers/harness.js';

const SERVER_FILE = fileURLToPath(new URL('../server.js', import.meta.url));

// The secret that server.js used to fall back to. It must never be accepted again.
const OLD_LITERAL_SECRET = 'drinkme-dev-secret-change-in-production';

const VALID_SECRET = 'abcdefghijklmnopqrstuvwxyz012345';
const SHORT_SECRET = 'short-canary-'.padEnd(31, 'x');
const REQUEST_TIMEOUT_MS = 20_000;
const SERVER_TEST_TIMEOUT_MS = 60_000;

// Synthetic credentials. The key exists only in memory, for this test run.
const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const TEST_SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'drinkme-guard-test',
  private_key: privateKey,
  client_email: 'guard-test@drinkme-guard-test.example.test',
});

// A line of the key body: it reads the same raw and JSON-escaped.
const PRIVATE_KEY_LINE = privateKey.split('\n')[1];

const productionEnv = (overrides = {}) => ({
  NODE_ENV: 'production',
  JWT_SECRET: VALID_SECRET,
  FIREBASE_SERVICE_ACCOUNT_KEY: TEST_SERVICE_ACCOUNT,
  ALLOW_EMPTY_DB: 'true',
  ...overrides,
});

// The Firebase block warns about FIREBASE_SERVICE_ACCOUNT_KEY on its own, so only the guard line counts.
const fatalLine = (stderr) => stderr.split(/\r?\n/).find((line) => line.includes('FATAL')) ?? '';

/** A DB_FILE in a directory that does not exist yet, to catch any write before the guard. */
const makeUnusedDbPath = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drinkme-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return path.join(dir, 'nested', 'db.json');
};

const assertNothingCreated = (dbFile) => {
  assert.equal(fs.existsSync(path.dirname(dbFile)), false, 'neither the DB file nor its directory may be created');
};

const startOn = async (t, env, options) => {
  const server = await startServer(env, options);
  t.after(() => server.stop());
  return server;
};

const postAuth = async (baseUrl, body) => {
  const res = await fetch(`${baseUrl}/api/auth/mobile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: res.status, body: await res.json() };
};

const notificationsStatus = async (baseUrl, token) => {
  const res = await fetch(`${baseUrl}/api/notifications`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return res.status;
};

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

test('production with no secret refuses to start and names JWT_SECRET only', async (t) => {
  const dbFile = makeUnusedDbPath(t);
  const { stderr } = await assertRefusesToStart(productionEnv({ JWT_SECRET: '', DB_FILE: dbFile }));

  assert.match(fatalLine(stderr), /JWT_SECRET/);
  assert.doesNotMatch(fatalLine(stderr), /FIREBASE_SERVICE_ACCOUNT_KEY/);
  assertNothingCreated(dbFile);
});

// An undefined value is dropped from the child env, so these settings are truly unset, not empty.
test('production with JWT_SECRET unset refuses to start and names it', async (t) => {
  const dbFile = makeUnusedDbPath(t);
  const { stderr } = await assertRefusesToStart(productionEnv({ JWT_SECRET: undefined, DB_FILE: dbFile }));

  assert.match(fatalLine(stderr), /JWT_SECRET/);
  assertNothingCreated(dbFile);
});

test('production with FIREBASE_SERVICE_ACCOUNT_KEY unset refuses to start and names it', async (t) => {
  const dbFile = makeUnusedDbPath(t);
  const { stderr } = await assertRefusesToStart(productionEnv({ FIREBASE_SERVICE_ACCOUNT_KEY: undefined, DB_FILE: dbFile }));

  assert.match(fatalLine(stderr), /FIREBASE_SERVICE_ACCOUNT_KEY/);
  assertNothingCreated(dbFile);
});

test('non-production with JWT_SECRET unset starts and rejects the old literal', async (t) => {
  const { baseUrl } = await startOn(t, { JWT_SECRET: undefined });
  const forged = jwt.sign({ uid: 'forged-user' }, OLD_LITERAL_SECRET, { expiresIn: '1h' });

  assert.equal(await notificationsStatus(baseUrl, forged), 401);
});

test('a refused start prints no secret or key material on stdout or stderr', async (t) => {
  const dbFile = makeUnusedDbPath(t);
  const { output } = await assertRefusesToStart(productionEnv({ JWT_SECRET: SHORT_SECRET, DB_FILE: dbFile }));

  assert.ok(!output.includes(SHORT_SECRET), 'the secret must not be printed');
  assert.ok(!output.includes(PRIVATE_KEY_LINE), 'the service account key must not be printed');
});

test('a successful start prints no secret or key material', { timeout: SERVER_TEST_TIMEOUT_MS }, async (t) => {
  const server = await startOn(t, productionEnv());
  await postAuth(server.baseUrl, { idToken: 'garbage-id-token-canary', uid: 'body-uid' });
  await server.stop(); // all output has been received once the child has closed

  assert.ok(!server.getOutput().includes(VALID_SECRET), 'the secret must not be printed');
  assert.ok(!server.getOutput().includes(PRIVATE_KEY_LINE), 'the service account key must not be printed');
});

test('PARTNER_CONSENT_REQUIRED=false warns under production rules only, and only when off', { timeout: SERVER_TEST_TIMEOUT_MS }, async (t) => {
  const warning = /\[partners\] PARTNER_CONSENT_REQUIRED=false is an emergency rollback/;
  const off = await startOn(t, productionEnv({ PARTNER_CONSENT_REQUIRED: 'false' }));
  await off.stop();
  assert.match(off.getOutput(), warning);

  const on = await startOn(t, productionEnv());
  await on.stop();
  assert.doesNotMatch(on.getOutput(), warning);

  const offOutsideProduction = await startOn(t, { PARTNER_CONSENT_REQUIRED: 'false' });
  await offOutsideProduction.stop();
  assert.doesNotMatch(offOutsideProduction.getOutput(), warning);
});

test('production with a whitespace-only secret refuses to start', async (t) => {
  const dbFile = makeUnusedDbPath(t);
  const { stderr } = await assertRefusesToStart(productionEnv({ JWT_SECRET: ' '.repeat(40), DB_FILE: dbFile }));

  assert.match(fatalLine(stderr), /JWT_SECRET/);
  assertNothingCreated(dbFile);
});

test('production with a 31 character secret refuses to start and does not print it', async (t) => {
  const dbFile = makeUnusedDbPath(t);
  const { stderr } = await assertRefusesToStart(productionEnv({ JWT_SECRET: SHORT_SECRET, DB_FILE: dbFile }));

  assert.match(fatalLine(stderr), /JWT_SECRET/);
  assert.ok(!stderr.includes(SHORT_SECRET), 'the secret must not be printed');
  assertNothingCreated(dbFile);
});

test('production with a valid secret and no Firebase key refuses and names the key', async (t) => {
  const dbFile = makeUnusedDbPath(t);
  const { stderr } = await assertRefusesToStart(productionEnv({ FIREBASE_SERVICE_ACCOUNT_KEY: '', DB_FILE: dbFile }));

  assert.match(fatalLine(stderr), /FIREBASE_SERVICE_ACCOUNT_KEY/);
  assert.doesNotMatch(fatalLine(stderr), /JWT_SECRET/);
  assertNothingCreated(dbFile);
});

test('production with both missing names both', async (t) => {
  const dbFile = makeUnusedDbPath(t);
  const { stderr } = await assertRefusesToStart(
    productionEnv({ JWT_SECRET: '', FIREBASE_SERVICE_ACCOUNT_KEY: '', DB_FILE: dbFile })
  );

  assert.match(fatalLine(stderr), /JWT_SECRET/);
  assert.match(fatalLine(stderr), /FIREBASE_SERVICE_ACCOUNT_KEY/);
});

for (const [label, key] of [
  ['malformed JSON', '{ "private_key": "guard-canary-value" '],
  ['a service account that fails validation', JSON.stringify({ project_id: 'guard-canary-value' })],
]) {
  test(`production with ${label} refuses, names the key and prints no value`, async (t) => {
    const dbFile = makeUnusedDbPath(t);
    const { stderr } = await assertRefusesToStart(productionEnv({ FIREBASE_SERVICE_ACCOUNT_KEY: key, DB_FILE: dbFile }));

    assert.match(fatalLine(stderr), /FIREBASE_SERVICE_ACCOUNT_KEY/);
    assert.ok(!stderr.includes('guard-canary-value'), 'the key content must not be printed');
    assertNothingCreated(dbFile);
  });
}

test(
  'production with a valid config starts, and a garbage idToken gets 401 and no JWT',
  { timeout: SERVER_TEST_TIMEOUT_MS },
  async (t) => {
    const idToken = 'garbage-id-token-canary';
    const { baseUrl, dbFile, getOutput } = await startOn(t, productionEnv());

    const health = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    assert.equal(health.status, 200);
    assert.equal(fs.existsSync(dbFile), true, 'ALLOW_EMPTY_DB=true creates the database');

    const startedAt = Date.now();
    const { status, body } = await postAuth(baseUrl, { idToken, uid: 'body-uid', email: 'body@example.test' });
    t.diagnostic(`verifyIdToken answered in ${Date.now() - startedAt} ms`);
    t.diagnostic(getOutput().split(/\r?\n/).find((line) => line.includes('verifyIdToken failed')) ?? 'no verify log');

    assert.equal(status, 401);
    assert.equal(body.token, undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(dbFile, 'utf8')).users, []);
    assert.ok(!getOutput().includes(idToken), 'the token must not be logged');
  }
);

test('non-production with no secret starts, warns, rejects the old literal and rotates on restart', async (t) => {
  const server = await startOn(t, { JWT_SECRET: '' });
  const { baseUrl } = server;
  assert.match(server.getOutput(), /JWT_SECRET not set/);

  const forged = jwt.sign({ uid: 'forged-user' }, OLD_LITERAL_SECRET, { expiresIn: '1h' });
  assert.equal(await notificationsStatus(baseUrl, forged), 401);

  // The development sign-in branch still works, and its token is accepted.
  const signedIn = await postAuth(baseUrl, { idToken: 'dev-fallback-token', uid: 'dev-user' });
  assert.equal(signedIn.status, 200);
  assert.equal(await notificationsStatus(baseUrl, signedIn.body.token), 200);

  await server.restart();
  assert.equal(await notificationsStatus(baseUrl, signedIn.body.token), 401);
});

test('non-production keeps using a configured secret, however short', async (t) => {
  const { baseUrl } = await startOn(t, { JWT_SECRET: 'short-dev-secret' });
  await postAuth(baseUrl, { idToken: 'dev-fallback-token', uid: 'dev-user' }); // tokens need an existing user
  const token = jwt.sign({ uid: 'dev-user' }, 'short-dev-secret', { expiresIn: '1h' });
  assert.equal(await notificationsStatus(baseUrl, token), 200);
});

test('server.js no longer contains the old literal secret', () => {
  assert.ok(!fs.readFileSync(SERVER_FILE, 'utf8').includes('drinkme-dev-secret'));
});

test('production with a relative DB_FILE refuses, even when that file exists and the flag is set', async () => {
  // The harness runs the child with cwd set to its temp dir, so the fixture is at this relative path.
  const { stderr } = await assertRefusesToStart(productionEnv({ DB_FILE: 'relative-db.json' }), { dbFixture: {} });

  assert.match(fatalLine(stderr), /DB_FILE \(must be an absolute path\)/);
});

test('production with a missing DB file and no flag refuses and creates nothing', async (t) => {
  const dbFile = makeUnusedDbPath(t);
  const { stderr } = await assertRefusesToStart(productionEnv({ ALLOW_EMPTY_DB: undefined, DB_FILE: dbFile }));

  assert.match(fatalLine(stderr), /DB_FILE/);
  assert.match(fatalLine(stderr), /ALLOW_EMPTY_DB/);
  assertNothingCreated(dbFile);
});

test('only the exact value true counts as ALLOW_EMPTY_DB', async (t) => {
  const dbFile = makeUnusedDbPath(t);
  await assertRefusesToStart(productionEnv({ ALLOW_EMPTY_DB: '1', DB_FILE: dbFile }));
  assertNothingCreated(dbFile);
});

// ── NODE_ENV fails closed ─────────────────────────────────────────────────────
for (const [label, nodeEnv] of [
  ['unset', undefined],
  ['prod', 'prod'],
  ['Production', 'Production'],
  ['production with a trailing space', 'production '],
]) {
  test(`NODE_ENV ${label} gets the production guards, whatever ALLOW_INSECURE_DEV_AUTH says`, async (t) => {
    const dbFile = makeUnusedDbPath(t);
    const { stderr } = await assertRefusesToStart(
      productionEnv({
        NODE_ENV: nodeEnv,
        JWT_SECRET: '',
        FIREBASE_SERVICE_ACCOUNT_KEY: '',
        ALLOW_INSECURE_DEV_AUTH: 'true',
        DB_FILE: dbFile,
      })
    );

    assert.match(fatalLine(stderr), /JWT_SECRET/);
    assert.match(fatalLine(stderr), /FIREBASE_SERVICE_ACCOUNT_KEY/);
    assertNothingCreated(dbFile);
  });

  test(`NODE_ENV ${label} applies the DB guard and starts with a full config`, async (t) => {
    const dbFile = makeUnusedDbPath(t);
    await assertRefusesToStart(productionEnv({ NODE_ENV: nodeEnv, ALLOW_EMPTY_DB: undefined, DB_FILE: dbFile }));
    assertNothingCreated(dbFile);

    await startOn(t, productionEnv({ NODE_ENV: nodeEnv }));
  });
}

// ── /api/auth/mobile without Firebase ─────────────────────────────────────────
for (const [label, flag] of [['no flag', undefined], ['a flag other than true', '1']]) {
  for (const nodeEnv of ['development', 'test']) {
    test(`NODE_ENV=${nodeEnv} with no key and ${label} returns 503 and issues no JWT`, async (t) => {
      const { baseUrl, dbFile } = await startOn(t, { NODE_ENV: nodeEnv, ALLOW_INSECURE_DEV_AUTH: flag });

      const { status, body } = await postAuth(baseUrl, { idToken: 'dev-fallback-token', uid: 'dev-user' });

      assert.equal(status, 503);
      assert.equal(body.token, undefined);
      assert.deepEqual(JSON.parse(fs.readFileSync(dbFile, 'utf8')).users, []);
    });
  }
}

test('NODE_ENV=development with no key and the flag signs in', async (t) => {
  const { baseUrl } = await startOn(t, { NODE_ENV: 'development', ALLOW_INSECURE_DEV_AUTH: 'true' });

  const { status, body } = await postAuth(baseUrl, { idToken: 'dev-fallback-token', uid: 'dev-user' });

  assert.equal(status, 200);
  assert.equal(await notificationsStatus(baseUrl, body.token), 200);
});

test('NODE_ENV=development with a valid key needs no flag: a garbage idToken reaches verification', async (t) => {
  const { baseUrl } = await startOn(t, {
    NODE_ENV: 'development',
    ALLOW_INSECURE_DEV_AUTH: undefined,
    FIREBASE_SERVICE_ACCOUNT_KEY: TEST_SERVICE_ACCOUNT,
  });

  const { status } = await postAuth(baseUrl, { idToken: 'garbage-id-token-canary', uid: 'dev-user' });

  assert.equal(status, 401); // not the 503 of the no-Firebase branch
});

// ── JWT_SECRET quality ────────────────────────────────────────────────────────
test('production refuses the old hardcoded secret and does not print it', async (t) => {
  const dbFile = makeUnusedDbPath(t);
  const { output, stderr } = await assertRefusesToStart(productionEnv({ JWT_SECRET: OLD_LITERAL_SECRET, DB_FILE: dbFile }));

  assert.match(fatalLine(stderr), /JWT_SECRET/);
  assert.ok(!output.includes(OLD_LITERAL_SECRET), 'the secret must not be printed');
  assertNothingCreated(dbFile);
});

for (const nodeEnv of ['test', 'development']) {
  for (const [label, secret] of [
    ['the old hardcoded secret', OLD_LITERAL_SECRET],
    ['the old hardcoded secret with surrounding whitespace', `  ${OLD_LITERAL_SECRET} `],
  ]) {
    test(`NODE_ENV=${nodeEnv} refuses ${label} and does not print it`, async (t) => {
      const dbFile = makeUnusedDbPath(t);
      const { output, stderr } = await assertRefusesToStart({ NODE_ENV: nodeEnv, JWT_SECRET: secret, DB_FILE: dbFile });

      assert.match(fatalLine(stderr), /JWT_SECRET/);
      assert.ok(!output.includes(OLD_LITERAL_SECRET), 'the secret must not be printed');
      assertNothingCreated(dbFile);
    });
  }
}

test('production refuses a long secret with fewer than 16 distinct characters', async (t) => {
  const dbFile = makeUnusedDbPath(t);
  const secret = 'abcdefghijklmno'.repeat(4); // 15 distinct
  const { stderr } = await assertRefusesToStart(productionEnv({ JWT_SECRET: secret, DB_FILE: dbFile }));

  assert.match(fatalLine(stderr), /JWT_SECRET/);
  assertNothingCreated(dbFile);
});

test('production accepts a secret of exactly 16 distinct characters', async (t) => {
  await startOn(t, productionEnv({ JWT_SECRET: 'abcdefghijklmnop'.repeat(2) }));
});

test('production accepts a generated secret', async (t) => {
  await startOn(t, productionEnv({ JWT_SECRET: crypto.randomBytes(64).toString('base64') }));
});

// ── JWT algorithm ─────────────────────────────────────────────────────────────
test('only HS256 tokens are accepted, and sign-in issues HS256', async (t) => {
  const secret = 'short-dev-secret';
  const { baseUrl } = await startOn(t, { JWT_SECRET: secret });
  await postAuth(baseUrl, { idToken: 'dev-fallback-token', uid: 'dev-user' }); // tokens need an existing user

  const hs256 = jwt.sign({ uid: 'dev-user' }, secret, { algorithm: 'HS256', expiresIn: '1h' });
  const hs512 = jwt.sign({ uid: 'dev-user' }, secret, { algorithm: 'HS512', expiresIn: '1h' });
  const unsigned = jwt.sign({ uid: 'dev-user' }, '', { algorithm: 'none' });
  assert.equal(await notificationsStatus(baseUrl, hs256), 200);
  assert.equal(await notificationsStatus(baseUrl, hs512), 401);
  assert.equal(await notificationsStatus(baseUrl, unsigned), 401);

  const { body } = await postAuth(baseUrl, { idToken: 'dev-fallback-token', uid: 'dev-user' });
  const { header, payload } = jwt.decode(body.token, { complete: true });
  assert.equal(header.alg, 'HS256');
  assert.equal(payload.exp - payload.iat, 30 * 24 * 60 * 60);
});

// ── Unusable database in production ───────────────────────────────────────────
const makeDbWith = (t, content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drinkme-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const dbFile = path.join(dir, 'db.json');
  fs.writeFileSync(dbFile, content);
  return dbFile;
};

const readBackups = (dbFile) => {
  const dir = path.dirname(dbFile);
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith(`${path.basename(dbFile)}.corrupt-`))
    .map((name) => fs.readFileSync(path.join(dir, name)));
};

for (const [label, content] of [
  ['corrupt bytes', Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x00, 0x0a])],
  ['an invalid shape', Buffer.from(JSON.stringify({ drinks: {}, nextDrinkId: 50 }))],
  ['an array root', Buffer.from('[1, 2, 3]')],
]) {
  test(`production with ${label} and no flag keeps a backup and refuses, also on the next start`, async (t) => {
    const dbFile = makeDbWith(t, content);
    const env = productionEnv({ ALLOW_EMPTY_DB: undefined, DB_FILE: dbFile });

    const { stderr } = await assertRefusesToStart(env);
    assert.match(fatalLine(stderr), /ALLOW_EMPTY_DB/);
    assert.deepEqual(fs.readFileSync(dbFile), content);
    assert.deepEqual(readBackups(dbFile), [content]);

    // The identical-backup path must refuse too, with no second backup.
    await assertRefusesToStart(env);
    assert.deepEqual(fs.readFileSync(dbFile), content);
    assert.deepEqual(readBackups(dbFile), [content]);
  });

  test(`production with ${label} and the flag keeps a backup, warns and starts empty`, async (t) => {
    const dbFile = makeDbWith(t, content);
    const server = await startOn(t, productionEnv({ DB_FILE: dbFile }));

    assert.deepEqual(readBackups(dbFile), [content]);
    assert.match(server.getOutput(), /ALLOW_EMPTY_DB=true but the database file exists/);
    const res = await fetch(`${server.baseUrl}/api/drinks`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    assert.deepEqual(await res.json(), { items: [], nextCursor: null });
  });
}

for (const [label, content] of [
  ['another JSON file', Buffer.from('{\n  "name": "some-other-app",\n  "version": "1.0.0"\n}\n')],
  ['an empty object', Buffer.from('{}')],
]) {
  test(`production with ${label} at DB_FILE refuses and leaves its bytes unchanged`, async (t) => {
    const dbFile = makeDbWith(t, content);

    const { stderr } = await assertRefusesToStart(productionEnv({ ALLOW_EMPTY_DB: undefined, DB_FILE: dbFile }));

    assert.match(fatalLine(stderr), /no known keys/);
    assert.deepEqual(fs.readFileSync(dbFile), content);
    assert.deepEqual(readBackups(dbFile), [content]);
  });
}

test('non-production still accepts an empty object with no backup', async (t) => {
  const dbFile = makeDbWith(t, '{}');
  const { baseUrl } = await startOn(t, { DB_FILE: dbFile });

  const res = await fetch(`${baseUrl}/api/drinks`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  assert.deepEqual(await res.json(), { items: [], nextCursor: null });
  assert.deepEqual(readBackups(dbFile), []);
});

test('production with an existing DB file starts without the flag and loads it', async (t) => {
  const fixture = { drinks: [{ id: 3, userId: 'nobody', name: 'Guard Fixture', isAlcoholic: false }], nextDrinkId: 4 };
  const { baseUrl } = await startOn(t, productionEnv({ ALLOW_EMPTY_DB: undefined }), { dbFixture: fixture });

  const res = await fetch(`${baseUrl}/api/drinks`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).items.map((drink) => drink.name), ['Guard Fixture']);
});

test('production warns once, with no ids, when ADMIN_USER_IDS is empty', { timeout: SERVER_TEST_TIMEOUT_MS }, async (t) => {
  const empty = await startOn(t, productionEnv());
  assert.equal(empty.getOutput().split('ADMIN_USER_IDS is empty').length - 1, 1);
  await empty.stop();
  const set = await startOn(t, productionEnv({ ADMIN_USER_IDS: 'secret-uid' }));
  assert.ok(!set.getOutput().includes('is empty'));
  assert.match(set.getOutput(), /1 of 1 match no known user/);
  assert.ok(!set.getOutput().includes('secret-uid'));
});
