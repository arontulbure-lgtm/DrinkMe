import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';

import { REAL_DB_FILE, startServer } from './helpers/harness.js';

const REQUEST_TIMEOUT_MS = 20_000;
const SEARCH_RESULT_CAP = 50;
const AUTH_ROUTES = ['/api/users/search?q=fixture', '/api/drinks/partners'];

const fixtureUser = (id, firstName, lastName = 'Fixture') => ({
  id,
  email: `${id}@example.test`,
  firstName,
  lastName,
  city: 'Cluj',
  bio: '',
  avatar: null,
  // Every route but the first-run ones needs the 18+ confirmation.
  ageConfirmedAt: '2026-01-01T00:00:00.000Z',
});

const fixtureDrink = (id, userId) => ({ id, userId, name: `Drink ${id}`, location: 'Cluj', isAlcoholic: false, cheersCount: 0 });

const socialFixture = () => ({
  nextDrinkId: 4,
  users: [fixtureUser('viewer', 'Vera'), fixtureUser('friend', 'Fiona'), fixtureUser('stranger', 'Stan')],
  drinks: [fixtureDrink(1, 'viewer'), fixtureDrink(2, 'friend'), fixtureDrink(3, 'stranger')],
  partnersByUser: { viewer: ['friend'], friend: ['viewer'] },
});

const startOn = async (t, options) => {
  const server = await startServer({}, options);
  t.after(() => server.stop());
  return server;
};

const startWithEnv = async (t, env, options) => {
  const server = await startServer(env, options);
  t.after(() => server.stop());
  return server;
};

const getStatus = async (baseUrl, path, headers = {}) => {
  const res = await fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  await res.arrayBuffer();
  return { status: res.status, remaining: res.headers.get('ratelimit-remaining') };
};

const putBio = async (baseUrl, uid, token) => {
  const res = await fetch(`${baseUrl}/api/users/${uid}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ bio: 'Saved by the test' }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await res.arrayBuffer();
  return res.status;
};

const getJson = async (baseUrl, path, token) => {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: res.status, body: await res.json() };
};

const signIn = async (baseUrl, uid) => {
  const res = await fetch(`${baseUrl}/api/auth/mobile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: 'dev-fallback-token', uid }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assert.equal(res.status, 200);
  return (await res.json()).token;
};

