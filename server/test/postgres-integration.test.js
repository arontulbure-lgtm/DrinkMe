// DATA-1 integration tests against a real Postgres. They run only when TEST_DATABASE_URL is set and
// names a throwaway database (its name must contain "test"): they DROP the drinkme_state tables there.
// `npm run test:postgres` starts a temporary Docker Postgres and runs this file. Without the variable
// every test is skipped, so `npm test` passes without Postgres.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import jwt from 'jsonwebtoken';

import { assertRefusesToStart, startServer } from './helpers/harness.js';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim() ?? '';
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const TEST_TIMEOUT_MS = 180_000;

const databaseNameOf = (url) => {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
};

const skipReason = !TEST_DATABASE_URL
  ? 'TEST_DATABASE_URL is not set: Postgres tests skipped (run npm run test:postgres in server/ to start a throwaway Postgres in Docker)'
  : !/test/i.test(databaseNameOf(TEST_DATABASE_URL))
    ? 'TEST_DATABASE_URL must name a throwaway database whose name contains "test" (these tests drop tables): skipped'
    : false;
if (skipReason) console.log(`[postgres-integration] ${skipReason}`);

const PASSWORD = skipReason ? '' : decodeURIComponent(new URL(TEST_DATABASE_URL).password);
const assertNoSecret = (text) => {
  if (PASSWORD) assert.ok(!text.includes(PASSWORD), 'output must never contain the database password');
  assert.ok(!text.includes(TEST_DATABASE_URL), 'output must never contain the connection string');
};

let pool = null;
const getPool = async () => {
  if (!pool) {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  }
  return pool;
};
after(async () => {
  await pool?.end();
});

const resetTables = async () => {
  await (await getPool()).query('DROP TABLE IF EXISTS drinkme_state_history, drinkme_state');
};
const readState = async () => {
  const { rows } = await (await getPool()).query('SELECT data FROM drinkme_state WHERE id = 1');
  return rows[0]?.data ?? null;
};
const historyCount = async () => {
  const { rows } = await (await getPool()).query('SELECT count(*)::int AS n FROM drinkme_state_history');
  return rows[0].n;
};

const waitFor = async (predicate, what, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
};

const postgresEnv = (overrides = {}) => ({ DB_DRIVER: 'postgres', DATABASE_URL: TEST_DATABASE_URL, ...overrides });

const postJson = async (url, body, token) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const getJson = async (url, token) => {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() };
};

const signIn = async (baseUrl, uid) => {
  const { status, body } = await postJson(`${baseUrl}/api/auth/mobile`, {
    idToken: 'dev-fallback-token', uid, email: `${uid}@example.test`, displayName: 'Postgres Tester',
  });
  assert.equal(status, 200);
  const age = await postJson(`${baseUrl}/api/users/${uid}/acknowledgements`, { type: 'age', confirmed: true }, body.token);
  assert.equal(age.status, 200);
  return body.token;
};

const createDrink = async (baseUrl, token, name) => {
  const created = await postJson(`${baseUrl}/api/drinks`, { name, description: 'Postgres test', rating: 4, isAlcoholic: false, imageData: TINY_PNG }, token);
  assert.equal(created.status, 201);
  return created.body;
};

