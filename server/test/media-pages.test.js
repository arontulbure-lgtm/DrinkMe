import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';

import { startServer } from './helpers/harness.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypheic'), Buffer.alloc(4)]);
const GOOGLE_PHOTO = 'https://lh3.googleusercontent.com/a/photo.jpg';
const MAX_T1_7_RESPONSE_BYTES = 256 * 1024;

const dataUrl = (mime, bytes) => `data:image/${mime};base64,${bytes.toString('base64')}`;
const readDb = (dbFile) => JSON.parse(fs.readFileSync(dbFile, 'utf8'));

const call = async (server, path, { token, method = 'GET', body } = {}) => {
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body && { 'Content-Type': 'application/json' }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : undefined };
};

const media = async (server, path) => {
  const res = await fetch(`${server.baseUrl}${path}`);
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
};

const signIn = async (server, uid, extra = {}) => {
  const { status, body } = await call(server, '/api/auth/mobile', {
    method: 'POST',
    body: { idToken: 'dev', uid, email: `${uid}@example.test`, displayName: `Name ${uid}`, ...extra },
  });
  assert.equal(status, 200);
  return body.token;
};

const user = (id, avatar = null) => ({
  id, email: `${id}@example.test`, firstName: id, lastName: 'Test', city: '', bio: '', nameSetByUser: true, avatar, ageConfirmedAt: '2026-01-01T00:00:00.000Z',
});

const drink = (id, userId, extra = {}) => ({
  id, userId, name: `Drink ${id}`, description: 'Plain', rating: 4, location: null, isAlcoholic: false,
  createdAt: '2026-01-01T00:00:00.000Z', cheersCount: 0, tags: [], imageUrl: dataUrl('png', PNG), ...extra,
});

const manyDrinks = (count, userId) => Array.from({ length: count }, (_, i) => drink(i + 1, userId));

