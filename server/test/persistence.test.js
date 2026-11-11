import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { REAL_DB_FILE, assertRefusesToStart, startServer } from './helpers/harness.js';

const DB_NAME = 'db.json';
const FAULT_PRELOAD = new URL('./helpers/db-fault-preload.js', import.meta.url).href;
const FAULT_USER_ID = 'fault-injected-user'; // must match the preload
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Every key written by saveDb(), in synthetic data.
const FULL_DB = {
  drinks: [{ id: 7, userId: 'round-trip-1', name: 'Fixture Lemonade', isAlcoholic: false, tags: [], cheersCount: 1 }],
  nextDrinkId: 8,
  nextNotificationId: 4,
  nextCommentId: 3,
  nextReportId: 2,
  dbSchemaVersion: 2,
  users: [
    { id: 'round-trip-1', email: 'one@example.test', firstName: 'Round', lastName: 'One', city: 'Testville', bio: 'Synthetic', avatar: null, ageConfirmedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'round-trip-2', email: 'two@example.test', firstName: 'Round', lastName: 'Two', city: 'Testville', bio: 'Synthetic', avatar: null },
  ],
  cheersByUser: { 'round-trip-1': [7] },
  savedByUser: { 'round-trip-1': [7], 'round-trip-2': [] },
  smartBarByUser: { 'round-trip-1': [{ id: 1, name: 'Tonic', quantity: '1', unit: 'bottle' }] },
  partnersByUser: { 'round-trip-1': ['round-trip-2'], 'round-trip-2': ['round-trip-1'] },
  notificationsByUser: {
    'round-trip-1': [{ id: 3, type: 'partner', message: 'Synthetic', read: false, createdAt: '2026-01-01T00:00:00.000Z' }],
  },
  commentsByDrink: {
    7: [{ id: 2, drinkId: 7, userId: 'round-trip-2', content: 'Synthetic', createdAt: '2026-01-01T00:00:00.000Z' }],
  },
  // Recent, because an expired event is pruned at load.
  limitEventsByUser: {
    'round-trip-2': [{ kind: 'comment', at: new Date().toISOString() }],
  },
  reports: [
    { id: 1, reporterId: 'round-trip-1', targetType: 'drink', targetId: 7, reason: 'spam', details: null, status: 'open', createdAt: '2026-01-01T00:00:00.000Z' },
  ],
  blocksByUser: { 'round-trip-2': ['round-trip-3'] },
  // Recent, because an expired request is dropped at load.
  partnerRequestsByUser: { 'round-trip-2': [{ fromId: 'round-trip-1', createdAt: new Date().toISOString() }] },
  pendingAccountDeletions: [],
};

// Stat only: the real database must never be read.
// The dev backend must be idle during tests, or its own writes will fail this check.
const statRealDb = () => {
  const stats = fs.statSync(REAL_DB_FILE, { throwIfNoEntry: false });
  return stats ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
};

const postJson = async (url, body, token) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

// Every route but the first-run ones needs the 18+ confirmation. confirmAge: false saves nothing new.
const signIn = async (baseUrl, uid, { confirmAge = true } = {}) => {
  const { status, body } = await postJson(`${baseUrl}/api/auth/mobile`, {
    idToken: 'dev-fallback-token',
    uid,
    email: `${uid}@example.test`,
    displayName: 'Persistence Tester',
  });
  assert.equal(status, 200);
  if (confirmAge) {
    const age = await postJson(`${baseUrl}/api/users/${uid}/acknowledgements`, { type: 'age', confirmed: true }, body.token);
    assert.equal(age.status, 200);
  }
  return body.token;
};

// A confirmed user of FULL_DB. Signed here, so reading writes nothing.
const fullDbReader = () => jwt.sign({ uid: 'round-trip-1' }, 'test-only-jwt-secret', { algorithm: 'HS256', expiresIn: '1h' });

const createDrink = async (baseUrl, token, name) => {
  const created = await postJson(
    `${baseUrl}/api/drinks`,
    { name, description: 'Persistence test', rating: 4, isAlcoholic: false, imageData: TINY_PNG },
    token
  );
  assert.equal(created.status, 201);
  return created.body;
};

