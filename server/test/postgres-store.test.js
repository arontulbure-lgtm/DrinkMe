// Unit tests for storage/postgres-store.js (DATA-1): settings, JSONB-safe text, the write-behind queue
// and the store's SQL flow, with fakes only. No Postgres needed; see postgres-integration.test.js.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import {
  DEFAULT_HISTORY_MAX_AGE_MS, countDbRecords, createWriteBehindQueue, describePgError, openPostgresStore, readDbDriverConfig,
  sslOptionFor, sslmodeOf, toJsonbSafeText,
} from '../storage/postgres-store.js';
import { assertRefusesToStart } from './helpers/harness.js';

const silentLog = { warn() {}, error() {}, log() {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));

// A write() the test settles by hand: calls[i] = { snapshot, resolve, reject }.
const controlledWriter = () => {
  const calls = [];
  const write = (snapshot) => new Promise((resolve, reject) => calls.push({ snapshot, resolve, reject }));
  return { calls, write };
};

test('DB_DRIVER defaults to json; postgres needs a postgres:// DATABASE_URL; names only in problems', () => {
  assert.deepEqual(readDbDriverConfig({}).driver, 'json');
  assert.deepEqual(readDbDriverConfig({}).problems, []);
  assert.deepEqual(readDbDriverConfig({ DB_DRIVER: ' json ' }).problems, []);
  assert.deepEqual(readDbDriverConfig({ DB_DRIVER: 'mysql' }).problems, ['DB_DRIVER (must be json or postgres)']);
  assert.deepEqual(readDbDriverConfig({ DB_DRIVER: 'Postgres', DATABASE_URL: 'postgres://u:p@h/db' }).problems, ['DB_DRIVER (must be json or postgres)']);
  assert.deepEqual(readDbDriverConfig({ DB_DRIVER: 'postgres' }).problems, ['DATABASE_URL (required when DB_DRIVER=postgres)']);
  const secret = 'mysql://user:hunter2@host/db';
  const bad = readDbDriverConfig({ DB_DRIVER: 'postgres', DATABASE_URL: secret });
  assert.deepEqual(bad.problems, ['DATABASE_URL (must start with postgres:// or postgresql://)']);
  assert.ok(!bad.problems.join(' ').includes('hunter2'));
  const ok = readDbDriverConfig({ DB_DRIVER: 'postgres', DATABASE_URL: ' postgresql://u:p@h:5432/db ', DATABASE_SSL: 'require' });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.databaseUrl, 'postgresql://u:p@h:5432/db');
  assert.equal(ok.ssl, 'require');
  assert.deepEqual(readDbDriverConfig({ DATABASE_SSL: 'yes' }).problems, ['DATABASE_SSL (must be require or disable)']);
  assert.deepEqual(readDbDriverConfig({ DATABASE_URL: 'postgres://x' }).warnings.length, 1);
  assert.deepEqual(sslOptionFor('require'), { rejectUnauthorized: true });
  assert.equal(sslOptionFor('disable'), false);
  assert.equal(sslOptionFor(null), undefined);
});

