import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { startServer } from './helpers/harness.js';

const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const FAULT_PRELOAD = new URL('./helpers/db-fault-preload.js', import.meta.url).href;
const HOUR_MS = 60 * 60 * 1000;
const MIB = 1024 * 1024;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const dataUrl = (bytes) => `data:image/png;base64,${bytes.toString('base64')}`;
const SMALL_IMAGE = dataUrl(PNG);
const imageOfBase64Length = (length) => dataUrl(Buffer.concat([PNG, Buffer.alloc(Math.floor(length * 3 / 4) - PNG.length, 7)]));
const filler = (length) => 'data:image/png;base64,'.padEnd(length, 'A');

const OWNER = 'owner';
const OTHER = 'other';
const THIRD = 'third';

const ago = (hours) => new Date(Date.now() - hours * HOUR_MS).toISOString();
const tokenFor = (uid) => jwt.sign({ uid }, HARNESS_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const readDb = (server) => JSON.parse(fs.readFileSync(server.dbFile, 'utf8'));
const failSaves = (server) => fs.writeFileSync(`${server.dbFile}.fail-saves`, '');
const allowSaves = (server) => fs.rmSync(`${server.dbFile}.fail-saves`);
const FAULT_ENV = { DB_FAULT: 'save', NODE_OPTIONS: `--import=${FAULT_PRELOAD}` };

const call = async (server, method, path, uid, body) => {
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(uid && { Authorization: `Bearer ${tokenFor(uid)}` }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
};
const remove = (server, id, uid) => call(server, 'DELETE', `/api/drinks/${id}`, uid);
const post = (server, uid, imageData = SMALL_IMAGE) => (
  call(server, 'POST', '/api/drinks', uid, { name: 'New', description: 'New', rating: 4, isAlcoholic: false, imageData })
);
const comment = (server, id, uid) => call(server, 'POST', `/api/drinks/${id}/comments`, uid, { content: 'Hello' });
// Nothing is readable logged out, so images are fetched as another confirmed user.
const media = (server, id, headers = {}) => fetch(`${server.baseUrl}/media/drinks/${id}`, { headers: { Authorization: `Bearer ${tokenFor(OTHER)}`, ...headers } });

const user = (id) => ({ id, email: `${id}@example.test`, firstName: id, lastName: '', city: '', bio: '', nameSetByUser: true, avatar: null, ageConfirmedAt: ago(1000) });
const drink = (id, userId, extra = {}) => ({
  id, userId, name: `Drink ${id}`, description: 'Plain', rating: 4, location: null, isAlcoholic: false,
  createdAt: ago(48), cheersCount: 0, tags: [], imageUrl: SMALL_IMAGE, ...extra,
});
const commentOf = (id, drinkId, userId, createdAt = ago(48)) => ({ id, drinkId, userId, content: `Comment ${id}`, createdAt });
const baseFixture = (extra = {}) => ({
  users: [user(OWNER), user(OTHER), user(THIRD)],
  limitEventsByUser: {},
  nextDrinkId: 10,
  nextCommentId: 100,
  ...extra,
});

describe('DELETE /api/drinks/:id', () => {
  const cascadeFixture = () => baseFixture({
    drinks: [drink(1, OWNER, { cheersCount: 2 }), drink(2, OTHER)],
    commentsByDrink: { 1: [commentOf(1, 1, OTHER), commentOf(2, 1, THIRD)], 2: [commentOf(3, 2, OWNER)] },
    cheersByUser: { [OTHER]: [1, 2], [THIRD]: [1] },
    savedByUser: { [OTHER]: [2, 1], [OWNER]: [2] },
  });

  test('checks the caller: logged out 401, not the owner 403, missing or malformed 404', async (t) => {
    const server = await startServer({}, { dbFixture: cascadeFixture() });
    t.after(() => server.stop());

    assert.equal((await remove(server, 1)).status, 401);
    assert.equal((await remove(server, 1, OTHER)).status, 403);
    assert.equal((await remove(server, 999, OWNER)).status, 404);
    for (const badId of ['abc', '1e0', '0x1', '-1', '1.0']) {
      assert.equal((await remove(server, badId, OWNER)).status, 404, badId);
    }
    assert.equal((await call(server, 'GET', '/api/drinks/1', THIRD)).status, 200, 'the post is still there');
  });

  test('the owner gets 204, and the post, comments, cheers and saves are gone, also after a restart', async (t) => {
    const server = await startServer({}, { dbFixture: cascadeFixture() });
    t.after(() => server.stop());

    const res = await remove(server, 1, OWNER);
    assert.equal(res.status, 204);
    assert.equal(res.body, undefined);

    const assertGone = async () => {
      assert.equal((await call(server, 'GET', '/api/drinks/1', THIRD)).status, 404);
      assert.equal((await call(server, 'GET', '/api/drinks/1/comments', THIRD)).status, 404);
      assert.equal((await call(server, 'POST', '/api/drinks/1/like', OTHER)).status, 404);
      assert.equal((await call(server, 'POST', '/api/drinks/1/save', OTHER)).status, 404);
      assert.equal((await comment(server, 1, OTHER)).status, 404);
      assert.equal((await remove(server, 1, OWNER)).status, 404);
      assert.equal((await media(server, 1)).status, 404);
      const saved = await call(server, 'GET', `/api/users/${OTHER}/saved-drinks`, OTHER);
      assert.deepEqual(saved.body.items.map((item) => item.id), [2]);
      const db = readDb(server);
      assert.deepEqual(db.drinks.map((item) => item.id), [2]);
      assert.deepEqual(Object.keys(db.commentsByDrink), ['2'], 'other posts keep their comments');
      assert.deepEqual(db.cheersByUser, { [OTHER]: [2], [THIRD]: [] });
      assert.deepEqual(db.savedByUser, { [OTHER]: [2], [OWNER]: [2] });
    };
    await assertGone();
    await server.restart();
    await assertGone();
  });

  test('a deleted post\'s image is a 404 at once', async (t) => {
    const server = await startServer({}, { dbFixture: cascadeFixture() });
    t.after(() => server.stop());

    await media(server, 1);
    const cached = await media(server, 1);
    assert.equal(cached.status, 200);
    assert.equal(cached.headers.get('x-media-cache'), 'hit');

    assert.equal((await remove(server, 1, OWNER)).status, 204);
    const gone = await media(server, 1);
    assert.equal(gone.status, 404);
    assert.equal(gone.headers.get('x-media-cache'), 'miss');
    const revalidated = await media(server, 1, { 'If-None-Match': cached.headers.get('etag') });
    assert.equal(revalidated.status, 404, 'a device holding the old ETag must not get a 304');
  });

  test('ids are not reused, and an id deleted last stays taken after a restart', async (t) => {
    const server = await startServer({}, { dbFixture: baseFixture({ drinks: [], nextDrinkId: 1 }) });
    t.after(() => server.stop());

    const first = await post(server, OWNER);
    assert.equal(first.body.id, 1);
    assert.equal((await remove(server, 1, OWNER)).status, 204);
    assert.equal((await post(server, OWNER)).body.id, 2);
    assert.equal((await remove(server, 2, OWNER)).status, 204);
    await server.restart();
    assert.equal((await post(server, OWNER)).body.id, 3);
  });

  test('a failed save returns 503 and restores everything', async (t) => {
    const server = await startServer(FAULT_ENV, { dbFixture: cascadeFixture() });
    t.after(() => server.stop());

    await media(server, 1);
    assert.equal((await media(server, 1)).headers.get('x-media-cache'), 'hit');
    const before = readDb(server);

    failSaves(server);
    const failed = await remove(server, 1, OWNER);
    assert.equal(failed.status, 503);
    assert.deepEqual(readDb(server), before, 'the file is untouched');
    allowSaves(server);

    // The restored state answers correctly before any new save.
    const detail = await call(server, 'GET', '/api/drinks/1', OTHER);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.isLiked, true);
    assert.equal(detail.body.isSaved, true);
    assert.equal(detail.body.cheersCount, 2);
    assert.equal((await call(server, 'GET', '/api/drinks/1/comments', THIRD)).body.items.length, 2);
    const image = await media(server, 1);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('x-media-cache'), 'miss');
    assert.equal((await media(server, 1)).headers.get('x-media-cache'), 'hit');

    // The next save writes exactly what was there, in the same order, and in the same place.
    assert.equal((await call(server, 'POST', '/api/notifications/read', OWNER)).status, 200);
    const after = readDb(server);
    for (const key of ['drinks', 'commentsByDrink', 'cheersByUser', 'savedByUser', 'nextDrinkId', 'nextCommentId', 'limitEventsByUser']) {
      assert.deepEqual(after[key], before[key], key);
    }

    assert.equal((await remove(server, 1, OWNER)).status, 204, 'deleting works once saves do');
    await server.restart();
    assert.equal((await call(server, 'GET', '/api/drinks/1', THIRD)).status, 404);
  });

  test('works above the growth limit, and frees it', async (t) => {
    const image = filler(200_000);
    const server = await startServer({ DB_GROWTH_MAX_BYTES: '100000' }, {
      dbFixture: baseFixture({ drinks: [drink(1, OWNER, { imageUrl: image })] }),
    });
    t.after(() => server.stop());

    const blocked = await post(server, OWNER);
    assert.equal(blocked.status, 507);
    assert.equal(blocked.body.code, 'storage_full');
    assert.equal((await remove(server, 1, OWNER)).status, 204);
    assert.equal((await post(server, OWNER)).status, 201, 'the guard reads the smaller file');
  });

  test('a failed save at the growth limit keeps the post and the block', async (t) => {
    const server = await startServer({ ...FAULT_ENV, DB_GROWTH_MAX_BYTES: '100000' }, {
      dbFixture: baseFixture({ drinks: [drink(1, OWNER, { imageUrl: filler(200_000) })] }),
    });
    t.after(() => server.stop());

    failSaves(server);
    assert.equal((await remove(server, 1, OWNER)).status, 503);
    allowSaves(server);
    assert.equal((await post(server, OWNER)).status, 507);
    assert.equal((await remove(server, 1, OWNER)).status, 204);
  });
});

