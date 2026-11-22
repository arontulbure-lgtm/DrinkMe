// One test per line of the "Securitate" section of D:\DrinkMeApp\QA_CHECKLIST.md, named after that line,
// so the manual checklist and the automated checks can be compared line by line.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { REAL_DB_FILE, startServer } from './helpers/harness.js';

const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const STUB_PRELOAD = new URL('./helpers/firebase-auth-stub-preload.js', import.meta.url).href;
const CONFIRMED_AT = '2026-01-02T03:04:05.000Z';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');

const ALICE = 'qa-sec-alice';
const BOB = 'qa-sec-bob';
const MINOR = 'qa-sec-minor';
const BOB_POST_NAME = 'Bob Secret Lemonade';

const tokenFor = (uid, secret = HARNESS_JWT_SECRET) => jwt.sign({ uid }, secret, { algorithm: 'HS256', expiresIn: '1h' });

const person = (id, extra = {}) => ({
  id, email: `${id}@example.test`, firstName: id, lastName: 'Test', city: 'Cluj', bio: 'Bio', nameSetByUser: true,
  avatar: null, privacyNoticeVersion: 2, privacyNoticeAt: CONFIRMED_AT, ...extra,
});

const fixture = () => ({
  dbSchemaVersion: 2,
  users: [
    person(ALICE, { ageConfirmedAt: CONFIRMED_AT }),
    person(BOB, { ageConfirmedAt: CONFIRMED_AT, firstName: 'Bob', lastName: 'Original', bio: 'Original bio' }),
    person(MINOR),
  ],
  drinks: [{
    id: 1, userId: BOB, name: BOB_POST_NAME, description: 'Plain', rating: 4, location: 'Cluj', isAlcoholic: false,
    createdAt: '2026-01-01T00:00:00.000Z', cheersCount: 0, tags: [], imageUrl: PNG_DATA_URL,
  }],
  nextDrinkId: 2,
  savedByUser: { [BOB]: [1] },
  commentsByDrink: {},
  nextCommentId: 1,
});

