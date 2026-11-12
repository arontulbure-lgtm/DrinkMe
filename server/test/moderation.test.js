import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { describe, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { startServer } from './helpers/harness.js';

const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const FAULT_PRELOAD = new URL('./helpers/db-fault-preload.js', import.meta.url).href;
const FAULT_ENV = { DB_FAULT: 'save', NODE_OPTIONS: `--import=${FAULT_PRELOAD}` };
const CONFIRMED_AT = '2026-01-02T03:04:05.000Z';
const OLD = '2026-01-01T00:00:00.000Z';
const HOUR_MS = 60 * 60 * 1000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const IMAGE = `data:image/png;base64,${PNG.toString('base64')}`;

const ago = (hours) => new Date(Date.now() - hours * HOUR_MS).toISOString();
const tokenFor = (uid) => jwt.sign({ uid }, HARNESS_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const readDb = (server) => JSON.parse(fs.readFileSync(server.dbFile, 'utf8'));
const failSaves = (server) => fs.writeFileSync(`${server.dbFile}.fail-saves`, '');
const allowSaves = (server) => fs.rmSync(`${server.dbFile}.fail-saves`);

const person = (id, extra = {}) => ({
  id, email: `${id}@example.test`, firstName: id, lastName: 'Test', city: '', bio: '', nameSetByUser: true, avatar: null, ageConfirmedAt: CONFIRMED_AT, ...extra,
});
const minor = (id) => person(id, { ageConfirmedAt: undefined });
const post = (id, userId, extra = {}) => ({
  id, userId, name: `Post ${id}`, description: 'Plain', rating: 4, location: null, isAlcoholic: false,
  createdAt: OLD, cheersCount: 0, tags: [], imageUrl: IMAGE, ...extra,
});
const commentOf = (id, drinkId, userId, extra = {}) => ({ id, drinkId, userId, content: `Comment ${id}`, createdAt: OLD, ...extra });

const call = async (server, method, route, uid, body) => {
  const res = await fetch(`${server.baseUrl}${route}`, {
    method,
    headers: {
      ...(uid && { Authorization: `Bearer ${tokenFor(uid)}` }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  return { status: res.status, headers: res.headers, text, body: parsed };
};
const idsOf = (res) => res.body.items.map((item) => item.id);
const report = (server, uid, targetType, targetId, reason = 'spam', extra = {}) => (
  call(server, 'POST', '/api/reports', uid, { targetType, targetId, reason, ...extra })
);

// alice and bob are the pair under test. carol knows both. Their partnership is left over on purpose.
const socialFixture = (blocksByUser) => ({
  users: [person('alice'), person('bob'), person('carol')],
  drinks: [
    post(1, 'alice', { location: 'Cluj' }),
    post(2, 'bob', { location: 'Cluj' }),
    post(3, 'carol', { location: 'Cluj' }),
  ],
  nextDrinkId: 4,
  commentsByDrink: {
    3: [commentOf(1, 3, 'alice'), commentOf(2, 3, 'bob'), commentOf(3, 3, 'carol')],
    1: [commentOf(4, 1, 'carol')],
    2: [commentOf(5, 2, 'carol')],
  },
  nextCommentId: 6,
  partnersByUser: { alice: ['bob', 'carol'], bob: ['alice', 'carol'], carol: ['alice', 'bob'] },
  savedByUser: { alice: [1, 2, 3], bob: [1, 2, 3], carol: [1, 2] },
  blocksByUser,
});

const PAIRS = [
  { viewer: 'alice', other: 'bob', ownPost: 1, otherPost: 2, otherComment: 2 },
  { viewer: 'bob', other: 'alice', ownPost: 2, otherPost: 1, otherComment: 1 },
];

for (const blocksByUser of [{ alice: ['bob'] }, { bob: ['alice'] }]) {
  const direction = Object.keys(blocksByUser)[0];

  describe(`a block by ${direction}, seen from both sides`, () => {
    for (const { viewer, other, ownPost, otherPost } of PAIRS) {
      test(`${viewer}: every post list leaves out ${other}, before paging`, async (t) => {
        const server = await startServer({}, { dbFixture: socialFixture(blocksByUser) });
        t.after(() => server.stop());

        assert.deepEqual(idsOf(await call(server, 'GET', '/api/drinks', viewer)), [3, ownPost]);
        assert.deepEqual(idsOf(await call(server, 'GET', '/api/drinks?limit=1', viewer)), [3]);
        const paged = await call(server, 'GET', '/api/drinks?limit=1&before=3', viewer);
        assert.deepEqual(idsOf(paged), [ownPost], 'the second page is full');
        assert.equal(paged.body.nextCursor, null);
        assert.deepEqual(idsOf(await call(server, 'GET', '/api/drinks?city=cluj', viewer)), [3, ownPost]);
        assert.deepEqual(idsOf(await call(server, 'GET', `/api/drinks?q=${encodeURIComponent(`Post ${otherPost}`)}`, viewer)), []);
        assert.ok(!idsOf(await call(server, 'GET', '/api/drinks?sort=trending', viewer)).includes(otherPost));
        assert.deepEqual(idsOf(await call(server, 'GET', '/api/drinks/partners', viewer)), [3, ownPost]);
        const saved = await call(server, 'GET', `/api/users/${viewer}/saved-drinks`, viewer);
        assert.ok(!idsOf(saved).includes(otherPost));

        const owned = await call(server, 'GET', `/api/drinks/user/${other}`, viewer);
        assert.deepEqual(idsOf(owned), []);
        assert.equal(owned.body.total, 0, 'total counts only visible posts');
      });

      test(`${viewer}: the post of ${other} answers exactly like a post that does not exist`, async (t) => {
        const server = await startServer({}, { dbFixture: socialFixture(blocksByUser) });
        t.after(() => server.stop());

        const missing = await call(server, 'GET', '/api/drinks/999', viewer);
        const routes = [
          ['GET', `/api/drinks/${otherPost}`, undefined],
          ['GET', `/api/drinks/${otherPost}/comments`, undefined],
          ['POST', `/api/drinks/${otherPost}/comments`, { content: 'Hi' }],
          ['POST', `/api/drinks/${otherPost}/like`, undefined],
          ['POST', `/api/drinks/${otherPost}/save`, undefined],
          ['DELETE', `/api/drinks/${otherPost}`, undefined],
        ];
        for (const [method, route, body] of routes) {
          const res = await call(server, method, route, viewer, body);
          assert.equal(res.status, 404, `${method} ${route}`);
          assert.deepEqual(res.body, missing.body, `${method} ${route}`);
        }
        assert.equal((await report(server, viewer, 'drink', otherPost)).status, 404);
        assert.equal((await call(server, 'GET', `/api/drinks/${ownPost}`, viewer)).status, 200, 'their own post is untouched');

        const db = readDb(server);
        assert.equal(db.drinks.find((d) => d.id === otherPost).cheersCount, 0);
        assert.equal(db.notificationsByUser?.[other]?.length ?? 0, 0);
      });

      test(`${viewer}: the image of the other's post is the same 404 as a missing one, with an ETag too`, async (t) => {
        const server = await startServer({}, { dbFixture: socialFixture(blocksByUser) });
        t.after(() => server.stop());
        const auth = { Authorization: `Bearer ${tokenFor(viewer)}` };

        const carolImage = await fetch(`${server.baseUrl}/media/drinks/${otherPost}`, { headers: { Authorization: `Bearer ${tokenFor('carol')}` } });
        assert.equal(carolImage.status, 200);
        const etag = carolImage.headers.get('etag');

        const missing = await fetch(`${server.baseUrl}/media/drinks/999`, { headers: auth });
        const blocked = await fetch(`${server.baseUrl}/media/drinks/${otherPost}`, { headers: auth });
        assert.equal(blocked.status, 404);
        assert.deepEqual(await blocked.json(), await missing.json());
        assert.equal(blocked.headers.get('cache-control'), 'no-store');
        assert.equal(blocked.headers.get('etag'), missing.headers.get('etag'));
        assert.equal(blocked.headers.get('x-media-cache'), 'miss', 'the cached image was not read');
        assert.match(blocked.headers.get('vary'), /Authorization/i);

        // Not fetch: it adds Cache-Control: no-cache to a request with If-None-Match.
        const { hostname, port } = new URL(server.baseUrl);
        const revalidated = await new Promise((resolve, reject) => {
          const req = http.request({ hostname, port, path: `/media/drinks/${otherPost}`, headers: { ...auth, 'If-None-Match': etag } }, (res) => {
            res.resume();
            res.on('end', () => resolve(res));
          });
          req.on('error', reject);
          req.end();
        });
        assert.equal(revalidated.statusCode, 404, 'a device holding the ETag does not get a 304');
      });

      test(`${viewer}: profile, search and partner routes hide ${other}`, async (t) => {
        const server = await startServer({}, { dbFixture: socialFixture(blocksByUser) });
        t.after(() => server.stop());

        const missing = await call(server, 'GET', '/api/users/nobody', viewer);
        const profile = await call(server, 'GET', `/api/users/${other}`, viewer);
        assert.equal(profile.status, 404);
        assert.deepEqual(profile.body, missing.body);

        const search = await call(server, 'GET', `/api/users/search?q=${other}`, viewer);
        assert.deepEqual(search.body, []);
        assert.equal((await call(server, 'GET', '/api/users/search?q=carol', viewer)).body.length, 1);

        assert.equal((await call(server, 'GET', `/api/users/${other}/partners`, viewer)).status, 404);
        const carolsPartners = await call(server, 'GET', '/api/users/carol/partners', viewer);
        assert.ok(!carolsPartners.body.some((user) => user.id === other));
        const myPartners = await call(server, 'GET', '/api/drink-partners', viewer);
        assert.deepEqual(myPartners.body.map((user) => user.id), ['carol']);

        assert.equal((await call(server, 'POST', `/api/drink-partners/${other}`, viewer)).status, 404);
        assert.equal((await report(server, viewer, 'user', other)).status, 404);
      });

      test(`${viewer}: comments of ${other} disappear on a third user's post`, async (t) => {
        const server = await startServer({}, { dbFixture: socialFixture(blocksByUser) });
        t.after(() => server.stop());

        const commentsOfThird = await call(server, 'GET', '/api/drinks/3/comments', viewer);
        const ownCommentId = viewer === 'alice' ? 1 : 2;
        const otherCommentId = viewer === 'alice' ? 2 : 1;
        assert.deepEqual(idsOf(commentsOfThird), [3, ownCommentId]);
        const firstPage = await call(server, 'GET', '/api/drinks/3/comments?limit=2', viewer);
        assert.equal(firstPage.body.items.length, 2, 'filtered before paging');
        assert.equal(firstPage.body.nextCursor, null);
        assert.deepEqual(idsOf(await call(server, 'GET', '/api/drinks/3/comments', 'carol')), [3, 2, 1]);

        assert.equal((await report(server, viewer, 'comment', otherCommentId)).status, 404, 'the post owner is not blocked, the author is');
        assert.equal((await call(server, 'DELETE', `/api/drinks/3/comments/${otherCommentId}`, viewer)).status, 404);
        assert.equal(readDb(server).commentsByDrink[3].length, 3);
      });
    }

    test('a third user still sees both, and a logged-out reader sees nothing', async (t) => {
      const server = await startServer({}, { dbFixture: socialFixture(blocksByUser) });
      t.after(() => server.stop());
      assert.deepEqual(idsOf(await call(server, 'GET', '/api/drinks', 'carol')), [3, 2, 1]);
      assert.equal((await call(server, 'GET', '/api/users/alice', 'carol')).status, 200);
      assert.equal((await call(server, 'GET', '/api/drinks')).status, 401);
      assert.equal((await call(server, 'GET', '/api/users/alice')).status, 401);
    });
  });
}

describe('a block and the age gate', () => {
  const fixture = () => ({
    users: [person('owner'), minor('blocked-minor'), minor('other-minor'), person('blocked-adult')],
    drinks: [post(1, 'owner', { isAlcoholic: true }), post(2, 'owner', { isAlcoholic: false })],
    nextDrinkId: 3,
    blocksByUser: { owner: ['blocked-minor', 'blocked-adult'] },
  });

  // An unconfirmed user gets age_required on every route, before any block is looked at, so the answer
  // says nothing about a block either.
  test('a block answers 404 whatever the flag, and an unconfirmed user gets age_required everywhere', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());
    for (const id of [1, 2]) {
      for (const route of [`/api/drinks/${id}`, `/api/drinks/${id}/comments`, `/media/drinks/${id}`]) {
        const res = await call(server, 'GET', route, 'blocked-adult');
        assert.equal(res.status, 404, `blocked-adult ${route}`);
        assert.equal(res.body.code, undefined);
        for (const uid of ['blocked-minor', 'other-minor']) {
          const minorRes = await call(server, 'GET', route, uid);
          assert.equal(minorRes.status, 403, `${uid} ${route}`);
          assert.equal(minorRes.body.code, 'age_required', `${uid} ${route}`);
        }
      }
      assert.equal((await call(server, 'POST', `/api/drinks/${id}/like`, 'blocked-adult')).status, 404);
      assert.equal((await call(server, 'POST', `/api/drinks/${id}/like`, 'blocked-minor')).body.code, 'age_required');
    }
    assert.equal((await call(server, 'GET', '/api/drinks/1')).status, 401, 'logged out');
  });
});

describe('/api/blocks', () => {
  test('checks the caller and the target', async (t) => {
    const server = await startServer({}, { dbFixture: socialFixture() });
    t.after(() => server.stop());

    assert.equal((await call(server, 'GET', '/api/blocks')).status, 401);
    assert.equal((await call(server, 'POST', '/api/blocks/bob')).status, 401);
    assert.equal((await call(server, 'DELETE', '/api/blocks/bob')).status, 401);
    assert.equal((await call(server, 'POST', '/api/blocks/alice', 'alice')).status, 400);
    assert.equal((await call(server, 'POST', '/api/blocks/nobody', 'alice')).status, 404);
    assert.equal(readDb(server).blocksByUser?.alice, undefined);
  });

  test('a block ends the partnership both ways; an unblock restores visibility but not the partnership; both survive a restart', async (t) => {
    const server = await startServer({}, { dbFixture: socialFixture() });
    t.after(() => server.stop());

    const blocked = await call(server, 'POST', '/api/blocks/bob', 'alice');
    assert.equal(blocked.status, 200);
    assert.equal((await call(server, 'POST', '/api/blocks/bob', 'alice')).status, 200, 'idempotent');
    let db = readDb(server);
    assert.deepEqual(db.blocksByUser, { alice: ['bob'] });
    assert.deepEqual(db.partnersByUser.alice, ['carol']);
    assert.deepEqual(db.partnersByUser.bob, ['carol']);
    assert.deepEqual(db.partnersByUser.carol, ['alice', 'bob'], 'other partnerships stay');

    await server.restart();
    assert.equal((await call(server, 'GET', '/api/users/bob', 'alice')).status, 404, 'the block survives a restart');
    assert.equal((await call(server, 'GET', '/api/users/alice', 'bob')).status, 404);

    const list = await call(server, 'GET', '/api/blocks', 'alice');
    assert.deepEqual(list.body.map((user) => user.id), ['bob']);
    assert.ok(!list.text.includes('@example.test'), 'no email');
    assert.deepEqual((await call(server, 'GET', '/api/blocks', 'bob')).body, [], 'who blocked you is not shown');

    assert.equal((await call(server, 'DELETE', '/api/blocks/bob', 'bob')).status, 204, 'the other side cannot lift it, and nothing happens');
    assert.equal((await call(server, 'GET', '/api/users/bob', 'alice')).status, 404);

    assert.equal((await call(server, 'DELETE', '/api/blocks/bob', 'alice')).status, 204);
    assert.equal((await call(server, 'DELETE', '/api/blocks/bob', 'alice')).status, 204, 'idempotent');
    assert.equal((await call(server, 'GET', '/api/users/bob', 'alice')).status, 200);
    assert.equal((await call(server, 'GET', '/api/drinks/2', 'alice')).status, 200);
    db = readDb(server);
    assert.deepEqual(db.blocksByUser, {});
    assert.deepEqual(db.partnersByUser.alice, ['carol'], 'the partnership does not come back');
    assert.equal((await call(server, 'GET', '/api/drinks/2', 'alice')).body.isPartner, false);

    await server.restart();
    assert.equal((await call(server, 'GET', '/api/users/bob', 'alice')).status, 200);
  });

  test('at most 200 per user', async (t) => {
    const others = Array.from({ length: 201 }, (_, i) => `user${i}`);
    const server = await startServer({}, {
      dbFixture: { users: [person('alice'), ...others.map((id) => person(id))], blocksByUser: { alice: others.slice(0, 200) } },
    });
    t.after(() => server.stop());
    const res = await call(server, 'POST', '/api/blocks/user200', 'alice');
    assert.equal(res.status, 429);
    assert.equal(res.body.code, 'block_limit');
    assert.equal((await call(server, 'POST', '/api/blocks/user0', 'alice')).status, 200, 'a repeat is not refused');
    assert.equal((await call(server, 'DELETE', '/api/blocks/user0', 'alice')).status, 204);
    assert.equal((await call(server, 'POST', '/api/blocks/user200', 'alice')).status, 200);
  });

  test('a new block, a repeat and an unblock all stay open at the storage limit', async (t) => {
    const server = await startServer({ DB_GROWTH_MAX_BYTES: '1' }, { dbFixture: socialFixture({ alice: ['bob'] }) });
    t.after(() => server.stop());
    const growth = await call(server, 'POST', '/api/smart-bar', 'alice', { name: 'Gin', quantity: '1' });
    assert.equal(growth.status, 507, 'the limit is in force');
    assert.equal((await call(server, 'POST', '/api/blocks/carol', 'alice')).status, 200);
    assert.equal((await call(server, 'POST', '/api/blocks/bob', 'alice')).status, 200);
    assert.equal((await call(server, 'DELETE', '/api/blocks/bob', 'alice')).status, 204);
  });

  test('a failed save restores the block and the partnership', async (t) => {
    const server = await startServer(FAULT_ENV, { dbFixture: socialFixture() });
    t.after(() => server.stop());

    failSaves(server);
    assert.equal((await call(server, 'POST', '/api/blocks/bob', 'alice')).status, 503);
    allowSaves(server);
    assert.equal((await call(server, 'GET', '/api/users/bob', 'alice')).status, 200);
    assert.deepEqual((await call(server, 'GET', '/api/drink-partners', 'alice')).body.map((user) => user.id), ['bob', 'carol'], 'same order');
    assert.deepEqual((await call(server, 'GET', '/api/blocks', 'alice')).body, []);

    assert.equal((await call(server, 'POST', '/api/blocks/bob', 'alice')).status, 200);
    failSaves(server);
    assert.equal((await call(server, 'DELETE', '/api/blocks/bob', 'alice')).status, 503);
    allowSaves(server);
    assert.equal((await call(server, 'GET', '/api/users/bob', 'alice')).status, 404, 'the failed unblock left the block');
  });
});

describe('notifications and blocks', () => {
  test('nothing is sent across a block, older ones hide on read, and an unblock brings them back', async (t) => {
    const legacy = { id: 90, type: 'partner', message: 'Legacy text', read: false, createdAt: new Date().toISOString() };
    const server = await startServer({}, {
      dbFixture: { ...socialFixture(), notificationsByUser: { bob: [legacy] }, nextNotificationId: 91, partnersByUser: {} },
    });
    t.after(() => server.stop());

    assert.equal((await call(server, 'POST', '/api/drinks/2/like', 'carol')).status, 200);
    assert.equal((await call(server, 'POST', '/api/drinks/2/comments', 'carol', { content: 'Hi' })).status, 201);
    assert.equal((await call(server, 'POST', '/api/drink-partners/bob', 'carol')).status, 200);
    const before = await call(server, 'GET', '/api/notifications', 'bob');
    assert.equal(before.body.notifications.length, 4);
    assert.equal(before.body.unreadCount, 4);
    assert.ok(!before.text.includes('actorId'), 'stays internal');
    assert.equal(readDb(server).notificationsByUser.bob[0].actorId, 'carol');

    assert.equal((await call(server, 'POST', '/api/blocks/carol', 'bob')).status, 200);
    const hidden = await call(server, 'GET', '/api/notifications', 'bob');
    assert.deepEqual(hidden.body.notifications.map((n) => n.id), [90], 'one with no recorded actor stays');
    assert.equal(hidden.body.unreadCount, 1);

    const countBefore = readDb(server).notificationsByUser.bob.length;
    assert.equal((await call(server, 'POST', '/api/drinks/2/like', 'carol')).status, 404);
    assert.equal(readDb(server).notificationsByUser.bob.length, countBefore);

    assert.equal((await call(server, 'DELETE', '/api/blocks/carol', 'bob')).status, 204);
    assert.equal((await call(server, 'GET', '/api/notifications', 'bob')).body.notifications.length, 4);
  });
});

describe('POST /api/reports', () => {
  const reportFixture = (extra = {}) => ({
    users: [person('reporter'), person('owner'), person('author'), minor('young')],
    drinks: [post(1, 'owner'), post(2, 'reporter'), post(3, 'owner', { isAlcoholic: true })],
    nextDrinkId: 4,
    commentsByDrink: { 1: [commentOf(1, 1, 'author'), commentOf(2, 1, 'reporter')], 3: [commentOf(3, 3, 'author')] },
    nextCommentId: 4,
    ...extra,
  });

  test('refuses bad input with 400, and logged out with 401', async (t) => {
    const server = await startServer({}, { dbFixture: reportFixture() });
    t.after(() => server.stop());

    assert.equal((await report(server, undefined, 'drink', 1)).status, 401);
    const bad = [
      {}, [], { targetType: 'drink', targetId: 1 }, { targetType: 'drink', reason: 'spam' }, { targetType: 'post', targetId: 1, reason: 'spam' },
      { targetType: ['drink'], targetId: 1, reason: 'spam' }, { targetType: 'drink', targetId: 1, reason: 'rude' },
      { targetType: 'drink', targetId: 1, reason: '__proto__' }, { targetType: 'drink', targetId: 1, reason: 'spam', details: 5 },
      { targetType: 'drink', targetId: 'abc', reason: 'spam' }, { targetType: 'drink', targetId: '1e0', reason: 'spam' },
      { targetType: 'drink', targetId: 1.5, reason: 'spam' }, { targetType: 'drink', targetId: 0, reason: 'spam' },
      { targetType: 'drink', targetId: -1, reason: 'spam' }, { targetType: 'drink', targetId: true, reason: 'spam' },
      { targetType: 'comment', targetId: ['1'], reason: 'spam' }, { targetType: 'user', targetId: 7, reason: 'spam' },
      { targetType: 'user', targetId: '', reason: 'spam' },
    ];
    for (const body of bad) {
      assert.equal((await call(server, 'POST', '/api/reports', 'reporter', body)).status, 400, JSON.stringify(body));
    }
    assert.equal(readDb(server).reports?.length ?? 0, 0);
  });

  test('refuses your own content with 400 and anything not visible with 404', async (t) => {
    const server = await startServer({}, { dbFixture: reportFixture({ blocksByUser: { author: ['blocked-viewer'] }, users: [...reportFixture().users, person('blocked-viewer')] }) });
    t.after(() => server.stop());

    assert.equal((await report(server, 'reporter', 'drink', 2)).status, 400);
    assert.equal((await report(server, 'reporter', 'comment', 2)).status, 400);
    assert.equal((await report(server, 'reporter', 'user', 'reporter')).status, 400);
    assert.equal((await report(server, 'reporter', 'drink', 999)).status, 404);
    assert.equal((await report(server, 'reporter', 'comment', 999)).status, 404);
    assert.equal((await report(server, 'reporter', 'user', 'nobody')).status, 404);
    // An unconfirmed user cannot report at all, so nothing tells them what exists.
    for (const [type, id] of [['drink', 3], ['comment', 3], ['drink', 1], ['user', 'owner']]) {
      assert.equal((await report(server, 'young', type, id)).body.code, 'age_required', `${type} ${id}`);
    }
    // Blocked: the author only, while the post's owner is not.
    assert.equal((await report(server, 'blocked-viewer', 'comment', 1)).status, 404);
    assert.equal((await report(server, 'blocked-viewer', 'drink', 1)).status, 201);
  });

  test('stores a sanitized report and answers with its id only; a repeat is 200; both survive a restart', async (t) => {
    const server = await startServer({}, { dbFixture: reportFixture() });
    t.after(() => server.stop());

    const details = `  Bad\u0007 ${'x'.repeat(400)}`;
    const created = await report(server, 'reporter', 'drink', 1, 'dangerous_drinking', { details });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body, { id: 1 });

    const [stored] = readDb(server).reports;
    assert.equal(stored.reporterId, 'reporter');
    assert.equal(stored.targetType, 'drink');
    assert.equal(stored.targetId, 1);
    assert.equal(stored.reason, 'dangerous_drinking');
    assert.equal(stored.status, 'open');
    assert.equal(stored.details.length, 300);
    assert.ok(stored.details.startsWith('Bad '), 'trimmed, with the control character removed');

    const repeat = await report(server, 'reporter', 'drink', '1', 'other');
    assert.equal(repeat.status, 200, 'digits name the same post');
    assert.deepEqual(repeat.body, { id: 1 });
    assert.equal(readDb(server).reports.length, 1);

    assert.equal((await report(server, 'author', 'drink', 1)).status, 201, 'another reporter counts on their own');
    assert.equal((await report(server, 'reporter', 'comment', 1)).status, 201);
    assert.equal((await report(server, 'reporter', 'user', 'owner', 'other', { details: '   ' })).status, 201);
    assert.equal(readDb(server).reports[3].details, null);

    await server.restart();
    assert.equal(readDb(server).nextReportId, 5);
    assert.equal((await report(server, 'reporter', 'drink', 1)).status, 200, 'still a repeat');
    assert.deepEqual((await report(server, 'reporter', 'user', 'author')).body, { id: 5 }, 'ids are not reused');
  });

  test('reports stay out of every other response', async (t) => {
    const server = await startServer({}, { dbFixture: reportFixture() });
    t.after(() => server.stop());
    await report(server, 'reporter', 'drink', 1, 'spam', { details: 'SECRET-DETAILS' });
    for (const uid of ['owner', 'reporter', undefined]) {
      for (const route of ['/api/drinks/1', '/api/drinks', '/api/users/owner', '/api/drinks/user/owner']) {
        const res = await call(server, 'GET', route, uid);
        assert.ok(!res.text.includes('SECRET-DETAILS'), route);
        assert.ok(!res.text.includes('reporterId'), route);
      }
    }
    assert.ok(!(await call(server, 'GET', '/api/notifications', 'owner')).text.includes('report'));
  });

  test('20 per user per 24 hours, counting only the window', async (t) => {
    const reports = [
      ...Array.from({ length: 19 }, (_, i) => ({ id: i + 1, reporterId: 'reporter', targetType: 'drink', targetId: 100 + i, reason: 'spam', details: null, status: 'open', createdAt: ago(1) })),
      { id: 20, reporterId: 'reporter', targetType: 'drink', targetId: 1, reason: 'spam', details: null, status: 'open', createdAt: ago(25) },
    ];
    const server = await startServer({}, { dbFixture: reportFixture({ reports, nextReportId: 21 }) });
    t.after(() => server.stop());

    assert.equal((await report(server, 'reporter', 'comment', 1)).status, 201, 'the 20th inside the window');
    const blocked = await report(server, 'reporter', 'user', 'owner');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'daily_report_limit');
    assert.equal((await report(server, 'reporter', 'drink', 1)).status, 200, 'a repeat is not refused');
    assert.equal((await report(server, 'author', 'user', 'owner')).status, 201, 'other users are not counted');
  });

  test('the growth guard refuses a new report, and a repeat still answers', async (t) => {
    const server = await startServer({ DB_GROWTH_MAX_BYTES: '1' }, {
      dbFixture: reportFixture({ reports: [{ id: 1, reporterId: 'reporter', targetType: 'drink', targetId: 1, reason: 'spam', details: null, status: 'open', createdAt: ago(1) }], nextReportId: 2 }),
    });
    t.after(() => server.stop());
    const refused = await report(server, 'reporter', 'user', 'owner');
    assert.equal(refused.status, 507);
    assert.equal(refused.body.code, 'storage_full');
    assert.equal((await report(server, 'reporter', 'drink', 1)).status, 200);
  });

  test('a failed save rolls back the report and its id', async (t) => {
    const server = await startServer(FAULT_ENV, { dbFixture: reportFixture() });
    t.after(() => server.stop());
    failSaves(server);
    assert.equal((await report(server, 'reporter', 'drink', 1)).status, 503);
    allowSaves(server);
    const created = await report(server, 'reporter', 'drink', 1);
    assert.equal(created.status, 201, 'not taken for a repeat');
    assert.deepEqual(created.body, { id: 1 });
  });

  test('a file from before these keys loads and works', async (t) => {
    const server = await startServer({}, { dbFixture: { users: [person('reporter'), person('owner')], drinks: [post(1, 'owner')], nextDrinkId: 2 } });
    t.after(() => server.stop());
    assert.equal((await report(server, 'reporter', 'drink', 1)).body.id, 1);
    assert.equal((await call(server, 'POST', '/api/blocks/owner', 'reporter')).status, 200);
    const db = readDb(server);
    assert.equal(db.nextReportId, 2);
    assert.deepEqual(db.blocksByUser, { reporter: ['owner'] });
  });

  test('the counter stays ahead of stored reports when its key is missing', async (t) => {
    const stored = { id: 7, reporterId: 'owner', targetType: 'user', targetId: 'reporter', reason: 'spam', details: null, status: 'open', createdAt: ago(1) };
    const server = await startServer({}, { dbFixture: { users: [person('reporter'), person('owner')], reports: [stored] } });
    t.after(() => server.stop());
    assert.equal((await report(server, 'reporter', 'user', 'owner')).body.id, 8);
  });

  for (const [key, value] of [['reports', 'x'], ['reports', [1]], ['nextReportId', '1'], ['blocksByUser', { alice: 'x' }]]) {
    test(`a ${key} of the wrong shape counts as a corrupt database`, async (t) => {
      const server = await startServer({}, { dbFixture: { users: [person('alice')], [key]: value } });
      t.after(() => server.stop());
      // alice's own JWT finds no account: the database started empty.
      assert.equal((await call(server, 'GET', '/api/users/alice', 'alice')).status, 401, 'started empty');
    });
  }
});

describe('DELETE /api/drinks/:id/comments/:commentId', () => {
  const route = (drinkId, commentId) => `/api/drinks/${drinkId}/comments/${commentId}`;
  const fixture = (extra = {}) => ({
    users: [person('owner'), person('author'), person('stranger'), minor('young')],
    drinks: [post(1, 'owner'), post(2, 'owner'), post(3, 'owner', { isAlcoholic: true })],
    nextDrinkId: 4,
    commentsByDrink: {
      1: [commentOf(1, 1, 'author'), commentOf(2, 1, 'author'), commentOf(3, 1, 'stranger')],
      2: [commentOf(4, 2, 'author')],
      3: [commentOf(5, 3, 'young')],
    },
    nextCommentId: 6,
    limitEventsByUser: {},
    ...extra,
  });

  test('the author and the post owner get 204; others get 401, 403 or 404', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    assert.equal((await call(server, 'DELETE', route(1, 1))).status, 401);
    assert.equal((await call(server, 'DELETE', route(1, 1), 'stranger')).status, 403);
    assert.equal((await call(server, 'DELETE', route(1, 999), 'owner')).status, 404);
    assert.equal((await call(server, 'DELETE', route(999, 1), 'owner')).status, 404);
    assert.equal((await call(server, 'DELETE', route(2, 1), 'owner')).status, 404, 'a comment of another post');
    for (const badId of ['abc', '1e0', '01', '-1']) {
      assert.equal((await call(server, 'DELETE', route(1, badId), 'owner')).status, 404, badId);
    }
    assert.equal(readDb(server).commentsByDrink[1].length, 3);

    const byAuthor = await call(server, 'DELETE', route(1, 1), 'author');
    assert.equal(byAuthor.status, 204);
    assert.equal(byAuthor.text, '');
    assert.equal((await call(server, 'DELETE', route(1, 2), 'owner')).status, 204);
    assert.equal((await call(server, 'DELETE', route(1, 1), 'author')).status, 404, 'already gone');

    assert.deepEqual(idsOf(await call(server, 'GET', '/api/drinks/1/comments', 'owner')), [3]);
    await server.restart();
    assert.deepEqual(idsOf(await call(server, 'GET', '/api/drinks/1/comments', 'owner')), [3]);
  });

  // Owner decision: before the 18+ confirmation nothing but the first-run steps works, so removing
  // their own comment waits for it too.
  test('the age gate: an unconfirmed user gets 403 age_required, even for their own comment', async (t) => {
    const server = await startServer({}, { dbFixture: fixture({ commentsByDrink: { 3: [commentOf(5, 3, 'young'), commentOf(6, 3, 'author')] } }) });
    t.after(() => server.stop());
    assert.equal((await call(server, 'DELETE', route(3, 6), 'young')).body.code, 'age_required');
    assert.equal((await call(server, 'DELETE', route(3, 999), 'young')).body.code, 'age_required', 'no way to test for a comment');
    assert.equal((await call(server, 'DELETE', route(3, 5), 'young')).body.code, 'age_required');
    assert.equal(readDb(server).commentsByDrink[3].length, 2);
  });

  test('a blocked author and a post owner can still remove what they wrote or hold', async (t) => {
    const server = await startServer({}, { dbFixture: fixture({ blocksByUser: { owner: ['author'] } }) });
    t.after(() => server.stop());
    assert.equal((await call(server, 'GET', '/api/drinks/1/comments', 'author')).status, 404);
    assert.equal((await call(server, 'DELETE', route(1, 1), 'author')).status, 204);
    assert.equal((await call(server, 'DELETE', route(1, 2), 'owner')).status, 204);
  });

  test('removing comments never shrinks the limit events, so the daily limit stays', async (t) => {
    const events = Array.from({ length: 200 }, () => ({ kind: 'comment', at: ago(1) }));
    const comments = Array.from({ length: 5 }, (_, i) => commentOf(i + 1, 1, 'author', { createdAt: ago(1) }));
    const server = await startServer({}, {
      dbFixture: fixture({ commentsByDrink: { 1: comments }, limitEventsByUser: { author: events } }),
    });
    t.after(() => server.stop());

    for (const id of [1, 2, 3]) assert.equal((await call(server, 'DELETE', route(1, id), 'author')).status, 204);
    assert.equal(readDb(server).limitEventsByUser.author.length, 200);
    const blocked = await call(server, 'POST', '/api/drinks/1/comments', 'author', { content: 'Again' });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'daily_comment_limit');

    await server.restart();
    assert.equal((await call(server, 'POST', '/api/drinks/1/comments', 'author', { content: 'Again' })).status, 429);
  });

  test('a legacy file is seeded before the removal is saved, so the removal gives nothing back', async (t) => {
    const comments = Array.from({ length: 200 }, (_, i) => commentOf(i + 1, 1, 'author', { createdAt: ago(1) }));
    const { limitEventsByUser, ...legacy } = fixture({ commentsByDrink: { 1: comments }, nextCommentId: 300 });
    const server = await startServer({}, { dbFixture: legacy });
    t.after(() => server.stop());

    assert.equal((await call(server, 'DELETE', route(1, 1), 'author')).status, 204);
    assert.equal(readDb(server).limitEventsByUser.author.length, 200);
    await server.restart();
    assert.equal((await call(server, 'POST', '/api/drinks/1/comments', 'author', { content: 'Again' })).status, 429);
  });

  test('works at the storage limit, where a new comment does not', async (t) => {
    const server = await startServer({ DB_GROWTH_MAX_BYTES: '1' }, { dbFixture: fixture() });
    t.after(() => server.stop());
    assert.equal((await call(server, 'POST', '/api/drinks/1/comments', 'author', { content: 'Hi' })).status, 507);
    assert.equal((await call(server, 'DELETE', route(1, 1), 'author')).status, 204);
  });

  test('a failed save puts the comment back in its place', async (t) => {
    const server = await startServer(FAULT_ENV, { dbFixture: fixture() });
    t.after(() => server.stop());
    const before = readDb(server);
    failSaves(server);
    assert.equal((await call(server, 'DELETE', route(1, 2), 'author')).status, 503);
    allowSaves(server);
    assert.deepEqual(idsOf(await call(server, 'GET', '/api/drinks/1/comments', 'owner')), [3, 2, 1]);
    assert.equal((await call(server, 'POST', '/api/notifications/read', 'owner')).status, 200);
    assert.deepEqual(readDb(server).commentsByDrink, before.commentsByDrink, 'the same order in the file');
  });
});

