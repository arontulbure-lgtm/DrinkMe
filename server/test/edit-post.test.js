import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { startServer } from './helpers/harness.js';

// Task F (T4-6): PUT /api/drinks/:id lets the owner change name, description, rating, location, the
// alcoholic flag and the category. A missing field stays as stored; the image cannot be changed.
// Checks, in order: sign-in and age gate, requireAuth, refuseIfSuspended, id, ownership (404 for a block
// or a post hidden from the caller, 403 otherwise), 409 for the owner's post hidden pending review, then
// validation, the growth guard, the no-op and the save with rollback.

const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const FAULT_PRELOAD = new URL('./helpers/db-fault-preload.js', import.meta.url).href;
const FAULT_ENV = { DB_FAULT: 'save', NODE_OPTIONS: `--import=${FAULT_PRELOAD}` };
const HOUR_MS = 60 * 60 * 1000;
const OLD = '2026-01-01T00:00:00.000Z';
const CONFIRMED_AT = '2026-01-02T03:04:05.000Z';
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const OWNER = 'owner';
const OTHER = 'other';
const BLOCKER = 'blocker';
const BLOCKED = 'blocked';
const ADMIN = 'admin';
const SUSPENDED = 'suspended';
const UNCONFIRMED = 'unconfirmed';
const REPORTERS = ['rep-1', 'rep-2', 'rep-3'];

