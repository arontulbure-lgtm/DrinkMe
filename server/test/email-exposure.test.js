import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';

import { REAL_DB_FILE, startServer } from './helpers/harness.js';

const REQUEST_TIMEOUT_MS = 20_000;
const MARKER = 'leakcheck';
const MARKER_EMAIL = 'leakcheck.marker@example.com';
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

const get = (baseUrl, path, token) => request(baseUrl, 'GET', path, token);
const post = (baseUrl, path, token, body) => request(baseUrl, 'POST', path, token, body);

const signIn = async (baseUrl, uid, fields = {}) => {
  const { status, body } = await post(baseUrl, '/api/auth/mobile', undefined, {
    idToken: 'dev-fallback-token',
    uid,
    ...fields,
  });
  assert.equal(status, 200);
  // Every route but the first-run ones needs the 18+ confirmation.
  assert.equal((await post(baseUrl, `/api/users/${uid}/acknowledgements`, body.token, { type: 'age', confirmed: true })).status, 200);
  return body.token;
};

const assertNoLeak = (label, { status, text }, expectedStatus = 200) => {
  assert.equal(status, expectedStatus, label);
  assert.ok(!text.toLowerCase().includes(MARKER), `${label} contains the email marker`);
  assert.ok(!text.includes('"email"'), `${label} contains an email key`);
  assert.ok(!text.includes('"emailVerified"'), `${label} contains an emailVerified key`);
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

describe('a new user with an email and no displayName', () => {
  let server;
  let tokenA;
  let tokenB;
  let drinkA;
  let drinkB;

  before(async () => {
    server = await startServer();
    const { baseUrl } = server;
    tokenA = await signIn(baseUrl, 'userA', { email: MARKER_EMAIL });
    tokenB = await signIn(baseUrl, 'userB', { email: 'bea@example.test', displayName: 'Bea Viewer' });
    // A new account is hidden until this.
    assert.equal((await post(baseUrl, '/api/users/userA/acknowledgements', tokenA, { type: 'privacy', version: 1 })).status, 200);
    assert.equal((await post(baseUrl, '/api/users/userB/acknowledgements', tokenB, { type: 'privacy', version: 1 })).status, 200);
    // A new user has no city, and search needs a public field to match on.
    assert.equal((await request(baseUrl, 'PUT', '/api/users/userA', tokenA, { city: 'Testville' })).status, 200);

    const drink = { description: 'Synthetic', rating: 4, isAlcoholic: false, imageData: IMAGE };
    drinkA = (await post(baseUrl, '/api/drinks', tokenA, { ...drink, name: 'A drink' })).body.id;
    drinkB = (await post(baseUrl, '/api/drinks', tokenB, { ...drink, name: 'B drink' })).body.id;

    // Everything A does to B creates a notification for B.
    assert.equal((await post(baseUrl, '/api/drink-partners/userB', tokenA)).status, 200);
    assert.equal((await post(baseUrl, '/api/drink-partners/requests/userA/accept', tokenB)).status, 200);
    assert.equal((await post(baseUrl, `/api/drinks/${drinkB}/like`, tokenA)).status, 200);
    assert.equal((await post(baseUrl, `/api/drinks/${drinkB}/comments`, tokenA, { content: 'From A' })).status, 201);
    assert.equal((await post(baseUrl, `/api/drinks/${drinkA}/comments`, tokenA, { content: 'A on A' })).status, 201);
    assert.equal((await post(baseUrl, `/api/drinks/${drinkA}/save`, tokenB)).status, 200);
  });

  after(() => server?.stop());

  test('routes B can reach carry A\'s data, with no email', async () => {
    const { baseUrl } = server;
    const routes = [
      '/api/users/search?q=testville',
      '/api/users/userA',
      '/api/users/userB/partners',
      '/api/drink-partners',
      '/api/drinks',
      '/api/drinks/partners',
      `/api/drinks/${drinkA}`,
      '/api/drinks/user/userA',
      '/api/users/userB/saved-drinks',
      `/api/drinks/${drinkA}/comments`,
      `/api/drinks/${drinkB}/comments`,
    ];
    for (const route of routes) {
      const response = await get(baseUrl, route, tokenB);
      assertNoLeak(`B: ${route}`, response);
      // Guards against a pass on an empty response.
      assert.ok(response.text.includes('"userA"'), `${route} should include user A`);
    }
    assertNoLeak('B: stories', await get(baseUrl, '/api/stories', tokenB));
  });

  test('logged-out reads get 401 and carry nothing of A\'s', async () => {
    const { baseUrl } = server;
    const routes = [
      '/api/users/userA',
      '/api/drinks',
      `/api/drinks/${drinkA}`,
      '/api/drinks/user/userA',
      `/api/drinks/${drinkA}/comments`,
    ];
    assert.equal((await get(baseUrl, '/api/users/userB/partners')).status, 401);
    for (const route of routes) {
      const response = await get(baseUrl, route);
      assertNoLeak(`logged out: ${route}`, response, 401);
      assert.ok(!response.text.includes('"userA"'), `${route} must not include user A`);
    }
    assertNoLeak('logged out: stories', await get(baseUrl, '/api/stories'), 401);
  });

  test('comment POST responses have no email', async () => {
    const { baseUrl } = server;
    assertNoLeak('POST as B', await post(baseUrl, `/api/drinks/${drinkA}/comments`, tokenB, { content: 'From B' }), 201);
    assertNoLeak('POST as A', await post(baseUrl, `/api/drinks/${drinkA}/comments`, tokenA, { content: 'Again' }), 201);
  });

  test('notifications name A as "Someone"', async () => {
    const response = await get(server.baseUrl, '/api/notifications', tokenB);
    assertNoLeak('notifications', response);
    const messages = response.body.notifications.map((n) => n.message).sort();
    assert.deepEqual(messages, [
      'Someone cheered your drink B drink.',
      'Someone commented on B drink.',
      'Someone sent you a drink partner request.',
    ]);
  });

  test('A gets their own email, and an empty name', async () => {
    const { body } = await get(server.baseUrl, '/api/users/userA', tokenA);
    assert.equal(body.email, MARKER_EMAIL);
    assert.equal(body.firstName, '');
  });

  test('profile updates stay full, for the owner', async () => {
    const res = await request(server.baseUrl, 'PUT', '/api/users/userB', tokenB, { bio: 'Updated' });
    assert.equal(res.status, 200);
    assert.equal(res.body.email, 'bea@example.test');
  });

  test('the response to creating a drink has no email', async () => {
    const drink = { description: 'Synthetic', rating: 4, isAlcoholic: false, imageData: IMAGE };
    const response = await post(server.baseUrl, '/api/drinks', tokenA, { ...drink, name: 'Another A drink' });
    assertNoLeak('POST /api/drinks as A', response, 201);
    assert.equal(response.body.user.id, 'userA');
  });

  test('the owner-only routes that return the full user refuse B', async () => {
    const { baseUrl } = server;
    assertNoLeak('PUT as B', await request(baseUrl, 'PUT', '/api/users/userA', tokenB, { bio: 'Hijacked' }), 403);
    assertNoLeak('avatar as B', await post(baseUrl, '/api/users/userA/avatar', tokenB, { imageData: IMAGE }), 403);
    const { body } = await get(baseUrl, '/api/users/userA', tokenA);
    assert.notEqual(body.bio, 'Hijacked');
    assert.notEqual(body.avatar, IMAGE);
  });

  test('search never matches on email', async () => {
    const { baseUrl } = server;
    for (const q of [MARKER, 'marker', 'example.com', MARKER_EMAIL]) {
      for (const token of [tokenB, tokenA]) {
        const { status, body } = await get(baseUrl, `/api/users/search?q=${encodeURIComponent(q)}`, token);
        assert.equal(status, 200, q);
        assert.deepEqual(body, [], q);
      }
    }
  });
});

describe('legacy accounts whose firstName came from the email', () => {
  const legacyUser = (id, email, firstName, lastName = '') => ({
    id, email, firstName, lastName, city: 'Cluj', bio: '', avatar: null,
  });
  const fixture = () => ({
    users: [
      { ...legacyUser('legacy', `${MARKER}.old@example.com`, `${MARKER}.old`), emailVerified: true },
      legacyUser('mixedCase', 'mixed.case@example.com', 'Mixed.Case'),
      legacyUser('escaped', "o'brien@example.com", 'o&#x27;brien'),
      legacyUser('cut', `a${"'".repeat(25)}@example.com`, `a${'&#x27;'.repeat(19)}&#x27`),
      legacyUser('realName', 'ana.pop@example.com', 'Ana', 'Pop'),
      legacyUser('legacyLast', `${MARKER}.last@example.com`, `${MARKER}.last`, 'Pop'),
      legacyUser('viewer', 'viewer@example.test', 'Vera', 'Fixture'),
    ],
    drinks: [{ id: 1, userId: 'viewer', name: 'Viewer drink', location: 'Cluj', isAlcoholic: false, cheersCount: 0 }],
    commentsByDrink: {
      1: [{ id: 1, drinkId: 1, userId: 'gone', content: 'Author deleted', createdAt: '2026-01-01T00:00:00.000Z' }],
    },
  });

  test('the name is hidden from others and kept for the owner, and the file is not rewritten', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());
    const { baseUrl, dbFile } = server;
    const viewer = await signIn(baseUrl, 'viewer');

    for (const id of ['legacy', 'legacyLast', 'mixedCase', 'escaped']) {
      const asViewer = await get(baseUrl, `/api/users/${id}`, viewer);
      assertNoLeak(`viewer: ${id}`, asViewer);
      assert.equal('firstName' in asViewer.body, false, id);
    }
    assert.deepEqual((await get(baseUrl, `/api/users/search?q=${MARKER}`, viewer)).body, []);
    assert.deepEqual((await get(baseUrl, '/api/users/search?q=brien', viewer)).body, []);

    const owner = await signIn(baseUrl, 'legacy');
    const asOwner = await get(baseUrl, '/api/users/legacy', owner);
    assert.equal(asOwner.body.firstName, `${MARKER}.old`);
    assert.equal(asOwner.body.email, `${MARKER}.old@example.com`);
    assert.equal(asOwner.body.emailVerified, true);

    // The sign-in above saved the file: the stored name must survive it.
    const stored = JSON.parse(fs.readFileSync(dbFile, 'utf8')).users.find((user) => user.id === 'legacy');
    assert.equal(stored.firstName, `${MARKER}.old`);

    await post(baseUrl, '/api/drinks/1/like', owner);
    const { body, text } = await get(baseUrl, '/api/notifications', viewer);
    assert.ok(!text.includes(MARKER));
    assert.deepEqual(body.notifications.map((n) => n.message), ['Someone cheered your drink Viewer drink.']);
  });

  test('a name that only looks similar stays public', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());
    const viewer = await signIn(server.baseUrl, 'viewer');
    const { body } = await get(server.baseUrl, '/api/users/realName', viewer);
    assert.equal(body.firstName, 'Ana');
    assert.equal(body.lastName, 'Pop');
    assert.deepEqual((await get(server.baseUrl, '/api/users/search?q=ana', viewer)).body.map((u) => u.id), ['realName']);
  });

  describe('saving a profile', () => {
    const put = (server, id, token, body) => request(server.baseUrl, 'PUT', `/api/users/${id}`, token, body);
    const readStored = (server, id) =>
      JSON.parse(fs.readFileSync(server.dbFile, 'utf8')).users.find((user) => user.id === id);

    test('a legacy user adding a last name stays masked', async (t) => {
      const server = await startServer({}, { dbFixture: fixture() });
      t.after(() => server.stop());
      const owner = await signIn(server.baseUrl, 'legacy');
      const viewer = await signIn(server.baseUrl, 'viewer');

      // The form resends every field.
      const saved = await put(server, 'legacy', owner, { firstName: `${MARKER}.old`, lastName: 'Pop', city: '', bio: '' });
      assert.equal(saved.status, 200);

      const asViewer = await get(server.baseUrl, '/api/users/legacy', viewer);
      assertNoLeak('viewer', asViewer);
      assert.equal('firstName' in asViewer.body, false);
      assert.equal(asViewer.body.lastName, 'Pop');
      assert.equal(readStored(server, 'legacy').nameSetByUser, undefined);
    });

    test('a bio-only save does not unmask', async (t) => {
      const server = await startServer({}, { dbFixture: fixture() });
      t.after(() => server.stop());
      const owner = await signIn(server.baseUrl, 'legacy');
      assert.equal((await put(server, 'legacy', owner, { bio: 'Only the bio' })).status, 200);

      const viewer = await signIn(server.baseUrl, 'viewer');
      assertNoLeak('another user', await get(server.baseUrl, '/api/users/legacy', viewer));
      assert.equal(readStored(server, 'legacy').nameSetByUser, undefined);
    });

    for (const [label, id, firstName, storedName] of [
      ['from a form opened before the migration', 'escaped', 'o&#x27;brien', "o'brien"],
      ['exactly as stored', 'escaped', "o'brien", "o'brien"],
      ['with surrounding spaces', 'escaped', " o'brien ", "o'brien"],
      ['from a form holding the old 120-character cut', 'cut', `a${'&#x27;'.repeat(19)}&#x27`, `a${"'".repeat(25)}`],
    ]) {
      test(`resending a migrated name ${label} changes nothing`, async (t) => {
        const server = await startServer({}, { dbFixture: fixture() });
        t.after(() => server.stop());
        const owner = await signIn(server.baseUrl, id);
        assert.equal((await put(server, id, owner, { firstName })).status, 200);

        const stored = readStored(server, id);
        assert.equal(stored.firstName, storedName);
        assert.equal(stored.nameSetByUser, undefined);
        const { body } = await get(server.baseUrl, `/api/users/${id}`, await signIn(server.baseUrl, 'viewer'));
        assert.equal('firstName' in body, false);
      });
    }

    test('a new user who sets a first name equal to the email prefix is public, also after a restart', async (t) => {
      const server = await startServer();
      t.after(() => server.stop());
      const { baseUrl } = server;
      const owner = await signIn(baseUrl, 'aron', { email: 'aron@example.com' });
      const viewer = await signIn(baseUrl, 'viewer');

      assert.equal((await put(server, 'aron', owner, { firstName: 'Aron', nameChosen: true })).status, 200);
      assert.equal(readStored(server, 'aron').nameSetByUser, true);
      assert.equal((await post(baseUrl, '/api/users/aron/acknowledgements', owner, { type: 'privacy', version: 1 })).status, 200);

      await server.restart();
      const { body, text } = await get(baseUrl, '/api/users/aron', viewer);
      assert.equal(body.firstName, 'Aron');
      assert.ok(!text.includes('nameSetByUser'));
      assert.deepEqual((await get(baseUrl, '/api/users/search?q=aron', viewer)).body.map((u) => u.id), ['aron']);
    });

    test('a legacy user who replaces the name is public', async (t) => {
      const server = await startServer({}, { dbFixture: fixture() });
      t.after(() => server.stop());
      const owner = await signIn(server.baseUrl, 'legacy');
      assert.equal((await put(server, 'legacy', owner, { firstName: 'Lena' })).status, 200);
      const viewer = await signIn(server.baseUrl, 'viewer');
      assert.equal((await get(server.baseUrl, '/api/users/legacy', viewer)).body.firstName, 'Lena');
      assert.equal(readStored(server, 'legacy').nameSetByUser, true);
    });
  });

  test('a new user has an empty city and bio, and an existing record keeps its own', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());
    const { baseUrl } = server;
    await signIn(baseUrl, 'brandNew', { email: 'brand.new@example.test' });
    const viewer = await signIn(baseUrl, 'viewer');

    const { body } = await get(baseUrl, '/api/users/brandNew', viewer);
    assert.equal(body.city, '');
    assert.equal(body.bio, '');
    assert.equal((await get(baseUrl, '/api/users/viewer', viewer)).body.city, 'Cluj');
  });

  test('a comment by a missing user still loads, with no user', async (t) => {
    const server = await startServer({}, { dbFixture: fixture() });
    t.after(() => server.stop());
    const { status, body } = await get(server.baseUrl, '/api/drinks/1/comments', await signIn(server.baseUrl, 'viewer'));
    assert.equal(status, 200);
    assert.equal(body.items[0].user, undefined);
  });
});

