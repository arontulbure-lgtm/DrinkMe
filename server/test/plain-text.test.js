import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { REAL_DB_FILE, assertRefusesToStart, startServer } from './helpers/harness.js';

const REQUEST_TIMEOUT_MS = 20_000;
const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const DB_NAME = 'db.json';
const FAULT_PRELOAD = new URL('./helpers/db-fault-preload.js', import.meta.url).href;
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const TEXT = "O'Brien <b>";
const USER_MARKER = 'usermarker';
const MIGRATION_LOG = /^\[db\] Migrated to schema version 2 \(plain text\)\. Previous file saved to \S*db\.json\.pre-migration-\d+\r?$/m;

const tokenFor = (uid) => jwt.sign({ uid }, HARNESS_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

const call = async (server, method, route, token, body) => {
  const res = await fetch(`${server.baseUrl}${route}`, {
    method,
    headers: {
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : undefined };
};

const makeDbDir = (t, content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drinkme-plain-text-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const dbFile = path.join(dir, DB_NAME);
  if (content !== undefined) fs.writeFileSync(dbFile, content);
  return dbFile;
};

const backupsOf = (dbFile, marker = '.pre-migration-') => (
  fs.readdirSync(path.dirname(dbFile))
    .filter((name) => name.startsWith(`${DB_NAME}${marker}`))
    .map((name) => path.join(path.dirname(dbFile), name))
);
const readDb = (dbFile) => JSON.parse(fs.readFileSync(dbFile, 'utf8'));
const storedUser = (dbFile, id) => readDb(dbFile).users.find((user) => user.id === id);

const startOn = async (t, dbFile, env = {}) => {
  const server = await startServer({ DB_FILE: dbFile, ...env });
  t.after(() => server.stop());
  return server;
};

const faultEnv = (dbFile, fault) => ({
  DB_FILE: dbFile,
  DB_FAULT: fault,
  NODE_OPTIONS: `--import=${FAULT_PRELOAD}`,
});

// Every migrated field, in the three spec forms, plus text that must not change.
const legacyDb = () => ({
  nextDrinkId: 2,
  nextNotificationId: 2,
  nextCommentId: 2,
  users: [
    {
      id: 'author', email: 'author@example.test', firstName: 'o&#x27;brien', lastName: 'a&amp;b',
      city: 'abc&#x2', bio: '&lt;b&gt; &quot;x&quot; &#x2F; &#x5C; &#96;', avatar: 'https://lh3.googleusercontent.com/a&amp;b',
      nameSetByUser: true,
    },
  ],
  drinks: [{
    id: 1, userId: 'author', name: 'o&#x27;brien', description: 'a&amp;b', location: 'abc&#x2',
    tags: ['a&amp;b'], imageUrl: IMAGE, rating: 4, isAlcoholic: false, cheersCount: 0, createdAt: '2026-01-01T00:00:00.000Z',
  }],
  commentsByDrink: { 1: [{ id: 1, drinkId: 1, userId: 'author', content: 'a&amp;lt;b', createdAt: '2026-01-01T00:00:00.000Z' }] },
  // The unit is exactly the old cap of 60, the only length at which Smart Bar text was cut.
  smartBarByUser: { author: [{ id: 1, name: 'o&#x27;brien', quantity: 'a&amp;b', unit: `${'u'.repeat(56)}&#x2` }] },
  // A fresh date: older notifications are dropped when read.
  notificationsByUser: {
    author: [{ id: 1, type: 'cheer', message: 'o&#x27;brien cheered a&amp;b.', read: false, createdAt: new Date().toISOString() }],
  },
});

let realDbBefore;
const statRealDb = () => {
  const stats = fs.statSync(REAL_DB_FILE, { throwIfNoEntry: false });
  return stats ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
};

before(() => {
  realDbBefore = statRealDb();
});

after(() => {
  assert.deepEqual(statRealDb(), realDbBefore, 'server/data/db.json must stay untouched');
});

describe('new text is stored plain', () => {
  let server;
  const token = tokenFor('writer');

  before(async () => {
    server = await startServer({}, { dbFixture: null });
    assert.equal((await call(server, 'POST', '/api/auth/mobile', undefined, {
      idToken: 'dev-fallback-token', uid: 'writer', displayName: TEXT,
    })).status, 200);
  });

  after(() => server?.stop());

  test('sign-in, profile, post, comment and smart bar round-trip unchanged', async () => {
    const signedIn = (await call(server, 'GET', '/api/users/writer', token)).body;
    assert.equal(`${signedIn.firstName} ${signedIn.lastName}`, TEXT);

    const profile = await call(server, 'PUT', '/api/users/writer', token, { firstName: TEXT, lastName: TEXT, city: TEXT, bio: TEXT });
    assert.equal(profile.status, 200);
    for (const field of ['firstName', 'lastName', 'city', 'bio']) assert.equal(profile.body[field], TEXT, field);

    const drink = await call(server, 'POST', '/api/drinks', token, { name: TEXT, description: TEXT, location: TEXT, rating: 4, isAlcoholic: false, imageData: IMAGE });
    assert.equal(drink.status, 201);
    for (const field of ['name', 'description', 'location']) assert.equal(drink.body[field], TEXT, field);
    const comment = await call(server, 'POST', `/api/drinks/${drink.body.id}/comments`, token, { content: TEXT });
    assert.equal(comment.body.content, TEXT);
    const item = await call(server, 'POST', '/api/smart-bar', token, { name: TEXT, quantity: TEXT, unit: TEXT });
    assert.deepEqual(item.body, { id: 1, name: TEXT, quantity: TEXT, unit: TEXT });
  });

  test('a 120-character name of apostrophes is not shortened', async () => {
    const name = "'".repeat(120);
    assert.equal((await call(server, 'PUT', '/api/users/writer', token, { firstName: name })).body.firstName, name);
  });

  test('sanitizing still rejects non-strings and strips control characters', async () => {
    const { body } = await call(server, 'PUT', '/api/users/writer', token, { bio: 'a\x01b\x7F\tc', city: 12, lastName: {} });
    assert.equal(body.bio, 'ab c');
    assert.equal(body.city, TEXT);
    assert.equal(body.lastName, TEXT);
    assert.equal((await call(server, 'POST', '/api/smart-bar', token, { name: 5, quantity: '1' })).status, 400);
  });

  test('bidi overrides and C1 controls are removed; ZWJ emoji and Romanian letters are kept', async () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    const { body } = await call(server, 'PUT', '/api/users/writer', token, {
      bio: 'a‮b⁦c⁩d\u0085e\u009Ff',
      city: `${family} șț`,
    });
    assert.equal(body.bio, 'abcdef');
    assert.equal(body.city, `${family} șț`);
  });

  for (const [label, location, expected] of [
    ['an object', { a: 1 }, null],
    ['an object with a bad toString', { toString: 1 }, null],
    ['a number', 5, null],
    ['a string', ' Cluj ', 'Cluj'],
  ]) {
    test(`a post location that is ${label} is stored as ${expected}`, async () => {
      const { status, body } = await call(server, 'POST', '/api/drinks', token, { name: 'Loc', description: 'Loc', rating: 4, isAlcoholic: false, imageData: IMAGE, location });
      assert.equal(status, 201);
      assert.equal(body.location, expected);
    });
  }
});

describe('migrating a legacy file', () => {
  test('backs up first, decodes every field, and leaves other fields alone', async (t) => {
    const content = JSON.stringify(legacyDb());
    const dbFile = makeDbDir(t, content);
    const server = await startOn(t, dbFile);

    const backups = backupsOf(dbFile);
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(backups[0], 'utf8'), content);

    const db = readDb(dbFile);
    assert.equal(db.dbSchemaVersion, 2);
    const [user] = db.users;
    assert.deepEqual(
      [user.firstName, user.lastName, user.city, user.bio],
      ["o'brien", 'a&b', 'abc', '<b> "x" / \\ `'],
    );
    assert.equal(user.avatar, 'https://lh3.googleusercontent.com/a&amp;b');
    const [drink] = db.drinks;
    assert.deepEqual([drink.name, drink.description, drink.location], ["o'brien", 'a&b', 'abc']);
    assert.deepEqual(drink.tags, ['a&amp;b']);
    assert.equal(db.commentsByDrink[1][0].content, 'a&lt;b'); // one level only
    assert.deepEqual(db.smartBarByUser.author[0], { id: 1, name: "o'brien", quantity: 'a&b', unit: 'u'.repeat(56) });
    assert.equal(db.notificationsByUser.author[0].message, "o'brien cheered a&b.");
    assert.equal((await call(server, 'GET', '/api/drinks/1')).status, 200);
  });

  test('no route returns an entity afterwards', async (t) => {
    const fixture = legacyDb();
    // Only migrated fields hold entities here, and each decodes to plain text.
    fixture.users[0].avatar = null;
    fixture.drinks[0].tags = [];
    fixture.commentsByDrink[1][0].content = 'o&#x27;brien &amp; &lt;b&gt; abc&#x2';
    const dbFile = makeDbDir(t, JSON.stringify(fixture));
    const server = await startOn(t, dbFile);

    const token = tokenFor('author');
    for (const route of ['/api/drinks', '/api/drinks/1', '/api/drinks/1/comments', '/api/users/author', '/api/smart-bar', '/api/notifications']) {
      const { status, text } = await call(server, 'GET', route, token);
      assert.equal(status, 200, route);
      assert.ok(!/&(amp|#x27|#x2F|#x5C|#96|quot|lt|gt);|&#x2\b/.test(text), `${route} holds an entity`);
    }
    const [comment] = (await call(server, 'GET', '/api/drinks/1/comments')).body.items;
    assert.equal(comment.content, "o'brien & <b> abc");
  });

  test('only a real cut is stripped: raw text survives', async (t) => {
    const fixture = legacyDb();
    Object.assign(fixture.users[0], { lastName: 'R&D', city: 'abc&#x2', bio: 'x&#x2F' });
    Object.assign(fixture.drinks[0], { name: 'R&D', description: 'Gin &', location: 'y&quo' });
    fixture.commentsByDrink[1][0].content = 'R&D';
    fixture.smartBarByUser.author = [
      { id: 1, name: 'Rum &', quantity: 'Gin &a', unit: 'R&D' },
      { id: 2, name: `${'n'.repeat(116)}&#x2`, quantity: `${'q'.repeat(58)}&a`, unit: `${'u'.repeat(59)}&` },
      { id: 3, name: `${'n'.repeat(115)}&amp;`, quantity: `${'q'.repeat(54)}&quot;`, unit: 'abc&#x2' },
    ];
    const dbFile = makeDbDir(t, JSON.stringify(fixture));
    await startOn(t, dbFile);

    const db = readDb(dbFile);
    const [user] = db.users;
    assert.deepEqual([user.lastName, user.city, user.bio], ['R&D', 'abc', 'x']);
    const [drink] = db.drinks;
    assert.deepEqual([drink.name, drink.description, drink.location], ['R&D', 'Gin ', 'y']);
    assert.equal(db.commentsByDrink[1][0].content, 'R&D');
    assert.deepEqual(db.smartBarByUser.author, [
      { id: 1, name: 'Rum &', quantity: 'Gin &a', unit: 'R&D' },
      { id: 2, name: 'n'.repeat(116), quantity: 'q'.repeat(58), unit: 'u'.repeat(59) },
      { id: 3, name: `${'n'.repeat(115)}&`, quantity: `${'q'.repeat(54)}"`, unit: 'abc&#x2' },
    ]);
  });

  test('schema version values', async (t) => {
    const body = (version) => `{"dbSchemaVersion":${version},"users":[{"id":"v","firstName":"a&amp;b"}]}`;
    for (const [version, outcome, name] of [
      ['-1', 'migrates', 'a&b'],
      ['0', 'migrates', 'a&b'],
      ['1', 'migrates', 'a&b'],
      ['1.5', 'corrupt'],
      ['2', 'unchanged', 'a&amp;b'],
      ['3', 'unchanged', 'a&amp;b'],
      ['9007199254740992', 'corrupt'],
      ['1e999', 'corrupt'],
      ['null', 'corrupt'],
      ['"2"', 'corrupt'],
      ['true', 'corrupt'],
    ]) {
      const content = body(version);
      const dbFile = makeDbDir(t, content);
      const server = await startServer({ DB_FILE: dbFile });
      try {
        assert.equal(backupsOf(dbFile).length, outcome === 'migrates' ? 1 : 0, `${version}: migration backups`);
        assert.equal(backupsOf(dbFile, '.corrupt-').length, outcome === 'corrupt' ? 1 : 0, `${version}: corrupt backups`);
        const { status, body: user } = await call(server, 'GET', '/api/users/v');
        if (outcome === 'corrupt') {
          assert.equal(status, 404, version);
        } else {
          assert.equal(user.firstName, name, version);
        }
        if (outcome === 'unchanged') assert.equal(fs.readFileSync(dbFile, 'utf8'), content, version);
        if (outcome === 'migrates') {
          assert.equal(fs.readFileSync(backupsOf(dbFile)[0], 'utf8'), content, version);
          assert.equal(readDb(dbFile).dbSchemaVersion, 2, version);
        }
      } finally {
        await server.stop();
      }
    }
  });

  test('logs the backup path and no user data', async (t) => {
    const fixture = legacyDb();
    fixture.users[0].bio = USER_MARKER;
    fixture.users[0].email = `${USER_MARKER}@example.test`;
    const dbFile = makeDbDir(t, JSON.stringify(fixture));
    const server = await startOn(t, dbFile);

    assert.match(server.getOutput(), MIGRATION_LOG);
    assert.ok(server.getOutput().includes(path.basename(backupsOf(dbFile)[0])));
    assert.ok(!server.getOutput().includes(USER_MARKER));
  });

  test('runs once: text typed after it, and decoded text, are never decoded again', async (t) => {
    const fixture = legacyDb();
    fixture.users[0].bio = 'a&amp;amp;b'; // a user had typed the literal text a&amp;b
    const dbFile = makeDbDir(t, JSON.stringify(fixture));
    const server = await startOn(t, dbFile);
    const token = tokenFor('author');
    const typed = 'a&amp;b &#x27; &#x2';

    assert.equal((await call(server, 'POST', '/api/drinks/1/comments', token, { content: typed })).status, 201);
    assert.equal((await call(server, 'PUT', '/api/users/author', token, { city: typed })).status, 200);

    for (let restart = 0; restart < 2; restart++) {
      await server.restart();
      assert.doesNotMatch(server.getOutput(), /Migrated/);
      assert.equal(backupsOf(dbFile).length, 1);
      const { body } = await call(server, 'GET', '/api/users/author', token);
      assert.equal(body.bio, 'a&amp;b');
      assert.equal(body.city, typed);
      const comments = (await call(server, 'GET', '/api/drinks/1/comments')).body.items;
      assert.equal(comments[0].content, typed);
      assert.equal(comments.at(-1).content, 'a&lt;b');
    }
  });

  test('a file already at version 2 is not touched at load', async (t) => {
    const content = JSON.stringify({ ...legacyDb(), dbSchemaVersion: 2 });
    const dbFile = makeDbDir(t, content);
    await startOn(t, dbFile);

    assert.equal(fs.readFileSync(dbFile, 'utf8'), content);
    assert.deepEqual(backupsOf(dbFile), []);
  });

  test('a lower version is legacy, and a newer one is kept as found', async (t) => {
    const lowerFile = makeDbDir(t, JSON.stringify({ ...legacyDb(), dbSchemaVersion: 1 }));
    const lower = await startOn(t, lowerFile);
    assert.equal(readDb(lowerFile).users[0].firstName, "o'brien");
    await lower.stop();

    const newerFile = makeDbDir(t, JSON.stringify({ ...legacyDb(), dbSchemaVersion: 3 }));
    const newer = await startOn(t, newerFile);
    assert.deepEqual(backupsOf(newerFile), []);
    await call(newer, 'PUT', '/api/users/author', tokenFor('author'), { bio: 'Saved' });
    assert.equal(readDb(newerFile).dbSchemaVersion, 3);
    assert.equal(readDb(newerFile).users[0].firstName, 'o&#x27;brien');
  });

  test('odd records and non-string fields are skipped and kept', async (t) => {
    const fixture = legacyDb();
    fixture.users.push(
      { id: 'odd-one', firstName: 5, bio: null, city: ['a&amp;b'], lastName: 'a&amp;b' },
      { id: 'odd-two', email: 'odd@example.test', firstName: 5 },
      { id: 'odd-three', email: 7, firstName: 'a&amp;b' },
    );
    fixture.drinks[0].description = 12;
    fixture.commentsByDrink[1].push(null, 'a&amp;b', 7);
    fixture.smartBarByUser.author.push(null, 'a&amp;b');
    fixture.notificationsByUser.author.push(3);
    const dbFile = makeDbDir(t, JSON.stringify(fixture));
    await startOn(t, dbFile);

    assert.equal(backupsOf(dbFile).length, 1);
    const db = readDb(dbFile);
    assert.equal(db.dbSchemaVersion, 2);
    assert.deepEqual(db.users[1], { id: 'odd-one', firstName: 5, bio: null, city: ['a&amp;b'], lastName: 'a&b' });
    assert.deepEqual(db.users[2], { id: 'odd-two', email: 'odd@example.test', firstName: 5 });
    assert.equal(db.users[3].firstName, 'a&b');
    assert.equal(db.drinks[0].description, 12);
    assert.deepEqual(db.commentsByDrink[1].slice(1), [null, 'a&amp;b', 7]);
    assert.deepEqual(db.smartBarByUser.author.slice(1), [null, 'a&amp;b']);
    assert.equal(db.notificationsByUser.author[1], 3);
  });

  for (const [fault, description] of [
    ['backup-open', 'cannot be created'],
    ['backup-fsync', 'cannot be flushed to disk'],
    ['backup-mismatch', 'does not read back the same'],
    ['backup-exists', 'already exists'],
  ]) {
    test(`a backup that ${description} stops startup with no write`, async (t) => {
      const content = JSON.stringify(legacyDb());
      const dbFile = makeDbDir(t, content);

      const { stderr } = await assertRefusesToStart(faultEnv(dbFile, fault));

      assert.match(stderr, /\[db\] FATAL: could not back up \(schema migration\)/);
      assert.equal(fs.readFileSync(dbFile, 'utf8'), content);
      assert.deepEqual(backupsOf(dbFile, '.tmp-'), []);
      assert.equal(backupsOf(dbFile).length, fault === 'backup-exists' ? 1 : 0);
    });
  }

  test('an error while decoding stops startup with the file unchanged', async (t) => {
    const fixture = legacyDb();
    fixture.users[0].bio = USER_MARKER;
    const content = JSON.stringify(fixture);
    const dbFile = makeDbDir(t, content);

    const { stderr } = await assertRefusesToStart(faultEnv(dbFile, 'migrate'));

    assert.match(stderr, /\[db\] FATAL: could not migrate .*\(TypeError\)/);
    assert.ok(!stderr.includes(USER_MARKER));
    assert.equal(fs.readFileSync(dbFile, 'utf8'), content);
    assert.deepEqual(backupsOf(dbFile, '.tmp-'), []);
    assert.equal(fs.readFileSync(backupsOf(dbFile)[0], 'utf8'), content);
  });

  test('a failed save keeps the old file, and the next start migrates it once', async (t) => {
    const content = JSON.stringify(legacyDb());
    const dbFile = makeDbDir(t, content);
    const failMarker = `${dbFile}.fail-saves`;
    fs.writeFileSync(failMarker, '');
    const server = await startServer(faultEnv(dbFile, 'save'));
    t.after(() => server.stop());

    assert.match(server.getOutput(), /Could not save the schema migration/);
    assert.doesNotMatch(server.getOutput(), /Migrated/);
    assert.equal(fs.readFileSync(dbFile, 'utf8'), content);
    assert.equal((await call(server, 'GET', '/api/users/author')).body.firstName, "o'brien");

    await server.restart();
    assert.equal(fs.readFileSync(dbFile, 'utf8'), content);

    fs.rmSync(failMarker);
    await server.restart();
    assert.match(server.getOutput(), MIGRATION_LOG);
    assert.equal(readDb(dbFile).users[0].firstName, "o'brien");
    assert.equal(readDb(dbFile).users[0].lastName, 'a&b');
    // Three starts on the same bytes share one backup, and the log names it.
    const backups = backupsOf(dbFile);
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(backups[0], 'utf8'), content);
    assert.ok(server.getOutput().includes(path.basename(backups[0])));
  });

  test('different content gets its own backup', async (t) => {
    const dbFile = makeDbDir(t, JSON.stringify(legacyDb()));
    fs.writeFileSync(`${dbFile}.fail-saves`, '');
    const server = await startServer(faultEnv(dbFile, 'save'));
    t.after(() => server.stop());
    assert.equal(backupsOf(dbFile).length, 1);

    const changed = { ...legacyDb(), nextDrinkId: 99 };
    await server.restart({ dbFixture: changed });

    const contents = backupsOf(dbFile).map((file) => fs.readFileSync(file, 'utf8'));
    assert.equal(contents.length, 2);
    assert.ok(contents.includes(JSON.stringify(changed, null, 2)));
  });

  test('a failed check of existing backups makes a new backup', async (t) => {
    const content = JSON.stringify(legacyDb());
    const dbFile = makeDbDir(t, content);
    // A directory with a backup's name cannot be read as one.
    const unreadable = `${dbFile}.pre-migration-${Date.now() + 3_600_000}`;
    fs.mkdirSync(unreadable);
    const server = await startOn(t, dbFile);

    assert.match(server.getOutput(), /Could not check existing backups/);
    const files = backupsOf(dbFile).filter((file) => file !== unreadable);
    assert.equal(files.length, 1);
    assert.equal(fs.readFileSync(files[0], 'utf8'), content);
  });

  test('a mutation after a failed migration save stores text and marker together', async (t) => {
    const fixture = legacyDb();
    fixture.users[0].lastName = 'a&amp;amp;b';
    const dbFile = makeDbDir(t, JSON.stringify(fixture));
    const failMarker = `${dbFile}.fail-saves`;
    fs.writeFileSync(failMarker, '');
    const server = await startServer(faultEnv(dbFile, 'save'));
    t.after(() => server.stop());

    fs.rmSync(failMarker);
    assert.equal((await call(server, 'PUT', '/api/users/author', tokenFor('author'), { bio: 'Saved' })).status, 200);
    const backupCount = backupsOf(dbFile).length;
    assert.equal(readDb(dbFile).dbSchemaVersion, 2);

    await server.restart();
    assert.equal(backupsOf(dbFile).length, backupCount);
    assert.equal(storedUser(dbFile, 'author').lastName, 'a&amp;b');
  });
});

describe('which files count as legacy', () => {
  test('no file starts at version 2 with no backup, and is never decoded', async (t) => {
    const dbFile = makeDbDir(t);
    const server = await startOn(t, dbFile);
    assert.equal(readDb(dbFile).dbSchemaVersion, 2);
    assert.deepEqual(backupsOf(dbFile), []);

    const token = tokenFor('fresh');
    assert.equal((await call(server, 'POST', '/api/auth/mobile', undefined, { idToken: 'dev-fallback-token', uid: 'fresh', displayName: 'a&amp;b' })).status, 200);
    await server.restart();
    assert.equal((await call(server, 'GET', '/api/users/fresh', token)).body.firstName, 'a&amp;b');
    assert.deepEqual(backupsOf(dbFile), []);
  });

  for (const [label, content] of [
    ['corrupt JSON', '{ not json'],
    ['an invalid shape, even with entities', JSON.stringify({ drinks: {}, users: [{ id: 'x', firstName: 'a&amp;b' }] })],
    ['a schema version of the wrong type', JSON.stringify({ dbSchemaVersion: '2', users: [] })],
  ]) {
    test(`${label} takes the corrupt path, then saves at version 2 and is not decoded`, async (t) => {
      const dbFile = makeDbDir(t, content);
      const server = await startOn(t, dbFile);

      assert.equal(backupsOf(dbFile, '.corrupt-').length, 1);
      assert.deepEqual(backupsOf(dbFile), []);
      assert.equal(fs.readFileSync(backupsOf(dbFile, '.corrupt-')[0], 'utf8'), content);

      const token = tokenFor('after-corrupt');
      assert.equal((await call(server, 'POST', '/api/auth/mobile', undefined, { idToken: 'dev-fallback-token', uid: 'after-corrupt', displayName: 'a&amp;b' })).status, 200);
      assert.equal(readDb(dbFile).dbSchemaVersion, 2);

      await server.restart();
      assert.deepEqual(backupsOf(dbFile), []);
      assert.equal((await call(server, 'GET', '/api/users/after-corrupt', token)).body.firstName, 'a&amp;b');
    });
  }
});

describe('email-derived names after the migration', () => {
  const VIEWER = { id: 'viewer', email: 'viewer@example.test', firstName: 'Vera', lastName: '', nameSetByUser: true };
  // firstName is the old escape, then the old 120-character cut.
  const LONG_PREFIX = `a${"'".repeat(25)}`;
  const CUT_NAME = `a${'&#x27;'.repeat(19)}&#x27`;
  const users = [
    { id: 'escaped', email: "o'brien@example.test", firstName: 'o&#x27;brien', lastName: '' },
    { id: 'cut', email: `${LONG_PREFIX}@example.test`, firstName: CUT_NAME, lastName: '' },
    { id: 'raw-amp', email: 'a&@example.test', firstName: 'a&', lastName: '' },
    { id: 'raw-rd', email: 'r&d@example.test', firstName: 'r&d', lastName: '' },
    { id: 'chosen', email: "o'neil@example.test", firstName: 'o&#x27;neil', lastName: '', nameSetByUser: true },
    VIEWER,
  ];

  test('stay masked, also after a restart, and a resent name does not unmask them', async (t) => {
    const dbFile = makeDbDir(t, JSON.stringify({ users, drinks: [{ id: 1, userId: 'viewer', name: 'Vera drink', isAlcoholic: false, cheersCount: 0 }], nextDrinkId: 2 }));
    const server = await startOn(t, dbFile);

    const assertMasked = async () => {
      for (const id of ['escaped', 'cut', 'raw-amp', 'raw-rd']) {
        const { body } = await call(server, 'GET', `/api/users/${id}`);
        assert.equal('firstName' in body, false, id);
      }
    };
    await assertMasked();
    assert.equal((await call(server, 'GET', '/api/users/chosen')).body.firstName, "o'neil");
    assert.deepEqual((await call(server, 'GET', '/api/users/search?q=brien', tokenFor('viewer'))).body, []);

    // The owner still has a readable name, with no entity left.
    const own = await call(server, 'GET', '/api/users/cut', tokenFor('cut'));
    assert.equal(own.body.firstName, LONG_PREFIX);

    for (const id of ['escaped', 'cut', 'raw-amp']) {
      const { firstName } = (await call(server, 'GET', `/api/users/${id}`, tokenFor(id))).body;
      assert.equal((await call(server, 'PUT', `/api/users/${id}`, tokenFor(id), { firstName, bio: 'Saved' })).status, 200);
      assert.equal(storedUser(dbFile, id).nameSetByUser, undefined, id);
    }
    await assertMasked();

    // Forms opened before the migration resend the old escaped text, cut at 120 for this user.
    for (const [id, firstName, storedName] of [['cut', CUT_NAME, LONG_PREFIX], ['escaped', 'o&#x27;brien', "o'brien"]]) {
      assert.equal((await call(server, 'PUT', `/api/users/${id}`, tokenFor(id), { firstName })).status, 200);
      const stored = storedUser(dbFile, id);
      assert.equal(stored.firstName, storedName, id);
      assert.equal(stored.nameSetByUser, undefined, id);
    }
    await assertMasked();

    await call(server, 'POST', '/api/drinks/1/like', tokenFor('cut'));
    const { body } = await call(server, 'GET', '/api/notifications', tokenFor('viewer'));
    assert.deepEqual(body.notifications.map((n) => n.message), ['Someone cheered your drink Vera drink.']);

    await server.restart();
    await assertMasked();
    assert.equal(storedUser(dbFile, 'cut').firstName, LONG_PREFIX);
  });

  test('an odd stored name does not break a profile save', async (t) => {
    const dbFile = makeDbDir(t, JSON.stringify({ users: [{ id: 'odd', firstName: 5, lastName: '' }], drinks: [], dbSchemaVersion: 2 }));
    const server = await startOn(t, dbFile);
    const { status, body } = await call(server, 'PUT', '/api/users/odd', tokenFor('odd'), { firstName: 'Ana' });
    assert.equal(status, 200);
    assert.equal(body.firstName, 'Ana');
  });

  test('a real change of name still sets the flag and shows it', async (t) => {
    const dbFile = makeDbDir(t, JSON.stringify({ users, drinks: [], nextDrinkId: 1 }));
    const server = await startOn(t, dbFile);
    const { status } = await call(server, 'PUT', '/api/users/escaped', tokenFor('escaped'), { firstName: "O'Hara" });
    assert.equal(status, 200);
    assert.equal(storedUser(dbFile, 'escaped').nameSetByUser, true);
    assert.equal((await call(server, 'GET', '/api/users/escaped')).body.firstName, "O'Hara");
  });

  test('a notification built after the migration holds plain text, and stays so', async (t) => {
    const fixture = {
      users: [{ ...VIEWER, id: 'fan', firstName: 'O&#x27;Neil' }, VIEWER],
      drinks: [{ id: 1, userId: 'viewer', name: 'a&amp;amp;b', isAlcoholic: false, cheersCount: 0 }],
      nextDrinkId: 2,
    };
    const dbFile = makeDbDir(t, JSON.stringify(fixture));
    const server = await startOn(t, dbFile);
    assert.equal((await call(server, 'POST', '/api/drinks/1/like', tokenFor('fan'))).status, 200);

    const expected = ["O'Neil cheered your drink a&amp;b."];
    const messages = async () => (await call(server, 'GET', '/api/notifications', tokenFor('viewer'))).body.notifications.map((n) => n.message);
    assert.deepEqual(await messages(), expected);
    await server.restart();
    assert.deepEqual(await messages(), expected);
  });
});
