import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { REAL_DATA_DIR, REAL_DB_FILE, startServer } from './helpers/harness.js';

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Synthetic data in the format written by saveDb() in server.js.
const FIXTURE_USER = {
  id: 'fixture-user-1',
  email: 'fixture.one@example.test',
  firstName: 'Fixture',
  lastName: 'One',
  city: 'Testville',
  bio: 'Synthetic user',
  avatar: null,
};
const FIXTURE_PARTNER = {
  id: 'fixture-user-2',
  email: 'fixture.two@example.test',
  firstName: 'Fixture',
  lastName: 'Two',
  city: 'Testville',
  bio: 'Synthetic partner',
  avatar: null,
};
const FIXTURE_DRINK = {
  id: 7,
  userId: FIXTURE_USER.id,
  name: 'Fixture Lemonade',
  description: 'Synthetic drink',
  rating: 4,
  location: 'Testville',
  isAlcoholic: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  cheersCount: 1,
  tags: [],
  imageUrl: 'data:image/png;base64,AAAA',
  isPartner: true,
};
const DB_FIXTURE = {
  drinks: [FIXTURE_DRINK],
  nextDrinkId: 8,
  nextNotificationId: 1,
  nextCommentId: 2,
  users: [FIXTURE_USER, FIXTURE_PARTNER],
  cheersByUser: { [FIXTURE_USER.id]: [FIXTURE_DRINK.id] },
  savedByUser: { [FIXTURE_USER.id]: [] },
  smartBarByUser: { [FIXTURE_USER.id]: [] },
  partnersByUser: { [FIXTURE_USER.id]: [FIXTURE_PARTNER.id], [FIXTURE_PARTNER.id]: [FIXTURE_USER.id] },
  notificationsByUser: {},
  commentsByDrink: {
    [FIXTURE_DRINK.id]: [{
      id: 1,
      drinkId: FIXTURE_DRINK.id,
      userId: FIXTURE_PARTNER.id,
      content: 'Synthetic comment',
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
  },
};

// Stat only: the real database must never be read.
// The dev backend must be idle during tests, or its own writes will fail this check.
const statRealDb = () => {
  const stats = fs.statSync(REAL_DB_FILE, { throwIfNoEntry: false });
  return stats ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
};

const getJson = async (url, token) => {
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  assert.equal(res.status, 200);
  return res.json();
};

const postJson = async (url, body, token) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const signIn = async (baseUrl, uid) => {
  const { status, body } = await postJson(`${baseUrl}/api/auth/mobile`, {
    idToken: 'dev-fallback-token',
    uid,
    email: `${uid}@example.test`,
    displayName: 'Harness Tester',
  });
  assert.equal(status, 200);
  // Every route but the first-run ones needs the 18+ confirmation.
  const age = await postJson(`${baseUrl}/api/users/${uid}/acknowledgements`, { type: 'age', confirmed: true }, body.token);
  assert.equal(age.status, 200);
  return body.token;
};

let realDbBefore;
let server;

before(async () => {
  realDbBefore = statRealDb();
  server = await startServer({}, { dbFixture: DB_FIXTURE });
});

after(async () => {
  await server?.stop();
  assert.deepEqual(statRealDb(), realDbBefore, 'server/data/db.json must stay untouched');
  if (server) {
    assert.equal(fs.existsSync(path.dirname(server.dbFile)), false, 'temp dir must be removed');
  }
});

test('a fixture in the saveDb format loads with its users and drinks', async () => {
  const { baseUrl } = server;
  const token = await signIn(baseUrl, FIXTURE_USER.id);
  const user = await getJson(`${baseUrl}/api/users/${FIXTURE_USER.id}`, token);
  assert.deepEqual(user, { ...FIXTURE_USER, ageConfirmed: true, needsName: false, official: false, privacyNoticeVersion: null, partnerCount: 1 });
  const partner = await getJson(`${baseUrl}/api/users/${FIXTURE_PARTNER.id}`, token);
  const { email: _partnerEmail, ...publicPartner } = FIXTURE_PARTNER;
  assert.deepEqual(partner, { ...publicPartner, official: false, partnerStatus: 'partner', partnerCount: 1 });

  const { items: drinks } = await getJson(`${baseUrl}/api/drinks`, token);
  assert.equal(drinks.length, 1);
  assert.equal(drinks[0].id, FIXTURE_DRINK.id);
  assert.equal(drinks[0].name, FIXTURE_DRINK.name);
  assert.equal(drinks[0].isLiked, true);

  const { items: comments } = await getJson(`${baseUrl}/api/drinks/${FIXTURE_DRINK.id}/comments`, token);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].content, 'Synthetic comment');

  const created = await postJson(
    `${baseUrl}/api/drinks`,
    { name: 'Counter check', description: 'Uses nextDrinkId', rating: 3, isAlcoholic: false, imageData: TINY_PNG },
    token
  );
  assert.equal(created.status, 201);
  assert.equal(created.body.id, DB_FIXTURE.nextDrinkId);
});