const call = async (server, route, { token, method = 'GET', body, form, headers = {} } = {}) => {
  const res = await fetch(`${server.baseUrl}${route}`, {
    method,
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    ...(form !== undefined && { body: form }),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  return { status: res.status, headers: res.headers, text, body: parsed };
};

const readDb = (server) => JSON.parse(fs.readFileSync(server.dbFile, 'utf8'));
const dbBytes = (server) => fs.readFileSync(server.dbFile);

const fileForm = (field, bytes, { type, filename }) => {
  const form = new FormData();
  form.append(field, new Blob([bytes], { type }), filename);
  return form;
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

describe('QA checklist, Securitate (dev auth)', () => {
  let server;
  before(async () => {
    server = await startServer({}, { dbFixture: fixture() });
  });
  after(() => server?.stop());

  test('Request fără token la o rută protejată → 401 (testează din Postman/curl)', async () => {
    const before = dbBytes(server);
    const mutations = [
      ['POST', '/api/drinks', { name: 'No Token', description: 'x', rating: 3, isAlcoholic: false, imageData: PNG_DATA_URL }],
      ['POST', '/api/drinks/1/like', {}],
      ['POST', '/api/drinks/1/save', {}],
      ['POST', '/api/drinks/1/comments', { content: 'No token' }],
      ['DELETE', '/api/drinks/1', undefined],
      ['PUT', `/api/users/${BOB}`, { firstName: 'Hacked' }],
      ['POST', '/api/smart-bar', { name: 'Gin', quantity: '1' }],
      ['POST', '/api/reports', { targetType: 'drink', targetId: 1, reason: 'spam' }],
      ['POST', `/api/drink-partners/${BOB}`, {}],
      ['POST', `/api/blocks/${BOB}`, { blocked: true }],
    ];
    // No token on every route; a token signed with another secret and a malformed one on a few. These are
    // keyed by IP in the mutation limiter (30 a minute), so the total stays well under it.
    for (const [token, routes] of [
      [undefined, mutations],
      [tokenFor(ALICE, 'some-other-secret-entirely'), mutations.slice(0, 3)],
      ['not-a-jwt', mutations.slice(0, 3)],
    ]) {
      for (const [method, route, body] of routes) {
        const res = await call(server, route, { method, body, token });
        assert.equal(res.status, 401, `${method} ${route} with token ${token === undefined ? 'none' : 'invalid'}`);
        assert.ok(!res.text.includes(BOB_POST_NAME), `${method} ${route} leaked post text`);
      }
    }
    assert.deepEqual(dbBytes(server), before, 'nothing was saved');
  });

  test('PUT /api/users/:id cu userId diferit → 403', async () => {
    const res = await call(server, `/api/users/${BOB}`, {
      method: 'PUT', token: tokenFor(ALICE), body: { firstName: 'Hacked', lastName: 'Name', city: 'Elsewhere', bio: 'Hacked bio' },
    });
    assert.equal(res.status, 403);
    const stored = readDb(server).users.find((user) => user.id === BOB);
    assert.equal(stored.firstName, 'Bob');
    assert.equal(stored.lastName, 'Original');
    assert.equal(stored.bio, 'Original bio');

    // The owner can still edit, so the 403 is about ownership and not a broken route.
    const own = await call(server, `/api/users/${ALICE}`, { method: 'PUT', token: tokenFor(ALICE), body: { city: 'Iasi' } });
    assert.equal(own.status, 200);
    assert.equal(own.body.city, 'Iasi');
  });

  test('POST cu text extrem de lung (> limita, de ex. descriere > 1000 caractere) → acceptat dar tăiat la limită și sanitizat', async () => {
    // A bidi override, a bell, a C1 control and a NUL, which must all go, then 1200 visible characters.
    const description = `  A\u202Eb\u0007c\u0085d\u0000${'x'.repeat(1200)}`;
    const expected = `Abcd${'x'.repeat(996)}`;
    const name = `N\u202E${'n'.repeat(200)}`;
    const created = await call(server, '/api/drinks', {
      method: 'POST', token: tokenFor(ALICE), body: { name, description, rating: 4, isAlcoholic: false, imageData: PNG_DATA_URL },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.description, expected);
    assert.equal(created.body.description.length, 1000);
    assert.equal(created.body.name, `N${'n'.repeat(119)}`);

    const stored = readDb(server).drinks.find((drink) => drink.id === created.body.id);
    assert.equal(stored.description, expected);
    assert.equal(stored.name.length, 120);
    assert.doesNotMatch(stored.description + stored.name, /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/);
  });

  test('POST cu text extrem de lung: un comentariu peste 500 de caractere → 400 (comportamentul actual), 500 e acceptat', async () => {
    const before = readDb(server).commentsByDrink;
    const tooLong = await call(server, '/api/drinks/1/comments', { method: 'POST', token: tokenFor(ALICE), body: { content: 'c'.repeat(501) } });
    assert.equal(tooLong.status, 400);
    assert.equal(typeof tooLong.body.error, 'string');
    assert.deepEqual(readDb(server).commentsByDrink, before, 'nothing stored');

    const atLimit = await call(server, '/api/drinks/1/comments', { method: 'POST', token: tokenFor(ALICE), body: { content: `\u202E${'c'.repeat(499)}` } });
    assert.equal(atLimit.status, 201);
    assert.equal(atLimit.body.content, 'c'.repeat(499));
  });

  test('Upload fișier non-imagine (ex: `.pdf` redenumit `.jpg`) → 400 (verificare după semnătura fișierului, nu după extensie/MIME)', async () => {
    const before = readDb(server);
    const pdfBase64 = PDF.toString('base64');
    for (const imageData of [`data:image/jpeg;base64,${pdfBase64}`, `data:image/jpg;base64,${pdfBase64}`, pdfBase64]) {
      const post = await call(server, '/api/drinks', {
        method: 'POST', token: tokenFor(ALICE), body: { name: 'PDF post', description: 'x', rating: 3, isAlcoholic: false, imageData },
      });
      assert.equal(post.status, 400, `post with ${imageData.slice(0, 24)}`);
      const avatar = await call(server, `/api/users/${ALICE}/avatar`, { method: 'POST', token: tokenFor(ALICE), body: { imageData } });
      assert.equal(avatar.status, 400, `JSON avatar with ${imageData.slice(0, 24)}`);
    }
    const multipart = await call(server, `/api/users/${ALICE}/avatar`, {
      method: 'POST', token: tokenFor(ALICE), form: fileForm('avatar', PDF, { type: 'image/jpeg', filename: 'document.jpg' }),
    });
    assert.equal(multipart.status, 400);

    const afterDb = readDb(server);
    assert.equal(afterDb.drinks.length, before.drinks.length, 'no post stored');
    assert.equal(afterDb.nextDrinkId, before.nextDrinkId, 'no id used');
    assert.equal(afterDb.users.find((user) => user.id === ALICE).avatar, null, 'no avatar stored');
  });

  test('`GET /api/users/:altUid/saved-drinks` → 403', async () => {
    const res = await call(server, `/api/users/${BOB}/saved-drinks`, { token: tokenFor(ALICE) });
    assert.equal(res.status, 403);
    assert.ok(!res.text.includes(BOB_POST_NAME));

    const own = await call(server, `/api/users/${BOB}/saved-drinks`, { token: tokenFor(BOB) });
    assert.equal(own.status, 200);
    assert.deepEqual(own.body.items.map((drink) => drink.id), [1]);
  });

  test('Rute AI → 503 `ai_disabled` cât timp `AI_PROVIDER` nu e `local`; vechile rute OpenAI nu mai există', async () => {
    const token = tokenFor(ALICE);
    const recipes = await call(server, '/api/ai/recipes', { method: 'POST', token, body: { mode: 'smart_bar' } });
    const scan = await call(server, '/api/ai/scan', { method: 'POST', token, body: { imageBase64: JPEG.toString('base64') } });
    for (const [label, res] of [['ai/recipes', recipes], ['ai/scan', scan]]) {
      assert.equal(res.status, 503, label);
      assert.equal(res.body.code, 'ai_disabled', label);
    }
    for (const legacy of ['/api/smart-bar/generate-recipes', '/api/generate-recipes', '/api/detect-product']) {
      assert.equal((await call(server, legacy, { method: 'POST', token, body: {} })).status, 404, legacy);
    }
  });

  test('Rută de citire fără token (ex. `GET /api/drinks`) → 401; `/healthz` răspunde fără token', async () => {
    const loggedOut = await call(server, '/api/drinks');
    assert.equal(loggedOut.status, 401);
    assert.ok(!loggedOut.text.includes(BOB_POST_NAME));
    assert.equal(loggedOut.headers.get('cache-control'), 'no-store');

    const health = await call(server, '/healthz');
    assert.equal(health.status, 200);

    // Signed in but not confirmed 18+: refused with its own code, and still no post text.
    const unconfirmed = await call(server, '/api/drinks', { token: tokenFor(MINOR) });
    assert.equal(unconfirmed.status, 403);
    assert.equal(unconfirmed.body.code, 'age_required');
    assert.ok(!unconfirmed.text.includes(BOB_POST_NAME));

    const confirmed = await call(server, '/api/drinks', { token: tokenFor(ALICE) });
    assert.equal(confirmed.status, 200);
    assert.ok(confirmed.body.items.some((drink) => drink.name === BOB_POST_NAME));
  });
});

describe('QA checklist, Securitate (Firebase stub)', () => {
  // Synthetic credentials. The key exists only in memory, for this test run.
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  let server;
  before(async () => {
    server = await startServer({
      ALLOW_INSECURE_DEV_AUTH: undefined,
      FIREBASE_SERVICE_ACCOUNT_KEY: JSON.stringify({
        type: 'service_account',
        project_id: 'drinkme-qa-security-test',
        private_key: privateKey,
        client_email: 'qa-security@drinkme-qa-security-test.example.test',
      }),
      NODE_OPTIONS: `--import=${STUB_PRELOAD}`,
    }, { dbFixture: fixture() });
  });
  after(() => server?.stop());

  test('`POST /api/auth/mobile` cu uid diferit de cel din idToken → 401', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const idToken = `stub:${JSON.stringify({
      uid: 'qa-sec-token-uid', email: 'token@example.test', email_verified: true, iat: nowSeconds, auth_time: nowSeconds,
      firebase: { sign_in_provider: 'password' },
    })}`;
    const before = dbBytes(server);

    for (const uid of ['qa-sec-other-uid', ALICE]) {
      const res = await call(server, '/api/auth/mobile', { method: 'POST', body: { idToken, uid, email: 'token@example.test' } });
      assert.equal(res.status, 401, `body uid ${uid}`);
      assert.equal(res.body.token, undefined, 'no JWT');
    }
    assert.deepEqual(dbBytes(server), before, 'nobody was registered or changed');

    // The matching uid signs in, so the 401 is about the mismatch only.
    const matching = await call(server, '/api/auth/mobile', { method: 'POST', body: { idToken, uid: 'qa-sec-token-uid' } });
    assert.equal(matching.status, 200);
    assert.equal(typeof matching.body.token, 'string');
  });
});
