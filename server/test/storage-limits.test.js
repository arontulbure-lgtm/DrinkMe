import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { REAL_DB_FILE, startServer } from './helpers/harness.js';

const REQUEST_TIMEOUT_MS = 120_000;
const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const FAULT_PRELOAD = new URL('./helpers/db-fault-preload.js', import.meta.url).href;
const MIB = 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const dataUrl = (type, bytes) => `data:image/${type};base64,${bytes.toString('base64')}`;
const SMALL_IMAGE = dataUrl('jpeg', JPEG);
const LARGER_IMAGE = dataUrl('png', Buffer.concat([PNG, Buffer.alloc(30, 0x41)]));

const postBody = (name = 'Limit test') => ({ name, description: 'Synthetic', rating: 4, isAlcoholic: false, imageData: SMALL_IMAGE });
const ago = (hours) => new Date(Date.now() - hours * HOUR_MS).toISOString();
const tokenFor = (uid) => jwt.sign({ uid }, HARNESS_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
// Confirmed 18+: every route but the first-run ones needs it.
const userOf = (id, extra = {}) => ({ id, email: `${id}@example.test`, firstName: 'Test', lastName: '', city: '', bio: '', avatar: null, ageConfirmedAt: '2026-01-01T00:00:00.000Z', ...extra });
const drinkOf = (id, userId, extra = {}) => ({
  id, userId, name: 'Fixture', description: 'Fixture', rating: 4, isAlcoholic: false, tags: [], cheersCount: 0, createdAt: ago(48), imageUrl: SMALL_IMAGE, ...extra,
});
const fixtureSize = (fixture) => Buffer.byteLength(JSON.stringify(fixture, null, 2));
const filler = (length) => 'data:image/png;base64,'.padEnd(length, 'A');

const storedAvatar = (server, id) => JSON.parse(fs.readFileSync(server.dbFile, 'utf8')).users.find((u) => u.id === id).avatar;

const call = async (server, method, path, token, body) => {
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};
const signIn = (server, uid) => call(server, 'POST', '/api/auth/mobile', undefined, { idToken: 'dev-fallback-token', uid });

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

describe('database growth guard', () => {
  const OWNER = 'guard-owner';
  const OTHER = 'guard-other';
  const THIRD = 'guard-third';
  const PHOTO_USER = 'guard-photo';
  const FIXTURE = {
    users: [
      userOf(OWNER, { bio: 'b'.repeat(5000), avatar: LARGER_IMAGE }),
      userOf(OTHER),
      userOf(THIRD),
      userOf(PHOTO_USER, { avatar: 'https://lh3.googleusercontent.com/a/photo' }),
    ],
    drinks: [drinkOf(1, OTHER), drinkOf(2, OTHER, { cheersCount: 1 })],
    nextDrinkId: 3,
    dbSchemaVersion: 2, // a legacy file would be rewritten at load, changing the sizes below
    smartBarByUser: { [OWNER]: [{ id: 1, name: 'Tonic', quantity: '1', unit: 'bottle' }, { id: 2, name: 'Gin', quantity: '1', unit: 'bottle' }] },
    partnersByUser: { [OWNER]: [OTHER], [OTHER]: [OWNER], [THIRD]: [], [PHOTO_USER]: [] },
    cheersByUser: { [OWNER]: [2] },
    savedByUser: { [OWNER]: [2] },
  };
  const ownerToken = tokenFor(OWNER);
  const commentBody = { content: 'Guarded' };

  const assertGrowthBlocked = ({ status, body }, label) => {
    assert.equal(status, 507, label);
    assert.equal(body.code, 'storage_full', label);
  };

  test('at the limit growth still works, and the save that passes it blocks the next', async (t) => {
    const server = await startServer({ DB_GROWTH_MAX_BYTES: String(fixtureSize(FIXTURE)) }, { dbFixture: FIXTURE });
    t.after(() => server.stop());
    assert.equal((await call(server, 'POST', '/api/drinks/1/comments', ownerToken, commentBody)).status, 201);
    assertGrowthBlocked(await call(server, 'POST', '/api/drinks/1/comments', ownerToken, commentBody), 'after passing');
  });

  test('one byte over the limit at load blocks growth', async (t) => {
    const server = await startServer({ DB_GROWTH_MAX_BYTES: String(fixtureSize(FIXTURE) - 1) }, { dbFixture: FIXTURE });
    t.after(() => server.stop());
    assertGrowthBlocked(await call(server, 'POST', '/api/drinks/1/comments', ownerToken, commentBody), 'comment');
  });

  describe('over the limit', () => {
    let server;

    // A margin, because the removals and the smaller avatar below shrink the database. The large
    // bio keeps it over the limit until the last test removes it.
    const SHRINK_MARGIN = 500;

    before(async () => {
      server = await startServer({ DB_GROWTH_MAX_BYTES: String(fixtureSize(FIXTURE) - SHRINK_MARGIN) }, { dbFixture: FIXTURE });
    });

    after(() => server?.stop());

    test('comment, smart bar add and a new user get 507, and state does not change', async () => {
      const dbBytes = fs.readFileSync(server.dbFile);
      assertGrowthBlocked(await call(server, 'POST', '/api/drinks/1/comments', ownerToken, commentBody), 'comment');
      assertGrowthBlocked(await call(server, 'POST', '/api/smart-bar', ownerToken, { name: 'Rum', quantity: '1' }), 'smart bar');
      assertGrowthBlocked(await signIn(server, 'guard-new-user'), 'new user');
      assert.deepEqual(fs.readFileSync(server.dbFile), dbBytes);
      assert.deepEqual((await call(server, 'GET', '/api/drinks/1/comments', tokenFor(OTHER))).body.items, []);
      assert.equal((await call(server, 'GET', '/api/smart-bar', ownerToken)).body.length, 2);
      assert.equal((await call(server, 'GET', '/api/users/guard-new-user', tokenFor(OTHER))).status, 404);
    });

    test('a post gets 507 and state does not change', async () => {
      const dbBytes = fs.readFileSync(server.dbFile);
      assertGrowthBlocked(await call(server, 'POST', '/api/drinks', ownerToken, postBody()), 'post');
      assert.deepEqual(fs.readFileSync(server.dbFile), dbBytes);
      assert.equal((await call(server, 'GET', '/api/drinks', tokenFor(OTHER))).body.items.length, 2);
    });

    test('an avatar that grows the database gets 507, on both paths, and state does not change', async () => {
      const dbBytes = fs.readFileSync(server.dbFile);
      const larger = dataUrl('png', Buffer.concat([PNG, Buffer.alloc(60, 0x41)]));
      const avatar = (uid, imageData) => call(server, 'POST', `/api/users/${uid}/avatar`, tokenFor(uid), { imageData });
      assertGrowthBlocked(await avatar(OWNER, larger), 'larger avatar');
      assertGrowthBlocked(await avatar(THIRD, SMALL_IMAGE), 'first avatar');
      assertGrowthBlocked(await avatar(PHOTO_USER, SMALL_IMAGE), 'data avatar replacing a provider photo');

      const form = new FormData();
      form.append('avatar', new Blob([JPEG]), 'a.jpg');
      const res = await fetch(`${server.baseUrl}/api/users/${THIRD}/avatar`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenFor(THIRD)}` },
        body: form,
      });
      assert.equal(res.status, 507);
      assert.deepEqual(fs.readFileSync(server.dbFile), dbBytes);
      assert.equal(storedAvatar(server, OWNER), LARGER_IMAGE);
    });

    test('adding a cheer, save or partner gets 507, with no state change or notification', async () => {
      const dbBytes = fs.readFileSync(server.dbFile);
      assertGrowthBlocked(await call(server, 'POST', '/api/drinks/1/like', ownerToken), 'cheer');
      assertGrowthBlocked(await call(server, 'POST', '/api/drinks/1/save', ownerToken), 'save');
      assertGrowthBlocked(await call(server, 'POST', `/api/drink-partners/${THIRD}`, ownerToken), 'partner');
      assert.deepEqual(fs.readFileSync(server.dbFile), dbBytes);

      assert.equal((await call(server, 'GET', '/api/drinks/1', tokenFor(OTHER))).body.cheersCount, 0);
      assert.deepEqual((await call(server, 'GET', '/api/notifications', tokenFor(THIRD))).body.notifications, []);
      assert.deepEqual((await call(server, 'GET', '/api/notifications', tokenFor(OTHER))).body.notifications, []);
    });

    test('removing a cheer, save or partner still works', async () => {
      const like = await call(server, 'POST', '/api/drinks/2/like', ownerToken);
      assert.deepEqual([like.status, like.body.cheered, like.body.cheersCount], [200, false, 0]);
      const save = await call(server, 'POST', '/api/drinks/2/save', ownerToken);
      assert.deepEqual([save.status, save.body.saved], [200, false]);
      const partner = await call(server, 'DELETE', `/api/drink-partners/${OTHER}`, ownerToken);
      assert.equal(partner.status, 204);
    });

    test('an avatar replacement that is the same size or smaller is allowed', async () => {
      const path = `/api/users/${OWNER}/avatar`;
      const sameSize = dataUrl('png', Buffer.concat([PNG, Buffer.alloc(30, 0x42)]));
      assert.equal(sameSize.length, LARGER_IMAGE.length);
      assert.equal((await call(server, 'POST', path, ownerToken, { imageData: sameSize })).status, 200);
      const smaller = await call(server, 'POST', path, ownerToken, { imageData: SMALL_IMAGE });
      assert.equal(smaller.status, 200);
      assert.equal(storedAvatar(server, OWNER), SMALL_IMAGE);
    });

    test('an existing user can still sign in, delete and edit', async () => {
      assert.equal((await signIn(server, OWNER)).status, 200);
      assert.equal((await call(server, 'POST', '/api/notifications/read', ownerToken)).status, 200);
      assert.equal((await call(server, 'DELETE', '/api/smart-bar/2', ownerToken)).status, 204);
      assert.equal((await call(server, 'PUT', `/api/users/${OWNER}`, ownerToken, { city: 'Cluj' })).status, 200);
    });

    test('the guard survives a restart', async () => {
      await server.restart();
      assertGrowthBlocked(await call(server, 'POST', '/api/drinks/1/comments', ownerToken, commentBody), 'after restart');
      assert.equal((await signIn(server, OWNER)).status, 200);
    });

    test('the guard lifts once the database shrinks', async () => {
      assert.equal((await call(server, 'PUT', `/api/users/${OWNER}`, ownerToken, { bio: '' })).status, 200);
      assert.equal((await call(server, 'POST', '/api/drinks/1/comments', ownerToken, commentBody)).status, 201);
    });
  });

  describe('size is measured in bytes, not characters', () => {
    const MULTI_BYTE_FIXTURE = { ...FIXTURE, users: [...FIXTURE.users.slice(1), userOf(OWNER, { bio: 'ă'.repeat(5000) })] };
    const COMMENT_LENGTH = 400;
    const post = (server, content) => call(server, 'POST', '/api/drinks/1/comments', ownerToken, { content });

    // The size of the file after one ASCII comment. The same comment in 3-byte characters saves the
    // same number of characters, and 2 * COMMENT_LENGTH more bytes.
    const sizeAfterAsciiComment = async () => {
      const probe = await startServer({}, { dbFixture: FIXTURE });
      try {
        assert.equal((await post(probe, 'a'.repeat(COMMENT_LENGTH))).status, 201);
        return fs.statSync(probe.dbFile).size;
      } finally {
        await probe.stop();
      }
    };

    test('a file over the limit only in bytes blocks growth at load', async (t) => {
      const chars = JSON.stringify(MULTI_BYTE_FIXTURE, null, 2).length;
      assert.ok(fixtureSize(MULTI_BYTE_FIXTURE) > chars);
      const server = await startServer({ DB_GROWTH_MAX_BYTES: String(chars) }, { dbFixture: MULTI_BYTE_FIXTURE });
      t.after(() => server.stop());
      assertGrowthBlocked(await post(server, 'Blocked'), 'at load');
    });

    test('a file exactly at the limit in bytes can still grow', async (t) => {
      const server = await startServer({ DB_GROWTH_MAX_BYTES: String(fixtureSize(MULTI_BYTE_FIXTURE)) }, { dbFixture: MULTI_BYTE_FIXTURE });
      t.after(() => server.stop());
      assert.equal((await post(server, 'Allowed')).status, 201);
    });

    test('a multi-byte save that passes the limit only in bytes blocks growth, also after a restart', async (t) => {
      const limit = await sizeAfterAsciiComment();
      const server = await startServer({ DB_GROWTH_MAX_BYTES: String(limit) }, { dbFixture: FIXTURE });
      t.after(() => server.stop());

      assert.equal((await post(server, '語'.repeat(COMMENT_LENGTH))).status, 201);
      const saved = fs.readFileSync(server.dbFile);
      assert.ok(saved.length > limit, 'the bytes must be over the limit');
      assert.ok(saved.toString('utf8').length <= limit, 'the characters must not be');

      assertGrowthBlocked(await post(server, 'Blocked'), 'after the save');
      await server.restart();
      assertGrowthBlocked(await post(server, 'Blocked'), 'after the restart');
    });

    test('the same save in ASCII stays at the limit and is not blocked', async (t) => {
      const limit = await sizeAfterAsciiComment();
      const server = await startServer({ DB_GROWTH_MAX_BYTES: String(limit) }, { dbFixture: FIXTURE });
      t.after(() => server.stop());

      assert.equal((await post(server, 'a'.repeat(COMMENT_LENGTH))).status, 201);
      assert.equal(fs.statSync(server.dbFile).size, limit);
      assert.equal((await post(server, 'Allowed')).status, 201);
      assertGrowthBlocked(await post(server, 'Blocked'), 'after passing');
    });

    test('an unusable file over the limit starts empty and is not blocked', async (t) => {
      const unusable = { drinks: 'not a list', padding: 'ă'.repeat(5000) };
      const server = await startServer({ DB_GROWTH_MAX_BYTES: '1000' }, { dbFixture: unusable });
      t.after(() => server.stop());
      assert.equal((await signIn(server, 'guard-new-user')).status, 200);
    });
  });

  for (const [label, env] of [
    ['a non-numeric override', { DB_GROWTH_MAX_BYTES: 'abc' }],
    ['an override outside tests', { DB_GROWTH_MAX_BYTES: '1', NODE_ENV: 'development' }],
  ]) {
    test(`${label} is ignored`, async (t) => {
      const server = await startServer(env, { dbFixture: FIXTURE });
      t.after(() => server.stop());
      assert.equal((await call(server, 'POST', '/api/drinks/1/comments', ownerToken, commentBody)).status, 201);
    });
  }
});

describe('text sanitizing and comment input', () => {
  const USER = 'text-user';
  const token = tokenFor(USER);
  let server;

  const comment = (content) => call(server, 'POST', '/api/drinks/1/comments', token, { content });

  before(async () => {
    server = await startServer({}, { dbFixture: { users: [userOf(USER)], drinks: [drinkOf(1, USER)], nextDrinkId: 2 } });
  });

  after(() => server?.stop());

  test('control characters are removed and newlines kept', async () => {
    const { status, body } = await comment('a\x00b\x1Fc\nd\x7Fe');
    assert.equal(status, 201);
    assert.equal(body.content, 'abc\nde');
  });

  test('a tab becomes a space, so pasted words stay apart', async () => {
    const { status, body } = await comment('Gin\tTonic');
    assert.equal(status, 201);
    assert.equal(body.content, 'Gin Tonic');
  });

  test('a lone surrogate is stored as U+FFFD, and a whole emoji is kept', async () => {
    const { status, body } = await comment('a\uD83Db\uDE00c😀');
    assert.equal(status, 201);
    assert.equal(body.content, 'a\uFFFDb\uFFFDc😀');
    const stored = JSON.parse(fs.readFileSync(server.dbFile, 'utf8')).commentsByDrink[1].at(-1);
    assert.equal(stored.content, 'a\uFFFDb\uFFFDc😀');
    assert.ok(!fs.readFileSync(server.dbFile, 'utf8').includes('\\ud83d'));
  });

  test('an emoji split by the length cut is removed', async () => {
    const NAME_MAX_LENGTH = 120;
    const { status, body } = await call(server, 'POST', '/api/smart-bar', token, {
      name: `${'a'.repeat(NAME_MAX_LENGTH - 1)}😀`,
      quantity: '1',
    });
    assert.equal(status, 201);
    assert.equal(body.name, 'a'.repeat(NAME_MAX_LENGTH - 1));
    assert.ok(body.name.isWellFormed());
  });

  test('a value of only control characters is empty, so it gets 400', async () => {
    for (const content of ['\x01\x02', '\x01 \x02', '\x7F']) {
      assert.equal((await comment(content)).status, 400, JSON.stringify(content));
    }
    assert.equal((await call(server, 'POST', '/api/smart-bar', token, { name: '\x01', quantity: '1' })).status, 400);
    const post = await call(server, 'POST', '/api/drinks', token, { ...postBody('\x01\x02') });
    assert.equal(post.status, 400);
  });

  test('non-string comment content gets 400, not 500', async () => {
    for (const content of [123, true, {}, ['text'], null]) {
      assert.equal((await comment(content)).status, 400, JSON.stringify(content));
    }
  });
});

test('a legacy name equal to the old escaped email prefix stays masked', async (t) => {
  const legacy = await startServer({}, {
    dbFixture: { users: [userOf('legacy-name', { email: 'a&\x01b@example.test', firstName: 'a&amp;\x01b' }), userOf('viewer')] },
  });
  t.after(() => legacy.stop());
  const { status, body } = await call(legacy, 'GET', '/api/users/legacy-name', tokenFor('viewer'));
  assert.equal(status, 200);
  assert.equal(body.firstName, undefined);
});

describe('smart bar item cap', () => {
  const MAX_ITEMS = 500;
  const HUGE_COUNT = 150_000; // more arguments than a spread can safely take
  const items = (count) => Array.from({ length: count }, (_, i) => ({ id: i + 1, name: 'Item', quantity: '1', unit: 'bottle' }));
  const newItem = { name: 'Rum', quantity: '1' };
  const bar = async (server, uid) => (await call(server, 'GET', '/api/smart-bar', tokenFor(uid))).body;
  const add = (server, uid) => call(server, 'POST', '/api/smart-bar', tokenFor(uid), newItem);
  const assertBarFull = ({ status, body }, label) => {
    assert.equal(status, 429, label);
    assert.equal(body.code, 'smart_bar_limit', label);
  };
  let server;

  before(async () => {
    server = await startServer({}, {
      dbFixture: {
        users: ['bar-almost', 'bar-full', 'bar-over', 'bar-huge'].map((id) => userOf(id)),
        smartBarByUser: {
          'bar-almost': items(MAX_ITEMS - 1),
          'bar-full': items(MAX_ITEMS),
          'bar-over': items(MAX_ITEMS + 2),
          'bar-huge': items(HUGE_COUNT),
        },
      },
    });
  });

  after(() => server?.stop());

  test('the 500th item is accepted and the 501st gets 429, with nothing stored', async () => {
    const accepted = await add(server, 'bar-almost');
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body.id, MAX_ITEMS);

    const dbBytes = fs.readFileSync(server.dbFile);
    assertBarFull(await add(server, 'bar-almost'), '501st');
    assert.deepEqual(fs.readFileSync(server.dbFile), dbBytes);
    assert.equal((await bar(server, 'bar-almost')).length, MAX_ITEMS);
  });

  test('at the cap, deleting one makes room for one', async () => {
    assertBarFull(await add(server, 'bar-full'), 'full');
    assert.equal((await call(server, 'DELETE', '/api/smart-bar/1', tokenFor('bar-full'))).status, 204);
    assert.equal((await add(server, 'bar-full')).status, 201);
    assertBarFull(await add(server, 'bar-full'), 'full again');
  });

  test('a list over the cap keeps its items, can delete, and adds again only below the cap', async () => {
    const token = tokenFor('bar-over');
    assertBarFull(await add(server, 'bar-over'), 'over');
    assert.equal((await bar(server, 'bar-over')).length, MAX_ITEMS + 2);

    assert.equal((await call(server, 'DELETE', '/api/smart-bar/1', token)).status, 204);
    assert.equal((await bar(server, 'bar-over')).length, MAX_ITEMS + 1);
    assertBarFull(await add(server, 'bar-over'), 'still over');

    assert.equal((await call(server, 'DELETE', '/api/smart-bar/2', token)).status, 204);
    assertBarFull(await add(server, 'bar-over'), 'at the cap');
    assert.equal((await call(server, 'DELETE', '/api/smart-bar/3', token)).status, 204);
    assert.equal((await add(server, 'bar-over')).status, 201);
  });

  test('a very long list gets the 429 rather than a crash in the id spread', async () => {
    assertBarFull(await add(server, 'bar-huge'), 'huge');
  });
});

describe('notification cap', () => {
  const makeNotifications = (count, startId) => Array.from({ length: count }, (_, i) => ({
    id: startId + count - 1 - i, // newest first, as the server stores them
    type: 'cheer',
    message: 'Old',
    read: true,
    createdAt: ago(1),
  }));
  const FIXTURE = {
    users: ['almost-full', 'full', 'fan'].map((id) => userOf(id)),
    drinks: [drinkOf(1, 'almost-full'), drinkOf(2, 'full')],
    nextDrinkId: 3,
    nextNotificationId: 1000,
    notificationsByUser: { 'almost-full': makeNotifications(199, 1), full: makeNotifications(200, 1) },
  };
  const fanToken = tokenFor('fan');
  const notifications = async (server, uid) => (await call(server, 'GET', '/api/notifications', tokenFor(uid))).body.notifications;

  test('the 200th is kept with all others, and the 201st drops only the oldest', async (t) => {
    const server = await startServer({}, { dbFixture: FIXTURE });
    t.after(() => server.stop());

    assert.equal((await call(server, 'POST', '/api/drinks/1/like', fanToken)).status, 200);
    const atLimit = await notifications(server, 'almost-full');
    assert.equal(atLimit.length, 200);
    assert.equal(atLimit[0].id, 1000);
    assert.equal(atLimit[199].id, 1);

    assert.equal((await call(server, 'POST', '/api/drinks/2/like', fanToken)).status, 200);
    const overLimit = await notifications(server, 'full');
    assert.equal(overLimit.length, 200);
    assert.equal(overLimit[0].id, 1001);
    assert.equal(overLimit[199].id, 2);
  });

  test('a comment that failed to save restores a notification the cap had dropped', async (t) => {
    const server = await startServer({ DB_FAULT: 'save', NODE_OPTIONS: `--import=${FAULT_PRELOAD}` }, { dbFixture: FIXTURE });
    t.after(async () => {
      fs.rmSync(`${server.dbFile}.fail-saves`, { force: true });
      await server.stop();
    });
    fs.writeFileSync(`${server.dbFile}.fail-saves`, '');

    const { status } = await call(server, 'POST', '/api/drinks/2/comments', fanToken, { content: 'Unsaved' });
    assert.equal(status, 503);
    const list = await notifications(server, 'full');
    assert.equal(list.length, 200);
    assert.equal(list[0].id, 200);
    assert.equal(list[199].id, 1);
  });
});

describe('daily comment limit', () => {
  const USER = 'comment-user';
  const OTHER = 'comment-other';
  const makeComments = (userId, count, hours, startId) => Array.from({ length: count }, (_, i) => ({
    id: startId + i, drinkId: 1, userId, content: 'Old', createdAt: ago(hours),
  }));
  let server;

  const comment = (uid) => call(server, 'POST', '/api/drinks/2/comments', tokenFor(uid), { content: 'New' });

  before(async () => {
    server = await startServer({}, {
      dbFixture: {
        users: [userOf(USER), userOf(OTHER)],
        drinks: [drinkOf(1, USER), drinkOf(2, USER)],
        nextDrinkId: 3,
        nextCommentId: 1000,
        commentsByDrink: {
          1: [...makeComments(USER, 150, 1, 1), ...makeComments(USER, 50, 25, 200), ...makeComments(OTHER, 50, 1, 300)],
          2: makeComments(USER, 49, 23, 400),
        },
      },
    });
  });

  after(() => server?.stop());

  test('the 200th comment in 24 hours is accepted and the 201st gets 429', async () => {
    assert.equal((await comment(USER)).status, 201);
    const count = JSON.parse(fs.readFileSync(server.dbFile, 'utf8')).nextCommentId;
    const { status, body } = await comment(USER);
    assert.equal(status, 429);
    assert.equal(body.code, 'daily_comment_limit');
    assert.equal(JSON.parse(fs.readFileSync(server.dbFile, 'utf8')).nextCommentId, count);
  });

  test('the limit survives a restart', async () => {
    await server.restart();
    assert.equal((await comment(USER)).status, 429);
  });

  test('other users are not counted', async () => {
    assert.equal((await comment(OTHER)).status, 201);
  });
});

describe('post limit code', () => {
  test('the daily post 429 carries its code', async (t) => {
    const USER = 'code-user';
    const drinks = Array.from({ length: 20 }, (_, i) => drinkOf(i + 1, USER, { createdAt: ago(1) }));
    const server = await startServer({}, { dbFixture: { users: [userOf(USER)], drinks, nextDrinkId: 21 } });
    t.after(() => server.stop());
    const { status, body } = await call(server, 'POST', '/api/drinks', tokenFor(USER), postBody());
    assert.equal(status, 429);
    assert.equal(body.code, 'daily_post_limit');
  });
});

describe('lifetime image quota, posts and avatar', () => {
  const QUOTA = 100 * MIB;
  const USER = 'quota-user';
  const OTHER = 'quota-other';
  const token = tokenFor(USER);
  let server;

  const assertQuota = ({ status, body }, label) => {
    assert.equal(status, 507, label);
    assert.equal(body.code, 'user_image_quota', label);
  };
  const setAvatar = (imageData) => call(server, 'POST', `/api/users/${USER}/avatar`, token, { imageData });

  before(async () => {
    server = await startServer({}, {
      dbFixture: {
        users: [userOf(USER), userOf(OTHER)],
        // Older than 24 hours, so only the lifetime quota applies.
        drinks: [drinkOf(1, USER, { imageUrl: filler(QUOTA - SMALL_IMAGE.length), createdAt: ago(48) })],
        nextDrinkId: 2,
      },
    });
  });

  after(() => server?.stop());

  test('an avatar that lands exactly on the quota is accepted', async () => {
    assert.equal((await setAvatar(SMALL_IMAGE)).status, 200);
  });

  test('over the quota a post and a larger avatar get 507, with nothing stored', async () => {
    assertQuota(await call(server, 'POST', '/api/drinks', token, postBody()), 'post');
    assertQuota(await setAvatar(LARGER_IMAGE), 'larger avatar');
    assert.equal(storedAvatar(server, USER), SMALL_IMAGE);
  });

  test('replacing the avatar credits the old size', async () => {
    assert.equal((await setAvatar(dataUrl('jpeg', Buffer.from(JPEG).fill(0x41, 3)))).status, 200);
  });

  test('other users are not affected', async () => {
    assert.equal((await call(server, 'POST', '/api/drinks', tokenFor(OTHER), postBody())).status, 201);
  });
});

describe('lifetime image quota, avatar freeing room', () => {
  const QUOTA = 100 * MIB;
  const USER = 'avatar-quota-user';
  const token = tokenFor(USER);
  let server;

  before(async () => {
    server = await startServer({}, {
      dbFixture: { users: [userOf(USER, { avatar: filler(QUOTA - SMALL_IMAGE.length) })] },
    });
  });

  after(() => server?.stop());

  test('the avatar counts toward the quota, and replacing it frees room for posts', async () => {
    assert.equal((await call(server, 'POST', '/api/drinks', token, postBody())).status, 201);
    const refused = await call(server, 'POST', '/api/drinks', token, postBody());
    assert.equal(refused.status, 507);
    assert.equal(refused.body.code, 'user_image_quota');

    assert.equal((await call(server, 'POST', `/api/users/${USER}/avatar`, token, { imageData: SMALL_IMAGE })).status, 200);
    assert.equal((await call(server, 'POST', '/api/drinks', token, postBody())).status, 201);
  });
});

describe('image storage warning and default', () => {
  const WARNING = '[storage] Stored images passed 80% of the limit.';
  const USER = 'warning-user';
  const countWarnings = (server) => server.getOutput().split(WARNING).length - 1;

  test('is logged once when the total passes 80%, with no user data', async (t) => {
    const LIMIT = 100; // SMALL_IMAGE is 39 characters, so the third post passes 80% and the limit
    const server = await startServer({ IMAGE_STORAGE_MAX_BYTES: String(LIMIT) }, { dbFixture: { users: [userOf(USER)] } });
    t.after(() => server.stop());
    const token = tokenFor(USER);
    const post = () => call(server, 'POST', '/api/drinks', token, postBody());

    assert.equal((await post()).status, 201);
    assert.equal((await post()).status, 201);
    assert.equal(countWarnings(server), 0);

    const refused = await post();
    assert.equal(refused.status, 507);
    assert.equal(refused.body.code, 'image_storage_full');
    assert.equal(countWarnings(server), 1);

    assert.equal((await post()).status, 507);
    assert.equal(countWarnings(server), 1);
    assert.ok(!server.getOutput().includes(USER));
  });

  test('the default total cap is 200 MB', async (t) => {
    const TOTAL = 200 * MIB;
    const server = await startServer({}, {
      dbFixture: {
        users: ['total-a', 'total-b', 'total-c'].map((id) => userOf(id)),
        drinks: [
          drinkOf(1, 'total-a', { imageUrl: filler(99 * MIB) }),
          drinkOf(2, 'total-b', { imageUrl: filler(TOTAL - 99 * MIB - SMALL_IMAGE.length) }),
        ],
        nextDrinkId: 3,
      },
    });
    t.after(() => server.stop());
    assert.equal((await call(server, 'POST', '/api/drinks', tokenFor('total-c'), postBody())).status, 201);
    const refused = await call(server, 'POST', '/api/drinks', tokenFor('total-c'), postBody());
    assert.equal(refused.status, 507);
    assert.equal(refused.body.code, 'image_storage_full');
  });
});
