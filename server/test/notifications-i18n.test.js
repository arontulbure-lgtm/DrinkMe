import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { REAL_DATA_DIR, REAL_DB_FILE, startServer } from './helpers/harness.js';

// Task G: GET /api/notifications adds `params: { actorName, drinkName, variant? }` per item, worked out on
// each read, so the app can write the text in ro or en. The stored record and its English `message` stay
// for older app versions and for entries from before actorId (params null). The actor's name follows the
// hide rules of getDisplayName ("Someone"); the post's name shows only while the post exists, is the
// reader's own and the reader may see it.
// Not covered here: the unconfirmed-reader branch of toVisibleNotification (neutral text, params with
// "Someone" and no post name). It cannot be reached over HTTP, because requireSignedInAdult refuses
// readers who have not confirmed 18+ before the route runs (see age-gate.test.js).

const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const HOUR_MS = 60 * 60 * 1000;
const CONFIRMED_AT = '2026-01-02T03:04:05.000Z';
const OLD = '2026-01-01T00:00:00.000Z';

const OWNER = 'owner';
const ANA = 'ana';
const HIDDEN = 'hidden-actor';
const PENDING = 'pending-actor';
const BLOCKED = 'blocked-actor';
const VICTIM = 'victim-actor';
const REPORTERS = ['rep-1', 'rep-2', 'rep-3'];

const ago = (hours) => new Date(Date.now() - hours * HOUR_MS).toISOString();
const tokenFor = (uid) => jwt.sign({ uid }, HARNESS_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

const statReal = (target) => {
  const stats = fs.statSync(target, { throwIfNoEntry: false });
  return stats ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
};
let realBefore;
before(() => { realBefore = [statReal(REAL_DATA_DIR), statReal(REAL_DB_FILE)]; });
after(() => {
  assert.deepEqual([statReal(REAL_DATA_DIR), statReal(REAL_DB_FILE)], realBefore, 'server/data must stay untouched');
});

// On Windows a read can meet the server's rename of the file; retry briefly.
const readDb = (server) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(fs.readFileSync(server.dbFile, 'utf8'));
    } catch (err) {
      if (attempt >= 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
};

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
  return { status: res.status, body: parsed };
};

const listFor = async (server, uid) => {
  const res = await call(server, 'GET', '/api/notifications', uid);
  assert.equal(res.status, 200);
  return res.body.notifications;
};
const byId = (items, id) => items.find((item) => item.id === id);

const person = (id, extra = {}) => ({
  id, email: `${id}@example.test`, firstName: `Name-${id}`, lastName: 'Test', city: 'Cluj', bio: '',
  nameSetByUser: true, avatar: null, ageConfirmedAt: CONFIRMED_AT, privacyNoticeVersion: 2, ...extra,
});
const post = (id, userId, extra = {}) => ({
  id, userId, name: `Post ${id}`, description: 'Plain words', rating: 4, location: 'Cluj',
  isAlcoholic: false, createdAt: OLD, cheersCount: 0, tags: [], imageUrl: null, ...extra,
});
const note = (id, type, message, extra = {}) => ({
  id, type, message, read: false, createdAt: ago(1), ...extra,
});
const userReport = (id, reporterId, targetId) => ({
  id, reporterId, targetType: 'user', targetId, reason: 'spam', details: null, status: 'open', createdAt: ago(1),
});
const drinkReport = (id, reporterId, targetId) => ({
  id, reporterId, targetType: 'drink', targetId, reason: 'spam', details: null, status: 'open', createdAt: ago(1),
});

