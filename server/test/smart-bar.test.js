import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';

import { REAL_DB_FILE, startServer } from './helpers/harness.js';

const REQUEST_TIMEOUT_MS = 20_000;
const SMART_BAR_PATH = '/api/smart-bar';
const LEGACY_USER_ID = 'legacy-user';
const LEGACY_ITEMS = [
  { id: 1, name: 'Whiskey single malt', quantity: '1', unit: 'bottle' },
  { id: 2, name: 'Sirop de soc artizanal', quantity: '750ml', unit: 'bottle' },
];

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
  return { status: res.status, text, body: text ? JSON.parse(text) : undefined };
};

const signIn = async (baseUrl, uid) => {
  const { status, body } = await request(baseUrl, 'POST', '/api/auth/mobile', undefined, {
    idToken: 'dev-fallback-token',
    uid,
  });
  assert.equal(status, 200);
  return body.token;
};

// Stat only: the real database must never be read.
const statRealDb = () => {
  const stats = fs.statSync(REAL_DB_FILE, { throwIfNoEntry: false });
  return stats ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
};

describe('Smart Bar', () => {
  let realDbBefore;
  let server;

  const addItem = (token, body) => request(server.baseUrl, 'POST', SMART_BAR_PATH, token, body);
  const listItems = (token) => request(server.baseUrl, 'GET', SMART_BAR_PATH, token);
  const deleteItem = (token, id) => request(server.baseUrl, 'DELETE', `${SMART_BAR_PATH}/${id}`, token);
  const storedItems = (userId) => JSON.parse(fs.readFileSync(server.dbFile, 'utf8')).smartBarByUser[userId];

  before(async () => {
    realDbBefore = statRealDb();
    server = await startServer({}, {
      dbFixture: {
        users: [{ id: LEGACY_USER_ID, email: 'legacy@example.test', firstName: 'Legacy', lastName: '', city: '', bio: '', avatar: null }],
        smartBarByUser: { [LEGACY_USER_ID]: LEGACY_ITEMS },
      },
    });
  });

  after(async () => {
    await server?.stop();
    assert.deepEqual(statRealDb(), realDbBefore, 'server/data/db.json must stay untouched');
  });

  test('a new user starts with an empty list, and it stays empty after a restart', async () => {
    const token = await signIn(server.baseUrl, 'new-user');
    const first = await listItems(token);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, []);

    await server.restart();
    assert.deepEqual((await listItems(token)).body, []);
  });

  test('a valid POST returns 201 with the same response shape, and ids start at 1', async () => {
    const token = await signIn(server.baseUrl, 'shape-user');
    const { status, body } = await addItem(token, { name: 'Gin', quantity: '1', unit: 'can' });
    assert.equal(status, 201);
    assert.deepEqual(body, { id: 1, name: 'Gin', quantity: '1', unit: 'can' });
    assert.deepEqual((await listItems(token)).body, [body]);
  });

  test('unit defaults to bottle, a numeric quantity is stored as a string, and ids increase', async () => {
    const token = await signIn(server.baseUrl, 'default-user');
    await addItem(token, { name: 'Rum', quantity: '1' });
    const { status, body } = await addItem(token, { name: 'Tonic', quantity: 2 });
    assert.equal(status, 201);
    assert.deepEqual(body, { id: 2, name: 'Tonic', quantity: '2', unit: 'bottle' });
  });

  test('markup is stored and returned as plain text', async () => {
    const token = await signIn(server.baseUrl, 'markup-user');
    const created = await addItem(token, {
      name: '<script>alert(1)</script>',
      quantity: '<b>1</b>',
      unit: '<i>can</i>',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, '<script>alert(1)</script>');
    assert.ok((await listItems(token)).text.includes('<b>1</b>'));
    assert.equal(storedItems('markup-user')[0].unit, '<i>can</i>');
  });

  test('values are cut to the 120, 60 and 60 limits', async () => {
    const token = await signIn(server.baseUrl, 'limit-user');
    const { status, body } = await addItem(token, {
      name: 'a'.repeat(200),
      quantity: 'b'.repeat(200),
      unit: 'c'.repeat(200),
    });
    assert.equal(status, 201);
    assert.equal(body.name.length, 120);
    assert.equal(body.quantity.length, 60);
    assert.equal(body.unit.length, 60);
  });

  test('invalid types and empty results return 400 and store nothing', async () => {
    const token = await signIn(server.baseUrl, 'invalid-user');
    const invalidBodies = [
      { name: {}, quantity: '1' },
      { name: '   ', quantity: '1' },
      { name: 123, quantity: '1' },
      { quantity: '1' },
      { name: 'Gin' },
      { name: 'Gin', quantity: {} },
      { name: 'Gin', quantity: [] },
      { name: 'Gin', quantity: true },
      { name: 'Gin', quantity: null },
      { name: 'Gin', quantity: '   ' },
      { name: 'Gin', quantity: '1', unit: {} },
      { name: 'Gin', quantity: '1', unit: 5 },
      { name: 'Gin', quantity: '1', unit: null },
      { name: 'Gin', quantity: '1', unit: '   ' },
    ];
    for (const invalidBody of invalidBodies) {
      const { status } = await addItem(token, invalidBody);
      assert.equal(status, 400, JSON.stringify(invalidBody));
    }
    assert.deepEqual((await listItems(token)).body, []);
  });

  test('a saved user keeps the old dummy items, and new ids continue after them', async () => {
    const token = await signIn(server.baseUrl, LEGACY_USER_ID);
    assert.deepEqual((await listItems(token)).body, LEGACY_ITEMS);

    const created = await addItem(token, { name: 'Gin', quantity: '1' });
    assert.equal(created.body.id, 3);
    assert.equal((await deleteItem(token, 3)).status, 204);
    assert.deepEqual(storedItems(LEGACY_USER_ID), LEGACY_ITEMS);
  });

  test('DELETE returns 404 for an unknown id, and ids work again once the list is empty', async () => {
    const token = await signIn(server.baseUrl, 'delete-user');
    const missing = await deleteItem(token, 999);
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: 'Item not found' });

    const { body: item } = await addItem(token, { name: 'Gin', quantity: '1' });
    assert.equal((await deleteItem(token, item.id)).status, 204);
    assert.deepEqual((await listItems(token)).body, []);
    assert.equal((await addItem(token, { name: 'Rum', quantity: '1' })).body.id, 1);
  });

  test('deleting a middle item does not make a later item reuse a live id', async () => {
    const token = await signIn(server.baseUrl, 'middle-user');
    for (const name of ['Gin', 'Rum', 'Tonic']) await addItem(token, { name, quantity: '1' });
    assert.equal((await deleteItem(token, 1)).status, 204);
    assert.equal((await addItem(token, { name: 'Vodka', quantity: '1' })).body.id, 4);
    const ids = (await listItems(token)).body.map((item) => item.id);
    assert.deepEqual(ids, [2, 3, 4]);
  });

  test('every route returns 401 when logged out, and one user cannot touch another user\'s items', async () => {
    const ownerToken = await signIn(server.baseUrl, 'owner-user');
    const otherToken = await signIn(server.baseUrl, 'other-user');
    const { body: item } = await addItem(ownerToken, { name: 'Gin', quantity: '1' });

    assert.equal((await listItems()).status, 401);
    assert.equal((await addItem(undefined, { name: 'Rum', quantity: '1' })).status, 401);
    assert.equal((await deleteItem(undefined, item.id)).status, 401);

    assert.deepEqual((await listItems(otherToken)).body, []);
    assert.equal((await deleteItem(otherToken, item.id)).status, 404);
    assert.deepEqual((await listItems(ownerToken)).body, [item]);
  });

  test('added and deleted items survive a restart', async () => {
    const token = await signIn(server.baseUrl, 'persist-user');
    const { body: removed } = await addItem(token, { name: 'Gin', quantity: '1' });
    const { body: kept } = await addItem(token, { name: 'Rum', quantity: '1' });

    await server.restart();
    assert.deepEqual((await listItems(token)).body, [removed, kept]);

    await deleteItem(token, removed.id);
    await server.restart();
    assert.deepEqual((await listItems(token)).body, [kept]);
  });
});