describe('request logs', () => {
  const LOG_TIMEOUT_MS = 5_000;
  const CANARY = 'logcanaryterm';

  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // morgan writes after the response, so the line can arrive shortly after the client has it.
  const waitForLogLine = async (server, pattern) => {
    const deadline = Date.now() + LOG_TIMEOUT_MS;
    while (!pattern.test(server.getOutput())) {
      assert.ok(Date.now() < deadline, `no log line matching ${pattern}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  for (const [label, env, pattern] of [
    ['the dev format', {}, /GET \/api\/drinks\b/],
    [
      'the production format (no IP, user agent or referrer)',
      {
        NODE_ENV: 'production',
        ALLOW_INSECURE_DEV_AUTH: undefined,
        JWT_SECRET: 'abcdefghijklmnopqrstuvwxyz012345',
        ALLOW_EMPTY_DB: 'true',
        FIREBASE_SERVICE_ACCOUNT_KEY: JSON.stringify({
          type: 'service_account',
          project_id: 'drinkme-log-test',
          private_key: privateKey,
          client_email: 'log-test@drinkme-log-test.example.test',
        }),
      },
      /\d{4}-\d\d-\d\dT[\d:.]+Z GET \/api\/drinks 401 /,
    ],
  ]) {
    // Logged out, so the answer is 401: the request is still logged.
    test(`${label} logs the path and not the query string`, async (t) => {
      const server = await startServer(env);
      t.after(() => server.stop());
      assert.equal((await get(server.baseUrl, `/api/drinks?city=${CANARY}`)).status, 401);
      await waitForLogLine(server, pattern);
      assert.ok(!server.getOutput().includes(CANARY));
      // Legal T-05: in production neither the client address nor its user agent is logged.
      if (env.NODE_ENV === 'production') {
        const requestLines = server.getOutput().split('\n').filter((line) => / GET \/api\/drinks /.test(line));
        assert.ok(requestLines.length > 0);
        for (const line of requestLines) assert.doesNotMatch(line, /127\.0\.0\.1|::ffff:|::1|undici|node|Mozilla/i);
      }
    });
  }
});

describe('client source', () => {
  const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

  test('no screen falls back to another user\'s email', () => {
    for (const file of [
      'src/screens/ExploreScreen.tsx',
      'src/screens/PartnersListScreen.tsx',
      'src/screens/DrinkDetailScreen.tsx',
      'src/components/DrinkPostCard.tsx',
      'src/components/StoriesSection.tsx',
    ]) {
      assert.ok(!/\.email/.test(read(file)), file);
    }
    const drawerMatches = read('src/components/CommentDrawer.tsx').split(/\r?\n/).filter((line) => /\.email/.test(line));
    assert.deepEqual(drawerMatches.map((line) => line.trim()), [
      "{(profile?.firstName ?? profile?.email ?? 'U')[0]?.toUpperCase() ?? 'U'}",
    ]);
  });

  test('ProfileScreen shows an email only on the owner\'s own profile', () => {
    const source = read('src/screens/ProfileScreen.tsx');
    const lines = source.split(/\r?\n/).filter((line) => /\.email/.test(line)).map((line) => line.trim());
    assert.deepEqual(lines, [
      'profileData.email ?? firebaseUser?.email ?? `user+${viewedUserId}@drinkme.app`',
      '}, [firebaseUser?.email, isSelf, profileData, setProfile, viewedUserId]);',
      "return source?.email || firebaseUser?.email || t('common.unknownUser');",
      '}, [firebaseUser?.email, isSelf, profileData, shownUser, t]);',
      '<Text style={styles.email}>{profileData?.email || profile?.email || firebaseUser?.email}</Text>',
    ]);

    // The render sits in the isSelf branch, and is that branch's only content.
    assert.match(source, /\{isSelf \? \(\s*<Text style=\{styles\.email\}>[^\n]*<\/Text>\s*\) : null\}/);
    // The stored profile is only written for the owner.
    assert.match(source, /if \(profileData && isSelf && viewedUserId\) \{\s*const normalizedEmail/);
    // The display name returns for other users before it reaches the email fallback.
    const otherUserReturn = source.indexOf('if (!isSelf) {', source.indexOf('const displayName = useMemo'));
    assert.ok(otherUserReturn > 0);
    assert.ok(otherUserReturn < source.indexOf('return source?.email'));
  });

  test('the new keys sit in the sections the client asks for', () => {
    const source = read('src/context/LocalizationContext.tsx');
    const section = (language, name) => {
      const languageStart = source.indexOf(`\n  ${language}: {`);
      assert.ok(languageStart >= 0, language);
      const start = source.indexOf(`\n    ${name}: {`, languageStart);
      assert.ok(start >= 0, `${language}.${name}`);
      return source.slice(start, source.indexOf('\n    },', start));
    };
    for (const language of ['en', 'ro']) {
      assert.match(section(language, 'common'), /\n\s+unknownUser: '/, language);
      assert.match(section(language, 'explore'), /\n\s+searchMinChars: '/, language);
      assert.match(section(language, 'profile'), /\n\s+loadError: '/, language);
      assert.match(section(language, 'profile'), /\n\s+retry: '/, language);
    }
  });

  test('ro and en both have the new keys', () => {
    const source = read('src/context/LocalizationContext.tsx');
    const roStart = source.indexOf('\n  ro: {');
    assert.ok(roStart > 0);
    const en = source.slice(0, roStart);
    const ro = source.slice(roStart);
    assert.match(en, /unknownUser: 'DrinkMe user'/);
    assert.match(ro, /unknownUser: 'Utilizator DrinkMe'/);
    assert.match(en, /searchMinChars: '/);
    assert.match(ro, /searchMinChars: '/);
  });
});
