// Owner decision: nothing is readable without signing in, and a signed-in user who has not confirmed
// they are 18+ can only do what the first-run flow needs (requireSignedInAdult in server.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { REAL_DB_FILE, startServer } from './helpers/harness.js';

const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const CONFIRMED_AT = '2026-01-02T03:04:05.000Z';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;
const PLAIN_TEXT = 'Plain Lemonade';
const COMMENT_TEXT = 'Visible comment';

const tokenFor = (uid) => jwt.sign({ uid }, HARNESS_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

const person = (id, extra = {}) => ({
  id, email: `${id}@example.test`, firstName: id, lastName: 'Test', city: 'Cluj', bio: 'Bio', nameSetByUser: true, avatar: PNG_DATA_URL, ...extra,
});

const fixture = () => ({
  users: [person('adult', { ageConfirmedAt: CONFIRMED_AT }), person('minor', { privacyNoticeVersion: 1 })],
  drinks: [{
    id: 1, userId: 'adult', name: PLAIN_TEXT, description: 'Plain', rating: 4, location: 'Cluj', isAlcoholic: false,
    createdAt: '2026-01-01T00:00:00.000Z', cheersCount: 0, tags: [], imageUrl: PNG_DATA_URL,
  }],
  nextDrinkId: 2,
  commentsByDrink: { 1: [{ id: 1, drinkId: 1, userId: 'adult', content: COMMENT_TEXT, createdAt: '2026-01-01T00:00:00.000Z' }] },
  nextCommentId: 2,
});

const call = async (server, route, { token, method = 'GET', body, headers = {} } = {}) => {
  const res = await fetch(`${server.baseUrl}${route}`, {
    method,
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  return { status: res.status, headers: res.headers, text, body: parsed };
};

const readDb = (server) => JSON.parse(fs.readFileSync(server.dbFile, 'utf8'));

const READ_ROUTES = [
  '/api/drinks', '/api/drinks?alcoholic=false', '/api/drinks?sort=trending', '/api/drinks/1', '/api/drinks/user/adult',
  '/api/drinks/1/comments', '/api/users/adult', '/api/users/minor', '/api/stories', '/media/drinks/1', '/media/avatars/adult',
  '/api/an-unknown-route',
];

const assertRefused = (res, status, label) => {
  assert.equal(res.status, status, label);
  assert.equal(res.headers.get('cache-control'), 'no-store', label);
  assert.match(res.headers.get('vary') ?? '', /Authorization/i, label);
  for (const text of [PLAIN_TEXT, COMMENT_TEXT, 'Bio', 'adult@example.test']) assert.ok(!res.text.includes(text), `${label} leaked ${text}`);
};

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

describe('logged out', () => {
  let server;
  before(async () => {
    server = await startServer({}, { dbFixture: fixture() });
  });
  after(() => server?.stop());

  for (const [label, token] of [['no token', undefined], ['an invalid token', 'not-a-token'], ['a JWT for an unknown user', tokenFor('ghost')]]) {
    test(`${label}: every read of drinks, users, comments and media gets 401`, async () => {
      for (const route of READ_ROUTES) {
        const res = await call(server, route, { token });
        assertRefused(res, 401, route);
        assert.deepEqual(res.body, { error: 'Authentication required' }, route);
      }
      assert.equal((await call(server, '/media/drinks/1', { token, method: 'HEAD' })).status, 401);
    });
  }

  test('mutations get 401 and change nothing, and a malformed body is never parsed', async () => {
    const before = fs.readFileSync(server.dbFile, 'utf8');
    assert.equal((await call(server, '/api/drinks/1/like', { method: 'POST' })).status, 401);
    assert.equal((await call(server, '/api/drinks/1/comments', { method: 'POST', body: { content: 'Hi' } })).status, 401);
    const malformed = await fetch(`${server.baseUrl}/api/smart-bar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ not json' });
    assert.equal(malformed.status, 401, 'refused before the parser would answer 400');
    assert.equal(fs.readFileSync(server.dbFile, 'utf8'), before);
  });

  test('only sign-in, the unverified-account deletion and the health check skip the gate', async () => {
    assert.equal((await call(server, '/healthz')).status, 200);
    // The deletion route exists only with REQUIRE_VERIFIED_EMAIL on: here it is a plain 404, not 401.
    assert.equal((await call(server, '/api/account/delete-unverified', { method: 'POST', body: {} })).status, 404);
    const signedIn = await call(server, '/api/auth/mobile', { method: 'POST', body: { idToken: 'dev-fallback-token', uid: 'newcomer' } });
    assert.equal(signedIn.status, 200);
    assert.ok(signedIn.body.token);
  });
});

describe('signed in, not confirmed 18+', () => {
  let server;
  const minor = tokenFor('minor');

  before(async () => {
    server = await startServer({}, { dbFixture: fixture() });
  });
  after(() => server?.stop());

  const assertAgeRequired = (res, label) => {
    assertRefused(res, 403, label);
    assert.equal(res.body?.code, 'age_required', label);
  };

  test('the feed, media, other profiles and every other read get age_required', async () => {
    for (const route of READ_ROUTES.filter((route) => route !== '/api/users/minor')) {
      assertAgeRequired(await call(server, route, { token: minor }), route);
    }
    for (const route of ['/api/notifications', '/api/smart-bar', '/api/blocks', '/api/drink-partners', '/api/users/search?q=adult', '/media/avatars/minor']) {
      assertAgeRequired(await call(server, route, { token: minor }), route);
    }
  });

  test('mutations get age_required and change nothing', async () => {
    const before = fs.readFileSync(server.dbFile, 'utf8');
    assertAgeRequired(await call(server, '/api/drinks/1/like', { token: minor, method: 'POST' }), 'like');
    assertAgeRequired(await call(server, '/api/drinks/1/comments', { token: minor, method: 'POST', body: { content: 'Hi' } }), 'comment');
    assertAgeRequired(await call(server, '/api/drinks', {
      token: minor, method: 'POST', body: { name: 'Tea', description: 'Tea', rating: 3, isAlcoholic: false, imageData: PNG.toString('base64') },
    }), 'post');
    assertAgeRequired(await call(server, '/api/smart-bar', { token: minor, method: 'POST', body: { name: 'Gin', quantity: '1' } }), 'smart bar');
    assertAgeRequired(await call(server, '/api/users/minor/avatar', { token: minor, method: 'POST', body: { imageData: PNG.toString('base64') } }), 'avatar');
    assertAgeRequired(await call(server, '/api/reports', { token: minor, method: 'POST', body: { targetType: 'drink', targetId: 1, reason: 'spam' } }), 'report');
    assertAgeRequired(await call(server, '/api/blocks/adult', { token: minor, method: 'POST', body: { blocked: true } }), 'block');
    assertAgeRequired(await call(server, '/api/drink-partners/adult', { token: minor, method: 'POST' }), 'partner');
    assert.equal(fs.readFileSync(server.dbFile, 'utf8'), before);
  });

  test('another user\'s account routes stay refused, in any spelling', async () => {
    for (const [method, route, body] of [
      ['GET', '/api/users/adult'],
      ['GET', '/API/Users/adult/'],
      ['PUT', '/api/users/adult', { bio: 'x' }],
      ['POST', '/api/users/adult/acknowledgements', { type: 'age', confirmed: true }],
      ['POST', '/api/users/adult/delete-account', {}],
      ['GET', '/api/users/minor/partners'],
      ['GET', '/api/users/minor/saved-drinks'],
      ['GET', '/api/users/%E0%A4%A'],
    ]) {
      assertAgeRequired(await call(server, route, { token: minor, method, body }), `${method} ${route}`);
    }
  });
});

describe('what an unconfirmed user can still do: the first-run flow and leaving', () => {
  test('own profile, name prompt, privacy notice and the age confirmation, then everything opens', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());
    const minor = tokenFor('minor');

    for (const route of ['/api/users/minor', '/API/USERS/minor/']) {
      const own = await call(server, route, { token: minor });
      assert.equal(own.status, 200, route);
      assert.equal(own.body.ageConfirmed, false);
      assert.equal(own.body.email, 'minor@example.test', 'the owner view');
    }
    const named = await call(server, '/api/users/minor', { token: minor, method: 'PUT', body: { firstName: 'Mia', nameChosen: true } });
    assert.equal(named.status, 200);
    assert.equal(named.body.firstName, 'Mia');

    // Version 2: the notice that says nothing is visible without signing in.
    assert.equal((await call(server, '/api/users/minor/acknowledgements', { token: minor, method: 'POST', body: { type: 'privacy', version: 3 } })).status, 400);
    const notice = await call(server, '/api/users/minor/acknowledgements', { token: minor, method: 'POST', body: { type: 'privacy', version: 2 } });
    assert.equal(notice.status, 200);
    assert.equal(notice.body.privacyNoticeVersion, 2);

    assert.equal((await call(server, '/api/drinks', { token: minor })).status, 403);
    const age = await call(server, '/api/users/minor/acknowledgements', { token: minor, method: 'POST', body: { type: 'age', confirmed: true } });
    assert.equal(age.status, 200);
    assert.equal(age.body.ageConfirmed, true);
    const feed = await call(server, '/api/drinks', { token: minor });
    assert.equal(feed.status, 200);
    assert.ok(feed.text.includes(PLAIN_TEXT));
    assert.equal((await call(server, '/media/drinks/1', { token: minor })).status, 200);
    assert.equal((await call(server, '/api/drinks/1/like', { token: minor, method: 'POST' })).status, 200);
  });

  test('a new account signs in and gets its own profile with the JWT it was given', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());
    const signedIn = await call(server, '/api/auth/mobile', { method: 'POST', body: { idToken: 'dev-fallback-token', uid: 'newcomer', displayName: 'New Comer' } });
    assert.equal(signedIn.status, 200);
    const own = await call(server, '/api/users/newcomer', { token: signedIn.body.token });
    assert.equal(own.status, 200);
    assert.equal(own.body.ageConfirmed, false);
    assert.equal(own.body.privacyNoticeVersion, null);
  });

  test('an unconfirmed user can delete their account', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());
    const res = await call(server, '/api/users/minor/delete-account', { token: tokenFor('minor'), method: 'POST', body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, true);
    assert.ok(!readDb(server).users.some((user) => user.id === 'minor'));
    assert.equal((await call(server, '/api/users/minor', { token: tokenFor('minor') })).status, 401);
  });
});
