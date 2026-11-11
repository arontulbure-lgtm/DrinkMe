import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';

import { REAL_DB_FILE, startServer } from './helpers/harness.js';

const REQUEST_TIMEOUT_MS = 20_000;
const DRINK_NAME = 'SavedDrinkMarker';
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const request = async (baseUrl, method, path, token, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    ...(body && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
};

const signIn = async (baseUrl, uid) => {
  const { status, body } = await request(baseUrl, 'POST', '/api/auth/mobile', undefined, {
    idToken: 'dev-fallback-token',
    uid,
  });
  assert.equal(status, 200);
  // Every route but the first-run ones needs the 18+ confirmation.
  const age = await request(baseUrl, 'POST', `/api/users/${uid}/acknowledgements`, body.token, { type: 'age', confirmed: true });
  assert.equal(age.status, 200);
  return body.token;
};

// Stat only: the real database must never be read.
const statRealDb = () => {
  const stats = fs.statSync(REAL_DB_FILE, { throwIfNoEntry: false });
  return stats ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
};

describe('GET /api/users/:userId/saved-drinks', () => {
  let realDbBefore;
  let server;
  let tokenA;
  let tokenB;
  let drinkId;

  const savedList = (userId, token) => request(server.baseUrl, 'GET', `/api/users/${userId}/saved-drinks`, token);

  before(async () => {
    realDbBefore = statRealDb();
    server = await startServer();
    tokenA = await signIn(server.baseUrl, 'userA');
    tokenB = await signIn(server.baseUrl, 'userB');
    const created = await request(server.baseUrl, 'POST', '/api/drinks', tokenB, {
      name: DRINK_NAME,
      description: 'Synthetic',
      rating: 4,
      isAlcoholic: false,
      imageData: IMAGE,
    });
    assert.equal(created.status, 201);
    drinkId = created.body.id;
    assert.equal((await request(server.baseUrl, 'POST', `/api/drinks/${drinkId}/save`, tokenA)).status, 200);
  });

  after(async () => {
    await server?.stop();
    assert.deepEqual(statRealDb(), realDbBefore, 'server/data/db.json must stay untouched');
  });

  test('another user gets 403 and no drink data, even for a drink they posted', async () => {
    const { status, body, text } = await savedList('userA', tokenB);
    assert.equal(status, 403);
    assert.deepEqual(body, { error: 'Forbidden' });
    assert.ok(!text.includes(DRINK_NAME));
  });

  test('an unknown user id gets the same 403, so ids cannot be probed', async () => {
    const { status, body } = await savedList('nobody', tokenB);
    assert.equal(status, 403);
    assert.deepEqual(body, { error: 'Forbidden' });
  });

  test('the owner gets 200 with the saved drink, marked isSaved', async () => {
    const { status, body } = await savedList('userA', tokenA);
    assert.equal(status, 200);
    assert.deepEqual(body.items.map((drink) => drink.id), [drinkId]);
    assert.equal(body.items[0].name, DRINK_NAME);
    assert.equal(body.items[0].isSaved, true);
  });

  test('the owner with nothing saved gets an empty list', async () => {
    const { status, body } = await savedList('userB', tokenB);
    assert.equal(status, 200);
    assert.deepEqual(body, { items: [], nextCursor: null });
  });

  test('no token or an invalid token gets 401', async () => {
    assert.equal((await savedList('userA')).status, 401);
    assert.equal((await savedList('userA', 'not-a-real-token')).status, 401);
  });

  test('unsaving removes the drink from the owner\'s list', async (t) => {
    const save = () => request(server.baseUrl, 'POST', `/api/drinks/${drinkId}/save`, tokenA);
    assert.equal((await save()).body.saved, false);
    t.after(save); // restores the state for any later test
    assert.deepEqual((await savedList('userA', tokenA)).body.items, []);
  });
});