const ago = (hours) => new Date(Date.now() - hours * HOUR_MS).toISOString();
const tokenFor = (uid) => jwt.sign({ uid }, HARNESS_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const readDb = (server) => JSON.parse(fs.readFileSync(server.dbFile, 'utf8'));
const failSaves = (server) => fs.writeFileSync(`${server.dbFile}.fail-saves`, '');
const allowSaves = (server) => fs.rmSync(`${server.dbFile}.fail-saves`);

const call = async (server, method, route, uid, body, { rawBody } = {}) => {
  const res = await fetch(`${server.baseUrl}${route}`, {
    method,
    headers: {
      ...(uid && { Authorization: `Bearer ${tokenFor(uid)}` }),
      ...((body !== undefined || rawBody !== undefined) && { 'Content-Type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    ...(rawBody !== undefined && { body: rawBody }),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  return { status: res.status, body: parsed };
};
const edit = (server, id, uid, body) => call(server, 'PUT', `/api/drinks/${id}`, uid, body);
const getDrink = (server, id, uid = OWNER) => call(server, 'GET', `/api/drinks/${id}`, uid);

const person = (id, extra = {}) => ({
  id, email: `${id}@example.test`, firstName: `Name-${id}`, lastName: 'Test', city: 'Cluj', bio: '',
  nameSetByUser: true, avatar: null, ageConfirmedAt: CONFIRMED_AT, privacyNoticeVersion: 2, ...extra,
});
const post = (id, userId, extra = {}) => ({
  id, userId, name: `Post ${id}`, description: 'Plain words', rating: 4, location: 'Cluj',
  isAlcoholic: true, createdAt: OLD, cheersCount: 0, tags: ['wine'], imageUrl: IMAGE, ...extra,
});
const openReport = (id, reporterId, targetId) => ({
  id, reporterId, targetType: 'drink', targetId, reason: 'spam', details: null, status: 'open', createdAt: ago(1),
});

// Post 1: the owner's alcoholic wine post. 2: the owner's non-alcoholic post without a category.
// 3: OTHER's post. 4: BLOCKER's post (BLOCKER blocked OWNER). 5: BLOCKED's post (OWNER blocked BLOCKED).
// 6: the owner's post hidden after 3 reports. 7: OTHER's post hidden after 3 reports.
const fixture = (extra = {}) => ({
  dbSchemaVersion: 2,
  users: [
    person(OWNER), person(OTHER), person(BLOCKER), person(BLOCKED), person(ADMIN),
    person(SUSPENDED, { suspensions: [{ at: ago(1), until: null, permanent: true, reason: 'test', by: ADMIN }] }),
    person(UNCONFIRMED, { ageConfirmedAt: undefined }),
    ...REPORTERS.map((id) => person(id)),
  ],
  drinks: [
    post(7, OTHER), post(6, OWNER), post(5, BLOCKED), post(4, BLOCKER), post(3, OTHER),
    post(2, OWNER, { isAlcoholic: false, tags: [], location: null }), post(1, OWNER),
    post(8, SUSPENDED),
  ],
  reports: [
    ...REPORTERS.map((reporter, index) => openReport(index + 1, reporter, 6)),
    ...REPORTERS.map((reporter, index) => openReport(index + 4, reporter, 7)),
  ],
  nextReportId: 10,
  blocksByUser: { [BLOCKER]: [OWNER], [OWNER]: [BLOCKED] },
  nextDrinkId: 20,
  limitEventsByUser: {},
  ...extra,
});

const storedDrink = (server, id) => readDb(server).drinks.find((d) => d.id === id);

describe('PUT /api/drinks/:id checks', () => {
  test('logged out 401; an unconfirmed user gets 403 age_required from the gate', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    assert.equal((await edit(server, 1, undefined, { name: 'X' })).status, 401);
    const unconfirmed = await edit(server, 1, UNCONFIRMED, { name: 'X' });
    assert.equal(unconfirmed.status, 403);
    assert.equal(unconfirmed.body.code, 'age_required');
    assert.equal(storedDrink(server, 1).name, 'Post 1');
  });

  test('a suspended user gets 403 account_suspended, before the id and ownership checks', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    for (const id of [8, 1, 999, 'abc']) {
      const res = await edit(server, id, SUSPENDED, { name: 'X' });
      assert.equal(res.status, 403, String(id));
      assert.equal(res.body.code, 'account_suspended');
      assert.equal(res.body.until, null);
    }
    assert.equal(storedDrink(server, 8).name, 'Post 8');
  });

  test('a missing or malformed id gives 404', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    for (const badId of [999, 'abc', '1e0', '0x1', '-1', '1.0', '0']) {
      assert.equal((await edit(server, badId, OWNER, { name: 'X' })).status, 404, String(badId));
    }
  });

  test('not the owner: 403, but 404 when blocked either way or the post is hidden from the caller', async (t) => {
    const server = await startServer({ ADMIN_USER_IDS: ADMIN }, { dbFixture: fixture() });
    t.after(() => server.stop());

    const other = await edit(server, 1, OTHER, { name: 'X' });
    assert.equal(other.status, 403);
    assert.equal((await edit(server, 4, OWNER, { name: 'X' })).status, 404, 'the author blocked the caller');
    assert.equal((await edit(server, 5, OWNER, { name: 'X' })).status, 404, 'the caller blocked the author');
    assert.equal((await edit(server, 7, OWNER, { name: 'X' })).status, 404, 'hidden after reports');
    assert.equal((await edit(server, 7, ADMIN, { name: 'X' })).status, 403, 'an admin sees it, but is not the owner');
    // The ownership check comes before validation: a bad body changes nothing in the answer.
    assert.equal((await edit(server, 3, OWNER, { imageData: IMAGE })).status, 403);
    for (const id of [1, 3, 4, 5, 7]) assert.equal(storedDrink(server, id).name, `Post ${id}`);
  });

  test('the owner of a post hidden pending review gets 409 hidden_pending_review', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    const res = await edit(server, 6, OWNER, { name: 'Clean name' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'hidden_pending_review');
    // Before validation too.
    assert.equal((await edit(server, 6, OWNER, {})).status, 409);
    assert.equal(storedDrink(server, 6).name, 'Post 6');
    assert.equal(storedDrink(server, 6).editedAt, undefined);
  });
});

describe('PUT /api/drinks/:id validation', () => {
  test('an empty body, unknown fields only, or a non-object body give 400', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    for (const body of [{}, { tags: ['beer'] }, { imageUrl: 'x' }, [], 'name']) {
      const res = await edit(server, 1, OWNER, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const nothing = await call(server, 'PUT', '/api/drinks/1', OWNER);
    assert.equal(nothing.status, 400, 'no body at all');
    assert.equal((await call(server, 'PUT', '/api/drinks/1', OWNER, undefined, { rawBody: '{bad' })).status, 400);
    assert.equal(storedDrink(server, 1).editedAt, undefined);
  });

  test('imageData gives 400 "Image cannot be changed", even next to valid fields', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    for (const body of [{ imageData: IMAGE }, { name: 'New', imageData: IMAGE }, { name: 'New', imageData: null }]) {
      const res = await edit(server, 1, OWNER, body);
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'Image cannot be changed');
    }
    assert.equal(storedDrink(server, 1).name, 'Post 1');
    assert.equal(storedDrink(server, 1).imageUrl, IMAGE);
  });

  test('whitespace-only or non-string text gives 400 and changes nothing', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    const cases = [
      { name: '   ' }, { name: '\u0000\u0001' }, { name: '' }, { name: null }, { name: 5 },
      { description: ' \n\t ' }, { description: '' }, { description: null }, { description: ['x'] },
      { location: '   ' }, { location: 5 }, { location: { a: 1 } },
      // One bad field refuses the whole edit.
      { name: 'Fine', description: '   ' },
    ];
    for (const body of cases) {
      const res = await edit(server, 1, OWNER, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const stored = storedDrink(server, 1);
    assert.equal(stored.name, 'Post 1');
    assert.equal(stored.description, 'Plain words');
    assert.equal(stored.location, 'Cluj');
    assert.equal(stored.editedAt, undefined);
  });

  test('text that is too long is cut to 120, 1000 and 180 characters and trimmed', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    const res = await edit(server, 1, OWNER, {
      name: `  ${'n'.repeat(200)}`, description: 'd'.repeat(1500), location: 'l'.repeat(300),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'n'.repeat(120));
    assert.equal(res.body.description, 'd'.repeat(1000));
    assert.equal(res.body.location, 'l'.repeat(180));
    const stored = storedDrink(server, 1);
    assert.equal(stored.name.length, 120);
    assert.equal(stored.description.length, 1000);
    assert.equal(stored.location.length, 180);
  });

  test('text is stored plain with control characters removed', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    const res = await edit(server, 1, OWNER, { name: 'Gin & <Tonic>\u0007', description: 'Line one\nLine\ttwo' });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Gin & <Tonic>');
    assert.equal(res.body.description, 'Line one\nLine two');
  });

  test('rating must be a number from 0 to 5', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    for (const rating of [-1, 5.5, 6, '4', null, true, [3]]) {
      const res = await edit(server, 1, OWNER, { rating });
      assert.equal(res.status, 400, JSON.stringify(rating));
    }
    assert.equal(storedDrink(server, 1).rating, 4);
    for (const rating of [0, 2.5, 5]) {
      const res = await edit(server, 1, OWNER, { rating });
      assert.equal(res.status, 200);
      assert.equal(res.body.rating, rating);
    }
  });

  test('isAlcoholic must be a boolean', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    for (const isAlcoholic of ['true', 'false', 1, 0, null, {}]) {
      const res = await edit(server, 2, OWNER, { isAlcoholic });
      assert.equal(res.status, 400, JSON.stringify(isAlcoholic));
    }
    assert.equal(storedDrink(server, 2).isAlcoholic, false);
  });

  test('the body is parsed by the 100 KB parser, not the 10 MB post parser', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    const res = await edit(server, 1, OWNER, { description: 'x'.repeat(150 * 1024) });
    assert.equal(res.status, 413);
    assert.equal(storedDrink(server, 1).description, 'Plain words');
  });
});

