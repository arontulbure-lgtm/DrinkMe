import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { startServer } from './helpers/harness.js';

// Task E: post categories. POST /api/drinks takes an optional `category` that must match isAlcoholic
// (which defaults to true) and is stored as tags: [category]. GET /api/drinks takes ?category= and
// filters on the server before paging, with the age gate, blocks and the hide after reports still applied.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_FILE = path.resolve(TEST_DIR, '..', 'server.js');
const CLIENT_TYPES_FILE = path.resolve(TEST_DIR, '..', '..', 'src', 'types', 'api.ts');

const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const HOUR_MS = 60 * 60 * 1000;
const OLD = '2026-01-01T00:00:00.000Z';
const CONFIRMED_AT = '2026-01-02T03:04:05.000Z';
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const ago = (hours) => new Date(Date.now() - hours * HOUR_MS).toISOString();
const tokenFor = (uid) => jwt.sign({ uid }, HARNESS_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const readDb = (server) => JSON.parse(fs.readFileSync(server.dbFile, 'utf8'));

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

const person = (id, extra = {}) => ({
  id, email: `${id}@example.test`, firstName: `Name-${id}`, lastName: 'Test', city: 'Cluj', bio: '',
  nameSetByUser: true, avatar: null, ageConfirmedAt: CONFIRMED_AT, privacyNoticeVersion: 2, ...extra,
});
const post = (id, userId, category, extra = {}) => ({
  id, userId, name: `Post ${id}`, description: 'Plain', rating: 4, location: 'Cluj',
  isAlcoholic: !['mocktail', 'coffee', 'tea', 'other'].includes(category) && category !== 'none-na',
  createdAt: OLD, cheersCount: 0, tags: category && category !== 'none-na' ? [category] : [], imageUrl: IMAGE, ...extra,
});
const openReport = (id, reporterId, targetId) => ({
  id, reporterId, targetType: 'drink', targetId, reason: 'spam', details: null, status: 'open', createdAt: ago(1),
});

const createBody = (extra = {}) => ({ name: 'New', description: 'Fresh post', rating: 4, imageData: IMAGE, ...extra });
const createPost = (server, uid, extra) => call(server, 'POST', '/api/drinks', uid, createBody(extra));

describe('POST /api/drinks category', () => {
  const fixture = () => ({
    dbSchemaVersion: 2,
    users: [
      person('poster'),
      person('suspended', { suspensions: [{ startedAt: ago(1), permanent: true, reason: 'test', by: 'admin' }] }),
    ],
    drinks: [],
    nextDrinkId: 1,
    limitEventsByUser: {},
  });

  test('each invalid category gives 400 and stores nothing', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    const cases = [
      ['unknown value', { category: 'whisky', isAlcoholic: true }],
      ['wrong case', { category: 'Wine', isAlcoholic: true }],
      ['empty string', { category: '', isAlcoholic: true }],
      ['number', { category: 5, isAlcoholic: true }],
      ['array', { category: ['wine'], isAlcoholic: true }],
      ['object', { category: { name: 'wine' }, isAlcoholic: true }],
      ['boolean', { category: true, isAlcoholic: true }],
      ['alcoholic category on a non-alcoholic post', { category: 'wine', isAlcoholic: false }],
      ['every other alcoholic category on a non-alcoholic post', { category: 'spirits', isAlcoholic: false }],
      ['non-alcoholic category on an alcoholic post', { category: 'mocktail', isAlcoholic: true }],
      ['non-alcoholic category with isAlcoholic missing (defaults to alcoholic)', { category: 'tea' }],
      ['isAlcoholic as the string "false"', { category: 'coffee', isAlcoholic: 'false' }],
      ['isAlcoholic as the string "true"', { category: 'wine', isAlcoholic: 'true' }],
      ['isAlcoholic as a number', { category: 'tea', isAlcoholic: 0 }],
      ['isAlcoholic null', { category: 'wine', isAlcoholic: null }],
      ['non-boolean isAlcoholic without a category', { isAlcoholic: 'false' }],
      ['isAlcoholic as an object', { isAlcoholic: {} }],
      ['"other" on an alcoholic post', { category: 'other', isAlcoholic: true }],
    ];
    for (const [label, extra] of cases) {
      const res = await createPost(server, 'poster', extra);
      assert.equal(res.status, 400, label);
      assert.equal(typeof res.body.error, 'string', label);
    }
    const db = readDb(server);
    assert.deepEqual(db.drinks, [], 'nothing stored');
    assert.equal(db.nextDrinkId, 1);
    assert.deepEqual(db.limitEventsByUser.poster ?? [], [], 'no daily limit used');
  });

  test('a valid category is stored as tags: [category]; none or null stores []', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    const cases = [
      [{ category: 'cocktail', isAlcoholic: true }, ['cocktail'], true],
      [{ category: 'wine', isAlcoholic: true }, ['wine'], true],
      [{ category: 'beer', isAlcoholic: true }, ['beer'], true],
      [{ category: 'spirits' }, ['spirits'], true], // isAlcoholic missing: alcoholic
      [{ category: 'mocktail', isAlcoholic: false }, ['mocktail'], false],
      [{ category: 'coffee', isAlcoholic: false }, ['coffee'], false],
      [{ category: 'tea', isAlcoholic: false }, ['tea'], false],
      [{ category: 'other', isAlcoholic: false }, ['other'], false],
      [{ isAlcoholic: true }, [], true],
      [{ isAlcoholic: false }, [], false],
      [{ category: null, isAlcoholic: false }, [], false],
    ];
    const created = [];
    for (const [extra, tags, isAlcoholic] of cases) {
      const res = await createPost(server, 'poster', extra);
      assert.equal(res.status, 201, JSON.stringify(extra));
      assert.deepEqual(res.body.tags, tags, JSON.stringify(extra));
      assert.equal(res.body.isAlcoholic, isAlcoholic, JSON.stringify(extra));
      assert.equal('category' in res.body, false, 'no new field');
      created.push([res.body.id, tags]);
    }
    const stored = new Map(readDb(server).drinks.map((d) => [d.id, d]));
    for (const [id, tags] of created) {
      assert.deepEqual(stored.get(id).tags, tags);
      assert.equal('category' in stored.get(id), false, 'no new stored field');
    }
    const detail = await call(server, 'GET', `/api/drinks/${created[1][0]}`, 'poster');
    assert.deepEqual(detail.body.tags, ['wine']);
  });

  test('a suspended user is still refused, whatever the category', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());
    const res = await createPost(server, 'suspended', { category: 'wine', isAlcoholic: true });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'account_suspended');
    const bad = await createPost(server, 'suspended', { category: 'whisky' });
    assert.equal(bad.status, 403, 'the suspension is checked before the body');
  });
});