describe('admin routes', () => {
  const ADMIN_ENV = { ADMIN_USER_IDS: ' admin , second-admin ,,' };
  const open = (id, reporterId, targetType, targetId, extra = {}) => ({
    id, reporterId, targetType, targetId, reason: 'spam', details: `Details ${id}`, status: 'open', createdAt: ago(1), ...extra,
  });
  const fixture = (extra = {}) => ({
    users: [person('admin'), person('second-admin'), person('owner'), person('author'), person('r1'), person('r2')],
    drinks: [post(1, 'owner', { cheersCount: 1 }), post(2, 'owner')],
    nextDrinkId: 3,
    commentsByDrink: { 1: [commentOf(1, 1, 'author')], 2: [commentOf(2, 2, 'author'), commentOf(3, 2, 'author')] },
    nextCommentId: 4,
    cheersByUser: { r1: [1] },
    savedByUser: { r1: [1] },
    reports: [
      open(1, 'r1', 'drink', 1),
      open(2, 'r2', 'drink', 1),
      open(3, 'r1', 'drink', 2),
      open(4, 'r1', 'comment', 2, { drinkId: 2 }),
      open(5, 'r2', 'comment', 2, { drinkId: 2 }),
      open(6, 'r1', 'user', 'author'),
    ],
    nextReportId: 7,
    ...extra,
  });
  const resolve = (server, id, action, uid = 'admin') => call(server, 'POST', `/api/admin/reports/${id}/resolve`, uid, { action });

  test('an empty or missing list means 403 for everyone', async () => {
    for (const env of [{}, { ADMIN_USER_IDS: '' }, { ADMIN_USER_IDS: ' , ' }]) {
      const server = await startServer(env, { dbFixture: fixture() });
      try {
        for (const uid of ['admin', 'owner']) {
          assert.equal((await call(server, 'GET', '/api/admin/reports', uid)).status, 403);
          assert.equal((await resolve(server, 1, 'dismiss', uid)).status, 403);
        }
        assert.equal(readDb(server).reports[0].status, 'open');
      } finally {
        await server.stop();
      }
    }
  });

  test('checks the caller, and trims the list', async (t) => {
    const server = await startServer(ADMIN_ENV, { dbFixture: fixture() });
    t.after(() => server.stop());
    assert.equal((await call(server, 'GET', '/api/admin/reports')).status, 401);
    assert.equal((await resolve(server, 1, 'dismiss', null)).status, 401);
    assert.equal((await call(server, 'GET', '/api/admin/reports', 'owner')).status, 403);
    assert.equal((await resolve(server, 1, 'dismiss', 'owner')).status, 403);
    assert.equal((await resolve(server, 999, 'dismiss', 'owner')).status, 403, 'not an answer about the report');
    assert.equal((await call(server, 'GET', '/api/admin/reports', 'admin')).status, 200);
    assert.equal((await call(server, 'GET', '/api/admin/reports', 'second-admin')).status, 200);
  });

  test('lists reports with reporter, details and target, and no email', async (t) => {
    const server = await startServer(ADMIN_ENV, { dbFixture: fixture() });
    t.after(() => server.stop());

    const res = await call(server, 'GET', '/api/admin/reports?status=open', 'admin');
    assert.equal(res.status, 200);
    assert.deepEqual(idsOf(res), [1, 2, 3, 4, 5, 6]);
    assert.equal(res.body.total, 6);
    assert.ok(!res.text.includes('@example.test'), 'no email of anyone');
    const [first] = res.body.items;
    assert.equal(first.reporterId, 'r1');
    assert.equal(first.details, 'Details 1');
    assert.equal(first.target.name, 'Post 1');
    assert.equal(first.target.imageUrl, '/media/drinks/1');
    assert.equal(first.target.user.id, 'owner');
    assert.equal(res.body.items[3].target.content, 'Comment 2');
    assert.equal(res.body.items[3].target.drinkId, 2);
    assert.equal(res.body.items[5].target.id, 'author');

    assert.deepEqual(idsOf(await call(server, 'GET', '/api/admin/reports', 'admin')), [1, 2, 3, 4, 5, 6], 'open by default');
    assert.deepEqual(idsOf(await call(server, 'GET', '/api/admin/reports?status=resolved', 'admin')), []);
    assert.equal((await call(server, 'GET', '/api/admin/reports?status=all', 'admin')).status, 400);
    assert.equal((await call(server, 'GET', '/api/admin/reports?status=open&status=resolved', 'admin')).status, 400);
  });

  test('returns at most 100, oldest first, with the full count', async (t) => {
    const reports = Array.from({ length: 105 }, (_, i) => open(i + 1, 'r1', 'user', `target${i}`));
    const server = await startServer(ADMIN_ENV, { dbFixture: fixture({ reports, nextReportId: 106 }) });
    t.after(() => server.stop());
    const res = await call(server, 'GET', '/api/admin/reports', 'admin');
    assert.equal(res.body.items.length, 100);
    assert.equal(res.body.total, 105);
    assert.equal(res.body.items[0].id, 1);
    assert.equal(res.body.items[0].target, null, 'a target that no longer exists');
  });

  test('checks the report and the action', async (t) => {
    const server = await startServer(ADMIN_ENV, { dbFixture: fixture() });
    t.after(() => server.stop());
    assert.equal((await resolve(server, 999, 'dismiss')).status, 404);
    assert.equal((await resolve(server, 'abc', 'dismiss')).status, 404);
    assert.equal((await resolve(server, 1, 'delete')).status, 400);
    assert.equal((await resolve(server, 1, undefined)).status, 400);
    assert.equal((await resolve(server, 6, 'remove_content')).status, 400, 'a user target');
    assert.equal(readDb(server).reports[5].status, 'open');
  });

  test('dismiss keeps the content and resolves sibling reports only', async (t) => {
    const server = await startServer(ADMIN_ENV, { dbFixture: fixture() });
    t.after(() => server.stop());

    const res = await resolve(server, 1, 'dismiss');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'resolved');
    assert.equal(res.body.action, 'dismiss');
    assert.equal(res.body.resolvedBy, 'admin');
    assert.ok(!res.text.includes('@example.test'));

    const db = readDb(server);
    assert.deepEqual(db.reports.map((r) => r.status), ['resolved', 'resolved', 'open', 'open', 'open', 'open']);
    assert.equal(db.drinks.length, 2);
    assert.deepEqual(idsOf(await call(server, 'GET', '/api/admin/reports?status=resolved', 'admin')), [1, 2]);
    assert.equal((await resolve(server, 2, 'dismiss')).status, 409, 'already resolved');
    assert.equal((await resolve(server, 6, 'dismiss')).status, 200, 'a user target can be dismissed');

    await server.restart();
    assert.deepEqual(idsOf(await call(server, 'GET', '/api/admin/reports', 'admin')), [3, 4, 5]);
  });

  test('remove_content deletes a post with its cascade, and resolves sibling reports', async (t) => {
    const server = await startServer(ADMIN_ENV, { dbFixture: fixture() });
    t.after(() => server.stop());
    const res = await resolve(server, 2, 'remove_content');
    assert.equal(res.status, 200);
    assert.equal(res.body.target, null);

    const db = readDb(server);
    assert.deepEqual(db.drinks.map((d) => d.id), [2]);
    assert.equal(db.commentsByDrink[1], undefined);
    assert.deepEqual(db.cheersByUser.r1, []);
    assert.deepEqual(db.savedByUser.r1, []);
    assert.deepEqual(db.reports.map((r) => r.status), ['resolved', 'resolved', 'open', 'open', 'open', 'open']);
    assert.equal((await call(server, 'GET', '/api/drinks/1', 'r1')).status, 404);
    assert.equal((await call(server, 'GET', '/media/drinks/1', 'r1')).status, 404);
  });

  test('remove_content deletes one comment, and the author keeps their limit events', async (t) => {
    const server = await startServer(ADMIN_ENV, {
      dbFixture: fixture({ limitEventsByUser: { author: [{ kind: 'comment', at: ago(1) }] } }),
    });
    t.after(() => server.stop());
    assert.equal((await resolve(server, 4, 'remove_content')).status, 200);
    const db = readDb(server);
    assert.deepEqual(db.commentsByDrink[2].map((c) => c.id), [3]);
    assert.equal(db.reports[4].status, 'resolved');
    assert.equal(db.limitEventsByUser.author.length, 1);
    assert.equal(db.drinks.length, 2);
  });

  test('remove_content on a target already gone still resolves the report', async (t) => {
    const server = await startServer(ADMIN_ENV, { dbFixture: fixture() });
    t.after(() => server.stop());
    assert.equal((await call(server, 'DELETE', '/api/drinks/1', 'owner')).status, 204);
    assert.equal((await resolve(server, 1, 'remove_content')).status, 200);
    assert.equal((await call(server, 'DELETE', '/api/drinks/2/comments/2', 'author')).status, 204);
    assert.equal((await resolve(server, 4, 'remove_content')).status, 200);
  });

  test('a failed save restores the content and the reports', async (t) => {
    const server = await startServer({ ...ADMIN_ENV, ...FAULT_ENV }, { dbFixture: fixture() });
    t.after(() => server.stop());
    const before = readDb(server);

    failSaves(server);
    assert.equal((await resolve(server, 1, 'remove_content')).status, 503);
    assert.equal((await resolve(server, 4, 'remove_content')).status, 503);
    assert.equal((await resolve(server, 6, 'dismiss')).status, 503);
    allowSaves(server);

    assert.equal((await call(server, 'GET', '/api/drinks/1', 'r1')).body.isSaved, true);
    assert.deepEqual(idsOf(await call(server, 'GET', '/api/admin/reports', 'admin')), [1, 2, 3, 4, 5, 6]);
    assert.equal((await call(server, 'POST', '/api/notifications/read', 'owner')).status, 200);
    const after = readDb(server);
    for (const key of ['drinks', 'commentsByDrink', 'cheersByUser', 'savedByUser', 'reports']) {
      assert.deepEqual(after[key], before[key], key);
    }
  });

  test('works at the storage limit', async (t) => {
    const server = await startServer({ ...ADMIN_ENV, DB_GROWTH_MAX_BYTES: '1' }, { dbFixture: fixture() });
    t.after(() => server.stop());
    assert.equal((await resolve(server, 1, 'remove_content')).status, 200);
  });
});