// Synthetic data in the shape saveDb writes.
const FIXTURE = {
  drinks: [{ id: 7, userId: 'pg-fixture-1', name: 'Fixture Lemonade', description: 'Synthetic', isAlcoholic: false, tags: ['mocktail'], cheersCount: 0, createdAt: '2026-01-01T00:00:00.000Z' }],
  nextDrinkId: 8,
  nextNotificationId: 1,
  nextCommentId: 3,
  nextReportId: 2,
  nextAuditId: 1,
  dbSchemaVersion: 2,
  users: [
    { id: 'pg-fixture-1', email: 'fixture-one@example.test', firstName: 'Fixture', lastName: 'One', city: 'Testville', bio: 'Synthetic', avatar: null, ageConfirmedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'pg-fixture-2', email: 'fixture-two@example.test', firstName: 'Fixture', lastName: 'Two', city: 'Testville', bio: 'Rum & cola é', avatar: null },
  ],
  reports: [{ id: 1, reporterId: 'pg-fixture-2', targetType: 'drink', targetId: 7, reason: 'spam', details: null, status: 'open', createdAt: '2026-01-01T00:00:00.000Z' }],
  cheersByUser: {},
  savedByUser: { 'pg-fixture-1': [7] },
  smartBarByUser: {},
  partnersByUser: {},
  notificationsByUser: {},
  commentsByDrink: { 7: [{ id: 2, drinkId: 7, userId: 'pg-fixture-2', content: 'Synthetic comment', createdAt: '2026-01-01T00:00:00.000Z' }] },
  limitEventsByUser: {},
  blocksByUser: {},
  partnerRequestsByUser: {},
  pendingAccountDeletions: [],
  auditLog: [],
};

const makeTempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drinkme-pg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return dir;
};