describe('GET /api/drinks ?category=', () => {
  // ids 1..60 by author a and b: every third post is wine, the rest are a mix, so wine posts are spread
  // over what would be several unfiltered pages. Plus special cases from 100 up.
  const WINE_IDS = [];
  const drinks = [];
  const mix = ['beer', 'coffee', null, 'none-na', 'cocktail'];
  for (let id = 1; id <= 60; id += 1) {
    const userId = id % 2 ? 'a' : 'b';
    const location = [30, 31, 33].includes(id) ? 'Iasi centru' : 'Cluj';
    if (id % 3 === 0) {
      WINE_IDS.push(id);
      drinks.push(post(id, userId, 'wine', { cheersCount: id, location }));
    } else {
      drinks.push(post(id, userId, mix[id % mix.length], { location }));
    }
  }
  const BLOCKED_BY_VIEWER = 101;
  const BLOCKER_OF_VIEWER = 102;
  const AUTO_HIDDEN = 103;
  const OWN = 104;
  const PARTNER = 105;
  const INCONSISTENT = 106; // tags say wine but the post is non-alcoholic: never shown under wine
  const LEGACY_NON_ALCOHOLIC = 107; // tags: [] and non-alcoholic
  const TEA = 108;
  drinks.push(
    post(BLOCKED_BY_VIEWER, 'blocked', 'wine', { cheersCount: 1000 }),
    post(BLOCKER_OF_VIEWER, 'blocker', 'wine', { cheersCount: 1000 }),
    post(AUTO_HIDDEN, 'a', 'wine', { cheersCount: 1000 }),
    post(OWN, 'viewer', 'wine', { cheersCount: 1000 }),
    post(PARTNER, 'partner', 'wine', { cheersCount: 1000 }),
    post(INCONSISTENT, 'a', 'wine', { isAlcoholic: false, cheersCount: 1000 }),
    post(LEGACY_NON_ALCOHOLIC, 'a', 'none-na'),
    post(TEA, 'a', 'tea'),
  );
  const fixture = () => ({
    dbSchemaVersion: 2,
    users: ['viewer', 'a', 'b', 'blocked', 'blocker', 'partner', 'r1', 'r2', 'r3'].map((id) => person(id))
      .concat(person('minor', { ageConfirmedAt: undefined })),
    drinks,
    nextDrinkId: 200,
    partnersByUser: { viewer: ['partner'], partner: ['viewer'] },
    blocksByUser: { viewer: ['blocked'], blocker: ['viewer'] },
    reports: ['r1', 'r2', 'r3'].map((reporterId, index) => openReport(index + 1, reporterId, AUTO_HIDDEN)),
    nextReportId: 4,
  });

  const loadAll = async (server, uid, query) => {
    const ids = [];
    let before;
    let pages = 0;
    do {
      const qs = new URLSearchParams({ ...query, ...(before !== undefined && { before: String(before) }) });
      const res = await call(server, 'GET', `/api/drinks?${qs}`, uid);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      pages += 1;
      if (res.body.nextCursor !== null) assert.equal(res.body.items.length, Number(query.limit), 'a page before the last is full');
      ids.push(...res.body.items.map((item) => item.id));
      for (const item of res.body.items) {
        if (query.category) assert.deepEqual(item.tags, [query.category]);
      }
      before = res.body.nextCursor ?? undefined;
      assert.ok(pages < 50, 'paging must end');
    } while (before !== undefined);
    return { ids, pages };
  };

  test('discover pages over the filtered list: full pages, no duplicates, every match once', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    const { ids, pages } = await loadAll(server, 'viewer', { scope: 'discover', category: 'wine', limit: '6' });
    assert.equal(WINE_IDS.length, 20);
    assert.equal(pages, 4, '20 matches at 6 per page');
    assert.equal(new Set(ids).size, ids.length, 'no duplicates');
    assert.deepEqual(ids, [...WINE_IDS].sort((x, y) => y - x), 'exactly the visible wine posts, newest first');

    // The first page is full even though wine is only every third post.
    const first = await call(server, 'GET', '/api/drinks?scope=discover&category=wine&limit=6', 'viewer');
    assert.deepEqual(first.body.items.map((d) => d.id), [60, 57, 54, 51, 48, 45]);
    assert.equal(first.body.nextCursor, 45);
  });

  test('blocks both ways, the hide after reports, own and partners posts, and inconsistent records stay out', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    const discover = await loadAll(server, 'viewer', { scope: 'discover', category: 'wine', limit: '50' });
    for (const id of [BLOCKED_BY_VIEWER, BLOCKER_OF_VIEWER, AUTO_HIDDEN, OWN, PARTNER, INCONSISTENT]) {
      assert.equal(discover.ids.includes(id), false, `post ${id} must not be listed`);
    }

    // Without a scope, own and partners' posts are listed, but blocked and hidden posts are still not.
    const global = await loadAll(server, 'viewer', { category: 'wine', limit: '50' });
    assert.ok(global.ids.includes(OWN));
    assert.ok(global.ids.includes(PARTNER));
    for (const id of [BLOCKED_BY_VIEWER, BLOCKER_OF_VIEWER, AUTO_HIDDEN, INCONSISTENT]) {
      assert.equal(global.ids.includes(id), false, `post ${id} must not be listed`);
    }

    // The hidden post's owner still gets it, marked.
    const owner = await call(server, 'GET', '/api/drinks?category=wine&limit=50', 'a');
    const hidden = owner.body.items.find((d) => d.id === AUTO_HIDDEN);
    assert.equal(hidden?.hiddenPendingReview, true);

    // Trending ranks only the filtered, visible posts.
    const trending = await call(server, 'GET', '/api/drinks?scope=discover&sort=trending&category=wine&limit=5', 'viewer');
    assert.equal(trending.status, 200);
    assert.deepEqual(trending.body.items.map((d) => d.id), [60, 57, 54, 51, 48]);
    assert.equal(trending.body.nextCursor, null);
  });

  test('posts without a category show only under All, and under Non-alcoholic when non-alcoholic', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());

    const all = await loadAll(server, 'viewer', { scope: 'discover', limit: '50' });
    assert.ok(all.ids.includes(LEGACY_NON_ALCOHOLIC));
    const nonAlcoholic = await loadAll(server, 'viewer', { scope: 'discover', alcoholic: 'false', limit: '50' });
    assert.ok(nonAlcoholic.ids.includes(LEGACY_NON_ALCOHOLIC));
    for (const category of ['cocktail', 'wine', 'beer', 'spirits', 'mocktail', 'coffee', 'tea', 'other']) {
      const res = await loadAll(server, 'viewer', { scope: 'discover', category, limit: '50' });
      assert.equal(res.ids.includes(LEGACY_NON_ALCOHOLIC), false, category);
    }

    // A non-alcoholic category combines with alcoholic=false.
    const tea = await loadAll(server, 'viewer', { scope: 'discover', alcoholic: 'false', category: 'tea', limit: '50' });
    assert.deepEqual(tea.ids, [TEA]);
  });

  test('category combines with the city filter', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());
    const res = await call(server, 'GET', '/api/drinks?scope=discover&category=wine&city=iasi', 'viewer');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((d) => d.id), [33, 30], 'wine posts in Iasi only; coffee post 31 left out');
    assert.equal(res.body.nextCursor, null);
  });

  test('an invalid category value gives 400', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());
    const bad = [
      'category=whisky',
      'category=WINE',
      'category=',
      'category=wine&category=beer',
      'category[0]=wine',
      'category[__proto__]=wine',
      'category[a]=wine',
      'category=__proto__',
      'category=constructor',
      'category=toString',
      'scope=discover&category=whisky',
      'scope=discover&alcoholic=false&category=wine', // contradiction
      'scope=discover&alcoholic=false&category=spirits',
    ];
    for (const qs of bad) {
      const res = await call(server, 'GET', `/api/drinks?${qs}`, 'viewer');
      assert.equal(res.status, 400, qs);
    }
  });

  test('the sign-in and age gate still apply', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());
    const signedOut = await call(server, 'GET', '/api/drinks?scope=discover&category=wine', undefined);
    assert.equal(signedOut.status, 401);
    const minor = await call(server, 'GET', '/api/drinks?scope=discover&category=mocktail', 'minor');
    assert.equal(minor.status, 403);
    assert.equal(minor.body.code, 'age_required');
  });
});