describe('PUT /api/drinks/:id category and alcoholic flag', () => {
  test('a category must match the flag the post will have after the edit', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    // Post 1 is alcoholic, stored as wine.
    for (const category of ['tea', 'whisky', 'Wine', '', 5]) {
      const res = await edit(server, 1, OWNER, { category });
      assert.equal(res.status, 400, JSON.stringify(category));
    }
    assert.deepEqual(storedDrink(server, 1).tags, ['wine']);

    const beer = await edit(server, 1, OWNER, { category: 'beer' });
    assert.equal(beer.status, 200);
    assert.deepEqual(beer.body.tags, ['beer']);
    const cleared = await edit(server, 1, OWNER, { category: null });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.body.tags, []);
    assert.deepEqual(storedDrink(server, 1).tags, []);
  });

  test('flipping the flag with a stored category of the other side needs a new category or null', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    const missing = await edit(server, 1, OWNER, { isAlcoholic: false });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'category_required');
    const wrong = await edit(server, 1, OWNER, { isAlcoholic: false, category: 'beer' });
    assert.equal(wrong.status, 400);
    let stored = storedDrink(server, 1);
    assert.equal(stored.isAlcoholic, true);
    assert.deepEqual(stored.tags, ['wine']);

    const tea = await edit(server, 1, OWNER, { isAlcoholic: false, category: 'tea' });
    assert.equal(tea.status, 200);
    assert.equal(tea.body.isAlcoholic, false);
    assert.deepEqual(tea.body.tags, ['tea']);

    const back = await edit(server, 1, OWNER, { isAlcoholic: true, category: null });
    assert.equal(back.status, 200);
    stored = storedDrink(server, 1);
    assert.equal(stored.isAlcoholic, true);
    assert.deepEqual(stored.tags, []);
  });

  test('flipping the flag of a post without a category needs no category', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    const res = await edit(server, 2, OWNER, { isAlcoholic: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.isAlcoholic, true);
    assert.deepEqual(res.body.tags, []);
  });

  test('a missing isAlcoholic keeps the stored value, never the create default', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    // Post 2 is non-alcoholic; the create default would be alcoholic.
    const res = await edit(server, 2, OWNER, { name: 'Renamed', category: 'coffee' });
    assert.equal(res.status, 200);
    assert.equal(res.body.isAlcoholic, false);
    assert.deepEqual(res.body.tags, ['coffee']);
    // An alcoholic category is checked against the stored flag too.
    assert.equal((await edit(server, 2, OWNER, { category: 'beer' })).status, 400);
    const alcoholic = await edit(server, 1, OWNER, { description: 'Still wine' });
    assert.equal(alcoholic.body.isAlcoholic, true);
    await server.restart();
    assert.equal(storedDrink(server, 2).isAlcoholic, false);
    assert.equal(storedDrink(server, 1).isAlcoholic, true);
  });

  test('the Explore category filter follows the edit', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    const ids = async (category) => (await call(server, 'GET', `/api/drinks?category=${category}`, OTHER)).body.items.map((d) => d.id);
    assert.ok((await ids('wine')).includes(1));
    assert.equal((await edit(server, 1, OWNER, { isAlcoholic: false, category: 'mocktail' })).status, 200);
    assert.ok(!(await ids('wine')).includes(1));
    assert.ok((await ids('mocktail')).includes(1));
  });
});