describe('deleting does not reset the daily limits', () => {
  test('post 20, delete all: the 21st gets 429, also after a restart, and passes once the window does', async (t) => {
    const server = await startServer({}, { dbFixture: baseFixture({ drinks: [], nextDrinkId: 1 }) });
    t.after(() => server.stop());

    const ids = [];
    for (let i = 0; i < 20; i += 1) {
      const created = await post(server, OWNER);
      assert.equal(created.status, 201);
      ids.push(created.body.id);
    }
    assert.equal((await post(server, OWNER)).body.code, 'daily_post_limit');
    // A restart also resets the in-memory limit of 30 mutations per minute.
    await server.restart();
    for (const id of ids) assert.equal((await remove(server, id, OWNER)).status, 204);

    const blocked = await post(server, OWNER);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'daily_post_limit');
    assert.equal((await post(server, OTHER)).status, 201, 'other users are not counted');

    await server.restart();
    assert.equal((await post(server, OWNER)).status, 429);
    assert.equal(readDb(server).drinks.filter((item) => item.userId === OWNER).length, 0);

    const aged = readDb(server);
    aged.limitEventsByUser[OWNER] = aged.limitEventsByUser[OWNER].map((event) => ({ ...event, at: ago(25) }));
    await server.restart({ dbFixture: aged });
    assert.equal((await post(server, OWNER)).status, 201);
    const events = readDb(server).limitEventsByUser[OWNER];
    assert.equal(events.length, 1, 'the expired events were pruned on that write');
  });

  test('deleting does not reduce the image bytes counted toward the daily limit', async (t) => {
    const server = await startServer({}, {
      dbFixture: baseFixture({
        drinks: [],
        limitEventsByUser: { [OWNER]: [{ kind: 'post', at: ago(1), imageBytes: 45 * MIB }] },
      }),
    });
    t.after(() => server.stop());

    const first = await post(server, OWNER, imageOfBase64Length(MIB));
    assert.equal(first.status, 201);
    // 45 + 1 + 4.5 is over 50 MB, while 45 + 4.5 alone would pass.
    const image = imageOfBase64Length(4.5 * MIB);
    assert.equal((await post(server, OWNER, image)).status, 429);
    assert.equal((await remove(server, first.body.id, OWNER)).status, 204);
    const blocked = await post(server, OWNER, image);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'daily_post_limit');
  });

  test('deleting a post holding your own comments does not reset the comment limit', async (t) => {
    const comments = Array.from({ length: 199 }, (_, i) => commentOf(i + 1, 1, OTHER, ago(1)));
    // No limitEventsByUser key: this one is seeded from the 199 comments.
    const server = await startServer({}, {
      dbFixture: {
        users: [user(OWNER), user(OTHER), user(THIRD)],
        drinks: [drink(1, OWNER), drink(2, THIRD)],
        commentsByDrink: { 1: comments },
        nextDrinkId: 3,
        nextCommentId: 300,
      },
    });
    t.after(() => server.stop());

    assert.equal((await comment(server, 1, OTHER)).status, 201);
    assert.equal((await comment(server, 1, OTHER)).body.code, 'daily_comment_limit');
    assert.equal((await remove(server, 1, OWNER)).status, 204);
    const blocked = await comment(server, 2, OTHER);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'daily_comment_limit');
    await server.restart();
    assert.equal((await comment(server, 2, OTHER)).status, 429);
    assert.equal((await comment(server, 2, THIRD)).status, 201, 'other users are not counted');
  });
});