// Posts: 1 OWNER's, 2 OWNER's hidden after 3 reports (the owner still sees it), 3 ANA's (OWNER blocked by
// nobody), 4 ANA's hidden after reports (OWNER cannot see it), 5 BLOCKED's (OWNER blocked BLOCKED).
const fixture = (notifications = [], extra = {}) => ({
  dbSchemaVersion: 2,
  users: [
    person(OWNER), person(ANA, { firstName: 'Ana', lastName: 'Pop' }),
    person(HIDDEN, { firstName: 'Hidden', lastName: 'Actor' }),
    person(PENDING, { firstName: 'Pending', lastName: 'Actor', privacyNoticeVersion: undefined, noticePending: true }),
    person(BLOCKED, { firstName: 'Blocked', lastName: 'Actor' }),
    person(VICTIM, { firstName: 'Victor', lastName: 'Gone' }),
    ...REPORTERS.map((id) => person(id)),
  ],
  drinks: [
    post(7, OWNER, { isAlcoholic: true, tags: ['wine'] }),
    post(6, VICTIM), post(5, BLOCKED), post(4, ANA), post(3, ANA), post(2, OWNER), post(1, OWNER),
  ],
  reports: [
    ...REPORTERS.map((reporter, index) => userReport(index + 1, reporter, HIDDEN)),
    ...REPORTERS.map((reporter, index) => drinkReport(index + 4, reporter, 2)),
    ...REPORTERS.map((reporter, index) => drinkReport(index + 7, reporter, 4)),
  ],
  nextReportId: 20,
  nextDrinkId: 20,
  nextNotificationId: 100,
  blocksByUser: { [OWNER]: [BLOCKED] },
  limitEventsByUser: {},
  notificationsByUser: { [OWNER]: notifications },
  ...extra,
});

const start = async (t, dbFixture, env = {}) => {
  const server = await startServer(env, { dbFixture });
  t.after(() => server.stop());
  return server;
};