const getDrinks = async (baseUrl, token = fullDbReader()) => {
  const res = await fetch(`${baseUrl}/api/drinks`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  return (await res.json()).items;
};

const filesMatching = (dbFile, marker) =>
  fs.readdirSync(path.dirname(dbFile)).filter((name) => name.startsWith(`${DB_NAME}${marker}`));

/**
 * Prepares DB_FILE in a test-owned temp dir before the server starts, because
 * the harness only accepts fixtures it can serialize as JSON.
 */
const makeDbDir = (t, prepare) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drinkme-persistence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const dbFile = path.join(dir, DB_NAME);
  prepare?.(dbFile);
  return dbFile;
};

const startOn = async (t, dbFile) => {
  const server = await startServer({ DB_FILE: dbFile });
  t.after(() => server.stop());
  return server;
};

const readDb = (dbFile) => JSON.parse(fs.readFileSync(dbFile, 'utf8'));

const writeRaw = (content) => (file) => fs.writeFileSync(file, content);

const faultEnv = (dbFile, fault) => ({
  DB_FILE: dbFile,
  DB_FAULT: fault,
  NODE_OPTIONS: `--import=${FAULT_PRELOAD}`,
});

let realDbBefore;

before(() => {
  realDbBefore = statRealDb();
});

after(() => {
  assert.deepEqual(statRealDb(), realDbBefore, 'server/data/db.json must stay untouched');
});

test('mutations leave no temp file and the same JSON format', async (t) => {
  const dbFile = makeDbDir(t);
  const { baseUrl } = await startOn(t, dbFile);
  const token = await signIn(baseUrl, 'atomic-user');
  await createDrink(baseUrl, token, 'Atomic Tea');

  assert.deepEqual(filesMatching(dbFile, '.tmp-'), []);
  const raw = fs.readFileSync(dbFile, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.drinks[0].name, 'Atomic Tea');
  assert.equal(raw, JSON.stringify(parsed, null, 2));
});

test('a corrupt file is copied byte for byte and the server still starts', async (t) => {
  const corruptBytes = Buffer.from([0x7b, 0x22, 0x64, 0x72, 0xff, 0xfe, 0x00, 0x2c, 0x0a]); // not UTF-8 either
  const dbFile = makeDbDir(t, (file) => fs.writeFileSync(file, corruptBytes));
  const { baseUrl } = await startOn(t, dbFile);

  const backups = filesMatching(dbFile, '.corrupt-');
  assert.equal(backups.length, 1);
  const backupFile = path.join(path.dirname(dbFile), backups[0]);
  assert.deepEqual(fs.readFileSync(backupFile), corruptBytes);

  // The next mutation replaces the DB and must leave the backup alone.
  const token = await signIn(baseUrl, 'corrupt-user');
  assert.deepEqual(await getDrinks(baseUrl, token), []);
  await createDrink(baseUrl, token, 'After Corruption');
  assert.equal(JSON.parse(fs.readFileSync(dbFile, 'utf8')).drinks[0].name, 'After Corruption');
  assert.deepEqual(fs.readFileSync(backupFile), corruptBytes);
});

for (const [label, content] of [
  ['an array root', '[1, 2, 3]'],
  ['a null root', 'null'],
  ['a null list entry', JSON.stringify({
    nextDrinkId: 50,
    drinks: [{ id: 49, name: 'Half Loaded', userId: 'nobody' }],
    users: [null],
  })],
  ['drinks as an object', JSON.stringify({ drinks: {}, nextDrinkId: 50 })],
  ['a counter of the wrong type', JSON.stringify({ nextDrinkId: '50' })],
  ['a map of the wrong type', JSON.stringify({ partnersByUser: [] })],
  ['a non-array map entry', JSON.stringify({ nextDrinkId: 50, cheersByUser: { someone: 'not-an-array' } })],
]) {
  test(`valid JSON with ${label} is preserved and the server starts empty`, async (t) => {
    const dbFile = makeDbDir(t, (file) => fs.writeFileSync(file, content, 'utf8'));
    const { baseUrl } = await startOn(t, dbFile);

    const backups = filesMatching(dbFile, '.corrupt-');
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(dbFile), backups[0]), 'utf8'), content);

    const token = await signIn(baseUrl, 'shape-user');
    assert.deepEqual(await getDrinks(baseUrl, token), []);
    assert.equal((await createDrink(baseUrl, token, 'Fresh Start')).id, 1);
  });
}