describe('limit events', () => {
  test('a legacy file is seeded from content inside the window, and the seed is saved once', async (t) => {
    const recentImage = imageOfBase64Length(1000);
    const fixture = {
      users: [user(OWNER), user(OTHER)],
      drinks: [
        ...Array.from({ length: 19 }, (_, i) => drink(i + 1, OWNER, { createdAt: ago(1), imageUrl: recentImage })),
        drink(20, OWNER, { createdAt: ago(25) }),
        drink(21, OTHER, { createdAt: ago(1) }),
      ],
      commentsByDrink: { 1: [commentOf(1, 1, OTHER, ago(2)), commentOf(2, 1, OTHER, ago(30)), null] },
      nextDrinkId: 22,
      nextCommentId: 3,
    };
    const server = await startServer({}, { dbFixture: fixture });
    t.after(() => server.stop());

    assert.equal((await post(server, OWNER)).status, 201, 'the 20th inside the window');
    const events = readDb(server).limitEventsByUser;
    const ownerEvents = events[OWNER];
    assert.equal(ownerEvents.length, 20);
    assert.equal(ownerEvents.filter((event) => event.imageBytes === recentImage.length).length, 19);
    assert.deepEqual(events[OTHER].map((event) => event.kind).sort(), ['comment', 'post']);

    const blocked = await post(server, OWNER);
    assert.equal(blocked.status, 429);

    // Deleting the seeded posts cannot help, and a restart must not seed again from what is left.
    for (let id = 1; id <= 19; id += 1) assert.equal((await remove(server, id, OWNER)).status, 204);
    await server.restart();
    assert.equal((await post(server, OWNER)).status, 429);
    assert.equal(readDb(server).limitEventsByUser[OWNER].length, 20);
  });

  test('a seeded legacy database enforces the image bytes limit', async (t) => {
    const fixture = {
      users: [user(OWNER)],
      drinks: [drink(1, OWNER, { createdAt: ago(1), imageUrl: filler(50 * MIB) })],
      nextDrinkId: 2,
    };
    const server = await startServer({}, { dbFixture: fixture });
    t.after(() => server.stop());
    assert.equal((await post(server, OWNER)).body.code, 'daily_post_limit');
  });

  test('only a positive, finite imageBytes counts toward the daily limit', async (t) => {
    const event = (imageBytes) => ({ kind: 'post', at: ago(1), imageBytes });
    const image = imageOfBase64Length(MIB);
    // A negative value must not hand back room: 49.5 + 1 is over 50 MB whatever else is listed.
    const negative = await startServer({}, {
      dbFixture: baseFixture({ drinks: [], limitEventsByUser: { [OWNER]: [event(49.5 * MIB), event(-40 * MIB)] } }),
    });
    try {
      const blocked = await post(negative, OWNER, image);
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.code, 'daily_post_limit');
    } finally {
      await negative.stop();
    }
    // Values that are not usable numbers add nothing, and the entries still count as posts.
    const unusable = await startServer({}, {
      dbFixture: baseFixture({ drinks: [], limitEventsByUser: { [OWNER]: [event('99999999999'), event(null), event(true)] } }),
    });
    try {
      assert.equal((await post(unusable, OWNER, image)).status, 201);
      assert.equal(readDb(unusable).limitEventsByUser[OWNER].length, 4);
    } finally {
      await unusable.stop();
    }
  });

  test('a file with the key but no entries is not seeded', async () => {
    const drinks = Array.from({ length: 20 }, (_, i) => drink(i + 1, OWNER, { createdAt: ago(1) }));
    const comments = Array.from({ length: 200 }, (_, i) => commentOf(i + 1, 1, OWNER, ago(1)));
    for (const limitEventsByUser of [{}, { [OWNER]: [] }]) {
      const server = await startServer({}, {
        dbFixture: baseFixture({ drinks, limitEventsByUser, commentsByDrink: { 1: comments }, nextDrinkId: 21, nextCommentId: 300 }),
      });
      try {
        assert.equal((await post(server, OWNER)).status, 201);
        assert.equal((await comment(server, 1, OWNER)).status, 201);
        assert.equal(readDb(server).limitEventsByUser[OWNER].length, 2);
      } finally {
        await server.stop();
      }
    }
  });

  test('a failed create leaves no event behind', async (t) => {
    const server = await startServer(FAULT_ENV, { dbFixture: baseFixture({ drinks: [drink(1, OTHER)] }) });
    t.after(() => server.stop());

    failSaves(server);
    assert.equal((await post(server, OWNER)).status, 503);
    assert.equal((await comment(server, 1, OWNER)).status, 503);
    allowSaves(server);

    assert.equal((await call(server, 'POST', '/api/notifications/read', OTHER)).status, 200);
    assert.deepEqual(readDb(server).limitEventsByUser, {}, 'a user with no events does not even keep a key');

    // Twenty failures do not use up the limit either.
    failSaves(server);
    for (let i = 0; i < 20; i += 1) assert.equal((await post(server, OWNER)).status, 503);
    allowSaves(server);
    const created = await post(server, OWNER);
    assert.equal(created.status, 201);
    assert.equal(created.body.id, 10, 'the id counter rolled back too');
    assert.equal(readDb(server).limitEventsByUser[OWNER].length, 1);
  });

  test('stale and malformed entries are dropped at load, and are not counted', async (t) => {
    const server = await startServer({}, {
      dbFixture: baseFixture({
        drinks: [],
        limitEventsByUser: {
          [OWNER]: [
            ...Array.from({ length: 20 }, () => ({ kind: 'post', at: ago(25), imageBytes: 10 })),
            null,
            'text',
            { kind: 'post' },
            { kind: 'post', at: 'not a date' },
          ],
          [THIRD]: [{ kind: 'comment', at: ago(30) }],
        },
      }),
    });
    t.after(() => server.stop());

    assert.equal((await post(server, OWNER)).status, 201);
    const events = readDb(server).limitEventsByUser;
    assert.equal(events[OWNER].length, 1);
    assert.deepEqual(Object.keys(events), [OWNER], 'pruning leaves no empty entry, so it cannot grow the file');
  });

  test('a limitEventsByUser value of the wrong shape counts as a corrupt database', async (t) => {
    const server = await startServer({}, { dbFixture: baseFixture({ drinks: [drink(1, OWNER)], limitEventsByUser: { [OWNER]: 'x' } }) });
    t.after(() => server.stop());
    assert.ok(fs.readdirSync(path.dirname(server.dbFile)).some((name) => name.includes('.corrupt-')));
    // The database started empty, so the reader signs in (dev fallback) and confirms first.
    const signIn = await call(server, 'POST', '/api/auth/mobile', undefined, { idToken: 'dev-fallback-token', uid: THIRD });
    assert.equal((await call(server, 'POST', `/api/users/${THIRD}/acknowledgements`, THIRD, { type: 'age', confirmed: true })).status, 200, signIn.status);
    assert.deepEqual((await call(server, 'GET', '/api/drinks', THIRD)).body.items, []);
  });

  test('reads and a logged-out request create no entry', async (t) => {
    const server = await startServer({}, { dbFixture: baseFixture({ drinks: [drink(1, OTHER)] }) });
    t.after(() => server.stop());

    await call(server, 'GET', '/api/drinks', THIRD);
    assert.equal((await post(server, undefined)).status, 401);
    assert.equal((await post(server, OWNER, 'not an image')).status, 400);
    assert.equal((await comment(server, 999, OWNER)).status, 404);
    assert.equal((await remove(server, 1, OWNER)).status, 403);
    assert.equal((await call(server, 'POST', '/api/notifications/read', OTHER)).status, 200);
    assert.deepEqual(readDb(server).limitEventsByUser, {});
  });
});