describe('bounded lists', () => {
  test('224 comments by 8 accounts with 2 MB avatars stay small when logged out', async (t) => {
    const avatarBytes = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 - PNG.length, 7)]);
    const users = Array.from({ length: 8 }, (_, i) => user(`heavy${i}`, dataUrl('png', avatarBytes)));
    const comments = Array.from({ length: 224 }, (_, i) => ({
      id: i + 1, drinkId: 1, userId: `heavy${i % 8}`, content: `Comment ${i + 1}`, createdAt: '2026-01-01T00:00:00.000Z',
    }));
    const server = await startServer({}, {
      dbFixture: { users, drinks: [drink(1, 'heavy0')], nextDrinkId: 2, commentsByDrink: { 1: comments }, nextCommentId: 225 },
    });
    t.after(() => server.stop());

    const { status, text, body } = await call(server, '/api/drinks/1/comments');
    assert.equal(status, 200);
    assert.ok(Buffer.byteLength(text) < MAX_T1_7_RESPONSE_BYTES, `response was ${Buffer.byteLength(text)} bytes`);
    assert.ok(!text.includes('data:'));
    assert.equal(body.items.length, 20);
    assert.equal(body.items[0].id, 224, 'newest first');
    assert.equal(body.nextCursor, 205);
  });

  describe('with 190 posts', () => {
    let server;
    let token;

    before(async () => {
      const savedIds = Array.from({ length: 190 }, (_, i) => i + 1);
      server = await startServer({}, {
        dbFixture: {
          users: [user('poster')],
          // Stored oldest first on purpose: the order must come from the id, not the array.
          drinks: manyDrinks(190, 'poster'),
          nextDrinkId: 191,
          savedByUser: { poster: savedIds },
          partnersByUser: { poster: [] },
        },
      });
      token = await signIn(server, 'poster');
    });
    after(() => server?.stop());

    for (const route of ['/api/drinks', '/api/drinks/partners', '/api/drinks/user/poster', '/api/users/poster/saved-drinks']) {
      test(`${route} visits each post once through the cursor`, async () => {
        const seen = [];
        let before;
        for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
          const query = before === undefined ? '' : `?before=${before}`;
          const { status, body } = await call(server, `${route}${query}`, { token });
          assert.equal(status, 200);
          assert.ok(body.items.length <= 20);
          seen.push(...body.items.map((item) => item.id));
          before = body.nextCursor;
          if (before === null) break;
        }
        assert.equal(before, null);
        assert.deepEqual(seen, Array.from({ length: 190 }, (_, i) => 190 - i));
      });
    }

    test('limit is honoured up to 50, and the default is 20', async () => {
      assert.equal((await call(server, '/api/drinks')).body.items.length, 20);
      assert.equal((await call(server, '/api/drinks?limit=50')).body.items.length, 50);
      const one = (await call(server, '/api/drinks?limit=1')).body;
      assert.deepEqual(one.items.map((item) => item.id), [190]);
      assert.equal(one.nextCursor, 190);
    });

    test('a page that reaches the end has a null cursor', async () => {
      const { body } = await call(server, '/api/drinks?before=3');
      assert.deepEqual(body.items.map((item) => item.id), [2, 1]);
      assert.equal(body.nextCursor, null);

      const exactlyFull = (await call(server, '/api/drinks?before=3&limit=2')).body;
      assert.deepEqual(exactlyFull.items.map((item) => item.id), [2, 1]);
      assert.equal(exactlyFull.nextCursor, null, 'a full last page must not offer another page');
    });

    test('total counts every post of the user, not the page', async () => {
      assert.equal((await call(server, '/api/drinks/user/poster?limit=1')).body.total, 190);
      assert.equal((await call(server, '/api/drinks/user/poster?before=3')).body.total, 190);
      assert.equal((await call(server, '/api/drinks/user/nobody')).body.total, 0);
    });

    test('the stored-token check of the app gets one post and no image bytes', async () => {
      const { status, text, body } = await call(server, '/api/users/poster/saved-drinks?limit=1', { token });
      assert.equal(status, 200);
      assert.equal(body.items.length, 1);
      assert.ok(!text.includes('data:'));
    });
  });

  test('invalid limit or before gets 400 on all five routes', async (t) => {
    const server = await startServer({}, {
      dbFixture: { users: [user('poster')], drinks: [drink(1, 'poster')], nextDrinkId: 2 },
    });
    t.after(() => server.stop());
    const token = await signIn(server, 'poster');
    const routes = [
      '/api/drinks',
      '/api/drinks/partners',
      '/api/drinks/user/poster',
      '/api/users/poster/saved-drinks',
      '/api/drinks/1/comments',
    ];
    const badQueries = [
      'limit=0', 'limit=51', 'limit=1e3', 'limit=-1', 'limit=1.5', 'limit=abc', 'limit=', 'limit=01', 'limit=0x10',
      'limit=1&limit=2', 'limit[]=1', 'limit[a]=1', 'limit=%201',
      'before=0', 'before=-1', 'before=1e3', 'before=1.5', 'before=abc', 'before=', 'before=1&before=2', 'before=99999999999999999',
    ];
    for (const route of routes) {
      await server.restart(); // resets the /api limit, which this many requests would otherwise reach
      for (const query of badQueries) {
        const { status, body } = await call(server, `${route}?${query}`, { token });
        assert.equal(status, 400, `${route}?${query}`);
        assert.equal(typeof body.error, 'string');
      }
    }
  });

  test('comments page newest first through the cursor', async (t) => {
    const comments = Array.from({ length: 45 }, (_, i) => ({
      id: i + 1, drinkId: 1, userId: 'poster', content: `C${i + 1}`, createdAt: '2026-01-01T00:00:00.000Z',
    }));
    const server = await startServer({}, {
      dbFixture: { users: [user('poster')], drinks: [drink(1, 'poster')], nextDrinkId: 2, commentsByDrink: { 1: comments }, nextCommentId: 46 },
    });
    t.after(() => server.stop());
    const first = (await call(server, '/api/drinks/1/comments')).body;
    const second = (await call(server, `/api/drinks/1/comments?before=${first.nextCursor}`)).body;
    const third = (await call(server, `/api/drinks/1/comments?before=${second.nextCursor}`)).body;
    const ids = [...first.items, ...second.items, ...third.items].map((c) => c.id);
    assert.deepEqual(ids, Array.from({ length: 45 }, (_, i) => 45 - i));
    assert.equal(third.nextCursor, null);
  });
});