describe('GET /api/notifications params', () => {
  test('every type made through the routes gets params, and the stored message stays', async (t) => {
    const server = await start(t, fixture());

    assert.equal((await call(server, 'POST', '/api/drinks/1/like', ANA)).status, 200);
    assert.equal((await call(server, 'POST', '/api/drinks/1/comments', ANA, { content: 'Nice' })).status, 201);
    assert.equal((await call(server, 'POST', `/api/drink-partners/${OWNER}`, ANA)).status, 200);

    const items = await listFor(server, OWNER);
    const cheer = items.find((n) => n.type === 'cheer');
    const comment = items.find((n) => n.type === 'comment');
    const request = items.find((n) => n.type === 'partner_request');
    assert.deepEqual(cheer.params, { actorName: 'Ana Pop', drinkName: 'Post 1' });
    assert.equal(cheer.message, 'Ana Pop cheered your drink Post 1.');
    assert.deepEqual(comment.params, { actorName: 'Ana Pop', drinkName: 'Post 1' });
    assert.equal(comment.message, 'Ana Pop commented on Post 1.');
    assert.deepEqual(request.params, { actorName: 'Ana Pop', drinkName: null });
    assert.equal(request.message, 'Ana Pop sent you a drink partner request.');
    for (const item of [cheer, comment, request]) assert.equal('variant' in item.params, false, item.type);
    for (const item of items) {
      assert.equal('actorId' in item, false, 'actorId stays internal');
      assert.equal('drinkId' in item, false, 'drinkId stays internal');
    }

    // The accept tells the one who asked.
    assert.equal((await call(server, 'POST', `/api/drink-partners/requests/${ANA}/accept`, OWNER)).status, 200);
    const accepted = (await listFor(server, ANA)).find((n) => n.type === 'partner');
    assert.deepEqual(accepted.params, { actorName: 'Name-owner Test', drinkName: null, variant: 'accepted' });
    assert.equal(accepted.message, 'Name-owner Test accepted your drink partner request.');

    // Nothing about params is stored.
    const stored = readDb(server).notificationsByUser[OWNER];
    assert.ok(stored.length >= 3);
    for (const item of stored) assert.equal('params' in item, false);
  });

  test('a partner "added you" entry (consent off) gets variant added', async (t) => {
    const server = await start(t, fixture(), { PARTNER_CONSENT_REQUIRED: 'false' });
    assert.equal((await call(server, 'POST', `/api/drink-partners/${OWNER}`, ANA)).status, 200);
    const added = (await listFor(server, OWNER)).find((n) => n.type === 'partner');
    assert.equal(added.message, 'Ana Pop added you as a drink partner.');
    assert.deepEqual(added.params, { actorName: 'Ana Pop', drinkName: null, variant: 'added' });
  });

  test('an actor hidden after reports or with a pending notice reads "Someone"', async (t) => {
    const server = await start(t, fixture([
      note(1, 'cheer', 'Hidden Actor cheered your drink Post 1.', { actorId: HIDDEN, drinkId: 1 }),
      note(2, 'partner_request', 'Pending Actor sent you a drink partner request.', { actorId: PENDING }),
    ]));
    const items = await listFor(server, OWNER);
    assert.deepEqual(byId(items, 1).params, { actorName: 'Someone', drinkName: 'Post 1' });
    assert.deepEqual(byId(items, 2).params, { actorName: 'Someone', drinkName: null });
    // The stored text is unchanged for older app versions (today's behaviour).
    assert.equal(byId(items, 1).message, 'Hidden Actor cheered your drink Post 1.');
  });

  test('a name hidden when the entry was made stays "Someone" for good; "Someone Else" is a name', async (t) => {
    const server = await start(t, fixture([
      note(1, 'comment', 'Someone commented on Post 1.', { actorId: ANA, drinkId: 1 }),
      note(2, 'partner', 'Someone accepted your drink partner request.', { actorId: ANA }),
      note(3, 'cheer', 'Someone Else cheered your drink Post 1.', { actorId: ANA, drinkId: 1 }),
    ]));
    const items = await listFor(server, OWNER);
    assert.equal(byId(items, 1).params.actorName, 'Someone');
    assert.equal(byId(items, 2).params.actorName, 'Someone');
    assert.equal(byId(items, 2).params.variant, 'accepted');
    assert.equal(byId(items, 3).params.actorName, 'Ana Pop');
  });

  test('a user named so that the text starts with "Someone cheered your" reads "Someone" (accepted by design)', async (t) => {
    const server = await start(t, fixture());
    assert.equal((await call(server, 'PUT', `/api/users/${ANA}`, ANA, { firstName: 'Someone', lastName: 'cheered your' })).status, 200);
    assert.equal((await call(server, 'POST', '/api/drinks/1/like', ANA)).status, 200);
    const [item] = await listFor(server, OWNER);
    assert.equal(item.message, 'Someone cheered your cheered your drink Post 1.');
    // A false "Someone" names nobody, so it errs on the private side.
    assert.deepEqual(item.params, { actorName: 'Someone', drinkName: 'Post 1' });
  });

  test('an alcoholic post shows its name to its confirmed owner', async (t) => {
    const server = await start(t, fixture([
      note(1, 'cheer', 'Ana Pop cheered your drink Post 7.', { actorId: ANA, drinkId: 7 }),
    ]));
    const [item] = await listFor(server, OWNER);
    assert.deepEqual(item.params, { actorName: 'Ana Pop', drinkName: 'Post 7' });
  });

  test('a drinkId that now names another user\'s post (reused after a restore) gives drinkName null', async (t) => {
    const server = await start(t, fixture([
      // Post 3 is ANA's and visible to OWNER, but a cheer notification is always about the reader's own post.
      note(1, 'cheer', 'Ana Pop cheered your drink Old Post.', { actorId: ANA, drinkId: 3 }),
      note(2, 'comment', 'Ana Pop commented on Old Post.', { actorId: ANA, drinkId: 3 }),
    ]));
    assert.equal((await call(server, 'GET', '/api/drinks/3', OWNER)).status, 200, 'the post itself is visible');
    const items = await listFor(server, OWNER);
    assert.deepEqual(byId(items, 1).params, { actorName: 'Ana Pop', drinkName: null });
    assert.deepEqual(byId(items, 2).params, { actorName: 'Ana Pop', drinkName: null });
  });

  test('an actor with a pending deletion never shows: the deletion resumes before the server listens', async (t) => {
    const server = await start(t, fixture([
      note(1, 'cheer', 'Victor Gone cheered your drink Post 1.', { actorId: VICTIM, drinkId: 1 }),
      note(2, 'comment', 'Ana Pop commented on Post 1.', { actorId: ANA, drinkId: 1 }),
    ], { pendingAccountDeletions: [{ uid: VICTIM }] }));
    const items = await listFor(server, OWNER);
    assert.deepEqual(items.map((n) => n.id), [2]);
    assert.ok(!JSON.stringify(items).includes('Victor'));
  });

  test('a renamed actor and an edited post show their current names', async (t) => {
    const server = await start(t, fixture([
      note(1, 'cheer', 'Ana Pop cheered your drink Post 1.', { actorId: ANA, drinkId: 1 }),
    ]));
    assert.equal((await call(server, 'PUT', '/api/drinks/1', OWNER, { name: 'Renamed Negroni' })).status, 200);
    assert.equal((await call(server, 'PUT', `/api/users/${ANA}`, ANA, { firstName: 'Anca', lastName: 'Pop' })).status, 200);
    const [item] = await listFor(server, OWNER);
    assert.deepEqual(item.params, { actorName: 'Anca Pop', drinkName: 'Renamed Negroni' });
    assert.equal(item.message, 'Ana Pop cheered your drink Post 1.', 'the stored text is not rewritten');
  });

  test('a deleted post gives drinkName null', async (t) => {
    const server = await start(t, fixture([
      note(1, 'comment', 'Ana Pop commented on Post 1.', { actorId: ANA, drinkId: 1 }),
      note(2, 'cheer', 'Ana Pop cheered your drink Post 99.', { actorId: ANA, drinkId: 99 }),
    ]));
    assert.equal((await call(server, 'DELETE', '/api/drinks/1', OWNER)).status, 204);
    const items = await listFor(server, OWNER);
    // Deleting a post removes no notification today; both read without a post name.
    assert.deepEqual(byId(items, 1).params, { actorName: 'Ana Pop', drinkName: null });
    assert.deepEqual(byId(items, 2).params, { actorName: 'Ana Pop', drinkName: null });
  });

  test('a post the reader cannot see gives drinkName null; the owner of a hidden post still sees its name', async (t) => {
    const server = await start(t, fixture([
      // OWNER cheered by ANA on a post of OWNER's that is hidden after reports: the owner still sees it.
      note(1, 'cheer', 'Ana Pop cheered your drink Post 2.', { actorId: ANA, drinkId: 2 }),
      // An entry naming a post OWNER cannot see (hidden after reports, not theirs).
      note(2, 'comment', 'Ana Pop commented on Post 4.', { actorId: ANA, drinkId: 4 }),
      // An entry naming a post of someone OWNER blocked, made by a visible actor.
      note(3, 'comment', 'Ana Pop commented on Post 5.', { actorId: ANA, drinkId: 5 }),
    ]));
    const items = await listFor(server, OWNER);
    assert.deepEqual(byId(items, 1).params, { actorName: 'Ana Pop', drinkName: 'Post 2' });
    assert.deepEqual(byId(items, 2).params, { actorName: 'Ana Pop', drinkName: null });
    assert.deepEqual(byId(items, 3).params, { actorName: 'Ana Pop', drinkName: null });
  });

  test('a blocked actor\'s notifications stay hidden (as today) and come back with params on unblock', async (t) => {
    const server = await start(t, fixture([
      note(1, 'cheer', 'Blocked Actor cheered your drink Post 1.', { actorId: BLOCKED, drinkId: 1 }),
      note(2, 'cheer', 'Ana Pop cheered your drink Post 1.', { actorId: ANA, drinkId: 1 }),
    ]));
    const res = await call(server, 'GET', '/api/notifications', OWNER);
    assert.deepEqual(res.body.notifications.map((n) => n.id), [2]);
    assert.equal(res.body.unreadCount, 1);

    assert.equal((await call(server, 'DELETE', `/api/blocks/${BLOCKED}`, OWNER)).status, 204);
    const items = await listFor(server, OWNER);
    assert.deepEqual(byId(items, 1).params, { actorName: 'Blocked Actor', drinkName: 'Post 1' });
  });

  test('legacy entries without actorId and unknown types get params null and keep their message', async (t) => {
    const server = await start(t, fixture([
      note(1, 'cheer', 'Ana Pop cheered your drink Post 1.', { drinkId: 1 }),
      note(2, 'partner', 'Ana Pop accepted your drink partner request.'),
      note(3, 'mystery', 'Something new happened.', { actorId: ANA }),
      note(4, 'comment', 'Ana Pop commented on Post 1.', { actorId: null, drinkId: 1 }),
    ]));
    const items = await listFor(server, OWNER);
    for (const id of [1, 2, 3, 4]) assert.equal(byId(items, id).params, null, String(id));
    assert.equal(byId(items, 1).message, 'Ana Pop cheered your drink Post 1.');
    assert.equal(byId(items, 3).message, 'Something new happened.');
  });

  test('an unknown actor (gone from the users) reads "Someone"', async (t) => {
    const server = await start(t, fixture([
      note(1, 'partner_request', 'Ghost User sent you a drink partner request.', { actorId: 'ghost-uid' }),
    ]));
    const [item] = await listFor(server, OWNER);
    assert.deepEqual(item.params, { actorName: 'Someone', drinkName: null });
  });

  test('marking read keeps params', async (t) => {
    const server = await start(t, fixture([
      note(1, 'cheer', 'Ana Pop cheered your drink Post 1.', { actorId: ANA, drinkId: 1 }),
    ]));
    assert.equal((await call(server, 'POST', '/api/notifications/read', OWNER)).status, 200);
    const res = await call(server, 'GET', '/api/notifications', OWNER);
    assert.equal(res.body.unreadCount, 0);
    assert.equal(res.body.notifications[0].read, true);
    assert.deepEqual(res.body.notifications[0].params, { actorName: 'Ana Pop', drinkName: 'Post 1' });
  });

  test('the account-deletion cascade is unchanged: entries by or about the deleted user go, others stay', async (t) => {
    const server = await start(t, fixture([], {
      notificationsByUser: {
        [OWNER]: [
          note(1, 'cheer', 'Victor Gone cheered your drink Post 1.', { actorId: VICTIM, drinkId: 1 }),
          note(2, 'cheer', 'Victor Gone cheered your drink Post 2.', { drinkId: 2 }), // legacy, matched by name
          note(3, 'comment', 'Ana Pop commented on Post 1.', { actorId: ANA, drinkId: 1 }),
          note(4, 'cheer', 'Someone cheered your drink Post 1.'), // the fallback names nobody
        ],
        // An entry about the victim's own post goes too, whoever made it.
        [ANA]: [note(5, 'comment', 'Name-owner Test commented on Post 6.', { actorId: OWNER, drinkId: 6 })],
        [VICTIM]: [note(6, 'cheer', 'Ana Pop cheered your drink Post 6.', { actorId: ANA, drinkId: 6 })],
      },
    }));
    assert.equal((await call(server, 'POST', `/api/users/${VICTIM}/delete-account`, VICTIM, {})).status, 200);

    const stored = readDb(server).notificationsByUser;
    assert.deepEqual(stored[OWNER].map((n) => n.id), [3, 4]);
    assert.deepEqual(stored[ANA] ?? [], []);
    assert.equal(stored[VICTIM], undefined);
    for (const item of stored[OWNER]) assert.equal('params' in item, false);

    const items = await listFor(server, OWNER);
    assert.deepEqual(items.map((n) => n.id), [3, 4]);
    assert.deepEqual(byId(items, 3).params, { actorName: 'Ana Pop', drinkName: 'Post 1' });
    assert.equal(byId(items, 4).params, null);
  });
});