describe('post ids in the URL', () => {
  test('only a plain positive integer names a post, on every route', async (t) => {
    const server = await startServer({}, {
      dbFixture: baseFixture({ drinks: [drink(1, OTHER)], commentsByDrink: { 1: [commentOf(1, 1, OTHER)] } }),
    });
    t.after(() => server.stop());

    for (const badId of ['1e0', '0x1', '1.0', '01', '+1', '%201', '0', '-1']) {
      assert.equal((await call(server, 'GET', `/api/drinks/${badId}`, THIRD)).status, 404, `detail ${badId}`);
      assert.equal((await call(server, 'GET', `/api/drinks/${badId}/comments`, THIRD)).status, 404, `comments ${badId}`);
    }
    for (const badId of ['1e0', '0x1', '1.0', '01']) {
      assert.equal((await comment(server, badId, OWNER)).status, 404, `comment ${badId}`);
      assert.equal((await call(server, 'POST', `/api/drinks/${badId}/like`, OWNER)).status, 404, `like ${badId}`);
      assert.equal((await call(server, 'POST', `/api/drinks/${badId}/save`, OWNER)).status, 404, `save ${badId}`);
    }
    const db = readDb(server);
    assert.equal(db.drinks[0].cheersCount, 0);
    assert.equal(db.commentsByDrink[1].length, 1);

    assert.equal((await call(server, 'GET', '/api/drinks/1', THIRD)).status, 200);
    assert.equal((await call(server, 'GET', '/api/drinks/1/comments', THIRD)).status, 200);
    assert.equal((await comment(server, 1, OWNER)).status, 201);
    assert.equal((await call(server, 'POST', '/api/drinks/1/like', OWNER)).body.cheersCount, 1);
    assert.equal((await call(server, 'POST', '/api/drinks/1/save', OWNER)).body.saved, true);
  });
});

describe('storage freed by a deletion', () => {
  test('the lifetime quota is freed', async (t) => {
    const quota = 100 * MIB;
    const server = await startServer({}, {
      dbFixture: baseFixture({ drinks: [drink(1, OWNER, { imageUrl: filler(quota - 10) })] }),
    });
    t.after(() => server.stop());

    const blocked = await post(server, OWNER);
    assert.equal(blocked.status, 507);
    assert.equal(blocked.body.code, 'user_image_quota');
    assert.equal((await remove(server, 1, OWNER)).status, 204);
    assert.equal((await post(server, OWNER)).status, 201);
  });

  test('the global image storage is freed', async (t) => {
    const server = await startServer({ IMAGE_STORAGE_MAX_BYTES: '1000' }, {
      dbFixture: baseFixture({ drinks: [drink(1, OTHER, { imageUrl: filler(990) })] }),
    });
    t.after(() => server.stop());

    const blocked = await post(server, OWNER);
    assert.equal(blocked.status, 507);
    assert.equal(blocked.body.code, 'image_storage_full');
    assert.equal((await remove(server, 1, OTHER)).status, 204);
    assert.equal((await post(server, OWNER)).status, 201);
  });
});