describe('GET /api/drinks filters', () => {
  let server;
  let viewerToken;

  before(async () => {
    server = await startServer({}, {
      dbFixture: {
        users: [user('viewer'), user('friend'), user('stranger')],
        drinks: [
          drink(1, 'viewer', { name: 'Own Mojito', isAlcoholic: true, cheersCount: 50 }),
          drink(2, 'friend', { name: 'Friend Spritz', isAlcoholic: true, cheersCount: 40 }),
          drink(3, 'stranger', { name: 'Stranger Lager', location: 'Cluj Centre', isAlcoholic: true, cheersCount: 3 }),
          drink(4, 'stranger', { name: 'Tea', description: 'Calm evening (a.*b)', isAlcoholic: false, cheersCount: 9 }),
          drink(5, 'stranger', { name: 'No flag', isAlcoholic: undefined, cheersCount: 9 }),
          drink(6, 'viewer', { name: 'a'.repeat(100), isAlcoholic: true }),
        ],
        nextDrinkId: 7,
        partnersByUser: { viewer: ['friend'], friend: ['viewer'] },
      },
    });
    viewerToken = await signIn(server, 'viewer');
  });
  after(() => server?.stop());

  const ids = async (query, token = viewerToken) => {
    const { status, body } = await call(server, `/api/drinks?${query}`, { token });
    assert.equal(status, 200, query);
    return body.items.map((item) => item.id);
  };

  test('q matches name, description and location, in any case', async () => {
    assert.deepEqual(await ids('q=MOJITO'), [1]);
    assert.deepEqual(await ids('q=calm'), [4]);
    assert.deepEqual(await ids('q=cluj'), [3]);
    assert.deepEqual(await ids('q=nothing-matches'), []);
  });

  test('q is plain text, never a pattern', async () => {
    assert.deepEqual(await ids('q=.*'), [4]);
    assert.deepEqual(await ids(`q=${encodeURIComponent('(a.*b)')}`), [4]);
    assert.deepEqual(await ids(`q=${encodeURIComponent('[')}`), []);
    assert.deepEqual(await ids(`q=${encodeURIComponent('(')}`), [4]);
  });

  test('q is cut at 100 characters', async () => {
    assert.deepEqual(await ids(`q=${'x'.repeat(5000)}`), []);
    assert.deepEqual(await ids(`q=${'a'.repeat(100)}zzz`), [6]);
  });

  test('a repeated or nested q or city gets 400', async () => {
    for (const query of ['q=a&q=b', 'q[]=a', 'q[a]=b', 'city=a&city=b', 'city[]=a']) {
      assert.equal((await call(server, `/api/drinks?${query}`)).status, 400, query);
    }
  });

  test('city still filters by location', async () => {
    assert.deepEqual(await ids('city=cluj'), [3]);
  });

  test('alcoholic=false keeps only posts marked non-alcoholic', async () => {
    assert.deepEqual(await ids('alcoholic=false'), [4]);
  });

  test('scope=discover hides own and partner posts, and needs a signed-in user', async () => {
    assert.deepEqual(await ids('scope=discover', viewerToken), [5, 4, 3]);
    assert.equal((await call(server, '/api/drinks?scope=discover')).status, 401);
    assert.equal((await call(server, '/api/drinks?scope=discover', { token: 'not-a-token' })).status, 401);
  });

  test('filters combine', async () => {
    assert.deepEqual(await ids('scope=discover&alcoholic=false', viewerToken), [4]);
  });

  test('sort=trending orders by cheers, then newest, with no next page', async () => {
    const { body } = await call(server, '/api/drinks?scope=discover&sort=trending', { token: viewerToken });
    assert.deepEqual(body.items.map((item) => item.id), [5, 4, 3]);
    assert.equal(body.nextCursor, null);
    assert.deepEqual(await ids('sort=trending&limit=2'), [1, 2]);
  });

  test('unknown filter values get 400', async () => {
    for (const query of ['alcoholic=true', 'alcoholic=0', 'scope=all', 'sort=new', 'sort=trending&before=5', 'sort=trending&sort=trending']) {
      assert.equal((await call(server, `/api/drinks?${query}`, { token: viewerToken })).status, 400, query);
    }
  });
});