test('sslmode in DATABASE_URL: a weaker mode conflicts with DATABASE_SSL=require; production needs verified TLS', () => {
  const base = 'postgres://u:hunter2@db.example.test:5432/drinkme';
  const config = (url, ssl, production = false) => readDbDriverConfig(
    { DB_DRIVER: 'postgres', DATABASE_URL: url, ...(ssl !== undefined && { DATABASE_SSL: ssl }) },
    { production },
  );
  assert.equal(sslmodeOf(`${base}?sslmode=Verify-Full`), 'verify-full');
  assert.equal(sslmodeOf(base), null);
  assert.equal(sslmodeOf('postgres://[bad'), undefined);
  for (const weak of ['disable', 'allow', 'prefer', 'no-verify']) {
    const { problems } = config(`${base}?sslmode=${weak}`, 'require');
    assert.equal(problems.length, 1, weak);
    assert.match(problems[0], /^DATABASE_SSL \(require conflicts with a weaker sslmode/);
    assert.ok(!problems[0].includes('hunter2'));
  }
  for (const strong of ['require', 'verify-ca', 'verify-full']) {
    assert.deepEqual(config(`${base}?sslmode=${strong}`, 'require').problems, [], strong);
  }
  // Outside production nothing more is required.
  assert.deepEqual(config(base, undefined).problems, []);
  assert.deepEqual(config(`${base}?sslmode=prefer`, undefined).problems, []);
  // Production: DATABASE_SSL=require, or a verifying sslmode, or an explicit disable (warned).
  assert.deepEqual(config(base, 'require', true).problems, []);
  for (const strong of ['require', 'verify-ca', 'verify-full']) assert.deepEqual(config(`${base}?sslmode=${strong}`, undefined, true).problems, []);
  for (const url of [base, `${base}?sslmode=prefer`, `${base}?sslmode=no-verify`, `${base}?sslmode=disable`]) {
    const { problems } = config(url, undefined, true);
    assert.deepEqual(problems, ['DATABASE_SSL (production needs require, or sslmode=verify-full in DATABASE_URL; disable only on a private network)'], url);
  }
  const disabled = config(base, 'disable', true);
  assert.deepEqual(disabled.problems, []);
  assert.match(disabled.warnings.join(' '), /not encrypted\. Use this only on a private network/);
  // The JSON driver ignores the URL's sslmode.
  assert.deepEqual(readDbDriverConfig({ DATABASE_URL: `${base}?sslmode=disable`, DATABASE_SSL: 'require' }, { production: true }).problems, []);
});

test('the history ceiling defaults to 28 days', () => {
  assert.equal(DEFAULT_HISTORY_MAX_AGE_MS, 28 * 24 * 60 * 60 * 1000);
});

test('describePgError gives a code, never a message', () => {
  assert.equal(describePgError(Object.assign(new Error('password authentication failed for user "x"'), { code: '28P01' })), '28P01');
  assert.equal(describePgError(new Error('connect to secret-host failed')), 'Error');
  assert.equal(describePgError(Object.assign(new Error('x'), { code: 'bad code with spaces' })), 'Error');
});

test('toJsonbSafeText replaces NUL and lone surrogate escapes only', () => {
  const sample = { a: 'x\u0000y', b: '\ud800', c: 'typed \\u0000 text', d: '\\\u0000', e: '😀', f: 'plain' };
  const { text, replaced } = toJsonbSafeText(JSON.stringify(sample));
  assert.equal(replaced, 3);
  assert.deepEqual(JSON.parse(text), { a: 'x�y', b: '�', c: 'typed \\u0000 text', d: '\\�', e: '😀', f: 'plain' });
  const clean = JSON.stringify({ a: 'nothing to do', b: '\u0001' });
  assert.deepEqual(toJsonbSafeText(clean), { text: clean, replaced: 0 });
});

test('countDbRecords counts users, drinks, comments and reports only', () => {
  assert.deepEqual(countDbRecords({ users: [{}, {}], drinks: [{}], commentsByDrink: { 1: [{}, {}], 2: [{}] }, reports: [] }), {
    users: 2, drinks: 1, comments: 3, reports: 0,
  });
  assert.deepEqual(countDbRecords({}), { users: 0, drinks: 0, comments: 0, reports: 0 });
});

test('write-behind: one write in flight, later snapshots coalesce to the latest, in order', async () => {
  const { calls, write } = controlledWriter();
  const queue = createWriteBehindQueue({ write, log: silentLog });
  queue.enqueue(1);
  queue.enqueue(2); // replaced by 3 while 1 is in flight
  queue.enqueue(3);
  await tick();
  assert.deepEqual(calls.map((c) => c.snapshot), [1]);
  calls[0].resolve();
  await tick();
  assert.deepEqual(calls.map((c) => c.snapshot), [1, 3]);
  queue.enqueue(4);
  await tick();
  assert.equal(calls.length, 2, 'never two writes at once');
  calls[1].resolve();
  await tick();
  assert.deepEqual(calls.map((c) => c.snapshot), [1, 3, 4]);
  calls[2].resolve();
  assert.equal(await queue.flush(1000), true);
  assert.deepEqual(queue.stats(), { enqueued: 4, written: 3, failedAttempts: 0, pending: false });
});

test('write-behind: flush waits for the pending write and is immediate when idle', async () => {
  const { calls, write } = controlledWriter();
  const queue = createWriteBehindQueue({ write, log: silentLog });
  assert.equal(await queue.flush(10), true);
  queue.enqueue('a');
  let flushed = null;
  const flushing = queue.flush(5000).then((value) => { flushed = value; });
  await tick();
  assert.equal(flushed, null);
  calls[0].resolve();
  await flushing;
  assert.equal(flushed, true);
  assert.equal(queue.isIdle(), true);
});

test('write-behind: flush waits only for snapshots enqueued before it, so steady traffic cannot hold it', async () => {
  const { calls, write } = controlledWriter();
  const queue = createWriteBehindQueue({ write, log: silentLog });
  assert.equal(queue.enqueue('a'), 1);
  let flushed = null;
  const flushing = queue.flush(5000).then((value) => { flushed = value; });
  await tick();
  assert.equal(queue.enqueue('b'), 2); // after the flush started
  calls[0].resolve(); // 'a' stored: the flush is done although 'b' is still pending
  await flushing;
  assert.equal(flushed, true);
  assert.equal(queue.isIdle(), false);
  await tick();
  calls[1].resolve();
  assert.equal(await queue.flush(1000), true);
});

test('write-behind: a durable save fails (false) while writes fail, and succeeds once a write goes through', async () => {
  let failing = true;
  const writes = [];
  const write = async (snapshot) => {
    if (failing) throw Object.assign(new Error('down'), { code: '57P01' });
    writes.push(snapshot);
  };
  const queue = createWriteBehindQueue({ write, retryWaitsMs: [5], log: silentLog });
  queue.enqueue('pending-deletion');
  assert.equal(await queue.flush(60), false, 'not stored in time: the caller answers 503 and rolls back');
  queue.enqueue('rolled-back'); // what server.js queues after its undo
  failing = false;
  assert.equal(await queue.flush(2000), true);
  assert.deepEqual(writes, ['rolled-back'], 'the newer (undone) state wins; the failing snapshot is never written after it');
});

test('write-behind: a failed write is retried with backoff; a newer snapshot supersedes it', async () => {
  const waits = [];
  let releaseSleep;
  const sleep = (ms) => {
    waits.push(ms);
    return new Promise((resolve) => { releaseSleep = resolve; });
  };
  const errors = [];
  const { calls, write } = controlledWriter();
  const queue = createWriteBehindQueue({ write, sleep, retryWaitsMs: [5, 10], log: { ...silentLog, error: (m) => errors.push(m) } });
  queue.enqueue('v1');
  await tick();
  calls[0].reject(Object.assign(new Error('secret host down'), { code: 'ECONNREFUSED' }));
  await tick();
  assert.deepEqual(waits, [5]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ECONNREFUSED/);
  assert.doesNotMatch(errors[0], /secret host/);
  releaseSleep();
  await tick();
  assert.equal(calls[1].snapshot, 'v1', 'retries the same snapshot');
  calls[1].reject(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
  await tick();
  queue.enqueue('v2'); // arrives during the retry wait
  releaseSleep();
  await tick();
  assert.equal(calls[2].snapshot, 'v2', 'the newer snapshot replaces the failing one');
  assert.deepEqual(waits, [5, 10]);
  calls[2].resolve();
  assert.equal(await queue.flush(1000), true);
  assert.deepEqual(calls.map((c) => c.snapshot), ['v1', 'v1', 'v2']);
  assert.equal(queue.stats().failedAttempts, 2);
});

test('write-behind: flush cuts a retry wait short and times out (false) while writes keep failing', async () => {
  let attempts = 0;
  const write = async () => {
    attempts += 1;
    throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
  };
  // A real wait far longer than the flush timeout: only the flush's wake-up makes the second attempt happen.
  const queue = createWriteBehindQueue({ write, retryWaitsMs: [60_000], log: silentLog });
  queue.enqueue('x');
  await tick();
  assert.equal(attempts, 1);
  assert.equal(await queue.flush(50), false);
  assert.ok(attempts >= 2, 'the flush retried at once');
  assert.equal(queue.isIdle(), false);
});

// A fake pg.Pool recording every statement.
const fakePool = ({ rows = [], failOn = null } = {}) => {
  const statements = [];
  const released = [];
  const run = async (sql, params) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    statements.push({ text, params });
    if (failOn && failOn.test(text)) throw Object.assign(new Error('boom at secret-host'), { code: '57P01' });
    if (/^SELECT data::text/.test(text)) return { rows, rowCount: rows.length };
    return { rows: [], rowCount: /^DELETE/.test(text) ? 2 : 1 };
  };
  const pool = {
    config: null,
    ended: false,
    query: run,
    on() {},
    async connect() { return { query: run, release: () => released.push(true) }; },
    async end() { pool.ended = true; },
  };
  return { pool, statements, released };
};

test('the store writes state, an hourly history snapshot and the prune in one transaction', async () => {
  const fake = fakePool();
  const store = await openPostgresStore({
    connectionString: 'postgres://u:p@h/db',
    ssl: 'disable',
    poolFactory: (config) => { fake.pool.config = config; return fake.pool; },
    log: silentLog,
  });
  assert.equal(fake.pool.config.ssl, false);
  await store.ensureSchema();
  assert.ok(fake.statements.some((s) => /CREATE TABLE IF NOT EXISTS drinkme_state \(/.test(s.text)));
  assert.ok(fake.statements.some((s) => /CREATE TABLE IF NOT EXISTS drinkme_state_history/.test(s.text)));
  fake.statements.length = 0;
  await store.write({ text: '{"users":[]}', schemaVersion: 2 });
  const kinds = fake.statements.map((s) => s.text.split(' ').slice(0, 2).join(' '));
  assert.deepEqual(kinds, ['BEGIN', 'INSERT INTO', 'INSERT INTO', 'DELETE FROM', 'COMMIT']);
  assert.deepEqual(fake.statements[1].params, ['{"users":[]}', 2]);
  assert.deepEqual(fake.statements[3].params.slice(1), [30, true]);
  fake.statements.length = 0;
  await store.write({ text: '{}', schemaVersion: 2, keepAllHistory: true });
  assert.equal(fake.statements[3].params[2], false, 'no row limit while a recovery hold may be on');
  assert.equal(await store.load(), null);
  await store.close();
  assert.equal(fake.pool.ended, true);
});

test('a failed write rolls back and releases the connection', async () => {
  const fake = fakePool({ failOn: /^INSERT INTO drinkme_state \(/ });
  const store = await openPostgresStore({ connectionString: 'postgres://h/db', poolFactory: () => fake.pool, log: silentLog });
  await assert.rejects(store.write({ text: '{}', schemaVersion: 2 }), { code: '57P01' });
  assert.deepEqual(fake.statements.map((s) => s.text.split(' ')[0]).slice(-1), ['ROLLBACK']);
  assert.equal(fake.released.length, 1);
});

test('the store returns the stored text', async () => {
  const fake = fakePool({ rows: [{ data: '{"users": []}', schema_version: 2, updated_at: new Date(0) }] });
  const store = await openPostgresStore({ connectionString: 'postgres://h/db', poolFactory: () => fake.pool, log: silentLog });
  assert.deepEqual(await store.load(), { text: '{"users": []}', schemaVersion: 2, updatedAt: new Date(0) });
});

// Synthetic production settings (as in production-guard.test.js), so the database check is the one that refuses.
const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const productionEnv = (overrides) => ({
  NODE_ENV: 'production',
  JWT_SECRET: 'abcdefghijklmnopqrstuvwxyz012345',
  FIREBASE_SERVICE_ACCOUNT_KEY: JSON.stringify({
    type: 'service_account',
    project_id: 'drinkme-pg-test',
    private_key: privateKey,
    client_email: 'pg-test@drinkme-pg-test.example.test',
  }),
  ALLOW_EMPTY_DB: 'true',
  ...overrides,
});
const fatalLine = (output) => output.split(/\r?\n/).find((line) => line.includes('FATAL')) ?? '';

// No Postgres needed: the settings are checked before any connection.
test('an invalid DB_DRIVER or a missing DATABASE_URL stops the server, naming settings only', { timeout: 120_000 }, async () => {
  for (const [env, pattern] of [
    [{ DB_DRIVER: 'mongo' }, /DB_DRIVER \(must be json or postgres\)/],
    [{ DB_DRIVER: 'postgres' }, /DATABASE_URL \(required when DB_DRIVER=postgres\)/],
    [{ DB_DRIVER: 'postgres', DATABASE_URL: 'mysql://user:hunter2@nowhere/db' }, /DATABASE_URL \(must start with postgres/],
  ]) {
    const dev = await assertRefusesToStart(env);
    assert.match(fatalLine(dev.output), /\[db\] FATAL: invalid database settings/);
    assert.match(fatalLine(dev.output), pattern);
    assert.doesNotMatch(dev.output, /hunter2/);
    const production = await assertRefusesToStart(productionEnv(env));
    assert.match(fatalLine(production.output), /\[startup\] FATAL: refusing to start in production/);
    assert.match(fatalLine(production.output), pattern);
    assert.doesNotMatch(production.output, /hunter2/);
  }
});

test('production refuses Postgres without verified TLS before connecting, naming settings only', { timeout: 60_000 }, async () => {
  const { output } = await assertRefusesToStart(productionEnv({ DB_DRIVER: 'postgres', DATABASE_URL: 'postgres://user:hunter2@127.0.0.1:1/drinkme?sslmode=prefer' }));
  assert.match(fatalLine(output), /DATABASE_SSL \(production needs require, or sslmode=verify-full in DATABASE_URL/);
  assert.doesNotMatch(output, /hunter2|ECONNREFUSED/);
});

test('Postgres that cannot be reached stops the server with an error code only', async () => {
  // Port 1 on localhost: nothing listens, so the connection is refused at once.
  const { output } = await assertRefusesToStart({ DB_DRIVER: 'postgres', DATABASE_URL: 'postgres://user:hunter2@127.0.0.1:1/drinkme_test' });
  assert.match(output, /\[db\] FATAL: could not open the Postgres database \(ECONNREFUSED\)/);
  assert.doesNotMatch(output, /hunter2/);
});