// The scripts load server/.env, but values in the environment win: every setting they read is given here.
const runScript = (script, args, cwd) => {
  const result = spawnSync(process.execPath, [path.join(SERVER_DIR, 'scripts', script), ...args], {
    cwd,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      DATABASE_URL: TEST_DATABASE_URL, DATABASE_SSL: 'disable', DB_FILE: path.join(cwd, 'unused', 'db.json'), INIT_CWD: cwd,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const output = `${result.stdout}${result.stderr}`;
  assertNoSecret(output);
  return { status: result.status, output };
};

test('postgres mode: mutations reach drinkme_state, survive a restart, and no JSON file is written', { skip: skipReason, timeout: TEST_TIMEOUT_MS }, async (t) => {
  await resetTables();
  const server = await startServer(postgresEnv());
  t.after(() => server.stop());
  assert.match(server.getOutput(), /No saved state found in Postgres/);
  await waitFor(async () => (await readState()) !== null, 'the first (empty) state row');

  const token = await signIn(server.baseUrl, 'pg-user-1');
  const drink = await createDrink(server.baseUrl, token, 'Postgres Lemonade');
  const comment = await postJson(`${server.baseUrl}/api/drinks/${drink.id}/comments`, { content: 'Stored in Postgres' }, token);
  assert.equal(comment.status, 201);
  const item = await postJson(`${server.baseUrl}/api/smart-bar`, { name: 'Tonic', quantity: '1', unit: 'bottle' }, token);
  assert.ok([200, 201].includes(item.status));

  // Write-behind: wait until the last change is in Postgres (a restart on Windows kills the process
  // without a signal, so nothing would flush it).
  await waitFor(async () => {
    const state = await readState();
    return state?.drinks?.some((d) => d.name === 'Postgres Lemonade')
      && state.commentsByDrink?.[String(drink.id)]?.some((c) => c.content === 'Stored in Postgres')
      && state.smartBarByUser?.['pg-user-1']?.some((i) => i.name === 'Tonic');
  }, 'the mutations in drinkme_state');
  assert.equal(fs.existsSync(server.dbFile), false, 'postgres mode must not write DB_FILE');
  assert.ok(await historyCount() >= 1, 'a history snapshot exists');

  await server.restart();
  assert.match(server.getOutput(), /\[db\] Loaded — 1 drinks, 1 users\./);
  const drinks = await getJson(`${server.baseUrl}/api/drinks`, token);
  assert.equal(drinks.status, 200);
  assert.deepEqual(drinks.body.items.map((d) => d.name), ['Postgres Lemonade']);
  const comments = await getJson(`${server.baseUrl}/api/drinks/${drink.id}/comments`, token);
  assert.deepEqual(comments.body.items.map((c) => c.content), ['Stored in Postgres']);
  // Ids continue after the restart.
  const second = await createDrink(server.baseUrl, token, 'Second Postgres Drink');
  assert.equal(second.id, drink.id + 1);
  assertNoSecret(server.getOutput());
});

test('postgres mode: SIGTERM writes the pending change before exit', {
  skip: skipReason || (process.platform === 'win32' ? 'Windows has no SIGTERM for child processes (kill terminates at once)' : false),
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  await resetTables();
  const server = await startServer(postgresEnv());
  t.after(() => server.stop());
  const token = await signIn(server.baseUrl, 'pg-user-2');
  await createDrink(server.baseUrl, token, 'Flushed On Exit');
  await server.stop(); // SIGTERM
  assert.match(server.getOutput(), /SIGTERM: every change is written to Postgres, exiting\./);
  const state = await readState();
  assert.ok(state.drinks.some((d) => d.name === 'Flushed On Exit'));
});

test('migrate and export scripts: round trip, refusals and --force', { skip: skipReason, timeout: TEST_TIMEOUT_MS }, async (t) => {
  await resetTables();
  const dir = makeTempDir(t);
  const source = path.join(dir, 'source.json');
  fs.writeFileSync(source, JSON.stringify(FIXTURE, null, 2));

  const migrated = runScript('migrate-to-postgres.mjs', ['source.json'], dir);
  assert.equal(migrated.status, 0, migrated.output);
  assert.match(migrated.output, /users=2 drinks=1 comments=1 reports=1/);
  for (const personal of ['fixture-one@example.test', 'Synthetic comment', 'Testville']) {
    assert.ok(!migrated.output.includes(personal), 'counts only, never personal data');
  }
  assert.deepEqual(await readState(), FIXTURE);

  const refused = runScript('migrate-to-postgres.mjs', ['source.json'], dir);
  assert.equal(refused.status, 2);
  assert.match(refused.output, /Refused: Postgres already holds a DrinkMe state/);

  const legacy = path.join(dir, 'legacy.json');
  fs.writeFileSync(legacy, JSON.stringify({ ...FIXTURE, dbSchemaVersion: undefined }));
  const legacyRun = runScript('migrate-to-postgres.mjs', [legacy, '--force'], dir);
  assert.equal(legacyRun.status, 2);
  assert.match(legacyRun.output, /schema version below 2/);

  const exported = runScript('export-from-postgres.mjs', ['out/db.json'], dir);
  assert.equal(exported.status, 0, exported.output);
  const exportedText = fs.readFileSync(path.join(dir, 'out', 'db.json'), 'utf8');
  assert.deepEqual(JSON.parse(exportedText), FIXTURE);
  assert.match(exportedText, /^\{\n {2}"/, 'same indented format as saveDb');
  const overwrite = runScript('export-from-postgres.mjs', ['out/db.json'], dir);
  assert.equal(overwrite.status, 2);
  assert.match(overwrite.output, /exists/);

  const changed = { ...FIXTURE, drinks: [], commentsByDrink: {} };
  fs.writeFileSync(source, JSON.stringify(changed));
  const historyBefore = await historyCount();
  const forced = runScript('migrate-to-postgres.mjs', ['source.json', '--force'], dir);
  assert.equal(forced.status, 0, forced.output);
  assert.match(forced.output, /Copied the existing state \(users=2 drinks=1 comments=1 reports=1\) to drinkme_state_history/);
  assert.deepEqual(await readState(), changed);
  assert.ok(await historyCount() > historyBefore);

  const listed = runScript('export-from-postgres.mjs', ['--list-history'], dir);
  assert.equal(listed.status, 0, listed.output);
  const oldId = [...listed.output.matchAll(/#(\d+) \S+ users=2 drinks=1/g)].map((m) => m[1])[0];
  assert.ok(oldId, listed.output);
  const fromHistory = runScript('export-from-postgres.mjs', ['old.json', '--history', oldId], dir);
  assert.equal(fromHistory.status, 0, fromHistory.output);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'old.json'), 'utf8')), FIXTURE);

  // The migrated document loads in the server like a file: the fixture user reads the fixture post.
  runScript('migrate-to-postgres.mjs', ['old.json', '--force'], dir);
  const server = await startServer(postgresEnv());
  t.after(() => server.stop());
  const reader = jwt.sign({ uid: 'pg-fixture-1' }, 'test-only-jwt-secret', { algorithm: 'HS256', expiresIn: '1h' });
  const drinks = await getJson(`${server.baseUrl}/api/drinks`, reader);
  assert.equal(drinks.status, 200);
  assert.deepEqual(drinks.body.items.map((d) => d.name), ['Fixture Lemonade']);
});

test('backup adapter postgres writes a JSON database file', { skip: skipReason, timeout: TEST_TIMEOUT_MS }, async (t) => {
  await resetTables();
  const dir = makeTempDir(t);
  fs.writeFileSync(path.join(dir, 'source.json'), JSON.stringify(FIXTURE));
  assert.equal(runScript('migrate-to-postgres.mjs', ['source.json'], dir).status, 0);
  const { runBackup } = await import('../scripts/backup.js');
  const saved = { url: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL };
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.DATABASE_SSL = 'disable';
  t.after(() => {
    if (saved.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.url;
    if (saved.ssl === undefined) delete process.env.DATABASE_SSL; else process.env.DATABASE_SSL = saved.ssl;
  });
  const { created } = await runBackup({ backupDir: path.join(dir, 'backups'), source: 'postgres', now: Date.UTC(2026, 10, 16) });
  assert.equal(created.length, 2); // daily, and the first weekly
  assert.deepEqual(JSON.parse(fs.readFileSync(created[0], 'utf8')), FIXTURE);
});

test('one server per database: a held instance lock stops a second start and a migration', { skip: skipReason, timeout: TEST_TIMEOUT_MS }, async (t) => {
  await resetTables();
  const holder = await (await getPool()).connect();
  try {
    const { rows } = await holder.query('SELECT pg_try_advisory_lock(4163271906) AS locked');
    assert.equal(rows[0].locked, true);
    const { output } = await assertRefusesToStart(postgresEnv());
    assert.match(output, /another DrinkMe server \(or a migration\) is using this Postgres database/);
    assertNoSecret(output);
  } finally {
    await holder.query('SELECT pg_advisory_unlock(4163271906)');
    holder.release();
  }
  // A running server holds it: the migration is refused and writes nothing.
  const server = await startServer(postgresEnv());
  t.after(() => server.stop());
  await waitFor(async () => (await readState()) !== null, 'the first state row');
  const before = await readState();
  const dir = makeTempDir(t);
  fs.writeFileSync(path.join(dir, 'source.json'), JSON.stringify(FIXTURE));
  const refused = runScript('migrate-to-postgres.mjs', ['source.json', '--force'], dir);
  assert.equal(refused.status, 2, refused.output);
  assert.match(refused.output, /Stop it first/);
  assert.deepEqual(await readState(), before);
});

test('durable saves: with Postgres blocked, suspend and account deletion answer 503 and are undone', { skip: skipReason, timeout: TEST_TIMEOUT_MS }, async (t) => {
  await resetTables();
  const server = await startServer(postgresEnv({ ADMIN_USER_IDS: 'pg-admin' }));
  t.after(() => server.stop());
  const adminToken = await signIn(server.baseUrl, 'pg-admin');
  const targetToken = await signIn(server.baseUrl, 'pg-target');
  await waitFor(async () => {
    const state = await readState();
    return state?.users?.some((u) => u.id === 'pg-target' && u.ageConfirmedAt);
  }, 'both users stored');

  // Block every write: the test holds an exclusive lock on the state table.
  const blocker = await (await getPool()).connect();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await blocker.query('ROLLBACK');
    blocker.release();
  };
  t.after(release);
  await blocker.query('BEGIN');
  await blocker.query('LOCK TABLE drinkme_state IN ACCESS EXCLUSIVE MODE');

  const suspend = await postJson(`${server.baseUrl}/api/admin/users/pg-target/suspend`, {}, adminToken);
  assert.equal(suspend.status, 503);
  const deletion = await postJson(`${server.baseUrl}/api/users/pg-target/delete-account`, {}, targetToken);
  assert.equal(deletion.status, 503);
  // Undone in memory: the account still works and is not suspended.
  const profile = await getJson(`${server.baseUrl}/api/users/pg-target`, targetToken);
  assert.equal(profile.status, 200);
  assert.equal(profile.body.suspendedUntil, undefined);

  await release();
  // The undone state is queued after the blocked one, so it is what Postgres ends up with.
  await waitFor(async () => {
    const state = await readState();
    const target = state?.users?.find((u) => u.id === 'pg-target');
    return target && !(target.suspensions?.length > 0)
      && !state.pendingAccountDeletions.some((entry) => entry.uid === 'pg-target')
      && !state.auditLog.some((entry) => entry.action === 'admin.user_suspended' || entry.action === 'account.deletion_requested');
  }, 'the undone state in drinkme_state');

  // With Postgres back, the same requests work and are stored before the answer.
  const suspended = await postJson(`${server.baseUrl}/api/admin/users/pg-target/suspend`, {}, adminToken);
  assert.equal(suspended.status, 200);
  const stored = (await readState()).users.find((u) => u.id === 'pg-target');
  assert.equal(stored.suspensions.length, 1, 'stored before the 200');
});

test('a stored state that will not load is copied to the history before the server starts empty', { skip: skipReason, timeout: TEST_TIMEOUT_MS }, async (t) => {
  await resetTables();
  // Creates the tables, then the test replaces the row with a document of the wrong shape.
  const first = await startServer(postgresEnv());
  await waitFor(async () => (await readState()) !== null, 'the first state row');
  await first.stop();
  const corrupt = { users: 'not a list', dbSchemaVersion: 2 };
  await (await getPool()).query('UPDATE drinkme_state SET data = $1::jsonb WHERE id = 1', [JSON.stringify(corrupt)]);
  const historyBefore = await historyCount();

  const server = await startServer(postgresEnv());
  t.after(() => server.stop());
  assert.match(server.getOutput(), /Copied the stored Postgres state to drinkme_state_history/);
  assert.match(server.getOutput(), /invalid shape: users\), a copy is in drinkme_state_history, starting empty/);
  assert.equal(await historyCount(), historyBefore + 1);
  const { rows } = await (await getPool()).query('SELECT data FROM drinkme_state_history ORDER BY id DESC LIMIT 1');
  assert.deepEqual(rows[0].data, corrupt);
  assert.deepEqual(fs.readdirSync(path.dirname(server.dbFile)).filter((name) => name.includes('.corrupt-')), [], 'no file copy in Postgres mode');
});

test('production refuses an empty Postgres without ALLOW_EMPTY_DB, naming settings only', { skip: skipReason, timeout: TEST_TIMEOUT_MS }, async () => {
  await resetTables();
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const { output } = await assertRefusesToStart(postgresEnv({
    NODE_ENV: 'production',
    JWT_SECRET: 'abcdefghijklmnopqrstuvwxyz012345',
    FIREBASE_SERVICE_ACCOUNT_KEY: JSON.stringify({
      type: 'service_account', project_id: 'drinkme-pg-test', private_key: privateKey, client_email: 'pg@drinkme-pg-test.example.test',
    }),
    ALLOW_EMPTY_DB: '',
    // The test container has no TLS; production accepts that only when it is said explicitly (warned).
    DATABASE_SSL: 'disable',
  }));
  assert.match(output, /DATABASE_SSL=disable: the Postgres connection is not encrypted/);
  assert.match(output, /refusing to start in production\. Fix: DATABASE_URL \(no DrinkMe state in this database/);
  assertNoSecret(output);
  assert.equal(await readState(), null, 'nothing was written');
});