describe('GET /api/drinks with 60 posts', () => {
  let server;

  // Every third post is non-alcoholic, and posts 1 to 30 are by a stranger to the viewer.
  before(async () => {
    const drinks = manyDrinks(60, 'poster').map((item) => ({
      ...item,
      userId: item.id <= 30 ? 'stranger' : 'poster',
      isAlcoholic: item.id % 3 !== 0,
    }));
    drinks[0].name = 'Needle'; // the oldest post, beyond the first page
    server = await startServer({}, {
      dbFixture: { users: [user('poster'), user('stranger')], drinks, nextDrinkId: 61 },
    });
  });
  after(() => server?.stop());

  const walk = async (query, token, firstCursor = null) => {
    const seen = [];
    let cursor = firstCursor;
    do {
      const { body } = await call(server, `/api/drinks?${query}${cursor ? `&before=${cursor}` : ''}`, { token });
      seen.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
    } while (cursor !== null);
    return seen;
  };

  test('alcoholic=false finds every match past page 1', async () => {
    const expected = Array.from({ length: 60 }, (_, i) => 60 - i).filter((id) => id % 3 === 0);
    assert.deepEqual(await walk('alcoholic=false&limit=5'), expected);
  });

  test('scope=discover finds every match past page 1', async () => {
    const token = await signIn(server, 'poster');
    assert.deepEqual(await walk('scope=discover&limit=10', token), Array.from({ length: 30 }, (_, i) => 30 - i));
  });

  test('a post made mid-walk causes no duplicate and no gap', async () => {
    const token = await signIn(server, 'poster');
    const first = (await call(server, '/api/drinks?limit=20', { token })).body;
    const created = await call(server, '/api/drinks', {
      token,
      method: 'POST',
      body: { name: 'Mid walk', description: 'New', rating: 3, imageData: PNG.toString('base64') },
    });
    assert.equal(created.status, 201);
    const seen = [...first.items.map((item) => item.id), ...await walk('limit=20', token, first.nextCursor)];
    assert.deepEqual(seen, Array.from({ length: 60 }, (_, i) => 60 - i));
    assert.equal((await call(server, '/api/drinks?limit=1', { token })).body.items[0].id, created.body.id);
  });

  test('q finds a post beyond the first page', async () => {
    const token = await signIn(server, 'poster');
    const { body } = await call(server, '/api/drinks?q=Needle', { token });
    assert.deepEqual(body.items.map((item) => item.id), [1]);
  });

  test('sort=trending returns at most 20, even when asked for more', async () => {
    const { body } = await call(server, '/api/drinks?sort=trending&limit=50');
    assert.equal(body.items.length, 20);
    assert.equal(body.nextCursor, null);
  });
});

