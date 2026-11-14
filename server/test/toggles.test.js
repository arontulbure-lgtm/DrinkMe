import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { startServer } from './helpers/harness.js';

// T4-5: POST /api/drinks/:id/like and /save take an optional { cheered } / { saved } that sets the state
// (idempotent), toggle without it, refuse a non-boolean with 400, and roll back a failed save.

const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const FAULT_PRELOAD = new URL('./helpers/db-fault-preload.js', import.meta.url).href;
const FAULT_ENV = { DB_FAULT: 'save', NODE_OPTIONS: `--import=${FAULT_PRELOAD}` };
const HOUR_MS = 60 * 60 * 1000;
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const OWNER = 'owner';
const FAN = 'fan';
const SUSPENDED = 'suspended';

const ago = (hours) => new Date(Date.now() - hours * HOUR_MS).toISOString();
const tokenFor = (uid) => jwt.sign({ uid }, HARNESS_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const readDb = (server) => JSON.parse(fs.readFileSync(server.dbFile, 'utf8'));
const failSaves = (server) => fs.writeFileSync(`${server.dbFile}.fail-saves`, '');
const allowSaves = (server) => fs.rmSync(`${server.dbFile}.fail-saves`);

// rawBody sends the string as it is, with a JSON content type.
const call = async (server, method, path, uid, body, { rawBody } = {}) => {
  const hasBody = body !== undefined || rawBody !== undefined;
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      ...(hasBody && { 'Content-Type': 'application/json' }),
      ...(uid && { Authorization: `Bearer ${tokenFor(uid)}` }),
    },
    ...(hasBody && { body: rawBody ?? JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};

const like = (server, id, uid, body, options) => call(server, 'POST', `/api/drinks/${id}/like`, uid, body, options);
const save = (server, id, uid, body, options) => call(server, 'POST', `/api/drinks/${id}/save`, uid, body, options);
const getDrink = async (server, id, uid) => (await call(server, 'GET', `/api/drinks/${id}`, uid)).body;
const savedIds = async (server, uid) => (await call(server, 'GET', `/api/users/${uid}/saved-drinks`, uid)).body.items.map((d) => d.id);
const cheerNotifications = async (server, uid) => (
  (await call(server, 'GET', '/api/notifications', uid)).body.notifications.filter((n) => n.type === 'cheer')
);

const user = (id, extra = {}) => ({
  id, email: `${id}@example.test`, firstName: id, lastName: '', city: '', bio: '', nameSetByUser: true,
  avatar: null, ageConfirmedAt: ago(1000), privacyNoticeVersion: 2, ...extra,
});
const drink = (id, userId, extra = {}) => ({
  id, userId, name: `Drink ${id}`, description: 'Plain', rating: 4, location: null, isAlcoholic: false,
  createdAt: ago(48), cheersCount: 0, tags: [], imageUrl: IMAGE, ...extra,
});
const fixture = () => ({
  users: [
    user(OWNER),
    user(FAN),
    user(SUSPENDED, { suspensions: [{ startedAt: ago(1), permanent: true, reason: 'test', by: 'admin' }] }),
  ],
  drinks: [drink(1, OWNER), drink(2, OWNER)],
  limitEventsByUser: {},
  nextDrinkId: 10,
  nextCommentId: 100,
});

describe('cheer and save with an explicit state', () => {
  test('{ cheered } sets the state: repeats change nothing and notify the owner once', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    for (let i = 0; i < 3; i += 1) {
      const res = await like(server, 1, FAN, { cheered: true });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { cheered: true, cheersCount: 1 });
    }
    assert.equal((await cheerNotifications(server, OWNER)).length, 1, 'one notification for one change');
    const cheered = await getDrink(server, 1, FAN);
    assert.equal(cheered.isLiked, true);
    assert.equal(cheered.cheersCount, 1);

    for (let i = 0; i < 2; i += 1) {
      const res = await like(server, 1, FAN, { cheered: false });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { cheered: false, cheersCount: 0 });
    }
    assert.equal((await getDrink(server, 1, FAN)).cheersCount, 0);

    // Off then on again counts again, but the owner already has this cheerer's notice for this post.
    assert.deepEqual((await like(server, 1, FAN, { cheered: true })).body, { cheered: true, cheersCount: 1 });
    assert.equal((await cheerNotifications(server, OWNER)).length, 1);
    assert.deepEqual(readDb(server).cheersByUser[FAN], [1]);
  });

  test('cycling a cheer off and on notifies the owner once per cheerer and post, read or not', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    for (let i = 0; i < 5; i += 1) {
      assert.equal((await like(server, 1, FAN)).status, 200);
      assert.equal((await like(server, 1, FAN)).status, 200);
    }
    assert.equal((await cheerNotifications(server, OWNER)).length, 1, 'toggling without a body');
    assert.equal((await call(server, 'POST', '/api/notifications/read', OWNER)).status, 200);
    assert.equal((await like(server, 1, FAN, { cheered: false })).status, 200);
    assert.equal((await like(server, 1, FAN, { cheered: true })).status, 200);
    const notices = await cheerNotifications(server, OWNER);
    assert.equal(notices.length, 1, 'a read notice still counts');
    assert.equal(notices[0].read, true);

    // Another post, or another cheerer, is a new notice.
    assert.equal((await like(server, 2, FAN, { cheered: true })).status, 200);
    assert.equal((await like(server, 1, SUSPENDED, { cheered: true })).status, 200);
    assert.equal((await cheerNotifications(server, OWNER)).length, 3);
  });

  test('a cheer notice past the keep time no longer counts, so a new cheer notifies again', async (t) => {
    const base = fixture();
    base.notificationsByUser = {
      [OWNER]: [{ id: 1, type: 'cheer', message: 'fan cheered your drink Drink 1.', actorId: FAN, drinkId: 1, read: true, createdAt: ago(8 * 24) }],
    };
    base.nextNotificationId = 2;
    const server = await startServer({}, { dbFixture: base });
    t.after(() => server.stop());
    assert.equal((await like(server, 1, FAN, { cheered: true })).status, 200);
    const notices = await cheerNotifications(server, OWNER);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].id, 2);
  });

  test('cheering an own post with { cheered: true } counts and notifies nobody', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());
    assert.deepEqual((await like(server, 1, OWNER, { cheered: true })).body, { cheered: true, cheersCount: 1 });
    assert.equal((await cheerNotifications(server, OWNER)).length, 0);
  });

  test('{ saved } sets the state: repeats keep one entry in the saved list', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    for (let i = 0; i < 3; i += 1) {
      const res = await save(server, 2, FAN, { saved: true });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { saved: true });
    }
    assert.deepEqual(await savedIds(server, FAN), [2]);
    assert.deepEqual(readDb(server).savedByUser[FAN], [2]);

    for (let i = 0; i < 2; i += 1) {
      assert.deepEqual((await save(server, 2, FAN, { saved: false })).body, { saved: false });
    }
    assert.deepEqual(await savedIds(server, FAN), []);
  });

  test('without a body, or a body without the field, both routes still toggle', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    assert.deepEqual((await like(server, 1, FAN)).body, { cheered: true, cheersCount: 1 });
    assert.deepEqual((await like(server, 1, FAN)).body, { cheered: false, cheersCount: 0 });
    assert.deepEqual((await like(server, 1, FAN, {})).body, { cheered: true, cheersCount: 1 });
    assert.deepEqual((await like(server, 1, FAN, { saved: true })).body, { cheered: false, cheersCount: 0 });

    assert.deepEqual((await save(server, 1, FAN)).body, { saved: true });
    assert.deepEqual((await save(server, 1, FAN)).body, { saved: false });
    assert.deepEqual((await save(server, 1, FAN, {})).body, { saved: true });
    assert.deepEqual((await save(server, 1, FAN, { cheered: false })).body, { saved: false });
  });

  test('a non-boolean state gives 400 and changes nothing', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    const badValues = ['true', 1, 0, null, {}, [true]];
    for (const value of badValues) {
      const cheer = await like(server, 1, FAN, { cheered: value });
      assert.equal(cheer.status, 400, `cheered: ${JSON.stringify(value)}`);
      assert.equal(typeof cheer.body.error, 'string');
      const saved = await save(server, 1, FAN, { saved: value });
      assert.equal(saved.status, 400, `saved: ${JSON.stringify(value)}`);
    }
    // A JSON body that is not an object.
    assert.equal((await like(server, 1, FAN, undefined, { rawBody: '[true]' })).status, 400);
    assert.equal((await save(server, 1, FAN, undefined, { rawBody: '[]' })).status, 400);
    // Checked before the post is looked up, so a missing post with a bad body is still 400.
    assert.equal((await like(server, 999, FAN, { cheered: 'yes' })).status, 400);

    const after = await getDrink(server, 1, FAN);
    assert.equal(after.isLiked, false);
    assert.equal(after.isSaved, false);
    assert.equal(after.cheersCount, 0);
    assert.equal((await cheerNotifications(server, OWNER)).length, 0);
  });

  test('a missing post still gives 404 with a valid body', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());
    assert.equal((await like(server, 999, FAN, { cheered: true })).status, 404);
    assert.equal((await save(server, 999, FAN, { saved: true })).status, 404);
  });

  test('a suspended user can still cheer and save', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());
    const comment = await call(server, 'POST', '/api/drinks/1/comments', SUSPENDED, { content: 'Hi' });
    assert.equal(comment.body.code, 'account_suspended', 'the fixture suspension is in force');
    assert.deepEqual((await like(server, 1, SUSPENDED, { cheered: true })).body, { cheered: true, cheersCount: 1 });
    assert.deepEqual((await save(server, 1, SUSPENDED, { saved: true })).body, { saved: true });
    assert.deepEqual((await like(server, 1, SUSPENDED)).body, { cheered: false, cheersCount: 0 });
    assert.deepEqual((await save(server, 1, SUSPENDED, { saved: false })).body, { saved: false });
  });

  test('when storage is full, turning on is refused but turning off and repeats still work', async (t) => {
    const base = fixture();
    base.cheersByUser = { [FAN]: [2] };
    base.savedByUser = { [FAN]: [2] };
    base.drinks[1].cheersCount = 1;
    const server = await startServer({ DB_GROWTH_MAX_BYTES: '1' }, { dbFixture: base });
    t.after(() => server.stop());

    assert.equal((await like(server, 1, FAN, { cheered: true })).status, 507);
    assert.equal((await save(server, 1, FAN, { saved: true })).status, 507);
    // Asking for the state already held grows nothing.
    assert.deepEqual((await like(server, 2, FAN, { cheered: true })).body, { cheered: true, cheersCount: 1 });
    assert.deepEqual((await save(server, 2, FAN, { saved: true })).body, { saved: true });
    assert.deepEqual((await like(server, 2, FAN, { cheered: false })).body, { cheered: false, cheersCount: 0 });
    assert.deepEqual((await save(server, 2, FAN, { saved: false })).body, { saved: false });
  });
});