describe('PUT /api/drinks/:id saving', () => {
  test('each field changes, the answer is the decorated post with editedAt, and it survives a restart', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    const before = Date.now();
    const res = await edit(server, 1, OWNER, {
      name: 'Negroni', description: 'Bitter and sweet', rating: 3, location: 'Bucharest', isAlcoholic: true, category: 'cocktail',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, 1);
    assert.equal(res.body.name, 'Negroni');
    assert.equal(res.body.description, 'Bitter and sweet');
    assert.equal(res.body.rating, 3);
    assert.equal(res.body.location, 'Bucharest');
    assert.equal(res.body.isAlcoholic, true);
    assert.deepEqual(res.body.tags, ['cocktail']);
    assert.equal(res.body.imageUrl, '/media/drinks/1', 'an image path, never the bytes');
    assert.equal(res.body.user.id, OWNER);
    assert.equal(res.body.isPartner, true);
    assert.equal(res.body.createdAt, OLD, 'createdAt stays');
    const editedAt = new Date(res.body.editedAt).getTime();
    assert.ok(editedAt >= before - 1000 && editedAt <= Date.now() + 1000);

    // One field at a time too.
    assert.equal((await edit(server, 1, OWNER, { rating: 1 })).body.rating, 1);
    const cleared = await edit(server, 1, OWNER, { location: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.location, null);
    assert.equal(cleared.body.name, 'Negroni', 'a missing field stays');

    const check = async () => {
      const got = await getDrink(server, 1, OTHER);
      assert.equal(got.status, 200);
      assert.equal(got.body.name, 'Negroni');
      assert.equal(got.body.description, 'Bitter and sweet');
      assert.equal(got.body.rating, 1);
      assert.equal(got.body.location, null);
      assert.deepEqual(got.body.tags, ['cocktail']);
      assert.equal(typeof got.body.editedAt, 'string');
      const stored = storedDrink(server, 1);
      assert.equal(stored.imageUrl, IMAGE);
      assert.equal(stored.editedAt, got.body.editedAt);
    };
    await check();
    await server.restart();
    await check();
  });

  test('an empty string location clears it', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    const res = await edit(server, 1, OWNER, { location: '' });
    assert.equal(res.status, 200);
    assert.equal(res.body.location, null);
  });

  test('a change that leaves the post as it is answers 200 without saving or a new editedAt', async (t) => {
    const server = await startServer(FAULT_ENV, { dbFixture: fixture() });
    t.after(() => server.stop());

    failSaves(server);
    const sameValues = [
      { name: 'Post 1' }, { name: '  Post 1  ' }, { description: 'Plain words' }, { rating: 4 },
      { location: 'Cluj' }, { isAlcoholic: true }, { category: 'wine' },
      { name: 'Post 1', description: 'Plain words', rating: 4, location: 'Cluj', isAlcoholic: true, category: 'wine' },
    ];
    for (const body of sameValues) {
      const res = await edit(server, 1, OWNER, body);
      assert.equal(res.status, 200, `${JSON.stringify(body)}: saves are failing, so a save would give 503`);
      assert.equal(res.body.editedAt, undefined);
    }
    // Post 2 has no location and no category.
    for (const body of [{ location: null }, { location: '' }, { category: null }]) {
      assert.equal((await edit(server, 2, OWNER, body)).status, 200, JSON.stringify(body));
    }
    allowSaves(server);
    assert.equal(storedDrink(server, 1).editedAt, undefined);
  });

  test('a failed save answers 503 and leaves the post unchanged', async (t) => {
    const server = await startServer(FAULT_ENV, { dbFixture: fixture() });
    t.after(() => server.stop());

    failSaves(server);
    const res = await edit(server, 1, OWNER, {
      name: 'Failed', description: 'Failed', rating: 1, location: null, isAlcoholic: false, category: 'tea',
    });
    assert.equal(res.status, 503);
    const got = await getDrink(server, 1);
    assert.equal(got.body.name, 'Post 1');
    assert.equal(got.body.description, 'Plain words');
    assert.equal(got.body.rating, 4);
    assert.equal(got.body.location, 'Cluj');
    assert.equal(got.body.isAlcoholic, true);
    assert.deepEqual(got.body.tags, ['wine']);
    assert.equal(got.body.editedAt, undefined);
    const search = await call(server, 'GET', '/api/drinks?q=Failed', OTHER);
    assert.deepEqual(search.body.items, []);

    allowSaves(server);
    const retry = await edit(server, 1, OWNER, { name: 'Worked' });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.description, 'Plain words', 'the failed edit left nothing behind');
    assert.equal(storedDrink(server, 1).name, 'Worked');
  });

  test('a failed save of a post edited before keeps its earlier editedAt', async (t) => {
    const earlier = '2026-02-02T02:02:02.000Z';
    const server = await startServer(FAULT_ENV, { dbFixture: fixture({ drinks: [post(1, OWNER, { editedAt: earlier })] }) });
    t.after(() => server.stop());

    failSaves(server);
    assert.equal((await edit(server, 1, OWNER, { name: 'Failed' })).status, 503);
    allowSaves(server);
    const got = await getDrink(server, 1);
    assert.equal(got.body.editedAt, earlier);
    assert.equal(got.body.name, 'Post 1');
  });

  test('search finds the new text and no longer the old', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    const search = async (q) => (await call(server, 'GET', `/api/drinks?q=${encodeURIComponent(q)}`, OTHER)).body.items.map((d) => d.id);
    assert.deepEqual(await search('Post 1'), [1]);
    const res = await edit(server, 1, OWNER, { name: 'Zanzibar', description: 'Quokka notes', location: 'Timbuktu' });
    assert.equal(res.status, 200);
    assert.deepEqual(await search('Post 1'), []);
    assert.deepEqual(await search('zanzibar'), [1]);
    assert.deepEqual(await search('quokka'), [1]);
    assert.deepEqual(await search('timbuktu'), [1]);
    const oldDescription = await search('Plain words');
    assert.ok(!oldDescription.includes(1));
    assert.ok(oldDescription.includes(2), 'other posts still match the old description');
  });

  test('an edit records no limit event and has no daily cap', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    for (let i = 0; i < 25; i++) {
      assert.equal((await edit(server, 1, OWNER, { name: `Name ${i}` })).status, 200, `edit ${i}`);
    }
    assert.deepEqual(readDb(server).limitEventsByUser, {});
  });

  test('the mutation rate limiter applies', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    const statuses = [];
    for (let i = 0; i < 31; i++) statuses.push((await edit(server, 1, OWNER, { rating: i % 2 })).status);
    assert.ok(statuses.slice(0, 30).every((status) => status === 200));
    assert.equal(statuses[30], 429);
  });

  test('with the growth guard on, only an edit that does not make the post bigger is saved', async (t) => {
    const earlier = '2026-02-02T02:02:02.000Z';
    const server = await startServer({ DB_GROWTH_MAX_BYTES: '1' }, {
      dbFixture: fixture({ drinks: [post(1, OWNER, { editedAt: earlier }), post(2, OWNER)] }),
    });
    t.after(() => server.stop());

    const longer = await edit(server, 1, OWNER, { name: 'A much longer name than before' });
    assert.equal(longer.status, 507);
    assert.equal(longer.body.code, 'storage_full');
    const multibyte = await edit(server, 1, OWNER, { name: 'Pöst 1' });
    assert.equal(multibyte.status, 507, 'counted in UTF-8 bytes, not characters');
    // Post 2 was never edited: adding editedAt makes the stored record bigger.
    assert.equal((await edit(server, 2, OWNER, { name: 'P2' })).status, 507);
    assert.equal(storedDrink(server, 1).name, 'Post 1');

    const shorter = await edit(server, 1, OWNER, { name: 'Short' });
    assert.equal(shorter.status, 200);
    assert.equal(shorter.body.name, 'Short');
    const sameSize = await edit(server, 1, OWNER, { name: 'Shirt' });
    assert.equal(sameSize.status, 200);
    assert.equal((await edit(server, 1, OWNER, { name: 'Shirt' })).status, 200, 'a no-op is never refused');
    assert.equal(storedDrink(server, 1).name, 'Shirt');
  });
});