test('the server creates DB_FILE and a mutation persists across a restart', async () => {
  await server.restart({ dbFixture: null }); // no file: the server must create it
  const { baseUrl, dbFile } = server;
  assert.equal(fs.existsSync(dbFile), true);

  const uid = 'persistence-user';
  const token = await signIn(baseUrl, uid);
  assert.deepEqual(await getJson(`${baseUrl}/api/drinks`, token), { items: [], nextCursor: null });
  const created = await postJson(
    `${baseUrl}/api/drinks`,
    { name: 'Persisted Tea', description: 'Survives a restart', rating: 5, isAlcoholic: false, imageData: TINY_PNG },
    token
  );
  assert.equal(created.status, 201);

  await server.restart();

  const { items: drinks } = await getJson(`${baseUrl}/api/drinks`, token);
  assert.equal(drinks.length, 1);
  assert.equal(drinks[0].id, created.body.id);
  assert.equal(drinks[0].name, 'Persisted Tea');
  assert.equal(drinks[0].userId, uid);
  assert.equal((await getJson(`${baseUrl}/api/users/${uid}`, token)).id, uid);
});

test('the harness refuses unsafe DB_FILE values before spawning', async () => {
  await assert.rejects(startServer({ DB_FILE: REAL_DB_FILE }), /inside server\/data/);
  await assert.rejects(startServer({ DB_FILE: path.join(REAL_DATA_DIR, 'other.json') }), /inside server\/data/);
  await assert.rejects(startServer({ DB_FILE: '' }), /non-empty DB_FILE/);
  await assert.rejects(startServer({ DB_FILE: '   ' }), /non-empty DB_FILE/);
  await assert.rejects(
    startServer({ DB_FILE: path.resolve(REAL_DATA_DIR, '..', 'not-temp.json') }),
    /outside the temp directory/
  );
});

test(
  'the harness refuses a DB_FILE that reaches server/data through a junction',
  { skip: !fs.existsSync(REAL_DATA_DIR) },
  async () => {
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'drinkme-link-'));
    const link = path.join(linkParent, 'data-link');
    fs.symlinkSync(REAL_DATA_DIR, link, 'junction');
    try {
      await assert.rejects(startServer({ DB_FILE: path.join(link, 'x.json') }), /inside server\/data/);
    } finally {
      // Never recursive: unlink removes only the junction, and rmdir fails if anything is left.
      fs.unlinkSync(link);
      fs.rmdirSync(linkParent);
    }
  }
);

test('the harness refuses to start when /healthz already answers', async () => {
  const health = await fetch(`${server.baseUrl}/healthz`);
  assert.equal(health.status, 200);

  let wronglyStarted = null;
  try {
    wronglyStarted = await startServer();
  } catch (err) {
    assert.match(err.message, /already answers \/healthz/);
  }
  if (wronglyStarted) {
    await wronglyStarted.stop();
    assert.fail('startServer must refuse when /healthz already answers');
  }
});
