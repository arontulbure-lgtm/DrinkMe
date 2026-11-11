import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { startServer } from './helpers/harness.js';

const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const STUB_PRELOAD = new URL('./helpers/openai-stub-preload.js', import.meta.url).href;
const FAULT_PRELOAD = new URL('./helpers/db-fault-preload.js', import.meta.url).href;
const CONFIRMED_AT = '2026-01-02T03:04:05.000Z';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;

const ALCOHOLIC_ID = 1;
const NON_ALCOHOLIC_ID = 2;
const NO_FLAG_ID = 3;
const HIDDEN_POST_IDS = [ALCOHOLIC_ID, NO_FLAG_ID];
const SECRET_TEXT = 'Hidden Whisky';

const tokenFor = (uid) => jwt.sign({ uid }, HARNESS_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

const person = (id, extra = {}) => ({
  id, email: `${id}@example.test`, firstName: id, lastName: 'Test', city: '', bio: '', nameSetByUser: true, avatar: null, ...extra,
});
const confirmed = (id, extra = {}) => person(id, { ageConfirmedAt: CONFIRMED_AT, ...extra });

const post = (id, userId, extra = {}) => ({
  id, userId, name: `Post ${id}`, description: 'Plain', rating: 4, location: null,
  createdAt: '2026-01-01T00:00:00.000Z', cheersCount: 0, tags: [], imageUrl: PNG_DATA_URL, ...extra,
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
  return { status: res.status, headers: res.headers, text, body: parsed };
};

const readDb = (server) => JSON.parse(fs.readFileSync(server.dbFile, 'utf8'));
const idsOf = (res) => res.body.items.map((item) => item.id);

const assertAgeRequired = (res, label) => {
  assert.equal(res.status, 403, label);
  assert.equal(res.body?.code, 'age_required', label);
  assert.ok(!res.text.includes(SECRET_TEXT), `${label} leaked post text`);
};

// Three posts by "owner" (confirmed), each saved by everyone and with one comment.
const matrixFixture = () => ({
  users: [confirmed('owner'), confirmed('adult'), person('minor')],
  drinks: [
    post(ALCOHOLIC_ID, 'owner', { isAlcoholic: true, name: SECRET_TEXT }),
    post(NON_ALCOHOLIC_ID, 'owner', { isAlcoholic: false, name: 'Plain Tea', location: 'Cluj' }),
    post(NO_FLAG_ID, 'owner', { name: `${SECRET_TEXT} old` }),
  ],
  nextDrinkId: 4,
  partnersByUser: { adult: ['owner'], minor: ['owner'], owner: ['adult', 'minor'] },
  savedByUser: {
    adult: [ALCOHOLIC_ID, NON_ALCOHOLIC_ID, NO_FLAG_ID],
    minor: [ALCOHOLIC_ID, NON_ALCOHOLIC_ID, NO_FLAG_ID],
  },
  commentsByDrink: Object.fromEntries([ALCOHOLIC_ID, NON_ALCOHOLIC_ID, NO_FLAG_ID].map((id) => [
    id,
    [{ id, drinkId: id, userId: 'owner', content: `Comment ${id}`, createdAt: '2026-01-01T00:00:00.000Z' }],
  ])),
  nextCommentId: 4,
});

// Owner decision: nothing is readable logged out, and a signed-in user who has not confirmed 18+ gets
// age_required on every route but the first-run ones. canViewDrink still decides per post for confirmed users.
const READ_ROUTES = [
  '/api/drinks', `/api/drinks?q=${encodeURIComponent('hidden')}`, '/api/drinks?city=cluj', '/api/drinks?alcoholic=false',
  '/api/drinks?sort=trending', '/api/drinks/user/owner', '/api/drinks/partners', '/api/users/minor/saved-drinks',
  ...[ALCOHOLIC_ID, NON_ALCOHOLIC_ID, NO_FLAG_ID].flatMap((id) => [`/api/drinks/${id}`, `/api/drinks/${id}/comments`, `/media/drinks/${id}`]),
  '/api/users/owner', '/media/avatars/owner', '/api/notifications', '/api/smart-bar',
];

describe('visibility matrix', () => {
  let server;

  before(async () => {
    server = await startServer({}, { dbFixture: matrixFixture() });
  });
  after(() => server?.stop());

  const ALL_IDS = [NO_FLAG_ID, NON_ALCOHOLIC_ID, ALCOHOLIC_ID];

  for (const [label, token] of [['logged out', undefined], ['an invalid token', 'not-a-token']]) {
    test(`${label}: every read gets 401 and no post text`, async () => {
      for (const route of READ_ROUTES) {
        const res = await call(server, route, { token });
        assert.equal(res.status, 401, route);
        assert.ok(!res.text.includes(SECRET_TEXT) && !res.text.includes('Plain Tea'), route);
      }
    });
  }

  test('unconfirmed: every read gets age_required, alcoholic or not', async () => {
    const token = tokenFor('minor');
    for (const route of READ_ROUTES) {
      const res = await call(server, route, { token });
      assertAgeRequired(res, route);
      assert.ok(!res.text.includes('Plain Tea') && !res.text.includes('Comment'), route);
    }
  });

  test('confirmed: GET /api/drinks and /api/drinks/user/:id', async () => {
    const token = tokenFor('adult');
    const drinks = await call(server, '/api/drinks', { token });
    assert.equal(drinks.status, 200);
    assert.deepEqual(idsOf(drinks), ALL_IDS);
    assert.equal(drinks.body.nextCursor, null);
    const owned = await call(server, '/api/drinks/user/owner', { token });
    assert.deepEqual(idsOf(owned), ALL_IDS);
    assert.equal(owned.body.total, ALL_IDS.length);
  });

  test('confirmed: q, city, alcoholic=false and sort=trending', async () => {
    const token = tokenFor('adult');
    assert.deepEqual(idsOf(await call(server, `/api/drinks?q=${encodeURIComponent('hidden')}`, { token })), [NO_FLAG_ID, ALCOHOLIC_ID]);
    assert.deepEqual(idsOf(await call(server, '/api/drinks?city=cluj', { token })), [NON_ALCOHOLIC_ID]);
    assert.deepEqual(idsOf(await call(server, '/api/drinks?alcoholic=false', { token })), [NON_ALCOHOLIC_ID]);
    assert.deepEqual(idsOf(await call(server, '/api/drinks?sort=trending', { token })).sort(), [...ALL_IDS].sort());
  });

  test('confirmed: a post, its comments and its image', async () => {
    const token = tokenFor('adult');
    for (const id of ALL_IDS) {
      assert.equal((await call(server, `/api/drinks/${id}`, { token })).status, 200);
      assert.equal((await call(server, `/api/drinks/${id}/comments`, { token })).status, 200);
      assert.equal((await call(server, `/media/drinks/${id}`, { token })).status, 200);
    }
  });

  test('confirmed: /api/drinks/partners and the saved list', async () => {
    const token = tokenFor('adult');
    assert.deepEqual(idsOf(await call(server, '/api/drinks/partners', { token })), ALL_IDS);
    assert.deepEqual(idsOf(await call(server, '/api/users/adult/saved-drinks', { token })), ALL_IDS);
  });

  test('a missing post stays 404 for a confirmed user', async () => {
    const token = tokenFor('adult');
    assert.equal((await call(server, '/api/drinks/999', { token })).status, 404);
    assert.equal((await call(server, '/api/drinks/999/comments', { token })).status, 404);
    assert.equal((await call(server, '/media/drinks/999', { token })).status, 404);
  });
});

describe('mutations on a post', () => {
  let server;
  const minor = tokenFor('minor');
  const adult = tokenFor('adult');

  before(async () => {
    server = await startServer({}, { dbFixture: matrixFixture() });
  });
  after(() => server?.stop());

  test('an unconfirmed user cannot cheer, save or comment on any post', async () => {
    for (const id of [...HIDDEN_POST_IDS, NON_ALCOHOLIC_ID]) {
      assertAgeRequired(await call(server, `/api/drinks/${id}/like`, { token: minor, method: 'POST' }), `like ${id}`);
      assertAgeRequired(await call(server, `/api/drinks/${id}/save`, { token: minor, method: 'POST' }), `save ${id}`);
      assertAgeRequired(
        await call(server, `/api/drinks/${id}/comments`, { token: minor, method: 'POST', body: { content: 'Hi' } }),
        `comment ${id}`,
      );
    }
    const db = readDb(server);
    for (const id of [ALCOHOLIC_ID, NON_ALCOHOLIC_ID]) {
      assert.equal(db.drinks.find((d) => d.id === id).cheersCount, 0);
      assert.equal(db.commentsByDrink[id].length, 1);
    }
    assert.deepEqual(db.notificationsByUser?.owner ?? [], []);
  });

  test('a confirmed user can cheer, save and comment on an alcoholic post', async () => {
    assert.equal((await call(server, `/api/drinks/${ALCOHOLIC_ID}/like`, { token: adult, method: 'POST' })).status, 200);
    assert.equal((await call(server, `/api/drinks/${ALCOHOLIC_ID}/save`, { token: adult, method: 'POST' })).status, 200);
    assert.equal((await call(server, `/api/drinks/${ALCOHOLIC_ID}/comments`, { token: adult, method: 'POST', body: { content: 'Hi' } })).status, 201);
  });
});

describe('POST /api/drinks', () => {
  let server;
  const newPost = { name: 'New', description: 'New', rating: 3, imageData: PNG.toString('base64') };

  before(async () => {
    server = await startServer({}, { dbFixture: { users: [person('minor'), confirmed('adult')], nextDrinkId: 1 } });
  });
  after(() => server?.stop());

  test('an unconfirmed user cannot create an alcoholic post, flagged or by default', async () => {
    const token = tokenFor('minor');
    const bodies = [newPost, ...[true, 'false', 0, null].map((isAlcoholic) => ({ ...newPost, isAlcoholic }))];
    for (const body of bodies) {
      assertAgeRequired(await call(server, '/api/drinks', { token, method: 'POST', body }), JSON.stringify(body.isAlcoholic));
    }
    assert.equal(readDb(server).drinks?.length ?? 0, 0);
  });

  test('the refusal comes before the image is processed', async () => {
    const res = await call(server, '/api/drinks', {
      token: tokenFor('minor'),
      method: 'POST',
      body: { name: 'New', description: 'New', rating: 3, imageData: 'not base64!' },
    });
    assertAgeRequired(res, 'invalid image');
  });

  test('an unconfirmed user cannot create a non-alcoholic post either', async () => {
    const res = await call(server, '/api/drinks', { token: tokenFor('minor'), method: 'POST', body: { ...newPost, isAlcoholic: false } });
    assertAgeRequired(res, 'non-alcoholic');
    assert.equal(readDb(server).drinks?.length ?? 0, 0);
  });

  test('a confirmed user keeps the alcoholic default', async () => {
    const res = await call(server, '/api/drinks', { token: tokenFor('adult'), method: 'POST', body: newPost });
    assert.equal(res.status, 201);
    assert.equal(res.body.isAlcoholic, true);
  });
});

describe('an unconfirmed owner and their own older posts', () => {
  let server;
  const token = tokenFor('legacy');

  before(async () => {
    server = await startServer({}, {
      dbFixture: {
        users: [person('legacy')],
        drinks: [
          post(1, 'legacy', { isAlcoholic: true, name: SECRET_TEXT }),
          post(2, 'legacy', { isAlcoholic: false }),
        ],
        nextDrinkId: 3,
      },
    });
  });
  after(() => server?.stop());

  test('the gate applies to the owner, on every route, their own posts included', async () => {
    for (const route of ['/api/drinks/user/legacy', '/api/drinks/partners', '/api/drinks/1', '/api/drinks/2', '/media/drinks/1', '/media/drinks/2']) {
      assertAgeRequired(await call(server, route, { token }), route);
    }
    assert.equal((await call(server, '/api/users/legacy', { token })).status, 200, 'the own profile is allowed');
  });

  test('deleting a post waits for the confirmation too', async () => {
    assertAgeRequired(await call(server, '/api/drinks/1', { token, method: 'DELETE' }), 'delete');
    assert.equal(readDb(server).drinks.some((d) => d.id === 1), true);
    assert.equal((await call(server, '/api/users/legacy/acknowledgements', { token, method: 'POST', body: { type: 'age', confirmed: true } })).status, 200);
    assert.equal((await call(server, '/api/drinks/1', { token, method: 'DELETE' })).status, 204);
  });
});

describe('a stored flag that is not exactly false', () => {
  test('an unconfirmed viewer never reaches it, and a confirmed one sees every post', async (t) => {
    const server = await startServer({}, {
      dbFixture: {
        users: [confirmed('owner'), person('minor')],
        drinks: [
          post(1, 'owner', { isAlcoholic: 'false', name: SECRET_TEXT }),
          post(2, 'owner', { isAlcoholic: 0, name: SECRET_TEXT }),
          post(3, 'owner', { isAlcoholic: null, name: SECRET_TEXT }),
          post(4, 'owner', { isAlcoholic: false, name: 'Plain Tea' }),
        ],
        nextDrinkId: 5,
      },
    });
    t.after(() => server.stop());
    const minor = tokenFor('minor');
    assertAgeRequired(await call(server, '/api/drinks', { token: minor }), 'list');
    for (const id of [1, 2, 3, 4]) {
      assertAgeRequired(await call(server, `/api/drinks/${id}`, { token: minor }), `detail ${id}`);
      assertAgeRequired(await call(server, `/media/drinks/${id}`, { token: minor }), `image ${id}`);
    }
    assert.deepEqual(idsOf(await call(server, '/api/drinks', { token: tokenFor('owner') })), [4, 3, 2, 1]);
  });
});

describe('paging with filtering', () => {
  let server;
  const ALL_IDS = Array.from({ length: 60 }, (_, i) => 60 - i);
  const VISIBLE_IDS = ALL_IDS.filter((id) => id % 3 === 0);

  before(async () => {
    server = await startServer({}, {
      dbFixture: {
        users: [confirmed('poster'), person('minor'), confirmed('adult')],
        drinks: ALL_IDS.map((id) => post(id, 'poster', { isAlcoholic: id % 3 !== 0 })),
        nextDrinkId: 61,
        partnersByUser: { minor: ['poster'], poster: ['minor'], adult: ['poster'] },
        savedByUser: { minor: ALL_IDS, adult: ALL_IDS },
      },
    });
  });
  after(() => server?.stop());

  const walk = async (route, token, limit) => {
    const seen = [];
    const separator = route.includes('?') ? '&' : '?';
    let cursor;
    for (let pageNumber = 0; pageNumber < 80; pageNumber += 1) {
      const query = `limit=${limit}${cursor ? `&before=${cursor}` : ''}`;
      const res = await call(server, `${route}${separator}${query}`, { token });
      assert.equal(res.status, 200, route);
      assert.ok(res.body.items.length <= limit);
      if (res.body.nextCursor !== null) assert.equal(res.body.items.length, limit, 'only the last page can be short');
      seen.push(...idsOf(res));
      cursor = res.body.nextCursor;
      if (cursor === null) return seen;
    }
    return assert.fail('the walk never ended');
  };

  // Only a confirmed user lists posts now, so the paging is walked with a confirmed user and a filter.
  const routes = ['/api/drinks?alcoholic=false', '/api/drinks', '/api/drinks/partners', '/api/drinks/user/poster', '/api/users/adult/saved-drinks'];
  for (const route of routes) {
    test(`${route}: full pages and correct cursors`, async () => {
      assert.deepEqual(await walk(route, tokenFor('adult'), 7), route.includes('alcoholic=false') ? VISIBLE_IDS : ALL_IDS);
    });
  }

  test('an unconfirmed user gets age_required on every list', async () => {
    for (const route of routes) assertAgeRequired(await call(server, route, { token: tokenFor('minor') }), route);
  });

  test('a confirmed user walks every post', async () => {
    assert.deepEqual(await walk('/api/drinks', tokenFor('adult'), 20), ALL_IDS);
    assert.deepEqual(await walk('/api/users/adult/saved-drinks', tokenFor('adult'), 20), ALL_IDS);
  });

  test('total counts every post, whatever the page', async () => {
    const token = tokenFor('adult');
    assert.equal((await call(server, '/api/drinks/user/poster?limit=1', { token })).body.total, ALL_IDS.length);
    assert.equal((await call(server, '/api/drinks/user/poster?before=4', { token })).body.total, ALL_IDS.length);
  });

  test('scope=discover and sort=trending', async () => {
    const token = tokenFor('adult');
    const trending = await call(server, '/api/drinks?sort=trending&limit=50', { token });
    assert.equal(trending.body.items.length, 20);
    assertAgeRequired(await call(server, '/api/drinks?sort=trending&limit=50', { token: tokenFor('minor') }), 'trending');
    assert.equal((await call(server, '/api/drinks?scope=discover', { token })).body.items.length, 0, 'the only poster is a partner');
  });
});

describe('scope=discover', () => {
  test('refuses an unconfirmed user, and shows a confirmed one every post', async (t) => {
    const server = await startServer({}, {
      dbFixture: {
        users: [person('minor'), confirmed('adult'), confirmed('stranger')],
        drinks: [post(1, 'stranger', { isAlcoholic: true }), post(2, 'stranger', { isAlcoholic: false }), post(3, 'stranger')],
        nextDrinkId: 4,
      },
    });
    t.after(() => server.stop());
    assertAgeRequired(await call(server, '/api/drinks?scope=discover', { token: tokenFor('minor') }), 'discover');
    assert.deepEqual(idsOf(await call(server, '/api/drinks?scope=discover', { token: tokenFor('adult') })), [3, 2, 1]);
  });
});

describe('media', () => {
  let server;
  const adult = tokenFor('adult');
  const minor = tokenFor('minor');

  before(async () => {
    server = await startServer({}, {
      dbFixture: {
        users: [confirmed('adult', { avatar: PNG_DATA_URL }), person('minor', { avatar: PNG_DATA_URL })],
        drinks: [post(1, 'adult', { isAlcoholic: true }), post(2, 'adult', { isAlcoholic: false })],
        nextDrinkId: 3,
      },
    });
  });
  after(() => server?.stop());

  // Not fetch: it adds Cache-Control: no-cache to a request with If-None-Match, which forces a full reply.
  const rawGet = (route, headers, method = 'GET') => new Promise((resolve, reject) => {
    const { hostname, port } = new URL(server.baseUrl);
    const req = http.request({ hostname, port, path: route, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });

  test('a decoded image and a matching ETag do not get past the check', async () => {
    const first = await call(server, '/media/drinks/1', { token: adult });
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag');
    assert.ok(etag);

    const cachedAdult = await call(server, '/media/drinks/1', { token: adult });
    assert.equal(cachedAdult.headers.get('x-media-cache'), 'hit');

    for (const [headers, status] of [[{}, 401], [{ Authorization: `Bearer ${minor}` }, 403]]) {
      for (const id of [1, 2]) {
        const withEtag = await rawGet(`/media/drinks/${id}`, { ...headers, 'If-None-Match': etag });
        assert.equal(withEtag.status, status);
        if (status === 403) assert.equal(JSON.parse(withEtag.body).code, 'age_required');
        assert.notEqual(withEtag.headers.etag, etag, 'the image ETag is not revealed');
        assert.equal(withEtag.headers['x-media-cache'], undefined, 'nothing was decoded or read from the cache');
        assert.ok(!withEtag.body.includes(PNG));
        const head = await rawGet(`/media/drinks/${id}`, headers, 'HEAD');
        assert.equal(head.status, status);
      }
    }

    const allowed = await rawGet('/media/drinks/1', { Authorization: `Bearer ${adult}`, 'If-None-Match': etag });
    assert.equal(allowed.status, 304);
    assert.match(allowed.headers.vary, /Authorization/i);
  });

  test('every answer varies on Authorization, and a refusal is not stored', async () => {
    const refused = await call(server, '/media/drinks/1');
    assert.match(refused.headers.get('vary'), /Authorization/i);
    assert.equal(refused.headers.get('cache-control'), 'no-store');
    for (const route of ['/media/drinks/2', '/media/drinks/999']) {
      assert.match((await call(server, route)).headers.get('vary'), /Authorization/i, route);
    }
    const served = await call(server, '/media/drinks/1', { token: adult });
    assert.match(served.headers.get('vary'), /Authorization/i);
    assert.equal(served.headers.get('cache-control'), 'private, max-age=86400');
  });

  test('avatars need a signed-in, confirmed viewer too', async () => {
    for (const id of ['adult', 'minor']) {
      assert.equal((await call(server, `/media/avatars/${id}`)).status, 401);
      assertAgeRequired(await call(server, `/media/avatars/${id}`, { token: minor }), id);
      assert.equal((await call(server, `/media/avatars/${id}`, { token: adult })).status, 200);
    }
  });
});

describe('media decoding', () => {
  test('a refused request decodes nothing', async (t) => {
    const server = await startServer({}, {
      dbFixture: { users: [confirmed('adult')], drinks: [post(1, 'adult', { isAlcoholic: true })], nextDrinkId: 2 },
    });
    t.after(() => server.stop());
    assert.equal((await call(server, '/media/drinks/1')).status, 401);
    const res = await call(server, '/media/drinks/1', { token: tokenFor('adult') });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-media-cache'), 'miss');
  });
});

describe('notifications', () => {
  let server;
  const legacyNotifications = [
    { id: 1, type: 'cheer', message: `A cheered your drink ${SECRET_TEXT}.`, read: false, createdAt: new Date().toISOString() },
    { id: 2, type: 'comment', message: `A commented on ${SECRET_TEXT}.`, read: false, createdAt: new Date().toISOString() },
    { id: 3, type: 'partner', message: 'A added you as a drink partner.', read: false, createdAt: new Date().toISOString() },
  ];

  before(async () => {
    server = await startServer({}, {
      dbFixture: {
        users: [person('legacy'), confirmed('adult')],
        drinks: [
          post(1, 'legacy', { isAlcoholic: true, name: SECRET_TEXT }),
          post(2, 'legacy', { isAlcoholic: false, name: 'Plain Tea' }),
        ],
        nextDrinkId: 3,
        notificationsByUser: { legacy: legacyNotifications },
        nextNotificationId: 4,
      },
    });
  });
  after(() => server?.stop());

  const read = (token) => call(server, '/api/notifications', { token });

  test('an unconfirmed reader gets age_required, never a post name', async () => {
    const adult = tokenFor('adult');
    assert.equal((await call(server, '/api/drinks/1/like', { token: adult, method: 'POST' })).status, 200);
    assert.equal((await call(server, '/api/drinks/1/comments', { token: adult, method: 'POST', body: { content: 'Hi' } })).status, 201);
    assert.equal((await call(server, '/api/drinks/2/like', { token: adult, method: 'POST' })).status, 200);
    assertAgeRequired(await read(tokenFor('legacy')), 'notifications');
    assertAgeRequired(await call(server, '/api/notifications/read', { token: tokenFor('legacy'), method: 'POST' }), 'mark read');
  });

  test('confirming brings the stored text back, and the file keeps it', async () => {
    assert.ok(JSON.stringify(readDb(server).notificationsByUser.legacy).includes(SECRET_TEXT));
    const token = tokenFor('legacy');
    assert.equal((await call(server, '/api/users/legacy/acknowledgements', { token, method: 'POST', body: { type: 'age', confirmed: true } })).status, 200);
    const { text, body } = await read(token);
    assert.ok(text.includes(SECRET_TEXT));
    assert.equal(body.notifications.length, 6);
    assert.ok(body.notifications.some((n) => n.message.endsWith('cheered your drink Plain Tea.')));
    for (const notification of body.notifications) assert.equal(notification.drinkId, undefined);
  });
});

describe('POST /api/users/:id/acknowledgements', () => {
  let server;
  const confirmBody = { type: 'age', confirmed: true };
  const route = '/api/users/new/acknowledgements';

  before(async () => {
    server = await startServer({}, { dbFixture: { users: [person('new'), person('other')] } });
  });
  after(() => server?.stop());

  test('logged out gets 401 and a non-owner gets 403', async () => {
    assert.equal((await call(server, route, { method: 'POST', body: confirmBody })).status, 401);
    assert.equal((await call(server, route, { token: tokenFor('other'), method: 'POST', body: confirmBody })).status, 403);
    assert.equal(readDb(server).users.find((u) => u.id === 'new').ageConfirmedAt, undefined);
  });

  test('any other input gets 400', async () => {
    const token = tokenFor('new');
    const badBodies = [
      {}, { type: 'age' }, { confirmed: true }, { type: 'age', confirmed: false }, { type: 'age', confirmed: 'true' },
      { type: 'age', confirmed: 1 }, { type: 'terms', confirmed: true }, { type: ['age'], confirmed: true }, [],
    ];
    for (const body of badBodies) {
      assert.equal((await call(server, route, { token, method: 'POST', body })).status, 400, JSON.stringify(body));
    }
    assert.equal(readDb(server).users.find((u) => u.id === 'new').ageConfirmedAt, undefined);
  });

  test('the first answer is stored, a repeat keeps its time, and both survive a restart', async () => {
    const token = tokenFor('new');
    const unconfirmed = await call(server, '/api/users/new', { token });
    assert.equal(unconfirmed.body.ageConfirmed, false);

    const first = await call(server, route, { token, method: 'POST', body: confirmBody });
    assert.equal(first.status, 200);
    assert.equal(first.body.ageConfirmed, true);
    assert.equal(first.body.ageConfirmedAt, undefined, 'the time stays internal');
    assert.equal(first.body.email, 'new@example.test', 'the owner view');
    const storedAt = readDb(server).users.find((u) => u.id === 'new').ageConfirmedAt;
    assert.ok(!Number.isNaN(Date.parse(storedAt)));

    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await call(server, route, { token, method: 'POST', body: confirmBody })).status, 200);
    assert.equal(readDb(server).users.find((u) => u.id === 'new').ageConfirmedAt, storedAt);

    await server.restart();
    assert.equal(readDb(server).users.find((u) => u.id === 'new').ageConfirmedAt, storedAt);
    assert.equal((await call(server, '/api/users/new', { token })).body.ageConfirmed, true);
  });

  test('the field never reaches another user or a logged-out viewer', async () => {
    for (const token of [undefined, tokenFor('other')]) {
      const { text, body } = await call(server, '/api/users/new', { token });
      assert.ok(!('ageConfirmed' in body));
      assert.ok(!text.includes('ageConfirmedAt'));
    }
    const search = await call(server, '/api/users/search?q=new', { token: tokenFor('other') });
    assert.ok(!search.text.includes('ageConfirmed'));
  });

  test('the field is on the owner view of every response that returns it', async () => {
    const token = tokenFor('new');
    const edited = await call(server, '/api/users/new', { token, method: 'PUT', body: { bio: 'Hi' } });
    assert.equal(edited.body.ageConfirmed, true);
    const avatar = await call(server, '/api/users/new/avatar', { token, method: 'POST', body: { imageData: PNG.toString('base64') } });
    assert.equal(avatar.status, 200);
    assert.equal(avatar.body.ageConfirmed, true);
  });

  test('a profile edit cannot set the field', async () => {
    const token = tokenFor('other');
    const res = await call(server, '/api/users/other', { token, method: 'PUT', body: { ageConfirmed: true, ageConfirmedAt: CONFIRMED_AT } });
    assert.equal(res.body.ageConfirmed, false);
    assert.equal(readDb(server).users.find((u) => u.id === 'other').ageConfirmedAt, undefined);
  });
});

describe('acknowledgement limits and failures', () => {
  const route = '/api/users/new/acknowledgements';
  const confirmBody = { type: 'age', confirmed: true };

  test('it works at the storage limit, where growth is refused', async (t) => {
    const server = await startServer({ DB_GROWTH_MAX_BYTES: '1' }, { dbFixture: { users: [person('new'), confirmed('adult')] } });
    t.after(() => server.stop());
    const token = tokenFor('new');
    const growth = await call(server, '/api/smart-bar', { token: tokenFor('adult'), method: 'POST', body: { name: 'Gin', quantity: '1' } });
    assert.equal(growth.status, 507, 'the limit is in force');
    const res = await call(server, route, { token, method: 'POST', body: confirmBody });
    assert.equal(res.status, 200);
    assert.equal(res.body.ageConfirmed, true);
  });

  test('a failed save returns 503 and rolls back', async (t) => {
    const server = await startServer({ DB_FAULT: 'save', NODE_OPTIONS: `--import=${FAULT_PRELOAD}` }, {
      dbFixture: {
        users: [person('new')],
        drinks: [post(1, 'new', { isAlcoholic: true })],
        nextDrinkId: 2,
      },
    });
    t.after(() => server.stop());
    const token = tokenFor('new');
    const marker = `${server.dbFile}.fail-saves`;
    fs.writeFileSync(marker, '');
    assert.equal((await call(server, route, { token, method: 'POST', body: confirmBody })).status, 503);
    fs.rmSync(marker);
    assert.equal((await call(server, '/api/users/new', { token })).body.ageConfirmed, false);
    assertAgeRequired(await call(server, '/api/drinks/1', { token }), 'after the failed save');

    assert.equal((await call(server, route, { token, method: 'POST', body: confirmBody })).status, 200);
    assert.equal((await call(server, '/api/drinks/1', { token })).status, 200);
  });
});

describe('AI recipes', () => {
  let server;
  let stubDir;
  const stubFile = (name) => path.join(stubDir, name);
  const MOCKTAIL = { title: 'Virgin Mule', difficulty: 'mocktail', ingredients: [{ name: 'Lime', amount_oz: 1, amount_ml: 30 }], garnish: null, instructions: 'Stir.' };
  const COCKTAIL = { ...MOCKTAIL, title: 'Gin Tonic', difficulty: 'easy' };
  const MOCKTAIL_RULE = /Every recipe must have difficulty "mocktail" and contain zero alcohol/;
  const SMART_BAR = '/api/smart-bar/generate-recipes';
  const FILTER_USERS = 40;
  let nextFilterUser = 0;
  const PRODUCT = '/api/generate-recipes';

  before(async () => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drinkme-age-stub-'));
    fs.writeFileSync(stubFile('behavior.json'), JSON.stringify({ outputText: JSON.stringify({ recipes: [COCKTAIL, MOCKTAIL] }) }));
    server = await startServer(
      { AI_ENABLED: 'true', OPENAI_API_KEY: 'sk-fake', OPENAI_STUB_DIR: stubDir, NODE_OPTIONS: `--import=${STUB_PRELOAD}` },
      { dbFixture: { users: [person('minor'), confirmed('adult'), ...Array.from({ length: FILTER_USERS }, (_, i) => confirmed(`filter${i}`))] } },
    );
  });
  after(async () => {
    await server?.stop();
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  const lastCall = () => {
    const lines = fs.readFileSync(stubFile('calls.jsonl'), 'utf8').split('\n').filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  };
  const titlesOf = (recipes) => recipes.map((recipe) => recipe.title);

  const smartBar = (token, extra = {}) => call(server, SMART_BAR, { token, method: 'POST', body: { ingredients: ['gin'], ...extra } });
  const product = (token, extra = {}) => call(server, PRODUCT, { token, method: 'POST', body: { productName: 'Gin', ...extra } });

  // The routes still force mocktails for an unconfirmed user, but the gate in front of them refuses first.
  test('an unconfirmed user gets age_required from both routes, and OpenAI is not called', async () => {
    const callCount = () => (fs.existsSync(stubFile('calls.jsonl')) ? fs.readFileSync(stubFile('calls.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0);
    const before = callCount();
    for (const extra of [{}, { nonAlcoholicOnly: false }, { nonAlcoholicOnly: true }]) {
      assertAgeRequired(await smartBar(tokenFor('minor'), extra), JSON.stringify(extra));
    }
    for (const extra of [{}, { isAlcoholic: true }, { isAlcoholic: false }]) {
      assertAgeRequired(await product(tokenFor('minor'), extra), JSON.stringify(extra));
    }
    assert.equal(callCount(), before);
  });

  test('a confirmed user keeps normal behaviour', async () => {
    const adult = tokenFor('adult');
    const bar = await smartBar(adult, { nonAlcoholicOnly: false });
    assert.deepEqual(titlesOf(bar.body), ['Gin Tonic', 'Virgin Mule']);
    assert.doesNotMatch(lastCall().instructions, MOCKTAIL_RULE);

    const barDefault = await smartBar(adult);
    assert.deepEqual(titlesOf(barDefault.body), ['Gin Tonic', 'Virgin Mule']);

    const barMocktails = await smartBar(adult, { nonAlcoholicOnly: true });
    assert.deepEqual(titlesOf(barMocktails.body), ['Virgin Mule']);
    assert.match(lastCall().instructions, MOCKTAIL_RULE);

    const withProduct = await product(adult, { isAlcoholic: true });
    assert.deepEqual(titlesOf(withProduct.body.recipes), ['Gin Tonic', 'Virgin Mule']);
    assert.doesNotMatch(lastCall().instructions, MOCKTAIL_RULE);

    const mocktailProduct = await product(adult, { isAlcoholic: false });
    assert.deepEqual(titlesOf(mocktailProduct.body.recipes), ['Virgin Mule']);
  });

  describe('the alcohol check on a mocktail-only answer', () => {
    const behave = (...recipes) => fs.writeFileSync(stubFile('behavior.json'), JSON.stringify({ outputText: JSON.stringify({ recipes }) }));
    const restore = () => behave(COCKTAIL, MOCKTAIL);
    // A confirmed user who asks for mocktails gets the same check an unconfirmed one used to.
    const ask = (route = SMART_BAR) => {
      const token = tokenFor(`filter${nextFilterUser++ % FILTER_USERS}`);
      return route === SMART_BAR ? smartBar(token, { nonAlcoholicOnly: true }) : product(token, { isAlcoholic: false });
    };
    const withField = (field, text) => ({
      ...MOCKTAIL,
      ...(field === 'ingredients' ? { ingredients: [{ name: text, amount_oz: 1, amount_ml: 30 }] } : { [field]: text }),
    });

    for (const route of [SMART_BAR, PRODUCT]) {
      for (const field of ['title', 'ingredients', 'garnish', 'instructions']) {
        test(`${route}: Whisky in ${field} is dropped, and nothing left is a 502`, async (t) => {
          t.after(restore);
          behave(withField(field, 'Add Whisky'));
          const res = await ask(route);
          assert.equal(res.status, 502);
          assert.equal(res.body.code, 'ai_invalid_output');
          assert.ok(!res.text.includes('Whisky'));
        });
      }
    }

    test('only the recipe that mentions alcohol is dropped', async (t) => {
      t.after(restore);
      behave(withField('instructions', 'Top with whiskey.'), MOCKTAIL);
      const res = await ask();
      assert.equal(res.status, 200);
      assert.deepEqual(titlesOf(res.body), ['Virgin Mule']);
    });

    for (const word of [
      'whisky', 'VODKA', 'gin', 'Gin,', 'rum.', 'tequila', 'brandy', 'white wine', 'beer', 'amaretto liqueur', 'Angostura bitters',
      'vermouth', 'vermut', 'țuică', 'ŢUICĂ', 'tuica', 'palincă', 'Pălincă', 'bere', 'vin roșu', 'lichior', 'șampanie', 'coniac',
      'triple-sec', 'wh\u200Bisky', 'alcohol',
    ]) {
      test(`"${word}" is refused`, async (t) => {
        t.after(restore);
        behave(withField('ingredients', word));
        assert.equal((await ask()).status, 502);
      });
    }

    for (const text of [
      'Ginger', 'ginger syrup', 'Gingerbread', 'Virginia peach', 'Rummy lime', 'Drum of ice', 'non-alcoholic', 'Non alcoholic',
      'alcohol-free', 'zero alcohol', 'fără alcool', 'nonalcoholic', 'ginger beer', 'root beer', 'Beverage', 'wine glass', 'apple cider vinegar',
      'Rome', 'bitter lemon',
    ]) {
      test(`"${text}" is not a false hit`, async (t) => {
        t.after(restore);
        behave(withField('ingredients', text));
        const res = await ask();
        assert.equal(res.status, 200, text);
        assert.deepEqual(titlesOf(res.body), ['Virgin Mule']);
      });
    }

    test('an alcohol word next to a safe phrase is still refused', async (t) => {
      t.after(restore);
      behave(withField('instructions', 'A non-alcoholic base with a shot of vodka.'));
      assert.equal((await ask()).status, 502);
    });

    test('a confirmed user who did not ask for mocktails is not checked', async (t) => {
      t.after(restore);
      behave(withField('title', 'Whisky Sour'));
      const res = await smartBar(tokenFor('adult'));
      assert.equal(res.status, 200);
      assert.deepEqual(titlesOf(res.body), ['Whisky Sour']);
    });

    test('a confirmed user who asked for mocktails is checked', async (t) => {
      t.after(restore);
      behave(withField('title', 'Whisky Sour'));
      assert.equal((await smartBar(tokenFor('adult'), { nonAlcoholicOnly: true })).status, 502);
    });

    test('the product instructions forbid using an alcoholic product', async () => {
      await product(tokenFor('adult'), { isAlcoholic: false });
      assert.match(lastCall().instructions, /If the product contains alcohol, do not use it; suggest alcohol-free recipes in a similar style\./);
    });
  });

  test('confirming changes the answer at once', async () => {
    const token = tokenFor('minor');
    assertAgeRequired(await smartBar(token), 'before');
    assert.equal((await call(server, '/api/users/minor/acknowledgements', { token, method: 'POST', body: { type: 'age', confirmed: true } })).status, 200);
    assert.deepEqual(titlesOf((await smartBar(token)).body), ['Gin Tonic', 'Virgin Mule']);
  });

  test('an invalid flag still gets 400', async () => {
    assert.equal((await smartBar(tokenFor('adult'), { nonAlcoholicOnly: 'yes' })).status, 400);
    assert.equal((await product(tokenFor('adult'), { isAlcoholic: 'yes' })).status, 400);
  });
});

describe('AI off', () => {
  test('recipe routes answer age_required to an unconfirmed user and 503 to a confirmed one', async (t) => {
    const server = await startServer({}, { dbFixture: { users: [person('minor'), confirmed('adult')] } });
    t.after(() => server.stop());
    const body = { productName: 'Gin' };
    assertAgeRequired(await call(server, '/api/generate-recipes', { token: tokenFor('minor'), method: 'POST', body }), 'minor');
    const res = await call(server, '/api/generate-recipes', { token: tokenFor('adult'), method: 'POST', body });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'ai_disabled');
  });
});