describe('media routes', () => {
  let server;
  let token;

  const drinks = [
    drink(1, 'owner'),
    drink(2, 'owner', { imageUrl: dataUrl('jpeg', JPEG) }),
    drink(3, 'owner', { imageUrl: dataUrl('webp', WEBP) }),
    drink(4, 'owner', { imageUrl: dataUrl('heic', HEIC) }),
    drink(5, 'owner', { imageUrl: 'data:image/png;base64,not base64!' }),
    drink(6, 'owner', { imageUrl: dataUrl('svg+xml', Buffer.from('<svg/>')) }),
    drink(7, 'owner', { imageUrl: `data:text/html;base64,${Buffer.from('<b>').toString('base64')}` }),
    drink(8, 'owner', { imageUrl: dataUrl('png', Buffer.from('not an image at all')) }),
    drink(9, 'owner', { imageUrl: 12345 }),
    drink(10, 'owner', { imageUrl: null }),
    drink(11, 'owner', { imageUrl: GOOGLE_PHOTO }),
    drink(12, 'owner', { imageUrl: 'data:image/png;base64,' }),
  ];

  before(async () => {
    server = await startServer({}, {
      dbFixture: {
        users: [
          user('owner', dataUrl('png', PNG)),
          user('provider', GOOGLE_PHOTO),
          user('plain'),
          user('corrupt', 'data:image/png;base64,AAAA'),
          user('svg', dataUrl('svg+xml', Buffer.from('<svg/>'))),
        ],
        drinks,
        nextDrinkId: 13,
        partnersByUser: { owner: ['provider'], provider: ['owner'] },
        savedByUser: { owner: [1] },
        commentsByDrink: { 1: [{ id: 1, drinkId: 1, userId: 'owner', content: 'Hi', createdAt: '2026-01-01T00:00:00.000Z' }] },
        nextCommentId: 2,
      },
    });
    token = await signIn(server, 'owner');
  });
  after(() => server?.stop());

  test('a post image comes back with the right bytes and type', async () => {
    for (const [id, mime, bytes] of [[1, 'image/png', PNG], [2, 'image/jpeg', JPEG], [3, 'image/webp', WEBP], [4, 'image/heic', HEIC]]) {
      const res = await media(server, `/media/drinks/${id}`);
      assert.equal(res.status, 200, mime);
      assert.equal(res.headers.get('content-type'), mime);
      assert.deepEqual(res.bytes, bytes);
    }
  });

  test('the response keeps nosniff, allows other origins and may be cached privately', async () => {
    const { headers: drinkHeaders } = await media(server, '/media/drinks/1');
    const { headers: avatarHeaders } = await media(server, '/media/avatars/owner');
    for (const headers of [drinkHeaders, avatarHeaders]) {
      assert.equal(headers.get('x-content-type-options'), 'nosniff');
      assert.equal(headers.get('cross-origin-resource-policy'), 'cross-origin');
      assert.equal(headers.get('cache-control'), 'private, max-age=86400');
    }
  });

  test('an avatar comes back with the right bytes and type, with or without v', async () => {
    const { avatar } = (await call(server, '/api/users/owner')).body;
    assert.match(avatar, /^\/media\/avatars\/owner\?v=[0-9a-f]{12}$/);
    for (const path of [avatar, '/media/avatars/owner', '/media/avatars/owner?v=stale']) {
      const res = await media(server, path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('content-type'), 'image/png');
      assert.deepEqual(res.bytes, PNG);
    }
  });

  test('anything unusable or missing gets 404, never 500', async () => {
    const paths = [
      '/media/drinks/5', '/media/drinks/6', '/media/drinks/7', '/media/drinks/8', '/media/drinks/9',
      '/media/drinks/10', '/media/drinks/12',
      '/media/drinks/999', '/media/drinks/abc', '/media/drinks/1e0', '/media/drinks/0x1', '/media/drinks/1.0', '/media/drinks/-1',
      '/media/avatars/nobody', '/media/avatars/plain', '/media/avatars/corrupt', '/media/avatars/svg', '/media/other',
    ];
    for (const path of paths) {
      const res = await media(server, path);
      assert.equal(res.status, 404, path);
      assert.ok(!res.bytes.includes('data:'), path);
    }
  });

  test('a provider photo is never proxied', async () => {
    assert.equal((await media(server, '/media/avatars/provider')).status, 404);
    assert.equal((await media(server, '/media/drinks/11')).status, 404);
    assert.equal((await call(server, '/api/users/provider')).body.avatar, GOOGLE_PHOTO);
    assert.equal((await call(server, '/api/drinks/11')).body.imageUrl, null, 'a post image is never a remote URL');
  });

  test('a stored type that is never served shows as no image', async () => {
    assert.equal((await call(server, '/api/users/svg')).body.avatar, null);
    assert.equal((await call(server, '/api/drinks/6')).body.imageUrl, null);
    assert.equal((await call(server, '/api/drinks/7')).body.imageUrl, null);
    assert.equal((await call(server, '/api/drinks/9')).body.imageUrl, null);
    assert.equal((await call(server, '/api/users/plain')).body.avatar, null);
  });

  test('a GET with a malformed JSON body still gets the image: no body parser runs', async () => {
    const { hostname, port } = new URL(server.baseUrl);
    const status = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname, port, path: '/media/drinks/1', method: 'GET', headers: { 'Content-Type': 'application/json', 'Content-Length': '9' },
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end('{not json');
    });
    assert.equal(status, 200);
  });

  test('no JSON response holds image bytes', async () => {
    const routes = [
      '/api/drinks', '/api/drinks/partners', '/api/drinks/1', '/api/drinks/user/owner', '/api/drinks/1/comments',
      '/api/users/owner', '/api/users/owner/partners', '/api/users/provider/partners', '/api/users/owner/saved-drinks',
      '/api/users/search?q=owner', '/api/drink-partners',
    ];
    for (const route of routes) {
      const { status, text } = await call(server, route, { token });
      assert.equal(status, 200, route);
      assert.ok(!text.includes('data:'), `${route} holds a data URL`);
      assert.ok(!text.includes(PNG.toString('base64')), `${route} holds base64`);
    }
    assert.ok((await call(server, '/api/drinks/1')).body.imageUrl === '/media/drinks/1');
  });

  test('media requests do not count against the /api limit', async () => {
    const remainingBefore = Number((await call(server, '/api/stories')).headers.get('ratelimit-remaining'));
    const { headers } = await media(server, '/media/drinks/1');
    assert.equal(headers.get('ratelimit-limit'), '600');
    const statuses = await Promise.all(Array.from({ length: 120 }, () => media(server, '/media/drinks/1')));
    assert.ok(statuses.every((res) => res.status === 200));
    const remainingAfter = Number((await call(server, '/api/stories')).headers.get('ratelimit-remaining'));
    assert.equal(remainingAfter, remainingBefore - 1);
  });
});