describe('cheer and save roll back a failed save', () => {
  test('a failed cheer leaves no cheer, count or notification behind, with or without a body', async (t) => {
    const server = await startServer(FAULT_ENV, { dbFixture: fixture() });
    t.after(() => server.stop());

    failSaves(server);
    assert.equal((await like(server, 1, FAN, { cheered: true })).status, 503);
    assert.equal((await like(server, 1, FAN)).status, 503);
    allowSaves(server);

    const after = await getDrink(server, 1, FAN);
    assert.equal(after.isLiked, false);
    assert.equal(after.cheersCount, 0);
    assert.equal((await cheerNotifications(server, OWNER)).length, 0);

    // A later successful save must not write the undone cheer to disk.
    assert.equal((await save(server, 2, FAN, { saved: true })).status, 200);
    const db = readDb(server);
    assert.equal(db.cheersByUser?.[FAN], undefined);
    assert.equal(db.drinks.find((d) => d.id === 1).cheersCount, 0);
    assert.equal((db.notificationsByUser?.[OWNER] ?? []).length, 0);

    // The next cheer works and notifies once.
    assert.deepEqual((await like(server, 1, FAN, { cheered: true })).body, { cheered: true, cheersCount: 1 });
    assert.equal((await cheerNotifications(server, OWNER)).length, 1);
  });

  test('a failed cheer to an owner with a full notification list keeps every old notice', async (t) => {
    const NOTIFICATIONS_MAX_PER_USER = 200;
    const base = fixture();
    base.notificationsByUser = {
      [OWNER]: Array.from({ length: NOTIFICATIONS_MAX_PER_USER }, (_, index) => ({
        id: NOTIFICATIONS_MAX_PER_USER - index, // newest first
        type: 'comment',
        message: 'Someone commented on Drink 2.',
        actorId: SUSPENDED,
        drinkId: 2,
        read: false,
        createdAt: ago(1 + index / 100),
      })),
    };
    base.nextNotificationId = NOTIFICATIONS_MAX_PER_USER + 1;
    const server = await startServer(FAULT_ENV, { dbFixture: base });
    t.after(() => server.stop());
    const idsBefore = base.notificationsByUser[OWNER].map((n) => n.id);

    failSaves(server);
    assert.equal((await like(server, 1, FAN, { cheered: true })).status, 503);
    allowSaves(server);

    assert.equal((await save(server, 2, FAN, { saved: true })).status, 200);
    const db = readDb(server);
    assert.deepEqual(db.notificationsByUser[OWNER].map((n) => n.id), idsBefore, 'the oldest notice was not dropped');
    assert.equal(db.nextNotificationId, NOTIFICATIONS_MAX_PER_USER + 1);

    // The cheer that works afterwards drops the oldest one, as the cap says.
    assert.equal((await like(server, 1, FAN, { cheered: true })).status, 200);
    const ids = (await call(server, 'GET', '/api/notifications', OWNER)).body.notifications.map((n) => n.id);
    assert.equal(ids.length, NOTIFICATIONS_MAX_PER_USER);
    assert.equal(ids[0], NOTIFICATIONS_MAX_PER_USER + 1);
    assert.ok(!ids.includes(1));
  });

  test('a failed first cheer leaves the owner with no notification list at all', async (t) => {
    const server = await startServer(FAULT_ENV, { dbFixture: fixture() });
    t.after(() => server.stop());
    failSaves(server);
    assert.equal((await like(server, 1, FAN, { cheered: true })).status, 503);
    allowSaves(server);
    assert.equal((await save(server, 2, FAN, { saved: true })).status, 200);
    assert.equal(readDb(server).notificationsByUser?.[OWNER], undefined);
  });

  test('a failed uncheer keeps the cheer and its count', async (t) => {
    const server = await startServer(FAULT_ENV, { dbFixture: fixture() });
    t.after(() => server.stop());

    assert.equal((await like(server, 1, FAN, { cheered: true })).status, 200);
    failSaves(server);
    assert.equal((await like(server, 1, FAN, { cheered: false })).status, 503);
    assert.equal((await like(server, 1, FAN)).status, 503);
    allowSaves(server);

    const after = await getDrink(server, 1, FAN);
    assert.equal(after.isLiked, true);
    assert.equal(after.cheersCount, 1);
    assert.equal((await cheerNotifications(server, OWNER)).length, 1);
    assert.deepEqual((await like(server, 1, FAN, { cheered: true })).body, { cheered: true, cheersCount: 1 });
  });

  test('a failed save or unsave leaves the saved list as it was', async (t) => {
    const server = await startServer(FAULT_ENV, { dbFixture: fixture() });
    t.after(() => server.stop());

    failSaves(server);
    assert.equal((await save(server, 1, FAN, { saved: true })).status, 503);
    assert.equal((await save(server, 1, FAN)).status, 503);
    allowSaves(server);
    assert.deepEqual(await savedIds(server, FAN), []);
    assert.equal((await getDrink(server, 1, FAN)).isSaved, false);

    assert.equal((await save(server, 2, FAN, { saved: true })).status, 200);
    failSaves(server);
    assert.equal((await save(server, 2, FAN, { saved: false })).status, 503);
    allowSaves(server);
    assert.deepEqual(await savedIds(server, FAN), [2]);

    // A later successful save writes only what really changed.
    assert.equal((await like(server, 2, FAN, { cheered: true })).status, 200);
    assert.deepEqual(readDb(server).savedByUser[FAN], [2]);
  });
});