const updateBio = async (baseUrl, uid, token) => {
  const res = await fetch(`${baseUrl}/api/users/${uid}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ bio: 'Saved by the test' }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assert.equal(res.status, 200);
};

const readPartnerKeys = (dbFile) => Object.keys(JSON.parse(fs.readFileSync(dbFile, 'utf8')).partnersByUser);

const signToken = (payload, secret) => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const content = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}`;
  const signature = crypto.createHmac('sha256', secret).update(content).digest('base64url');
  return `${content}.${signature}`;
};

// Well formed, but signed with a secret the server does not use.
const forgeToken = (uid) => signToken({ uid }, 'not-the-server-secret');

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

describe('routes that require a signed-in user', () => {
  test('return 401 with no token, a malformed token and a forged token', async (t) => {
    const { baseUrl } = await startOn(t, { dbFixture: socialFixture() });
    for (const route of AUTH_ROUTES) {
      for (const token of [undefined, 'not-a-real-token', forgeToken('viewer')]) {
        const { status, body } = await getJson(baseUrl, route, token);
        assert.equal(status, 401, `${route} with token ${token}`);
        assert.deepEqual(body, { error: 'Authentication required' });
      }
    }
  });

  test('return 401 with an expired token signed by the server secret', async (t) => {
    const secret = 'test-only-expiry-secret';
    const server = await startServer({ JWT_SECRET: secret }, { dbFixture: socialFixture() });
    t.after(() => server.stop());
    const nowSeconds = Math.floor(Date.now() / 1000);
    const live = signToken({ uid: 'viewer', exp: nowSeconds + 3600 }, secret);
    const expired = signToken({ uid: 'viewer', iat: nowSeconds - 7200, exp: nowSeconds - 3600 }, secret);
    for (const route of AUTH_ROUTES) {
      // The live token proves the signing here is valid, so the 401 below comes from the expiry alone.
      assert.equal((await getJson(server.baseUrl, route, live)).status, 200, `${route} with a live token`);
      const { status, body } = await getJson(server.baseUrl, route, expired);
      assert.equal(status, 401, `${route} with an expired token`);
      assert.deepEqual(body, { error: 'Authentication required' });
    }
  });

  test('/api/drinks/partners returns the feed of the signed-in user', async (t) => {
    const { baseUrl } = await startOn(t, { dbFixture: socialFixture() });
    const token = await signIn(baseUrl, 'viewer');
    const { status, body } = await getJson(baseUrl, '/api/drinks/partners', token);
    assert.equal(status, 200);
    assert.deepEqual(body.items.map((drink) => drink.id).sort(), [1, 2]);
    assert.ok(body.items.every((drink) => drink.isPartner));
  });

  test('/api/users/search filters users and marks partners', async (t) => {
    const { baseUrl } = await startOn(t, { dbFixture: socialFixture() });
    const token = await signIn(baseUrl, 'viewer');

    const friend = await getJson(baseUrl, '/api/users/search?q=%40fiona', token);
    assert.equal(friend.status, 200);
    assert.deepEqual(friend.body.map((user) => [user.id, user.isPartner]), [['friend', true]]);

    const stranger = await getJson(baseUrl, '/api/users/search?q=stan', token);
    assert.equal(stranger.status, 200);
    assert.deepEqual(stranger.body.map((user) => [user.id, user.isPartner]), [['stranger', false]]);
  });
});

describe('/api/users/search result size', () => {
  test('an empty query returns no users', async (t) => {
    const { baseUrl } = await startOn(t, { dbFixture: socialFixture() });
    const token = await signIn(baseUrl, 'viewer');
    for (const path of ['/api/users/search', '/api/users/search?q=', '/api/users/search?q=%20%20', '/api/users/search?q=%40']) {
      const { status, body } = await getJson(baseUrl, path, token);
      assert.equal(status, 200, path);
      assert.deepEqual(body, [], path);
    }
  });

  test('a one-character query returns no users, and two characters are enough', async (t) => {
    const { baseUrl } = await startOn(t, { dbFixture: socialFixture() });
    const token = await signIn(baseUrl, 'viewer');
    for (const path of ['/api/users/search?q=v', '/api/users/search?q=%40v', '/api/users/search?q=%20v%20']) {
      const { status, body } = await getJson(baseUrl, path, token);
      assert.equal(status, 200, path);
      assert.deepEqual(body, [], path);
    }
    const { body } = await getJson(baseUrl, '/api/users/search?q=ve', token);
    assert.deepEqual(body.map((user) => user.id), ['viewer']);
  });

  test('a search with 51 matches returns 50', async (t) => {
    const matches = Array.from({ length: SEARCH_RESULT_CAP + 1 }, (_, i) => fixtureUser(`bulk-${i}`, 'Bulkname'));
    const { baseUrl } = await startOn(t, {
      dbFixture: { users: [fixtureUser('viewer', 'Vera'), ...matches] },
    });
    const token = await signIn(baseUrl, 'viewer');
    const { status, body } = await getJson(baseUrl, '/api/users/search?q=bulkname', token);
    assert.equal(status, 200);
    assert.equal(body.length, SEARCH_RESULT_CAP);
    assert.equal(new Set(body.map((user) => user.id)).size, SEARCH_RESULT_CAP);
  });
});

describe('the "null" key in partnersByUser', () => {
  test('logged-out calls to /api/users/:id/partners get 401 and do not create it', async (t) => {
    const { baseUrl, dbFile } = await startOn(t, { dbFixture: socialFixture() });

    const { status } = await getJson(baseUrl, '/api/users/friend/partners');
    assert.equal(status, 401);

    const token = await signIn(baseUrl, 'viewer');
    await updateBio(baseUrl, 'viewer', token);
    assert.deepEqual(readPartnerKeys(dbFile).sort(), ['friend', 'viewer']);
  });

  test('/api/users/:id/partners reports isPartner for a signed-in requester', async (t) => {
    const { baseUrl } = await startOn(t, { dbFixture: socialFixture() });
    const token = await signIn(baseUrl, 'viewer');
    const { status, body } = await getJson(baseUrl, '/api/users/viewer/partners', token);
    assert.equal(status, 200);
    assert.deepEqual(body.map((user) => [user.id, user.isPartner]), [['friend', true]]);
  });

  test('a logged-out read of the drink routes gets 401 and does not create it', async (t) => {
    const { baseUrl, dbFile } = await startOn(t, { dbFixture: socialFixture() });
    for (const path of ['/api/drinks', '/api/drinks/1', '/api/drinks/user/viewer']) {
      const { status } = await getJson(baseUrl, path);
      assert.equal(status, 401, path);
    }
    await signIn(baseUrl, 'viewer');
    assert.deepEqual(readPartnerKeys(dbFile).sort(), ['friend', 'viewer']);
  });

  test('an old key in the saved file is gone after the next save', async (t) => {
    const fixture = socialFixture();
    fixture.partnersByUser.null = ['friend'];
    fixture.dbSchemaVersion = 2; // a legacy file would be rewritten at load
    const { baseUrl, dbFile } = await startOn(t, { dbFixture: fixture });
    assert.ok(readPartnerKeys(dbFile).includes('null'), 'loading alone does not rewrite the file');

    await signIn(baseUrl, 'viewer');

    const saved = JSON.parse(fs.readFileSync(dbFile, 'utf8')).partnersByUser;
    assert.deepEqual(saved, { viewer: ['friend'], friend: ['viewer'] });
  });
});

describe('GET /api/drinks/:id/comments', () => {
  test('reads of unknown drinks return 404 and save nothing', async (t) => {
    const { baseUrl, dbFile } = await startOn(t, { dbFixture: socialFixture() });
    const token = await signIn(baseUrl, 'viewer');
    for (const id of ['abc', '999999']) {
      const { status, body } = await getJson(baseUrl, `/api/drinks/${id}/comments`, token);
      assert.equal(status, 404, id);
      assert.deepEqual(body, { error: 'Drink not found' });
    }
    assert.deepEqual((await getJson(baseUrl, '/api/drinks/1/comments', token)).body.items, []);

    await updateBio(baseUrl, 'viewer', token);

    assert.deepEqual(JSON.parse(fs.readFileSync(dbFile, 'utf8')).commentsByDrink, {});
  });

  test('loading drops empty orphan lists and keeps every list that has comments', async (t) => {
    const comment = { id: 1, drinkId: 777, userId: 'viewer', content: 'Kept', createdAt: '2026-01-01T00:00:00.000Z' };
    const realComment = { ...comment, id: 2, drinkId: 1 };
    const fixture = {
      ...socialFixture(),
      commentsByDrink: {
        NaN: [],
        Infinity: [],
        999999: [],
        2: [],
        1: [realComment],
        777: [comment],
        abc: [comment],
      },
    };
    const { baseUrl, dbFile } = await startOn(t, { dbFixture: fixture });
    const token = await signIn(baseUrl, 'viewer');
    assert.deepEqual((await getJson(baseUrl, '/api/drinks/1/comments', token)).body.items.map((c) => c.id), [2]);

    await updateBio(baseUrl, 'viewer', token);

    assert.deepEqual(JSON.parse(fs.readFileSync(dbFile, 'utf8')).commentsByDrink, {
      1: [realComment],
      2: [],
      777: [comment],
      abc: [comment],
    });
  });
});

describe('TRUST_PROXY_HOPS', () => {
  const API_LIMIT = 100;
  const spoofedIp = (i) => ({ 'X-Forwarded-For': `203.0.113.${i % 250}` });

  test('by default, a varying X-Forwarded-For does not avoid the limiter', async (t) => {
    const { baseUrl } = await startWithEnv(t, {});
    // Logged out, so each request gets 401, after the limiter has counted it.
    for (let i = 0; i < API_LIMIT; i++) {
      const { status } = await getStatus(baseUrl, '/api/stories', spoofedIp(i));
      assert.equal(status, 401, `request ${i + 1}`);
    }
    assert.equal((await getStatus(baseUrl, '/api/stories', spoofedIp(API_LIMIT))).status, 429);
  });

  test('a configured hop count trusts the header', async (t) => {
    const { baseUrl } = await startWithEnv(t, { TRUST_PROXY_HOPS: '1' });
    for (let i = 0; i < 3; i++) {
      const { status, remaining } = await getStatus(baseUrl, '/api/stories', spoofedIp(i));
      assert.equal(status, 401);
      assert.equal(remaining, String(API_LIMIT - 1), 'each forwarded IP has its own bucket');
    }
  });

  for (const value of ['abc', '-1', '1.5', 'true']) {
    test(`the invalid value "${value}" counts as 0, with a warning`, async (t) => {
      const { baseUrl, getOutput } = await startWithEnv(t, { TRUST_PROXY_HOPS: value });
      assert.match(getOutput(), /TRUST_PROXY_HOPS must be a non-negative integer/);
      assert.ok(!getOutput().includes(`"${value}"`));
      assert.equal((await getStatus(baseUrl, '/api/stories', spoofedIp(1))).remaining, String(API_LIMIT - 1));
      assert.equal((await getStatus(baseUrl, '/api/stories', spoofedIp(2))).remaining, String(API_LIMIT - 2));
    });
  }

  test('the default prints no warning', async (t) => {
    const { getOutput } = await startWithEnv(t, {});
    assert.ok(!getOutput().includes('TRUST_PROXY_HOPS'));
  });
});

describe('a validly signed token for an unknown user', () => {
  const secret = 'test-only-unknown-user-secret';
  const liveToken = (uid) => signToken({ uid, exp: Math.floor(Date.now() / 1000) + 3600 }, secret);

  test('gets 401 on a mutation and on reads', async (t) => {
    const { baseUrl, dbFile } = await startWithEnv(t, { JWT_SECRET: secret }, { dbFixture: socialFixture() });
    const ghost = liveToken('ghost');

    assert.equal(await putBio(baseUrl, 'ghost', ghost), 401);
    assert.equal((await getJson(baseUrl, '/api/drinks/partners', ghost)).status, 401);

    assert.equal((await getJson(baseUrl, '/api/drinks/1', ghost)).status, 401);
    assert.equal((await getJson(baseUrl, '/api/users/friend/partners', ghost)).status, 401);

    assert.equal(await putBio(baseUrl, 'viewer', liveToken('viewer')), 200);
    assert.deepEqual(readPartnerKeys(dbFile).sort(), ['friend', 'viewer']);
  });

  test('a real user keeps working, and signing in again recovers an unknown one', async (t) => {
    const { baseUrl } = await startWithEnv(t, { JWT_SECRET: secret }, { dbFixture: socialFixture() });

    const drink = await getJson(baseUrl, '/api/drinks/2', liveToken('viewer'));
    assert.equal(drink.body.isPartner, true);

    const ghost = liveToken('ghost');
    assert.equal(await putBio(baseUrl, 'ghost', ghost), 401);
    await signIn(baseUrl, 'ghost');
    assert.equal(await putBio(baseUrl, 'ghost', ghost), 200);
  });
});

describe('per-user rate limits', () => {
  test('mutationLimiter still keys on the signed-in user', async (t) => {
    const MUTATION_LIMIT = 30;
    const { baseUrl } = await startOn(t, { dbFixture: socialFixture() });
    const viewer = await signIn(baseUrl, 'viewer');
    const friend = await signIn(baseUrl, 'friend');
    for (let i = 0; i < MUTATION_LIMIT; i++) {
      assert.equal(await putBio(baseUrl, 'viewer', viewer), 200, `request ${i + 1}`);
    }
    assert.equal(await putBio(baseUrl, 'viewer', viewer), 429);
    assert.equal(await putBio(baseUrl, 'friend', friend), 200);
  });

  test('searchLimiter allows 60 searches per user, and only runs after requireAuth', async (t) => {
    const SEARCH_LIMIT = 60;
    const { baseUrl } = await startOn(t, { dbFixture: socialFixture() });
    const viewer = await signIn(baseUrl, 'viewer');
    const friend = await signIn(baseUrl, 'friend');
    const authorized = (token) => ({ Authorization: `Bearer ${token}` });
    const SEARCH = '/api/users/search?q=stan';

    assert.equal((await getStatus(baseUrl, SEARCH)).status, 401);
    for (let i = 0; i < SEARCH_LIMIT; i++) {
      assert.equal((await getStatus(baseUrl, SEARCH, authorized(viewer))).status, 200, `request ${i + 1}`);
    }
    assert.equal((await getStatus(baseUrl, SEARCH, authorized(viewer))).status, 429);
    assert.equal((await getStatus(baseUrl, SEARCH)).status, 401);
    assert.equal((await getStatus(baseUrl, SEARCH, authorized(friend))).status, 200);
  });
});