describe('legacy image/jpg prefix', () => {
  test('it is served as jpeg, and its bytes are still checked', async (t) => {
    const server = await startServer({}, {
      dbFixture: {
        users: [user('owner', dataUrl('jpg', JPEG))],
        drinks: [
          drink(1, 'owner', { imageUrl: dataUrl('jpg', JPEG) }),
          drink(2, 'owner', { imageUrl: dataUrl('jpg', Buffer.from('not an image at all')) }),
        ],
        nextDrinkId: 3,
      },
    });
    t.after(() => server.stop());
    for (const path of ['/media/drinks/1', '/media/avatars/owner']) {
      const res = await media(server, path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('content-type'), 'image/jpeg', path);
      assert.deepEqual(res.bytes, JPEG, path);
    }
    assert.equal((await call(server, '/api/drinks/1')).body.imageUrl, '/media/drinks/1');
    assert.match((await call(server, '/api/users/owner')).body.avatar, /^\/media\/avatars\/owner\?v=/);
    assert.equal((await media(server, '/media/drinks/2')).status, 404);
  });
});

describe('media cache', () => {
  let server;
  let token;

  before(async () => {
    // Fits any two of PNG (12 bytes), JPEG (8) and WEBP (12), but not all three.
    server = await startServer({ MEDIA_CACHE_MAX_BYTES: '24' }, {
      dbFixture: {
        users: [user('owner', dataUrl('png', PNG))],
        drinks: [
          drink(1, 'owner', { imageUrl: dataUrl('png', PNG) }),
          drink(2, 'owner', { imageUrl: dataUrl('jpeg', JPEG) }),
          drink(3, 'owner', { imageUrl: dataUrl('webp', WEBP) }),
          drink(4, 'owner', { imageUrl: dataUrl('png', Buffer.concat([PNG, Buffer.alloc(40)])) }),
        ],
        nextDrinkId: 5,
      },
    });
    token = await signIn(server, 'owner');
  });
  after(() => server?.stop());

  const cacheState = async (path) => (await media(server, path)).headers.get('x-media-cache');

  // Not fetch: it adds Cache-Control: no-cache to a request with If-None-Match, which forces a full reply.
  const getWithEtag = (etag) => new Promise((resolve, reject) => {
    const { hostname, port } = new URL(server.baseUrl);
    http.get({ hostname, port, path: '/media/drinks/1', headers: { 'If-None-Match': etag } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    }).on('error', reject);
  });

  test('a repeated GET or HEAD uses the decoded bytes', async () => {
    assert.equal(await cacheState('/media/drinks/1'), 'miss');
    assert.equal(await cacheState('/media/drinks/1'), 'hit');
    const head = await fetch(`${server.baseUrl}/media/drinks/1`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('x-media-cache'), 'hit');
    assert.equal(head.headers.get('content-length'), String(PNG.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  });

  test('If-None-Match gets 304 with no body, and another ETag gets the image', async () => {
    const etag = (await media(server, '/media/drinks/1')).headers.get('etag');
    assert.match(etag, /^"[0-9a-f]{32}"$/);
    const notModified = await getWithEtag(etag);
    assert.equal(notModified.status, 304);
    assert.equal(notModified.bytes.length, 0);
    assert.equal(notModified.headers['cache-control'], 'private, max-age=86400');
    const changed = await getWithEtag('"other"');
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.bytes, PNG);
  });

  test('the size bound evicts the least recently used image', async () => {
    await media(server, '/media/drinks/2');
    await media(server, '/media/drinks/1'); // now the most recent, so drink 2 goes first
    assert.equal(await cacheState('/media/drinks/3'), 'miss');
    assert.equal(await cacheState('/media/drinks/1'), 'hit');
    assert.equal(await cacheState('/media/drinks/2'), 'miss');
  });

  test('an image larger than the bound is served but not kept', async () => {
    assert.equal(await cacheState('/media/drinks/4'), 'miss');
    const res = await media(server, '/media/drinks/4');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-media-cache'), 'miss');
  });

  test('a replaced image serves the new bytes and a new ETag at once', async () => {
    const first = await media(server, '/media/avatars/owner');
    assert.deepEqual(first.bytes, PNG);
    assert.equal((await media(server, '/media/avatars/owner')).headers.get('x-media-cache'), 'hit');
    const upload = await call(server, '/api/users/owner/avatar', {
      token,
      method: 'POST',
      body: { imageData: JPEG.toString('base64') },
    });
    assert.equal(upload.status, 200);
    const replaced = await media(server, '/media/avatars/owner');
    assert.equal(replaced.headers.get('x-media-cache'), 'miss');
    assert.deepEqual(replaced.bytes, JPEG);
    assert.notEqual(replaced.headers.get('etag'), first.headers.get('etag'));
  });
});

describe('photo URLs on output', () => {
  test('a stored photo on any other host shows as no image, and stays stored', async (t) => {
    const foreign = ['https://1.2.3.4.bc.googleusercontent.com/a.jpg', 'https://evil.example/a.jpg', 'http://lh3.googleusercontent.com/a.jpg'];
    const server = await startServer({}, {
      dbFixture: { users: [...foreign.map((url, i) => user(`foreign${i}`, url)), user('fine', 'https://lh6.googleusercontent.com/a.jpg')] },
    });
    t.after(() => server.stop());
    for (let i = 0; i < foreign.length; i += 1) {
      assert.equal((await call(server, `/api/users/foreign${i}`)).body.avatar, null, foreign[i]);
    }
    assert.equal((await call(server, '/api/users/fine')).body.avatar, 'https://lh6.googleusercontent.com/a.jpg');
    await signIn(server, 'foreign0');
    assert.equal(readDb(server.dbFile).users.find((u) => u.id === 'foreign0').avatar, foreign[0]);
  });
});

describe('mutation responses', () => {
  test('PUT, avatar upload and comment POST hold no image bytes', async (t) => {
    const server = await startServer({}, {
      dbFixture: { users: [user('owner', dataUrl('png', PNG))], drinks: [drink(1, 'owner')], nextDrinkId: 2 },
    });
    t.after(() => server.stop());
    const token = await signIn(server, 'owner');
    const responses = [
      await call(server, '/api/users/owner', { token, method: 'PUT', body: { bio: 'New' } }),
      await call(server, '/api/users/owner/avatar', { token, method: 'POST', body: { imageData: JPEG.toString('base64') } }),
      await call(server, '/api/drinks/1/comments', { token, method: 'POST', body: { content: 'Hi' } }),
    ];
    assert.deepEqual(responses.map((res) => res.status), [200, 200, 201]);
    for (const res of responses) assert.ok(!res.text.includes('data:'), res.text.slice(0, 80));
  });
});

describe('stored images stay raw', () => {
  let server;

  before(async () => {
    server = await startServer({}, {
      dbFixture: {
        users: [user('owner', dataUrl('jpeg', JPEG)), user('google')],
        drinks: [drink(1, 'owner')],
        nextDrinkId: 2,
      },
    });
  });
  after(() => server?.stop());

  const assertNoMediaUrlSaved = () => {
    const saved = fs.readFileSync(server.dbFile, 'utf8');
    assert.ok(!saved.includes('/media/'), 'a /media URL reached the database');
  };

  test('reads and saves never write a /media URL, and a restart serves the original bytes', async () => {
    const token = await signIn(server, 'owner');
    await call(server, '/api/drinks');
    await call(server, '/api/users/owner', { token });
    const created = await call(server, '/api/drinks', {
      token,
      method: 'POST',
      body: { name: 'New', description: 'New', rating: 3, isAlcoholic: false, imageData: PNG.toString('base64') },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.imageUrl, `/media/drinks/${created.body.id}`);
    assert.equal((await call(server, '/api/users/owner', { token, method: 'PUT', body: { bio: 'Saved' } })).status, 200);
    assertNoMediaUrlSaved();
    const db = readDb(server.dbFile);
    assert.equal(db.users.find((u) => u.id === 'owner').avatar, dataUrl('jpeg', JPEG));
    assert.equal(db.drinks.find((d) => d.id === created.body.id).imageUrl, dataUrl('png', PNG));

    const avatarBefore = (await call(server, '/api/users/owner')).body.avatar;
    await server.restart();

    assert.equal((await call(server, '/api/users/owner')).body.avatar, avatarBefore, 'the hash is rebuilt at load');
    assert.deepEqual((await media(server, avatarBefore)).bytes, JPEG);
    assert.deepEqual((await media(server, '/media/drinks/1')).bytes, PNG);
    assert.deepEqual((await media(server, `/media/drinks/${created.body.id}`)).bytes, PNG);
    assertNoMediaUrlSaved();
  });

  test('the avatar URL changes on upload, and both forms of the old URL serve the new bytes', async () => {
    const token = await signIn(server, 'owner');
    const before = (await call(server, '/api/users/owner')).body.avatar;
    const upload = await call(server, '/api/users/owner/avatar', {
      token,
      method: 'POST',
      body: { imageData: WEBP.toString('base64') },
    });
    assert.equal(upload.status, 200);
    assert.notEqual(upload.body.avatar, before);
    assert.equal((await call(server, '/api/users/owner')).body.avatar, upload.body.avatar);
    assert.deepEqual((await media(server, upload.body.avatar)).bytes, WEBP);
    assert.deepEqual((await media(server, before)).bytes, WEBP);
    assertNoMediaUrlSaved();
  });

  test('a provider photo at sign-in passes through, and an upload replaces it', async () => {
    const token = await signIn(server, 'google-new', { photoURL: GOOGLE_PHOTO });
    assert.equal((await call(server, '/api/users/google-new', { token })).body.avatar, GOOGLE_PHOTO);
    assert.equal((await media(server, '/media/avatars/google-new')).status, 404);
    assert.equal(readDb(server.dbFile).users.find((u) => u.id === 'google-new').avatar, GOOGLE_PHOTO);

    const upload = await call(server, '/api/users/google-new/avatar', {
      token,
      method: 'POST',
      body: { imageData: PNG.toString('base64') },
    });
    assert.match(upload.body.avatar, /^\/media\/avatars\/google-new\?v=/);
    // A new account is hidden until this.
    const acknowledged = await call(server, '/api/users/google-new/acknowledgements', { token, method: 'POST', body: { type: 'privacy', version: 1 } });
    assert.equal(acknowledged.status, 200);
    await signIn(server, 'google-new', { photoURL: GOOGLE_PHOTO });
    assert.equal((await call(server, '/api/users/google-new')).body.avatar, upload.body.avatar);
  });

  test('a provider photo fills an empty avatar on a later sign-in', async () => {
    await signIn(server, 'google');
    assert.equal((await call(server, '/api/users/google')).body.avatar, null);
    await signIn(server, 'google', { photoURL: GOOGLE_PHOTO });
    assert.equal((await call(server, '/api/users/google')).body.avatar, GOOGLE_PHOTO);
  });
});