describe('T2-3 fix pass', () => {
  const ADMIN_ENV = { ADMIN_USER_IDS: 'admin' };
  const resolve = (server, id, action) => call(server, 'POST', `/api/admin/reports/${id}/resolve`, 'admin', { action });
  const openReport = (id, reporterId, targetType, targetId, extra = {}) => ({
    id, reporterId, targetType, targetId, reason: 'spam', details: `Details ${id}`, status: 'open', createdAt: ago(1), ...extra,
  });
  const profileFixture = (extra = {}) => ({
    users: [
      person('admin'), person('r1'), person('r2'),
      person('target', { bio: 'Bad bio', city: 'Cluj', avatar: IMAGE, lastName: 'Bad' }),
    ],
    reports: [openReport(1, 'r1', 'user', 'target'), openReport(2, 'r2', 'user', 'target'), openReport(3, 'r1', 'user', 'r2')],
    nextReportId: 4,
    ...extra,
  });

  test('a report can be filed again once the earlier one is resolved', async (t) => {
    const server = await startServer(ADMIN_ENV, { dbFixture: profileFixture() });
    t.after(() => server.stop());
    assert.deepEqual((await report(server, 'r1', 'user', 'target')).body, { id: 1 }, 'still open: a repeat');
    assert.equal((await resolve(server, 1, 'dismiss')).status, 200);
    const again = await report(server, 'r1', 'user', 'target');
    assert.equal(again.status, 201);
    assert.deepEqual(again.body, { id: 4 });
    assert.equal((await report(server, 'r1', 'user', 'target')).status, 200, 'the new one is open');
  });

  describe('an admin reviewing an image', () => {
    const mediaFixture = () => ({
      users: [person('admin'), person('poster'), person('blocked-user')],
      drinks: [post(1, 'poster'), post(2, 'poster', { isAlcoholic: true })],
      nextDrinkId: 3,
      blocksByUser: { poster: ['admin', 'blocked-user'] },
    });
    const media = (server, id, uid) => fetch(`${server.baseUrl}/media/drinks/${id}`, { headers: { Authorization: `Bearer ${tokenFor(uid)}` } });

    test('a poster who blocks the admin does not hide the image, and the answer is not stored', async (t) => {
      const server = await startServer(ADMIN_ENV, { dbFixture: mediaFixture() });
      t.after(() => server.stop());
      const image = await media(server, 1, 'admin');
      assert.equal(image.status, 200);
      assert.equal(image.headers.get('cache-control'), 'no-store');
      assert.equal((await media(server, 1, 'blocked-user')).status, 404, 'nobody else is exempt');
      assert.equal((await call(server, 'GET', '/api/drinks/1', 'admin')).status, 404, 'media only');
    });

    // The sign-in and age gate in front of every route applies to admins too.
    test('an admin who has not confirmed their age gets age_required, like everyone', async (t) => {
      const fixture = { ...mediaFixture(), users: [minor('admin'), person('poster')], blocksByUser: {} };
      const server = await startServer(ADMIN_ENV, { dbFixture: fixture });
      t.after(() => server.stop());
      for (const id of [1, 2]) {
        const image = await media(server, id, 'admin');
        assert.equal(image.status, 403);
        assert.equal(image.headers.get('cache-control'), 'no-store');
      }
      assert.equal((await call(server, 'GET', '/api/admin/reports', 'admin')).body.code, 'age_required');
    });

    test('a confirmed admin sees an alcoholic post\'s image with no exemption used', async (t) => {
      const fixture = { ...mediaFixture(), blocksByUser: {} };
      const server = await startServer(ADMIN_ENV, { dbFixture: fixture });
      t.after(() => server.stop());
      const image = await media(server, 2, 'admin');
      assert.equal(image.status, 200);
      assert.equal(image.headers.get('cache-control'), 'private, max-age=86400');
    });

    test('without the env list the same user is refused', async (t) => {
      const server = await startServer({}, { dbFixture: mediaFixture() });
      t.after(() => server.stop());
      assert.equal((await media(server, 1, 'admin')).status, 404);
    });
  });

  describe('clear_profile', () => {
    test('blanks name, bio and avatar, keeps the rest, resolves sibling reports only', async (t) => {
      const server = await startServer(ADMIN_ENV, { dbFixture: profileFixture() });
      t.after(() => server.stop());
      assert.equal((await fetch(`${server.baseUrl}/media/avatars/target`, { headers: { Authorization: `Bearer ${tokenFor('r1')}` } })).status, 200);

      const res = await resolve(server, 1, 'clear_profile');
      assert.equal(res.status, 200);
      assert.equal(res.body.removed, true);
      assert.ok(!res.text.includes('@example.test'));

      const check = async () => {
        const db = readDb(server);
        const stored = db.users.find((u) => u.id === 'target');
        assert.equal(stored.firstName, '');
        assert.equal(stored.lastName, '');
        assert.equal(stored.bio, '');
        assert.equal(stored.avatar, null);
        assert.equal(stored.city, 'Cluj');
        assert.equal(stored.email, 'target@example.test');
        assert.deepEqual(db.reports.map((r) => r.status), ['resolved', 'resolved', 'open']);
        const publicView = await call(server, 'GET', '/api/users/target', 'r1');
        assert.equal(publicView.status, 200, 'not suspended');
        assert.equal(publicView.body.avatar, null);
        assert.ok(!publicView.text.includes('avatarClearedByAdmin'));
        assert.equal((await fetch(`${server.baseUrl}/media/avatars/target`, { headers: { Authorization: `Bearer ${tokenFor('r1')}` } })).status, 404);
      };
      await check();
      await server.restart();
      await check();
    });

    test('a masked name stays out of public view, and a later name is public', async (t) => {
      const legacy = person('target', { firstName: 'target', nameSetByUser: undefined });
      const server = await startServer(ADMIN_ENV, { dbFixture: profileFixture({ users: [person('admin'), person('r1'), person('r2'), legacy] }) });
      t.after(() => server.stop());
      assert.equal((await resolve(server, 1, 'clear_profile')).status, 200);
      assert.ok(!(await call(server, 'GET', '/api/users/target', 'r1')).text.includes('"firstName":"target"'));
      assert.equal((await call(server, 'PUT', '/api/users/target', 'target', { firstName: 'Tudor' })).status, 200);
      assert.equal((await call(server, 'GET', '/api/users/target', 'r1')).body.firstName, 'Tudor');
    });

    test('signing in again brings back neither the name nor a provider photo', async (t) => {
      const server = await startServer(ADMIN_ENV, { dbFixture: profileFixture() });
      t.after(() => server.stop());
      assert.equal((await resolve(server, 1, 'clear_profile')).status, 200);
      const signIn = await call(server, 'POST', '/api/auth/mobile', null, {
        idToken: 'dev', uid: 'target', displayName: 'Bad Name', photoURL: 'https://lh3.googleusercontent.com/a/photo',
      });
      assert.equal(signIn.status, 200);
      const stored = readDb(server).users.find((u) => u.id === 'target');
      assert.equal(stored.firstName, '');
      assert.equal(stored.avatar, null);
      const uploaded = await call(server, 'POST', '/api/users/target/avatar', 'target', { imageData: PNG.toString('base64') });
      assert.equal(uploaded.status, 200, 'the user can still upload one');
    });

    test('is refused on other targets, and remove_content on a user stays 400', async (t) => {
      const fixture = profileFixture({
        drinks: [post(1, 'target')],
        nextDrinkId: 2,
        reports: [openReport(1, 'r1', 'user', 'target'), openReport(2, 'r1', 'drink', 1)],
      });
      const server = await startServer(ADMIN_ENV, { dbFixture: fixture });
      t.after(() => server.stop());
      assert.equal((await resolve(server, 2, 'clear_profile')).status, 400);
      assert.equal((await resolve(server, 1, 'remove_content')).status, 400);
      const db = readDb(server);
      assert.equal(db.users.find((u) => u.id === 'target').bio, 'Bad bio');
      assert.deepEqual(db.reports.map((r) => r.status), ['open', 'open']);
    });

    test('a user already gone still resolves, and records that nothing was removed', async (t) => {
      const server = await startServer(ADMIN_ENV, { dbFixture: profileFixture({ reports: [openReport(1, 'r1', 'user', 'gone')] }) });
      t.after(() => server.stop());
      const res = await resolve(server, 1, 'clear_profile');
      assert.equal(res.status, 200);
      assert.equal(res.body.removed, false);
    });

    test('a failed save restores the profile and the reports', async (t) => {
      const server = await startServer({ ...ADMIN_ENV, ...FAULT_ENV }, { dbFixture: profileFixture() });
      t.after(() => server.stop());
      const before = readDb(server);
      failSaves(server);
      assert.equal((await resolve(server, 1, 'clear_profile')).status, 503);
      allowSaves(server);
      const publicView = await call(server, 'GET', '/api/users/target', 'r1');
      assert.equal(publicView.body.firstName, 'target');
      assert.equal(publicView.body.bio, 'Bad bio');
      assert.ok(publicView.body.avatar);
      assert.equal((await fetch(`${server.baseUrl}/media/avatars/target`, { headers: { Authorization: `Bearer ${tokenFor('r1')}` } })).status, 200);
      assert.equal((await call(server, 'POST', '/api/notifications/read', 'r1')).status, 200);
      const after = readDb(server);
      assert.deepEqual(after.users, before.users);
      assert.deepEqual(after.reports, before.reports);
    });
  });

  describe('retention', () => {
    const DAY_HOURS = 24;
    const resolved = (id, days) => openReport(id, 'r1', 'user', 'r2', {
      status: 'resolved', details: null, action: 'dismiss', removed: false, resolvedBy: 'admin', resolvedAt: ago(days * DAY_HOURS),
    });

    test('resolving clears details and records whether anything was removed', async (t) => {
      const fixture = profileFixture({ drinks: [post(1, 'target')], nextDrinkId: 2, reports: [openReport(1, 'r1', 'drink', 1), openReport(2, 'r2', 'drink', 1), openReport(3, 'r1', 'user', 'r2')] });
      const server = await startServer(ADMIN_ENV, { dbFixture: fixture });
      t.after(() => server.stop());
      assert.equal((await resolve(server, 1, 'remove_content')).body.removed, true);
      assert.equal((await resolve(server, 3, 'dismiss')).body.removed, false);
      const { reports } = readDb(server);
      assert.deepEqual(reports.map((r) => r.details), [null, null, null]);
      assert.deepEqual(reports.map((r) => r.removed), [true, true, false]);
      assert.equal(reports[0].reporterId, 'r1', 'kept for now');
    });

    test('remove_content on a target already gone records false', async (t) => {
      const server = await startServer(ADMIN_ENV, { dbFixture: profileFixture({ reports: [openReport(1, 'r1', 'drink', 999)] }) });
      t.after(() => server.stop());
      assert.equal((await resolve(server, 1, 'remove_content')).body.removed, false);
    });

    test('the reporter is dropped after 30 days, at load and on resolve; open reports keep theirs', async (t) => {
      const reports = [resolved(1, 31), resolved(2, 29), openReport(3, 'r2', 'user', 'target', { createdAt: ago(40 * DAY_HOURS) })];
      const server = await startServer(ADMIN_ENV, { dbFixture: profileFixture({ reports }) });
      t.after(() => server.stop());

      assert.equal((await call(server, 'POST', '/api/notifications/read', 'r1')).status, 200);
      let stored = readDb(server).reports;
      assert.equal('reporterId' in stored[0], false, 'at load');
      assert.equal(stored[1].reporterId, 'r1');
      assert.equal(stored[2].reporterId, 'r2');

      // The prune inside resolve needs a report to age while the server runs, so only load can be aged here.
      await server.restart({ dbFixture: { ...readDb(server), reports: [resolved(2, 31), openReport(3, 'r2', 'user', 'target')] } });
      assert.equal((await resolve(server, 3, 'dismiss')).status, 200);
      stored = readDb(server).reports;
      assert.equal('reporterId' in stored[0], false);
      assert.equal(stored[1].reporterId, 'r2', 'just resolved');
    });
  });

  describe('scoped comment reports and counters', () => {
    test('a comment report stores its post, and acts only on that post', async (t) => {
      const fixture = {
        users: [person('admin'), person('r1'), person('owner'), person('author')],
        drinks: [post(1, 'owner'), post(2, 'owner')],
        nextDrinkId: 3,
        commentsByDrink: { 1: [commentOf(5, 1, 'author', { content: 'First' })], 2: [commentOf(5, 2, 'author', { content: 'Second' })] },
        nextCommentId: 6,
        reports: [openReport(1, 'r1', 'comment', 5, { drinkId: 2 })],
        nextReportId: 2,
      };
      const server = await startServer(ADMIN_ENV, { dbFixture: fixture });
      t.after(() => server.stop());

      const list = await call(server, 'GET', '/api/admin/reports', 'admin');
      assert.equal(list.body.items[0].target.content, 'Second');
      assert.equal((await resolve(server, 1, 'remove_content')).status, 200);
      const db = readDb(server);
      assert.deepEqual(db.commentsByDrink[1].map((c) => c.content), ['First']);
      assert.deepEqual(db.commentsByDrink[2], []);
    });

    test('a new comment report records the post it found', async (t) => {
      const server = await startServer({}, { dbFixture: socialFixture() });
      t.after(() => server.stop());
      assert.equal((await report(server, 'alice', 'comment', 5)).status, 201);
      assert.equal(readDb(server).reports[0].drinkId, 2);
    });

    test('nextDrinkId and nextCommentId move ahead of stored records', async (t) => {
      const server = await startServer({}, {
        dbFixture: {
          users: [person('alice')],
          drinks: [post(5, 'alice')],
          nextDrinkId: 1,
          commentsByDrink: { 5: [commentOf(9, 5, 'alice'), null] },
          nextCommentId: 2,
        },
      });
      t.after(() => server.stop());
      const created = await call(server, 'POST', '/api/drinks', 'alice', { name: 'New', description: 'New', rating: 4, isAlcoholic: false, imageData: IMAGE });
      assert.equal(created.body.id, 6);
      const db = readDb(server);
      assert.equal(db.nextCommentId, 10);
    });
  });

  test('GET /api/blocks: someone who also blocked the caller shows only id and name', async (t) => {
    const fixture = {
      users: [person('alice'), person('mutual', { bio: 'Hidden', city: 'Hidden', avatar: IMAGE }), person('oneway', { bio: 'Shown' })],
      blocksByUser: { alice: ['mutual', 'oneway'], mutual: ['alice'] },
    };
    const server = await startServer({}, { dbFixture: fixture });
    t.after(() => server.stop());
    const { body } = await call(server, 'GET', '/api/blocks', 'alice');
    assert.deepEqual(body[0], { id: 'mutual', firstName: 'mutual', lastName: 'Test', official: false });
    assert.equal(body[1].bio, 'Shown');
  });

  test('scope=discover: a post with no partnership in between is there before a block and gone after', async (t) => {
    const fixture = {
      users: [person('dana'), person('erin')],
      drinks: [post(1, 'dana'), post(2, 'erin')],
      nextDrinkId: 3,
    };
    const server = await startServer({}, { dbFixture: fixture });
    t.after(() => server.stop());
    const discover = async (uid) => idsOf(await call(server, 'GET', '/api/drinks?scope=discover', uid));
    assert.deepEqual(await discover('dana'), [2]);
    assert.deepEqual(await discover('erin'), [1]);
    assert.equal((await call(server, 'POST', '/api/blocks/erin', 'dana')).status, 200);
    assert.deepEqual(await discover('dana'), []);
    assert.deepEqual(await discover('erin'), [], 'both directions');
  });

  describe('the ADMIN_USER_IDS startup warning', () => {
    test('counts unknown ids and never prints them', async (t) => {
      const server = await startServer({ ADMIN_USER_IDS: 'known,secret-uid-1,secret-uid-2' }, { dbFixture: { users: [person('known')] } });
      t.after(() => server.stop());
      const output = server.getOutput();
      assert.match(output, /ADMIN_USER_IDS: 2 of 3 match no known user/);
      assert.ok(!output.includes('secret-uid'));
    });

    test('says nothing when all are known, or when empty outside production', async () => {
      for (const env of [{ ADMIN_USER_IDS: 'known' }, {}]) {
        const server = await startServer(env, { dbFixture: { users: [person('known')] } });
        try {
          assert.ok(!server.getOutput().includes('[moderation]'));
        } finally {
          await server.stop();
        }
      }
    });
  });
});