test('20 sequential mutations leave a parseable DB with the last write', async (t) => {
  const dbFile = makeDbDir(t);
  const server = await startOn(t, dbFile);
  const token = await signIn(server.baseUrl, 'sequence-user');

  const MUTATIONS = 20; // under the limit of 30 per minute per user
  for (let i = 1; i <= MUTATIONS; i++) {
    await createDrink(server.baseUrl, token, `Sequence ${i}`);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(dbFile, 'utf8')));
  }

  const parsed = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  assert.equal(parsed.drinks.length, MUTATIONS);
  assert.ok(parsed.drinks.some((drink) => drink.name === `Sequence ${MUTATIONS}`));
  assert.deepEqual(filesMatching(dbFile, '.tmp-'), []);

  await server.restart();
  const names = (await getDrinks(server.baseUrl, token)).map((drink) => drink.name);
  assert.ok(names.includes(`Sequence ${MUTATIONS}`));
});

test('a failed rename returns 503, removes the temp file and keeps the target', async (t) => {
  const dbFile = makeDbDir(t);
  const { baseUrl } = await startOn(t, dbFile);
  const token = await signIn(baseUrl, 'rename-user');

  // A directory at the target path makes every rename fail, on Windows with a retryable EPERM.
  fs.rmSync(dbFile);
  fs.mkdirSync(dbFile);
  const sentinel = path.join(dbFile, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'keep me', 'utf8');

  const failed = await postJson(
    `${baseUrl}/api/drinks`,
    { name: 'Unsaved Drink', description: 'Persistence test', rating: 4, isAlcoholic: false, imageData: TINY_PNG },
    token
  );
  assert.equal(failed.status, 503);
  assert.equal(typeof failed.body.error, 'string');

  assert.deepEqual(filesMatching(dbFile, '.tmp-'), []);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep me');
});

test('a DB path that cannot be read stops the server and is left alone', async (t) => {
  // A directory at DB_FILE fails the read with a non-retryable EISDIR.
  let sentinel;
  const dbFile = makeDbDir(t, (file) => {
    fs.mkdirSync(file);
    sentinel = path.join(file, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'keep me', 'utf8');
  });

  await assertRefusesToStart({ DB_FILE: dbFile });

  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep me');
  assert.deepEqual(filesMatching(dbFile, '.corrupt-'), []);
  assert.deepEqual(filesMatching(dbFile, '.tmp-'), []);
});

for (const fault of ['stat', 'read']) {
  test(`a persistent ${fault} failure exits with no backup and no empty start`, async (t) => {
    const content = JSON.stringify(FULL_DB);
    const dbFile = makeDbDir(t, writeRaw(content));

    await assertRefusesToStart(faultEnv(dbFile, fault));

    assert.equal(fs.readFileSync(dbFile, 'utf8'), content);
    assert.deepEqual(filesMatching(dbFile, '.corrupt-'), []);
  });
}

test('a transient read failure is retried and the data loads', async (t) => {
  const dbFile = makeDbDir(t, writeRaw(JSON.stringify(FULL_DB)));
  const server = await startServer(faultEnv(dbFile, 'read-transient'));
  t.after(() => server.stop());

  assert.equal((await getDrinks(server.baseUrl)).length, FULL_DB.drinks.length);
  assert.deepEqual(filesMatching(dbFile, '.corrupt-'), []);
});

for (const [fault, description] of [
  ['backup-open', 'cannot be created'],
  ['backup-fsync', 'cannot be flushed to disk'],
  ['backup-mismatch', 'does not read back the same'],
]) {
  test(`a corrupt file whose backup ${description} stops the server and is left alone`, async (t) => {
    const dbFile = makeDbDir(t, writeRaw('{ not json'));

    await assertRefusesToStart(faultEnv(dbFile, fault));

    assert.equal(fs.readFileSync(dbFile, 'utf8'), '{ not json');
    assert.deepEqual(filesMatching(dbFile, '.corrupt-'), []);
  });
}