describe('category lists stay in sync', () => {
  const extractArray = (source, pattern, label) => {
    const match = source.match(pattern);
    assert.ok(match, `${label} not found`);
    return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  };

  test('src/types/api.ts declares the same lists as server.js', () => {
    const server = fs.readFileSync(SERVER_FILE, 'utf8');
    const client = fs.readFileSync(CLIENT_TYPES_FILE, 'utf8');
    const serverAlcoholic = extractArray(server, /\balcoholic:\s*Object\.freeze\(\[([^\]]*)\]\)/, 'server alcoholic list');
    const serverNonAlcoholic = extractArray(server, /\bnonAlcoholic:\s*Object\.freeze\(\[([^\]]*)\]\)/, 'server nonAlcoholic list');
    const clientAlcoholic = extractArray(client, /export const ALCOHOLIC_DRINK_CATEGORIES = \[([^\]]*)\] as const;/, 'client ALCOHOLIC_DRINK_CATEGORIES');
    const clientNonAlcoholic = extractArray(client, /export const NON_ALCOHOLIC_DRINK_CATEGORIES = \[([^\]]*)\] as const;/, 'client NON_ALCOHOLIC_DRINK_CATEGORIES');

    assert.deepEqual(serverAlcoholic, ['cocktail', 'wine', 'beer', 'spirits']);
    assert.deepEqual(serverNonAlcoholic, ['mocktail', 'coffee', 'tea', 'other']);
    assert.deepEqual(clientAlcoholic, serverAlcoholic);
    assert.deepEqual(clientNonAlcoholic, serverNonAlcoholic);
  });
});