describe('PUT /api/drinks/:id and the rest of the app', () => {
  test('the admin report target shows the current content and editedAt', async (t) => {
    const server = await startServer({ ADMIN_USER_IDS: ADMIN }, {
      dbFixture: fixture({ reports: [openReport(1, OTHER, 1)], nextReportId: 2 }),
    });
    t.after(() => server.stop());

    const targetOf = async () => (await call(server, 'GET', '/api/admin/reports', ADMIN)).body.items.find((r) => r.id === 1).target;
    const before = await targetOf();
    assert.equal(before.name, 'Post 1');
    assert.equal('editedAt' in before, false);

    const res = await edit(server, 1, OWNER, { name: 'Edited name', description: 'Edited description' });
    assert.equal(res.status, 200);
    const after = await targetOf();
    assert.equal(after.name, 'Edited name');
    assert.equal(after.description, 'Edited description');
    assert.equal(after.editedAt, res.body.editedAt);
    assert.equal('email' in after.user, false);
  });

  test('no edit history is stored: the old text is gone from the file', async (t) => {
    const server = await startServer({}, { dbFixture: fixture({ drinks: [post(1, OWNER, { name: 'Oldname-Xq7', description: 'Olddesc-Zr9' })] }) });
    t.after(() => server.stop());

    assert.equal((await edit(server, 1, OWNER, { name: 'New name', description: 'New description' })).status, 200);
    const raw = fs.readFileSync(server.dbFile, 'utf8');
    assert.ok(!raw.includes('Oldname-Xq7'));
    assert.ok(!raw.includes('Olddesc-Zr9'));
  });

  test('account deletion still removes edited posts', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    assert.equal((await edit(server, 1, OWNER, { name: 'Edited-Kp3' })).status, 200);
    const deleted = await call(server, 'POST', `/api/users/${OWNER}/delete-account`, OWNER, {});
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, true);
    const db = readDb(server);
    assert.ok(!db.drinks.some((d) => d.userId === OWNER));
    assert.ok(!fs.readFileSync(server.dbFile, 'utf8').includes('Edited-Kp3'));
    assert.equal((await getDrink(server, 1, OTHER)).status, 404);
  });

  test('deleting an edited post still works', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    assert.equal((await edit(server, 1, OWNER, { name: 'Edited' })).status, 200);
    assert.equal((await call(server, 'DELETE', '/api/drinks/1', OWNER)).status, 204);
    assert.equal((await edit(server, 1, OWNER, { name: 'Again' })).status, 404);
  });
});

