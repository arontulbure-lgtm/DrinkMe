// Owner decision of 2026-11-12: the official DrinkMe account. OFFICIAL_USER_IDS marks it; every user view
// carries `official`; the brand name is reserved for it in profile names (PUT /api/users/:id and the name
// stored at sign-in); and its content is never auto-hidden by reports, while reports are still queued and
// admins can still remove content, clear the profile and suspend it.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { describe, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { startServer } from './helpers/harness.js';

const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const STUB_PRELOAD = new URL('./helpers/firebase-auth-stub-preload.js', import.meta.url).href;
const CONFIRMED_AT = '2026-01-02T03:04:05.000Z';
const OLD = '2026-01-01T00:00:00.000Z';
const HOUR_MS = 60 * 60 * 1000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const IMAGE = `data:image/png;base64,${PNG.toString('base64')}`;
const OFFICIAL_ENV = { OFFICIAL_USER_IDS: 'official', ADMIN_USER_IDS: 'admin' };

const ago = (hours) => new Date(Date.now() - hours * HOUR_MS).toISOString();
const tokenFor = (uid) => jwt.sign({ uid }, HARNESS_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const readDb = (server) => JSON.parse(fs.readFileSync(server.dbFile, 'utf8'));
const storedUser = (server, id) => readDb(server).users.find((user) => user.id === id);

const person = (id, extra = {}) => ({
  id, email: `${id}@example.test`, firstName: `Name-${id}`, lastName: 'Test', city: 'Cluj', bio: `Bio of ${id}`,
  nameSetByUser: true, avatar: null, ageConfirmedAt: CONFIRMED_AT, privacyNoticeVersion: 2, ...extra,
});
const post = (id, userId, extra = {}) => ({
  id, userId, name: `Post ${id}`, description: 'Plain', rating: 4, location: 'Cluj', isAlcoholic: false,
  createdAt: OLD, cheersCount: 0, tags: [], imageUrl: IMAGE, ...extra,
});
const commentOf = (id, drinkId, userId) => ({ id, drinkId, userId, content: `Comment ${id}`, createdAt: OLD });
const openReport = (id, reporterId, targetType, targetId, extra = {}) => ({
  id, reporterId, targetType, targetId, reason: 'spam', details: null, status: 'open', createdAt: ago(1), ...extra,
});
const reportsBy = (reporters, targetType, targetId, firstId = 1, extra = {}) => reporters.map((reporterId, index) => (
  openReport(firstId + index, reporterId, targetType, targetId, extra)
));

// official wrote post 1 (with comment 10 by official and comment 11 by author), author wrote post 2.
// viewer is the official account's partner; r1 to r3 are reporters old enough to count.
const baseFixture = (reports = [], extra = {}) => ({
  dbSchemaVersion: 2,
  users: [
    person('admin'), person('viewer'), person('author'),
    person('official', { firstName: 'DrinkMe', lastName: 'Official' }),
    person('r1'), person('r2'), person('r3'),
  ],
  drinks: [post(1, 'official'), post(2, 'author')],
  nextDrinkId: 3,
  commentsByDrink: { 1: [commentOf(10, 1, 'official'), commentOf(11, 1, 'author')] },
  nextCommentId: 12,
  partnersByUser: { official: ['viewer'], viewer: ['official'] },
  reports,
  nextReportId: reports.length + 1,
  ...extra,
});

const call = async (server, method, route, uid, body) => {
  const res = await fetch(`${server.baseUrl}${route}`, {
    method,
    headers: {
      ...(uid && { Authorization: `Bearer ${tokenFor(uid)}` }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  return { status: res.status, text, body: parsed };
};

const start = async (t, fixture, env = OFFICIAL_ENV) => {
  const server = await startServer(env, { dbFixture: fixture });
  t.after(() => server.stop());
  return server;
};

const putProfile = (server, uid, body) => call(server, 'PUT', `/api/users/${uid}`, uid, body);
const devSignIn = (server, uid, displayName) => call(server, 'POST', '/api/auth/mobile', undefined, {
  idToken: 'dev-fallback-token', uid, ...(displayName !== undefined && { displayName }),
});

describe('OFFICIAL_USER_IDS', () => {
  test('is parsed like ADMIN_USER_IDS: trimmed, comma-separated, empty entries ignored, unknown ids counted', async (t) => {
    const server = await start(t, baseFixture(), { OFFICIAL_USER_IDS: ' official , ,ghost,' });
    assert.equal((await call(server, 'GET', '/api/users/official', 'viewer')).body.official, true);
    assert.equal((await call(server, 'GET', '/api/users/author', 'viewer')).body.official, false);
    assert.match(server.getOutput(), /OFFICIAL_USER_IDS: 1 of 2 match no known user/);
    assert.ok(!server.getOutput().includes('ghost'), 'ids stay out of the logs');
  });

  test('empty by default: nobody is official', async (t) => {
    const server = await start(t, baseFixture(), {});
    assert.equal((await call(server, 'GET', '/api/users/official', 'viewer')).body.official, false);
    assert.equal((await call(server, 'GET', '/api/users/official', 'official')).body.official, false);
  });

  test('an official user is not an admin', async (t) => {
    const server = await start(t, baseFixture());
    assert.equal((await call(server, 'GET', '/api/admin/reports', 'official')).status, 403);
  });

  test('startup warns (counts only) about an official uid that is also an admin, and about dev sign-in', async (t) => {
    const server = await start(t, baseFixture(), { OFFICIAL_USER_IDS: 'official', ADMIN_USER_IDS: 'admin,official' });
    assert.match(server.getOutput(), /1 OFFICIAL_USER_IDS entr\(y\/ies\) also in ADMIN_USER_IDS/);
    // The harness runs with ALLOW_INSECURE_DEV_AUTH=true.
    assert.match(server.getOutput(), /OFFICIAL_USER_IDS has 1 entr\(y\/ies\) while ALLOW_INSECURE_DEV_AUTH=true/);
    await server.stop();

    const quiet = await start(t, baseFixture(), { OFFICIAL_USER_IDS: 'official', ADMIN_USER_IDS: 'admin', ALLOW_INSECURE_DEV_AUTH: 'false' });
    assert.ok(!quiet.getOutput().includes('also in ADMIN_USER_IDS'));
    assert.ok(!quiet.getOutput().includes('while ALLOW_INSECURE_DEV_AUTH=true'));
  });
});

describe('the official flag in every view', () => {
  test('public and owner profile views', async (t) => {
    const server = await start(t, baseFixture());
    const publicView = await call(server, 'GET', '/api/users/official', 'viewer');
    assert.equal(publicView.body.official, true);
    const ownerView = await call(server, 'GET', '/api/users/official', 'official');
    assert.equal(ownerView.body.official, true);
    assert.equal(ownerView.body.firstName, 'DrinkMe');
    const other = await call(server, 'GET', '/api/users/author', 'viewer');
    assert.equal(other.body.official, false);
    assert.equal((await call(server, 'GET', '/api/users/author', 'author')).body.official, false);
  });

  test('the stripped view of an official uid (notice still pending) is official: false', async (t) => {
    const server = await start(t, baseFixture([], {
      users: [person('viewer'), person('official', { firstName: 'DrinkMe', noticePending: true })],
    }));
    const stripped = await call(server, 'GET', '/api/users/official', 'viewer');
    assert.equal(stripped.status, 200);
    assert.equal(stripped.body.firstName, undefined);
    assert.equal(stripped.body.official, false);
    assert.equal((await call(server, 'GET', '/api/users/official', 'official')).body.official, true);
  });

  test('posts, comments, search, partners, partner requests and blocks', async (t) => {
    const server = await start(t, baseFixture([], {
      partnerRequestsByUser: { author: [{ fromId: 'official', createdAt: ago(1) }] },
      blocksByUser: { r1: ['official'] },
    }));
    const authorOf = (items, id) => items.find((item) => item.id === id)?.user;

    const feed = (await call(server, 'GET', '/api/drinks', 'viewer')).body.items;
    assert.equal(authorOf(feed, 1).official, true);
    assert.equal(authorOf(feed, 2).official, false);
    assert.equal((await call(server, 'GET', '/api/drinks?q=Post', 'viewer')).body.items.find((d) => d.id === 1).user.official, true);
    assert.equal((await call(server, 'GET', '/api/drinks?sort=trending', 'viewer')).body.items.find((d) => d.id === 1).user.official, true);
    assert.equal((await call(server, 'GET', '/api/drinks/partners', 'viewer')).body.items.find((d) => d.id === 1).user.official, true);
    assert.equal((await call(server, 'GET', '/api/drinks/user/official', 'viewer')).body.items[0].user.official, true);
    assert.equal((await call(server, 'GET', '/api/drinks/1', 'viewer')).body.user.official, true);
    assert.equal((await call(server, 'GET', '/api/drinks/2', 'viewer')).body.user.official, false);

    const comments = (await call(server, 'GET', '/api/drinks/1/comments', 'viewer')).body.items;
    assert.equal(authorOf(comments, 10).official, true);
    assert.equal(authorOf(comments, 11).official, false);

    const search = (await call(server, 'GET', '/api/users/search?q=Name', 'viewer')).body;
    assert.ok(search.length > 0);
    assert.ok(search.every((user) => user.official === false));
    const officialSearch = (await call(server, 'GET', '/api/users/search?q=drinkme', 'viewer')).body;
    assert.equal(officialSearch.find((user) => user.id === 'official').official, true);

    assert.equal((await call(server, 'GET', '/api/drink-partners', 'viewer')).body.find((u) => u.id === 'official').official, true);
    assert.equal((await call(server, 'GET', '/api/users/official/partners', 'viewer')).body.find((u) => u.id === 'viewer').official, false);
    const requests = (await call(server, 'GET', '/api/drink-partners/requests', 'author')).body;
    assert.equal(requests.incoming.find((u) => u.id === 'official').official, true);
    assert.equal((await call(server, 'GET', '/api/blocks', 'r1')).body.find((u) => u.id === 'official').official, true);
  });

  test('the admin report target carries it', async (t) => {
    const server = await start(t, baseFixture([openReport(1, 'r1', 'user', 'official'), openReport(2, 'r1', 'drink', 2)]));
    const { items } = (await call(server, 'GET', '/api/admin/reports', 'admin')).body;
    assert.equal(items.find((item) => item.id === 1).target.official, true);
    assert.equal(items.find((item) => item.id === 2).target.user.official, false);
  });
});

describe('reserved display names', () => {
  const REFUSED = [
    { firstName: 'DrinkMe' },
    { firstName: 'drinkme' },
    { firstName: 'DRINKME Official' },
    { firstName: 'Drink Me' },
    { firstName: 'Drink.Me' },
    { firstName: 'drink_me' },
    { firstName: 'drink-me' },
    { firstName: 'D r i n k M e' },
    { firstName: 'Drínk Mé' },
    { firstName: 'Dr1nkMe' },
    { firstName: 'DrinkM3' },
    { firstName: 'DrlnkMe' },
    { firstName: 'Drіnkмe' }, // Cyrillic і and м
    { firstName: 'Drinkmе' }, // Cyrillic е
    { firstName: 'Drιnkme' }, // Greek iota
    { firstName: 'ＤｒｉｎｋＭｅ' }, // full-width, folded by NFKC
    { firstName: 'Drink​Me' }, // zero-width space
    { firstName: 'Drink🍺Me' },
    { firstName: 'Drinkrne' },
    { firstName: 'Drink', lastName: 'Me' },
    { firstName: 'Ana', lastName: 'DrinkMe' },
    { firstName: 'TheDrinkMeTeam' },
    // Lead decision (fix loop 1): the rule stays broad, so a name that merely contains the brand is refused
    // too ("Drink Meister" folds to "drinkmeister").
    { firstName: 'Drink', lastName: 'Meister' },
    { firstName: 'Drink Meister' },
    // Fix loop 1: letters outside the map and other look-alikes.
    { firstName: 'ɗrinkme' }, // d with hook
    { firstName: 'ɖɍɨnƙɱe' }, // d with tail, r with stroke, i with stroke, k with hook, m with hook
    { firstName: 'Dгinkme' }, // Cyrillic г
    { firstName: 'Drinkmɛ' }, // open e
    { firstName: 'Drinkmə' }, // schwa
    { firstName: 'ᎠrinkᎷᎬ' }, // Cherokee
    { firstName: 'Clrinkme' }, // "cl" read as "d"
    { firstName: '🇩🇷🇮🇳🇰🇲🇪' }, // regional-indicator letters
    { firstName: 'ჲrinkme' }, // an unmapped letter becomes a wildcard
    { firstName: 'Dr★nkme' }, // an unmapped symbol becomes a wildcard
    { firstName: 'ჲrinkმe' }, // two wildcards, five real letters
    // Fix loop 1: imitating the Official badge.
    { firstName: 'Ana', lastName: 'Official' },
    { firstName: 'Oficial' },
    { firstName: 'Ana 0ffic1al' },
    { firstName: 'Ana ✓' },
    { firstName: '✔ Ana' },
    { firstName: 'Ana☑' },
    { firstName: 'Ana', lastName: '✅' },
    { firstName: 'Ana 🗸' },
  ];

  test('a non-official user cannot use the brand name or a look-alike (400 name_reserved, nothing saved)', async (t) => {
    const server = await start(t, baseFixture());
    // Spread over several accounts: the mutation limiter allows 30 requests a minute per account.
    const editors = ['author', 'viewer', 'r1', 'r2', 'r3'];
    for (const [index, body] of REFUSED.entries()) {
      const res = await putProfile(server, editors[index % editors.length], body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.code, 'name_reserved', JSON.stringify(body));
    }
    for (const uid of editors) {
      const user = storedUser(server, uid);
      assert.equal(user.firstName, `Name-${uid}`);
      assert.equal(user.lastName, 'Test');
    }
    const view = await call(server, 'GET', '/api/users/author', 'author');
    assert.equal(view.body.firstName, 'Name-author');
  });

  test('ordinary names that only look close are accepted', async (t) => {
    const server = await start(t, baseFixture());
    for (const body of [
      { firstName: 'Drink', lastName: 'Lover' }, { firstName: 'Mehmet' }, { firstName: 'Dorin', lastName: 'Kmetty' },
      { firstName: 'Bernd' }, { firstName: 'Ana', lastName: 'Popescu' }, { firstName: 'Clara' },
      { firstName: 'Ioana', lastName: 'Ștefănescu' }, { firstName: 'Officer' }, { firstName: 'Mihai', lastName: 'Drinkwater' },
      { firstName: '李', lastName: '明' }, { firstName: 'Drinkman' }, { firstName: 'ჲრინკ' },
    ]) {
      const res = await putProfile(server, 'author', body);
      assert.equal(res.status, 200, JSON.stringify(body));
    }
  });

  test('the name prompt (nameChosen) is checked too', async (t) => {
    const server = await start(t, baseFixture([], { users: [person('author', { firstName: '', nameSetByUser: undefined })] }));
    const res = await putProfile(server, 'author', { firstName: 'Drink Me', nameChosen: true });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'name_reserved');
  });

  test('the name prompt cannot publish a masked legacy name that uses the brand', async (t) => {
    // A legacy account whose first name is its email prefix: masked from others until the owner chooses it.
    const legacy = person('masked', { email: 'drinkme@example.test', firstName: 'drinkme', lastName: '', nameSetByUser: undefined });
    const server = await start(t, baseFixture([], { users: [person('viewer'), legacy] }));
    assert.equal((await call(server, 'GET', '/api/users/masked', 'viewer')).body.firstName, undefined);
    const res = await putProfile(server, 'masked', { firstName: 'drinkme', nameChosen: true });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'name_reserved');
    assert.equal(storedUser(server, 'masked').nameSetByUser, undefined);
    assert.equal((await call(server, 'GET', '/api/users/masked', 'viewer')).body.firstName, undefined);
  });

  test('the official user may use the brand name', async (t) => {
    const server = await start(t, baseFixture());
    const res = await putProfile(server, 'official', { firstName: 'DrinkMe', lastName: 'Official Team' });
    assert.equal(res.status, 200);
    assert.equal(res.body.lastName, 'Official Team');
    assert.equal(res.body.official, true);
  });

  test('a name stored before the rule stays, other fields can change, and name edits that keep the brand are refused', async (t) => {
    const server = await start(t, baseFixture([], { users: [person('legacy', { firstName: 'DrinkMe', lastName: 'Fan' })] }));
    assert.match(server.getOutput(), /1 non-official profile name\(s\) use a reserved name/);
    assert.ok(!server.getOutput().includes('legacy'), 'no id in the log');
    // The client resends the stored name on every save.
    const cityEdit = await putProfile(server, 'legacy', { firstName: 'DrinkMe', lastName: 'Fan', city: 'Iasi' });
    assert.equal(cityEdit.status, 200);
    assert.equal(cityEdit.body.city, 'Iasi');
    const keepsBrand = await putProfile(server, 'legacy', { firstName: 'DrinkMe', lastName: 'Club' });
    assert.equal(keepsBrand.status, 400);
    assert.equal(keepsBrand.body.code, 'name_reserved');
    assert.equal(storedUser(server, 'legacy').lastName, 'Fan');
    const rename = await putProfile(server, 'legacy', { firstName: 'Ana', lastName: 'Fan' });
    assert.equal(rename.status, 200);
    assert.equal(rename.body.firstName, 'Ana');
  });

  test('sign-in does not store a reserved displayName for a non-official account (dev mode)', async (t) => {
    const server = await start(t, { dbSchemaVersion: 2, users: [] });
    assert.equal((await devSignIn(server, 'newbie', 'DrinkMe Official')).status, 200);
    const user = storedUser(server, 'newbie');
    assert.equal(user.firstName, '');
    assert.equal(user.lastName, '');
    assert.equal(user.nameSetByUser, undefined);
    const ownerView = await call(server, 'GET', '/api/users/newbie', 'newbie');
    assert.equal(ownerView.body.needsName, true, 'the app asks for a name');
    assert.equal(ownerView.body.official, false);
    assert.equal(ownerView.body.nameReservedAtSignIn, true, 'the name prompt can say why');
    // Gone with the first profile save.
    assert.equal((await putProfile(server, 'newbie', { firstName: 'Ana', nameChosen: true })).status, 200);
    assert.equal(storedUser(server, 'newbie').nameReservedAtSignIn, undefined);
    assert.equal((await call(server, 'GET', '/api/users/newbie', 'newbie')).body.nameReservedAtSignIn, undefined);

    assert.equal((await devSignIn(server, 'official', 'DrinkMe Official')).status, 200);
    assert.equal(storedUser(server, 'official').firstName, 'DrinkMe');
    assert.equal(storedUser(server, 'official').lastName, 'Official');

    assert.equal((await devSignIn(server, 'plain', 'Ana Pop')).status, 200);
    assert.equal(storedUser(server, 'plain').firstName, 'Ana');
    assert.equal(storedUser(server, 'plain').nameReservedAtSignIn, undefined);
    assert.equal((await devSignIn(server, 'nameless')).status, 200);
    assert.equal(storedUser(server, 'nameless').nameReservedAtSignIn, undefined, 'only a dropped name sets it');
  });

  test('sign-in does not store a reserved provider name (Firebase token name)', async (t) => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const firebaseEnv = {
      ...OFFICIAL_ENV,
      ALLOW_INSECURE_DEV_AUTH: undefined,
      FIREBASE_SERVICE_ACCOUNT_KEY: JSON.stringify({
        type: 'service_account', project_id: 'drinkme-official-test', private_key: privateKey,
        client_email: 'official-test@drinkme-official-test.example.test',
      }),
      NODE_OPTIONS: `--import=${STUB_PRELOAD}`,
    };
    const server = await start(t, { dbSchemaVersion: 2, users: [] }, firebaseEnv);
    const now = Math.floor(Date.now() / 1000);
    const signIn = (uid, name) => call(server, 'POST', '/api/auth/mobile', undefined, {
      idToken: `stub:${JSON.stringify({
        uid, email: `${uid}@example.test`, email_verified: true, name, iat: now, auth_time: now,
        firebase: { sign_in_provider: 'google.com' },
      })}`,
      uid,
    });
    assert.equal((await signIn('google-user', 'Drink Mé')).status, 200);
    assert.equal(storedUser(server, 'google-user').firstName, '');
    assert.equal((await signIn('official', 'DrinkMe')).status, 200);
    assert.equal(storedUser(server, 'official').firstName, 'DrinkMe');
  });
});

describe('auto-hide exemption for the official account', () => {
  const threeOn = (targetType, targetId, firstId = 1, extra = {}) => reportsBy(['r1', 'r2', 'r3'], targetType, targetId, firstId, extra);

  test('3 counting reporters do not hide the official post, comment or profile', async (t) => {
    const server = await start(t, baseFixture([
      ...threeOn('drink', 1, 1),
      ...threeOn('comment', 10, 4, { drinkId: 1 }),
      ...threeOn('user', 'official', 7),
    ]));
    assert.equal((await call(server, 'GET', '/api/drinks/1', 'viewer')).status, 200);
    assert.ok((await call(server, 'GET', '/api/drinks', 'viewer')).body.items.some((d) => d.id === 1));
    assert.equal((await call(server, 'GET', '/media/drinks/1', 'viewer')).status, 200);
    const comments = (await call(server, 'GET', '/api/drinks/1/comments', 'viewer')).body.items;
    assert.ok(comments.some((c) => c.id === 10));
    const profile = await call(server, 'GET', '/api/users/official', 'viewer');
    assert.equal(profile.body.firstName, 'DrinkMe');
    assert.ok((await call(server, 'GET', '/api/users/search?q=drinkme', 'viewer')).body.some((u) => u.id === 'official'));
    // The owner gets no hidden notice, and can still edit the post.
    const own = await call(server, 'GET', '/api/users/official', 'official');
    assert.equal(own.body.hiddenPendingReview, undefined);
    assert.equal((await call(server, 'GET', '/api/drinks/1', 'official')).body.hiddenPendingReview, undefined);
    assert.equal((await call(server, 'PUT', '/api/drinks/1', 'official', { name: 'Edited' })).status, 200);
  });

  test("others' content still hides, also under the official post", async (t) => {
    const server = await start(t, baseFixture([
      ...threeOn('drink', 2, 1),
      ...threeOn('comment', 11, 4, { drinkId: 1 }),
      ...threeOn('user', 'author', 7),
    ]));
    assert.equal((await call(server, 'GET', '/api/drinks/2', 'viewer')).status, 404);
    const comments = (await call(server, 'GET', '/api/drinks/1/comments', 'viewer')).body.items;
    assert.ok(!comments.some((c) => c.id === 11));
    assert.equal((await call(server, 'GET', '/api/users/author', 'viewer')).body.firstName, undefined);
  });

  test('reports on official content are accepted through the API and still queued, with targetOfficial', async (t) => {
    const server = await start(t, baseFixture([openReport(1, 'r1', 'drink', 2)], { nextReportId: 2 }));
    for (const uid of ['r1', 'r2', 'r3']) {
      assert.equal((await call(server, 'POST', '/api/reports', uid, { targetType: 'drink', targetId: 1, reason: 'spam' })).status, 201);
    }
    assert.equal((await call(server, 'POST', '/api/reports', 'r1', { targetType: 'comment', targetId: 10, reason: 'spam' })).status, 201);
    assert.equal((await call(server, 'POST', '/api/reports', 'r1', { targetType: 'user', targetId: 'official', reason: 'spam' })).status, 201);
    assert.equal((await call(server, 'GET', '/api/drinks/1', 'viewer')).status, 200);

    const { items, total } = (await call(server, 'GET', '/api/admin/reports', 'admin')).body;
    assert.equal(total, 6);
    const official = items.filter((item) => item.targetType === 'drink' && item.targetId === 1);
    assert.equal(official.length, 3);
    for (const item of official) {
      assert.equal(item.targetOfficial, true);
      assert.equal(item.autoHidden, false);
      assert.equal(item.openReporterCount, 3);
      assert.equal(item.autoHideReporterCount, 3);
    }
    assert.equal(items.find((item) => item.targetType === 'comment').targetOfficial, true);
    assert.equal(items.find((item) => item.targetType === 'user').targetOfficial, true);
    assert.equal(items.find((item) => item.id === 1).targetOfficial, false);
  });

  test('admins can remove official content and clear the profile', async (t) => {
    const server = await start(t, baseFixture([
      ...threeOn('drink', 1, 1),
      ...threeOn('comment', 10, 4, { drinkId: 1 }),
      ...threeOn('user', 'official', 7),
    ]));
    const removeComment = await call(server, 'POST', '/api/admin/reports/4/resolve', 'admin', { action: 'remove_content' });
    assert.equal(removeComment.status, 200);
    assert.ok(!(await call(server, 'GET', '/api/drinks/1/comments', 'viewer')).body.items.some((c) => c.id === 10));

    const clear = await call(server, 'POST', '/api/admin/reports/7/resolve', 'admin', { action: 'clear_profile' });
    assert.equal(clear.status, 200);
    assert.equal(storedUser(server, 'official').firstName, '');

    const removePost = await call(server, 'POST', '/api/admin/reports/1/resolve', 'admin', { action: 'remove_content' });
    assert.equal(removePost.status, 200);
    assert.equal((await call(server, 'GET', '/api/drinks/1', 'viewer')).status, 404);
    assert.equal((await call(server, 'GET', '/api/admin/reports', 'admin')).body.total, 0);
  });

  test('admins can suspend the official account, unless it is also an admin', async (t) => {
    const server = await start(t, baseFixture([...threeOn('drink', 1, 1)]));
    const suspended = await call(server, 'POST', '/api/admin/users/official/suspend', 'admin', {});
    assert.equal(suspended.status, 200);
    assert.equal(suspended.body.suspended, true);
    assert.equal((await call(server, 'POST', '/api/drinks/1/comments', 'official', { content: 'hi' })).status, 403);
    await server.stop();

    const both = await start(t, baseFixture(), { OFFICIAL_USER_IDS: 'official', ADMIN_USER_IDS: 'admin,official' });
    const refused = await call(both, 'POST', '/api/admin/users/official/suspend', 'admin', {});
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'cannot_suspend_admin');
  });
});
