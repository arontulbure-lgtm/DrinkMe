// Gate checks for every route in ROUTE_MANIFEST (test/helpers/routes.js), so a new route gets them as
// soon as it is listed there: logged out 401, unconfirmed 403 age_required, suspended 403
// account_suspended where the manifest says so (and nowhere else), non-admin 403 on admin routes, and
// post, comment and report ids that are not plain positive integers answer 404 and change nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { REAL_DB_FILE, startServer } from './helpers/harness.js';
import { ROUTE_MANIFEST, fillPath, paramNames } from './helpers/routes.js';

const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const CONFIRMED_AT = '2026-01-02T03:04:05.000Z';
const OLD = '2026-01-01T00:00:00.000Z';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;
// Both /api limiters (100 per IP per 15 min, 30 writes per minute) are in memory: a restart every
// CHUNK_SIZE requests keeps a long matrix under them, so a 429 never hides the answer under test.
const CHUNK_SIZE = 20;

const tokenFor = (uid) => jwt.sign({ uid }, HARNESS_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

const person = (id, extra = {}) => ({
  id, email: `${id}@example.test`, firstName: `Name-${id}`, lastName: 'Test', city: 'Cluj', bio: `Bio of ${id}`,
  nameSetByUser: true, avatar: null, ageConfirmedAt: CONFIRMED_AT, privacyNoticeVersion: 2, ...extra,
});
const post = (id, userId) => ({
  id, userId, name: `Post ${id}`, description: 'Plain', rating: 4, location: 'Cluj', isAlcoholic: false,
  createdAt: OLD, cheersCount: 0, tags: [], imageUrl: PNG_DATA_URL,
});

// adult owns post 1, comment 1 and Smart Bar item 1. susp is permanently suspended, owns post 2 and has
// a partner request from adult. other reported post 1 (report 1, open). minor has not confirmed 18+.
const fixture = () => ({
  dbSchemaVersion: 2,
  users: [
    person('adult'), person('other'), person('admin'),
    person('minor', { ageConfirmedAt: undefined }),
    person('susp', { suspensions: [{ at: OLD, until: null, permanent: true, reason: null, by: 'admin' }] }),
  ],
  drinks: [post(1, 'adult'), post(2, 'susp')],
  nextDrinkId: 3,
  commentsByDrink: { 1: [{ id: 1, drinkId: 1, userId: 'adult', content: 'Comment 1', createdAt: OLD }] },
  nextCommentId: 2,
  reports: [{
    id: 1, reporterId: 'other', targetType: 'drink', targetId: 1, reason: 'spam', details: null, status: 'open',
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  }],
  nextReportId: 2,
  partnerRequestsByUser: { susp: [{ fromId: 'adult', createdAt: new Date().toISOString() }] },
  smartBarByUser: { adult: [{ id: 1, name: 'Gin', quantity: '1', unit: 'bottle' }] },
});

// Bodies that the route would accept, so a refusal is the gate and not the validation.
const VALID_BODIES = {
  'POST /api/drinks': { name: 'New', description: 'New', rating: 4, isAlcoholic: false, imageData: PNG_DATA_URL },
  'POST /api/drinks/:id/comments': { content: 'Hi' },
  'PUT /api/drinks/:id': { name: 'Changed' },
  'PUT /api/users/:id': { bio: 'Changed' },
  'POST /api/users/:id/avatar': { imageData: PNG_DATA_URL },
  'POST /api/reports': { targetType: 'drink', targetId: 1, reason: 'spam' },
  'POST /api/admin/reports/:id/resolve': { action: 'remove_content' },
  'POST /api/admin/users/:id/suspend': { reason: 'Spam' },
  'POST /api/admin/users/:id/unsuspend': {},
  'POST /api/smart-bar': { name: 'Rum', quantity: '1' },
  'POST /api/blocks/:targetId': { blocked: true },
  'POST /api/users/:id/acknowledgements': { type: 'age', confirmed: true },
};

const ROUTES = Object.entries(ROUTE_MANIFEST).map(([key, entry]) => {
  const space = key.indexOf(' ');
  return { key, method: key.slice(0, space), path: key.slice(space + 1), ...entry };
});
const GATED = ROUTES.filter((route) => route.gate !== 'public' && route.gate !== 'dev-only');
// Registered only when NODE_ENV=development; this file runs the server in test mode.
const DEV_ONLY = ROUTES.filter((route) => route.gate === 'dev-only');

// The segment before a parameter says what it names: a user, or a numbered post, comment or report.
const NUMBERED_SEGMENTS = new Set(['drinks', 'comments', 'reports', 'smart-bar']);
const segmentBefore = (routePath, name) => {
  const parts = routePath.split('/');
  return parts[parts.indexOf(`:${name}`) - 1];
};
const fillWith = (routePath, userId, numberedId, overrides = {}) => fillPath(routePath, overrides, (name) => (
  NUMBERED_SEGMENTS.has(segmentBefore(routePath, name)) ? numberedId : userId
));

const call = async (server, { method, route, uid, token, body }) => {
  const bearer = token ?? (uid && tokenFor(uid));
  const sendsBody = body !== undefined && method !== 'GET';
  const res = await fetch(`${server.baseUrl}${route}`, {
    method,
    headers: {
      ...(bearer && { Authorization: `Bearer ${bearer}` }),
      ...(sendsBody && { 'Content-Type': 'application/json' }),
    },
    ...(sendsBody && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  return { status: res.status, headers: res.headers, text, body: parsed };
};

const readDbText = (server) => fs.readFileSync(server.dbFile, 'utf8');

// Restarts before every chunk (fresh limiters), then runs check(request) for each request in turn.
const runInChunks = async (server, requests, check) => {
  for (let start = 0; start < requests.length; start += CHUNK_SIZE) {
    await server.restart();
    for (const request of requests.slice(start, start + CHUNK_SIZE)) {
      await check(request, await call(server, request));
    }
  }
};

const assertRefusal = (res, status, label) => {
  assert.equal(res.status, status, label);
  assert.equal(res.headers.get('cache-control'), 'no-store', label);
  assert.match(res.headers.get('vary') ?? '', /Authorization/i, label);
};

// Stat only: the real database must never be read.
const statRealDb = () => {
  const stats = fs.statSync(REAL_DB_FILE, { throwIfNoEntry: false });
  return stats ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
};

describe('gates on every listed route', () => {
  let realDbBefore;
  let server;

  before(async () => {
    realDbBefore = statRealDb();
    server = await startServer({ ADMIN_USER_IDS: 'admin' }, { dbFixture: fixture() });
  });

  after(async () => {
    await server?.stop();
    assert.deepEqual(statRealDb(), realDbBefore, 'server/data/db.json must stay untouched');
  });

  test('dev-only routes do not exist in test mode (404, nothing written)', async () => {
    assert.ok(DEV_ONLY.length > 0);
    await server.restart();
    const dbBefore = readDbText(server);
    for (const route of DEV_ONLY) {
      const res = await call(server, { method: route.method, route: route.path, body: { entries: [{ kind: 'note', message: 'x' }] } });
      assert.equal(res.status, 404, route.key);
    }
    assert.equal(readDbText(server), dbBefore);
    assert.doesNotMatch(server.getOutput(), /\[dev-log\]/);
  });

  test('the manifest gives this file something to check', () => {
    assert.ok(GATED.length >= 40, `only ${GATED.length} gated routes`);
    assert.ok(GATED.some((route) => route.suspended) && GATED.some((route) => route.admin));
  });

  test('logged out (no token, or a JWT for an unknown user): every gated route answers 401 and writes nothing', async () => {
    await server.restart();
    const dbBefore = readDbText(server);
    const requests = [];
    for (const token of [undefined, tokenFor('ghost')]) {
      for (const route of GATED) {
        requests.push({
          key: route.key, method: route.method, token, body: VALID_BODIES[route.key] ?? {},
          route: fillWith(route.path, 'adult', '1'),
        });
      }
    }
    await runInChunks(server, requests, (request, res) => {
      const label = `${request.token ? 'unknown user' : 'no token'}: ${request.method} ${request.route}`;
      assertRefusal(res, 401, label);
      assert.deepEqual(res.body, { error: 'Authentication required' }, label);
    });
    assert.equal(readDbText(server), dbBefore);
  });

  test('signed in, not confirmed 18+: every gated route answers 403 age_required, also for another user\'s account', async () => {
    await server.restart();
    const dbBefore = readDbText(server);
    const requests = GATED.map((route) => ({
      key: route.key, method: route.method, uid: 'minor', body: VALID_BODIES[route.key] ?? {},
      // 'adult', never the caller: an own-before-age route is open only for the caller's own id.
      route: fillWith(route.path, 'adult', '1'),
    }));
    await runInChunks(server, requests, (request, res) => {
      const label = `${request.method} ${request.route}`;
      assertRefusal(res, 403, label);
      assert.equal(res.body?.code, 'age_required', label);
      assert.ok(!res.text.includes('Post 1') && !res.text.includes('Bio of adult'), `${label} leaked data`);
    });
    assert.equal(readDbText(server), dbBefore);
  });

  test('suspended: every route marked suspended answers 403 account_suspended and writes nothing', async () => {
    const suspendedRoutes = GATED.filter((route) => route.suspended);
    await server.restart();
    const dbBefore = readDbText(server);
    const requests = suspendedRoutes.map((route) => ({
      key: route.key, method: route.method, uid: 'susp', body: VALID_BODIES[route.key] ?? {},
      // Own account and own post 2, adult's pending request and another user to ask: every other check
      // would pass, so only the suspension can refuse.
      route: fillWith(route.path, 'susp', '2', { targetId: 'other', fromId: 'adult' }),
    }));
    await runInChunks(server, requests, (request, res) => {
      const label = `${request.method} ${request.route}`;
      assert.equal(res.status, 403, label);
      assert.deepEqual(res.body, {
        error: 'Your account is suspended, so you cannot do this.', code: 'account_suspended', until: null,
      }, label);
    });
    assert.equal(readDbText(server), dbBefore);
  });

  test('suspended: no other route answers account_suspended', async () => {
    const openRoutes = GATED.filter((route) => !route.suspended);
    const requests = openRoutes.map((route) => ({
      key: route.key, method: route.method, uid: 'susp', body: {},
      // Another user's account, and ids that do not exist, so nothing is deleted or changed for real.
      route: fillWith(route.path, 'other', '999', { targetId: 'nobody', fromId: 'nobody' }),
    }));
    await runInChunks(server, requests, (request, res) => {
      const label = `${request.method} ${request.route}`;
      assert.notEqual(res.body?.code, 'account_suspended', label);
      // The AI routes are off in tests and answer 503 ai_disabled after the auth checks.
      assert.ok(res.status < 500 || res.body?.code === 'ai_disabled', `${label}: ${res.status}`);
    });
  });

  test('a signed-in adult who is not an admin gets 403 on every admin route, and nothing changes', async () => {
    const adminRoutes = GATED.filter((route) => route.admin);
    await server.restart();
    const dbBefore = readDbText(server);
    const requests = adminRoutes.map((route) => ({
      key: route.key, method: route.method, uid: 'adult', body: VALID_BODIES[route.key] ?? {},
      route: fillWith(route.path, 'other', '1'),
    }));
    await runInChunks(server, requests, (request, res) => {
      const label = `${request.method} ${request.route}`;
      assert.equal(res.status, 403, label);
      assert.deepEqual(res.body, { error: 'Forbidden' }, label);
    });
    assert.equal(readDbText(server), dbBefore);
  });
});

describe('post, comment and report ids', () => {
  // Every route that names a post or comment by id accepts only a plain positive integer. Each of these
  // would name post 1, comment 1 or report 1 if it were read with Number() or parseInt().
  const MALFORMED_IDS = ['1.0', '1e0', '0x1', '01', '00001', '+1', '-1', '%201', '1%20', '1abc'];
  const ID_SEGMENTS = new Set(['drinks', 'comments', 'reports']);
  let realDbBefore;
  let server;

  before(async () => {
    realDbBefore = statRealDb();
    server = await startServer({ ADMIN_USER_IDS: 'admin' }, { dbFixture: fixture() });
  });

  after(async () => {
    await server?.stop();
    assert.deepEqual(statRealDb(), realDbBefore, 'server/data/db.json must stay untouched');
  });

  const slots = [];
  for (const route of GATED) {
    for (const name of paramNames(route.path)) {
      if (ID_SEGMENTS.has(segmentBefore(route.path, name))) slots.push({ route, name });
    }
  }

  test('the manifest has numbered routes to check', () => {
    assert.ok(slots.length >= 10, `only ${slots.length} id parameters`);
  });

  test('a malformed id answers 404 for the owner or admin, and nothing changes', async () => {
    await server.restart();
    const dbBefore = readDbText(server);
    const requests = [];
    for (const { route, name } of slots) {
      for (const malformed of MALFORMED_IDS) {
        requests.push({
          key: route.key, method: route.method, body: VALID_BODIES[route.key] ?? {},
          // adult owns post 1 and comment 1, and admin may resolve report 1: only the id can refuse.
          uid: route.admin ? 'admin' : 'adult',
          route: fillWith(route.path, 'adult', '1', { [name]: malformed }),
        });
      }
    }
    await runInChunks(server, requests, (request, res) => {
      assert.equal(res.status, 404, `${request.method} ${request.route}`);
    });
    assert.equal(readDbText(server), dbBefore);
  });

  test('control: the same reads with the plain id answer 200', async () => {
    await server.restart();
    for (const { route } of slots.filter((slot) => slot.route.method === 'GET')) {
      const routePath = fillWith(route.path, 'adult', '1');
      assert.equal((await call(server, { method: 'GET', route: routePath, uid: route.admin ? 'admin' : 'adult' })).status, 200, routePath);
    }
  });
});