describe('PUT /api/drinks/:id fix loop 1', () => {
  const snapshotFixture = (extra = {}) => fixture({
    reports: [openReport(1, 'rep-1', 1), openReport(2, 'rep-2', 1), openReport(3, 'rep-1', 3)],
    nextReportId: 4,
    ...extra,
  });
  const adminReports = async (server, status = 'open') => (await call(server, 'GET', `/api/admin/reports?status=${status}`, ADMIN)).body.items;
  const AS_REPORTED = { name: 'Post 1', description: 'Plain words', location: 'Cluj', isAlcoholic: true, category: 'wine' };
  const deleteAccount = (server, uid) => call(server, 'POST', `/api/users/${uid}/delete-account`, uid, {});

  test('the first edit after a report stores the content as reported on each open report, and a second edit does not overwrite it', async (t) => {
    const server = await startServer({ ADMIN_USER_IDS: ADMIN }, { dbFixture: snapshotFixture() });
    t.after(() => server.stop());

    const first = await edit(server, 1, OWNER, { name: 'Harmless', description: 'Nothing to see', isAlcoholic: false, category: 'tea' });
    assert.equal(first.status, 200);
    let stored = readDb(server).reports;
    for (const id of [1, 2]) {
      const { capturedAt, ...content } = stored.find((r) => r.id === id).targetSnapshot;
      assert.deepEqual(content, AS_REPORTED);
      assert.equal(typeof capturedAt, 'string');
    }
    assert.equal(stored.find((r) => r.id === 3).targetSnapshot, undefined, 'a report on another post is untouched');
    const capturedAt = stored.find((r) => r.id === 1).targetSnapshot.capturedAt;

    assert.equal((await edit(server, 1, OWNER, { name: 'Second edit' })).status, 200);
    stored = readDb(server).reports;
    assert.deepEqual(stored.find((r) => r.id === 1).targetSnapshot, { ...AS_REPORTED, capturedAt });

    const items = await adminReports(server);
    const item = items.find((r) => r.id === 1);
    assert.equal(item.editedAfterReport, true);
    assert.equal(item.targetSnapshot.name, 'Post 1');
    assert.equal(item.target.name, 'Second edit');
    assert.equal(item.target.category, 'tea');
    assert.equal(item.target.rating, 4);
    assert.equal(items.find((r) => r.id === 3).editedAfterReport, false);
    assert.equal('targetSnapshot' in items.find((r) => r.id === 3), false);
  });

  test('an edit with no open reports stores nothing, and a later report shows editedAfterReport false', async (t) => {
    const server = await startServer({ ADMIN_USER_IDS: ADMIN }, { dbFixture: fixture({ reports: [], nextReportId: 1 }) });
    t.after(() => server.stop());

    assert.equal((await edit(server, 1, OWNER, { name: 'Edited first' })).status, 200);
    assert.deepEqual(readDb(server).reports, []);
    const filed = await call(server, 'POST', '/api/reports', OTHER, { targetType: 'drink', targetId: 1, reason: 'spam' });
    assert.equal(filed.status, 201);
    const [item] = await adminReports(server);
    assert.equal(item.editedAfterReport, false);
    assert.equal(item.targetSnapshot, undefined);
  });

  test('a resolved report gets no snapshot', async (t) => {
    const resolvedReport = { ...openReport(1, 'rep-1', 1), status: 'resolved', action: 'dismiss', removed: false, resolvedAt: ago(1), resolvedBy: ADMIN };
    const server = await startServer({}, { dbFixture: fixture({ reports: [resolvedReport], nextReportId: 2 }) });
    t.after(() => server.stop());

    assert.equal((await edit(server, 1, OWNER, { name: 'Edited' })).status, 200);
    assert.equal(readDb(server).reports[0].targetSnapshot, undefined);
  });

  test('resolving the report deletes the snapshot', async (t) => {
    const server = await startServer({ ADMIN_USER_IDS: ADMIN }, { dbFixture: snapshotFixture() });
    t.after(() => server.stop());

    assert.equal((await edit(server, 1, OWNER, { name: 'Edited' })).status, 200);
    const resolved = await call(server, 'POST', '/api/admin/reports/1/resolve', ADMIN, { action: 'dismiss' });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.targetSnapshot, undefined);
    const stored = readDb(server).reports;
    assert.equal(stored.find((r) => r.id === 1).targetSnapshot, undefined);
    assert.equal(stored.find((r) => r.id === 2).targetSnapshot, undefined, 'every open report on the target is resolved');
    assert.ok(!stored.some((r) => r.targetSnapshot));
  });

  test('a failed resolve keeps the snapshot', async (t) => {
    const server = await startServer({ ...FAULT_ENV, ADMIN_USER_IDS: ADMIN }, { dbFixture: snapshotFixture() });
    t.after(() => server.stop());

    assert.equal((await edit(server, 1, OWNER, { name: 'Edited' })).status, 200);
    failSaves(server);
    assert.equal((await call(server, 'POST', '/api/admin/reports/1/resolve', ADMIN, { action: 'dismiss' })).status, 503);
    allowSaves(server);
    const item = (await adminReports(server)).find((r) => r.id === 1);
    assert.equal(item.targetSnapshot.name, 'Post 1');
  });

  test('a failed save removes the snapshots taken in that request', async (t) => {
    const server = await startServer({ ...FAULT_ENV, ADMIN_USER_IDS: ADMIN }, { dbFixture: snapshotFixture() });
    t.after(() => server.stop());

    failSaves(server);
    assert.equal((await edit(server, 1, OWNER, { name: 'Failed' })).status, 503);
    allowSaves(server);
    const items = await adminReports(server);
    for (const id of [1, 2]) {
      const item = items.find((r) => r.id === id);
      assert.equal('targetSnapshot' in item, false);
      assert.equal(item.editedAfterReport, false);
      assert.equal(item.target.name, 'Post 1');
    }
    // The next good edit still captures the content as reported.
    assert.equal((await edit(server, 1, OWNER, { name: 'Worked' })).status, 200);
    assert.equal(readDb(server).reports.find((r) => r.id === 1).targetSnapshot.name, 'Post 1');
  });

  test('account deletion removes snapshots: an anonymised report keeps none, and the owner deletion removes the reports', async (t) => {
    const server = await startServer({}, { dbFixture: snapshotFixture() });
    t.after(() => server.stop());

    assert.equal((await edit(server, 1, OWNER, { name: 'Edited' })).status, 200);
    assert.equal((await deleteAccount(server, 'rep-2')).status, 200);
    const anonymised = readDb(server).reports.find((r) => r.id === 2);
    assert.equal(anonymised.reporterDeleted, true);
    assert.equal(anonymised.targetSnapshot, undefined);
    assert.ok(readDb(server).reports.find((r) => r.id === 1).targetSnapshot, 'other reporters keep theirs');

    assert.equal((await deleteAccount(server, OWNER)).status, 200);
    const stored = readDb(server).reports;
    assert.ok(!stored.some((r) => r.targetType === 'drink' && r.targetId === 1));
    assert.ok(!stored.some((r) => r.targetSnapshot));
  });

  test('flipping a tea post to alcoholic without a category gives category_required', async (t) => {
    const server = await startServer({}, { dbFixture: fixture({ drinks: [post(1, OWNER, { isAlcoholic: false, tags: ['tea'] })] }) });
    t.after(() => server.stop());

    const res = await edit(server, 1, OWNER, { isAlcoholic: true });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'category_required');
    assert.equal(storedDrink(server, 1).isAlcoholic, false);
    assert.equal((await edit(server, 1, OWNER, { isAlcoholic: true, category: 'spirits' })).status, 200);
  });

  test('isAlcoholic true on a legacy post without the field is a no-op', async (t) => {
    const { isAlcoholic, ...legacy } = post(1, OWNER);
    assert.equal(isAlcoholic, true);
    const server = await startServer(FAULT_ENV, { dbFixture: fixture({ drinks: [legacy] }) });
    t.after(() => server.stop());

    failSaves(server);
    const res = await edit(server, 1, OWNER, { isAlcoholic: true });
    assert.equal(res.status, 200, 'a save would give 503');
    assert.equal(res.body.editedAt, undefined);
    allowSaves(server);
    assert.equal('isAlcoholic' in storedDrink(server, 1), false);
  });

  test('__proto__ and constructor keys in the body change nothing', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    const raw = (rawBody) => call(server, 'PUT', '/api/drinks/1', OWNER, undefined, { rawBody });
    assert.equal((await raw('{"__proto__":{"name":"Polluted","editedAt":"x"}}')).status, 400);
    assert.equal((await raw('{"constructor":{"prototype":{"name":"Polluted"}}}')).status, 400);
    const mixed = await raw('{"__proto__":{"rating":1},"constructor":{"prototype":{"x":1}},"name":"Clean"}');
    assert.equal(mixed.status, 200);
    assert.equal(mixed.body.name, 'Clean');
    assert.equal(mixed.body.rating, 4);
    const stored = storedDrink(server, 1);
    assert.equal(stored.rating, 4);
    assert.equal(Object.hasOwn(stored, '__proto__'), false);
    assert.equal(Object.hasOwn(stored, 'constructor'), false);
    assert.equal((await getDrink(server, 2)).body.name, 'Post 2');
    assert.equal((await getDrink(server, 2)).body.x, undefined, 'no prototype pollution on the server');
  });

  test('a deleted account token gets 401 on PUT', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    assert.equal((await deleteAccount(server, OWNER)).status, 200);
    assert.equal((await edit(server, 2, OWNER, { name: 'Ghost' })).status, 401);
    assert.equal((await edit(server, 3, 'never-existed', { name: 'Ghost' })).status, 401);
  });
});