test('an existing backup at the same path is neither overwritten nor removed', async (t) => {
  const dbFile = makeDbDir(t, writeRaw('{ not json'));

  await assertRefusesToStart(faultEnv(dbFile, 'backup-exists'));

  assert.equal(fs.readFileSync(dbFile, 'utf8'), '{ not json');
  const backups = filesMatching(dbFile, '.corrupt-');
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(dbFile), backups[0]), 'utf8'), 'existing backup');
});

test('an exception during restore is fatal, with no backup and no empty start', async (t) => {
  const content = JSON.stringify({ users: [{ id: FAULT_USER_ID }] });
  const dbFile = makeDbDir(t, writeRaw(content));

  await assertRefusesToStart(faultEnv(dbFile, 'restore'));

  assert.equal(fs.readFileSync(dbFile, 'utf8'), content);
  assert.deepEqual(filesMatching(dbFile, '.corrupt-'), []);
});

test('restarting on the same corrupt file creates no second backup', async (t) => {
  const dbFile = makeDbDir(t, writeRaw('{ not json'));
  const server = await startOn(t, dbFile);
  assert.equal(filesMatching(dbFile, '.corrupt-').length, 1);

  await server.restart();
  assert.equal(filesMatching(dbFile, '.corrupt-').length, 1);

  // Different corrupt bytes do get their own backup.
  await server.restart({ dbFixture: [] });
  assert.equal(filesMatching(dbFile, '.corrupt-').length, 2);
});

test('stale temp files are removed after a good load, and the DB is not', async (t) => {
  const staleName = `${DB_NAME}.tmp-999-0123456789abcdef`;
  const backupBytes = Buffer.from([0x7b, 0xff, 0x00, 0x0a]);
  const backupFile = (dbPath) => path.join(path.dirname(dbPath), `${DB_NAME}.corrupt-1`);
  const dbFile = makeDbDir(t, (file) => {
    fs.writeFileSync(file, JSON.stringify(FULL_DB), 'utf8');
    fs.writeFileSync(path.join(path.dirname(file), staleName), 'partial write', 'utf8');
    fs.writeFileSync(backupFile(file), backupBytes);
  });
  await startOn(t, dbFile);

  assert.deepEqual(filesMatching(dbFile, '.tmp-'), []);
  assert.deepEqual(readDb(dbFile), FULL_DB);
  assert.deepEqual(fs.readFileSync(backupFile(dbFile)), backupBytes);
});

test('every saveDb key round-trips through load and save, across a restart', async (t) => {
  const dbFile = makeDbDir(t, writeRaw(JSON.stringify(FULL_DB)));
  const server = await startOn(t, dbFile);
  assert.deepEqual(filesMatching(dbFile, '.corrupt-'), []);

  // Signing in as an existing user saves without changing any data.
  await signIn(server.baseUrl, FULL_DB.users[0].id, { confirmAge: false });
  assert.deepEqual(readDb(dbFile), FULL_DB);

  await server.restart();
  await signIn(server.baseUrl, FULL_DB.users[0].id, { confirmAge: false });
  assert.deepEqual(readDb(dbFile), FULL_DB);
  assert.deepEqual(filesMatching(dbFile, '.corrupt-'), []);
});

test('a drinks array too large to spread loads and saves', async (t) => {
  const DRINK_COUNT = 200_000;
  const largeDb = {
    drinks: Array.from({ length: DRINK_COUNT }, (_, i) => ({ id: i + 1 })),
    nextDrinkId: DRINK_COUNT + 1,
  };
  const dbFile = makeDbDir(t, writeRaw(JSON.stringify(largeDb)));
  const { baseUrl } = await startOn(t, dbFile);
  assert.deepEqual(filesMatching(dbFile, '.corrupt-'), []);

  const token = await signIn(baseUrl, 'large-user');
  assert.equal((await createDrink(baseUrl, token, 'One More')).id, DRINK_COUNT + 1);
  assert.equal(readDb(dbFile).drinks.length, DRINK_COUNT + 1);
});
