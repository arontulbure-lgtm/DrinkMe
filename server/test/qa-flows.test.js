// Server behaviour behind flows of D:\DrinkMeApp\QA_CHECKLIST.md and the project's QA_CHECKLIST.md that no
// other test file covered (T3-3). Each test names the checklist flow it backs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { REAL_DB_FILE, startServer } from './helpers/harness.js';

const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const CONFIRMED_AT = '2026-01-02T03:04:05.000Z';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;

const ANA = 'qa-flow-ana';
const BOB = 'qa-flow-bob';
const CAROL = 'qa-flow-carol';

const tokenFor = (uid) => jwt.sign({ uid }, HARNESS_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

const person = (id, extra = {}) => ({
  id, email: `${id}@example.test`, firstName: id, lastName: 'Test', city: 'Cluj', bio: '', nameSetByUser: true,
  avatar: null, privacyNoticeVersion: 2, privacyNoticeAt: CONFIRMED_AT, ageConfirmedAt: CONFIRMED_AT, ...extra,
});

const drink = (id, userId, extra = {}) => ({
  id, userId, name: `Drink ${id}`, description: 'Plain', rating: 4, location: 'Cluj', isAlcoholic: false,
  createdAt: '2026-01-01T00:00:00.000Z', cheersCount: 0, tags: [], imageUrl: PNG_DATA_URL, ...extra,
});

// Ana and Bob are partners; Carol is a stranger to both.
const fixture = () => ({
  dbSchemaVersion: 2,
  users: [person(ANA, { firstName: 'Ana' }), person(BOB, { firstName: 'Bob', city: 'Timisoara' }), person(CAROL, { firstName: 'Carol' })],
  drinks: [
    drink(1, ANA),
    drink(2, BOB, { cheersCount: 5 }),
    drink(3, CAROL, { cheersCount: 1 }),
    drink(4, CAROL, { cheersCount: 9 }),
    drink(5, ANA, { cheersCount: 50 }),
  ],
  nextDrinkId: 6,
  partnersByUser: { [ANA]: [BOB], [BOB]: [ANA] },
  commentsByDrink: {},
  nextCommentId: 1,
});

const call = async (server, route, { token, method = 'GET', body } = {}) => {
  const res = await fetch(`${server.baseUrl}${route}`, {
    method,
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  return { status: res.status, text, body: parsed };
};

const ids = (items) => items.map((item) => item.id);

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

describe('QA flows: first run and relogin', () => {
  let server;
  before(async () => {
    server = await startServer({}, { dbFixture: fixture() });
  });
  after(() => server?.stop());

  test('Smoke: deloghează și reloghează — age gate / notă / nume nu sunt cerute din nou', async () => {
    const uid = 'qa-flow-newcomer';
    const signIn = () => call(server, '/api/auth/mobile', {
      method: 'POST', body: { idToken: 'dev-fallback-token', uid, email: `${uid}@example.test` },
    });
    const first = await signIn();
    assert.equal(first.status, 200);
    const token = first.body.token;
    const fresh = await call(server, `/api/users/${uid}`, { token });
    assert.equal(fresh.body.ageConfirmed, false);
    assert.equal(fresh.body.needsName, true);

    // The first-run flow: age, privacy notice, name.
    assert.equal((await call(server, `/api/users/${uid}/acknowledgements`, { method: 'POST', token, body: { type: 'age', confirmed: true } })).status, 200);
    assert.equal((await call(server, `/api/users/${uid}/acknowledgements`, { method: 'POST', token, body: { type: 'privacy', version: 2 } })).status, 200);
    assert.equal((await call(server, `/api/users/${uid}`, { method: 'PUT', token, body: { firstName: 'Newcomer', nameChosen: true } })).status, 200);

    // Log out (the client drops the JWT) and sign in again, also after a restart.
    for (const restart of [false, true]) {
      if (restart) await server.restart();
      const again = await signIn();
      assert.equal(again.status, 200);
      const profile = await call(server, `/api/users/${uid}`, { token: again.body.token });
      assert.equal(profile.status, 200);
      assert.equal(profile.body.ageConfirmed, true, 'age gate not asked again');
      assert.equal(profile.body.privacyNoticeVersion, 2, 'notice not asked again');
      assert.equal(profile.body.needsName, false, 'name not asked again');
      assert.equal(profile.body.firstName, 'Newcomer');
      assert.equal((await call(server, '/api/drinks/partners', { token: again.body.token })).status, 200, 'the feed opens');
    }
  });
});

describe('QA flows: feed, cheers, saves, comments, notifications', () => {
  let server;
  before(async () => {
    server = await startServer({}, { dbFixture: fixture() });
  });
  after(() => server?.stop());

  test('Home: feed-ul arată postările proprii și ale partenerilor; o postare nouă apare sus', async () => {
    const feed = await call(server, '/api/drinks/partners', { token: tokenFor(ANA) });
    assert.equal(feed.status, 200);
    assert.deepEqual(ids(feed.body.items), [5, 2, 1], 'own and partner posts, newest first, no stranger');

    const created = await call(server, '/api/drinks', {
      method: 'POST', token: tokenFor(BOB), body: { name: 'Fresh', description: 'New post', rating: 5, isAlcoholic: false, imageData: PNG_DATA_URL },
    });
    assert.equal(created.status, 201);
    for (const uid of [ANA, BOB]) {
      const after = await call(server, '/api/drinks/partners', { token: tokenFor(uid) });
      assert.equal(after.body.items[0].id, created.body.id, `${uid} sees it first`);
    }
    const own = await call(server, `/api/drinks/user/${BOB}`, { token: tokenFor(BOB) });
    assert.equal(own.body.items[0].id, created.body.id);
    assert.equal(own.body.total, 2, 'profile post count');
    const stranger = await call(server, '/api/drinks/partners', { token: tokenFor(CAROL) });
    assert.ok(!ids(stranger.body.items).includes(created.body.id), 'not in a stranger\'s home feed');
  });

  test('Cheers (două pahare): icon-ul toggle-ează, numărul se actualizează, autorul e notificat', async () => {
    const on = await call(server, '/api/drinks/2/like', { method: 'POST', token: tokenFor(CAROL) });
    assert.equal(on.status, 200);
    assert.deepEqual(on.body, { cheered: true, cheersCount: 6 });
    const detail = await call(server, '/api/drinks/2', { token: tokenFor(CAROL) });
    assert.equal(detail.body.isLiked, true);
    assert.equal(detail.body.cheersCount, 6);

    const notifications = await call(server, '/api/notifications', { token: tokenFor(BOB) });
    assert.ok(notifications.body.notifications.some((n) => n.type === 'cheer' && /Carol/.test(n.message)));

    const off = await call(server, '/api/drinks/2/like', { method: 'POST', token: tokenFor(CAROL) });
    assert.deepEqual(off.body, { cheered: false, cheersCount: 5 });
    assert.equal((await call(server, '/api/drinks/2', { token: tokenFor(CAROL) })).body.isLiked, false);
  });

  test('Save pe o postare: persistă după refresh și restart; Saved arată cheers badge', async () => {
    const saved = await call(server, '/api/drinks/4/save', { method: 'POST', token: tokenFor(ANA) });
    assert.equal(saved.status, 200);
    await server.restart();
    const detail = await call(server, '/api/drinks/4', { token: tokenFor(ANA) });
    assert.equal(detail.body.isSaved, true);
    const list = await call(server, `/api/users/${ANA}/saved-drinks`, { token: tokenFor(ANA) });
    assert.deepEqual(ids(list.body.items), [4]);
    assert.equal(list.body.items[0].cheersCount, 9, 'the badge count is in the saved list');
    assert.equal(list.body.items[0].isSaved, true);
  });

  test('Comentariu nou: apare imediat, îl văd și alți useri, autorul postării e notificat', async () => {
    const created = await call(server, '/api/drinks/3/comments', { method: 'POST', token: tokenFor(ANA), body: { content: 'Looks great' } });
    assert.equal(created.status, 201);
    for (const uid of [ANA, BOB, CAROL]) {
      const list = await call(server, '/api/drinks/3/comments', { token: tokenFor(uid) });
      assert.ok(list.body.items.some((c) => c.id === created.body.id && c.content === 'Looks great'), `${uid} sees it`);
    }
    const notifications = await call(server, '/api/notifications', { token: tokenFor(CAROL) });
    assert.ok(notifications.body.notifications.some((n) => n.type === 'comment' && /Ana/.test(n.message)));
  });

  test('Notificări: badge-ul de unread se actualizează; „Mark all read” curăță badge-ul, și după restart', async () => {
    const before = await call(server, '/api/notifications', { token: tokenFor(CAROL) });
    assert.ok(before.body.unreadCount >= 1);
    const read = await call(server, '/api/notifications/read', { method: 'POST', token: tokenFor(CAROL) });
    assert.equal(read.status, 200);
    assert.equal((await call(server, '/api/notifications', { token: tokenFor(CAROL) })).body.unreadCount, 0);
    await server.restart();
    const later = await call(server, '/api/notifications', { token: tokenFor(CAROL) });
    assert.equal(later.body.unreadCount, 0);
    assert.equal(later.body.notifications.length, before.body.notifications.length, 'read, not removed');
  });

  test('Secțiunea Stories nu apare: GET /api/stories e mereu gol pentru un user confirmat', async () => {
    const res = await call(server, '/api/stories', { token: tokenFor(ANA) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });
});

describe('QA flows: explore, create post, partners', () => {
  let server;
  before(async () => {
    server = await startServer({}, { dbFixture: fixture() });
  });
  after(() => server?.stop());

  test('Explore: tap pe un card trending — trending exclude postările proprii și ale partenerilor', async () => {
    const res = await call(server, '/api/drinks?scope=discover&sort=trending&limit=20', { token: tokenFor(ANA) });
    assert.equal(res.status, 200);
    assert.deepEqual(ids(res.body.items), [4, 3], 'only strangers\' posts, most cheered first');
    assert.equal(res.body.nextCursor, null);
  });

  test('Explore: @username caută după nume public și oraș', async () => {
    const byCity = await call(server, '/api/users/search?q=@timis', { token: tokenFor(CAROL) });
    assert.equal(byCity.status, 200);
    assert.deepEqual(ids(byCity.body), [BOB]);
    const byName = await call(server, '/api/users/search?q=carol', { token: tokenFor(ANA) });
    assert.deepEqual(ids(byName.body), [CAROL]);
    assert.equal(byName.body[0].partnerStatus, 'none');
  });

  test('Create post: rating-ul trebuie să fie între 0 și 5', async () => {
    const base = { name: 'Rated', description: 'x', isAlcoholic: false, imageData: PNG_DATA_URL };
    for (const rating of [6, -1, 'abc']) {
      const res = await call(server, '/api/drinks', { method: 'POST', token: tokenFor(CAROL), body: { ...base, rating } });
      assert.equal(res.status, 400, `rating ${rating}`);
    }
    for (const rating of [0, 5]) {
      const res = await call(server, '/api/drinks', { method: 'POST', token: tokenFor(CAROL), body: { ...base, rating } });
      assert.equal(res.status, 201, `rating ${rating}`);
      assert.equal(res.body.rating, rating);
    }
  });

  test('PartnersList: empty state dacă nu ai parteneri', async () => {
    const res = await call(server, '/api/drink-partners', { token: tokenFor(CAROL) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
    const own = await call(server, `/api/users/${CAROL}`, { token: tokenFor(CAROL) });
    assert.equal(own.body.partnerCount, 0);
  });

  test('Remove partner → dispare din listă și din feed, fără să revină', async () => {
    const before = await call(server, '/api/drinks/partners', { token: tokenFor(ANA) });
    assert.ok(ids(before.body.items).includes(2));
    assert.equal((await call(server, `/api/users/${ANA}`, { token: tokenFor(ANA) })).body.partnerCount, 1);

    const removed = await call(server, `/api/drink-partners/${BOB}?expect=partner`, { method: 'DELETE', token: tokenFor(ANA) });
    assert.equal(removed.status, 204);
    for (const [uid, other] of [[ANA, BOB], [BOB, ANA]]) {
      assert.ok(!ids((await call(server, '/api/drink-partners', { token: tokenFor(uid) })).body).includes(other), `${uid} list`);
      const feed = await call(server, '/api/drinks/partners', { token: tokenFor(uid) });
      assert.ok(feed.body.items.every((item) => item.userId === uid), `${uid} feed holds own posts only`);
    }
    await server.restart();
    assert.deepEqual((await call(server, '/api/drink-partners', { token: tokenFor(ANA) })).body, []);
    assert.equal((await call(server, `/api/users/${ANA}`, { token: tokenFor(ANA) })).body.partnerCount, 0);
  });

  test('Regression / Backend: endpoint-urile răspund (/api/drinks, /api/smart-bar)', async () => {
    const drinks = await call(server, '/api/drinks', { token: tokenFor(BOB) });
    assert.equal(drinks.status, 200);
    assert.ok(Array.isArray(drinks.body.items));
    const smartBar = await call(server, '/api/smart-bar', { token: tokenFor(BOB) });
    assert.equal(smartBar.status, 200);
    assert.ok(Array.isArray(smartBar.body));
  });
});
