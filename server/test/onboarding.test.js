import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { startServer } from './helpers/harness.js';

const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const FAULT_PRELOAD = new URL('./helpers/db-fault-preload.js', import.meta.url).href;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;
const CONFIRMED_AT = '2026-01-02T03:04:05.000Z';
const NOTICE_BODY = { type: 'privacy', version: 1 };

const tokenFor = (uid) => jwt.sign({ uid }, HARNESS_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

const person = (id, extra = {}) => ({
  id, email: `${id}@example.test`, firstName: 'Named', lastName: 'Test', city: 'Cluj', bio: 'Hello', nameSetByUser: true, avatar: null, ...extra,
});
const unnamed = (id, extra = {}) => person(id, { firstName: '', lastName: '', nameSetByUser: undefined, ...extra });
// A legacy account whose firstName was built from the email prefix.
const masked = (id, extra = {}) => person(id, { firstName: id, lastName: '', nameSetByUser: undefined, ...extra });

const post = (id, userId, extra = {}) => ({
  id, userId, name: `Post ${id}`, description: 'Plain', rating: 4, location: 'Cluj',
  createdAt: '2026-01-01T00:00:00.000Z', cheersCount: 0, tags: [], imageUrl: PNG_DATA_URL, isAlcoholic: false, ...extra,
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
  return { status: res.status, text, body: parsed };
};

const readDb = (server) => JSON.parse(fs.readFileSync(server.dbFile, 'utf8'));
const storedUser = (server, id) => readDb(server).users.find((u) => u.id === id);
const owner = (server, id) => call(server, `/api/users/${id}`, { token: tokenFor(id) });
const putName = (server, id, body) => call(server, `/api/users/${id}`, { token: tokenFor(id), method: 'PUT', body });
const acknowledge = (server, id, body = NOTICE_BODY, token = tokenFor(id)) => (
  call(server, `/api/users/${id}/acknowledgements`, { token, method: 'POST', body })
);

describe('needsName', () => {
  let server;

  before(async () => {
    server = await startServer({}, {
      dbFixture: {
        users: [
          unnamed('empty'),
          person('missing', { firstName: undefined, nameSetByUser: undefined }),
          masked('legacy'),
          masked('chosen', { nameSetByUser: true }),
          person('set'),
        ],
      },
    });
  });
  after(() => server?.stop());

  test('true with no name, or with a masked one that the owner still gets back', async () => {
    assert.equal((await owner(server, 'empty')).body.needsName, true);
    assert.equal((await owner(server, 'missing')).body.needsName, true);
    const legacy = (await owner(server, 'legacy')).body;
    assert.equal(legacy.needsName, true);
    assert.equal(legacy.firstName, 'legacy');
  });

  test('false for a name that is public, even one equal to the email prefix', async () => {
    assert.equal((await owner(server, 'set')).body.needsName, false);
    assert.equal((await owner(server, 'chosen')).body.needsName, false);
  });

  test('neither field reaches anyone but the owner', async () => {
    const tokens = [undefined, tokenFor('set')];
    for (const id of ['empty', 'legacy']) {
      for (const token of tokens) {
        const { text } = await call(server, `/api/users/${id}`, { token });
        assert.ok(!text.includes('needsName'), text);
        assert.ok(!text.includes('privacyNotice'), text);
      }
    }
    const search = await call(server, '/api/users/search?q=named', { token: tokenFor('empty') });
    assert.equal(search.status, 200);
    assert.ok(search.body.length > 0);
    assert.ok(!search.text.includes('needsName'));
    assert.ok(!search.text.includes('privacyNotice'));
  });
});

describe('saving the name', () => {
  let server;

  before(async () => {
    server = await startServer({}, {
      dbFixture: {
        users: [
          unnamed('fresh'), unnamed('blank'), unnamed('control'), masked('legacy'), masked('resend'), masked('same'), masked('flagtext'), person('clearing'),
        ],
        drinks: [post(1, 'legacy'), post(2, 'fresh')],
        nextDrinkId: 3,
      },
    });
  });
  after(() => server?.stop());

  test('a new user\'s name is public at once, on the profile and on their posts', async () => {
    const res = await putName(server, 'fresh', { firstName: '  Ana Pop  ', nameChosen: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.needsName, false);
    assert.equal(res.body.firstName, 'Ana Pop');
    assert.equal((await call(server, '/api/users/fresh')).body.firstName, 'Ana Pop');
    assert.equal((await call(server, '/api/drinks/2')).body.user.firstName, 'Ana Pop');
  });

  test('a masked user who enters a real name becomes public under it', async () => {
    assert.equal((await call(server, '/api/users/legacy')).body.firstName, undefined);
    const res = await putName(server, 'legacy', { firstName: 'Ion', nameChosen: true });
    assert.equal(res.body.needsName, false);
    assert.equal((await call(server, '/api/users/legacy')).body.firstName, 'Ion');
    assert.equal((await call(server, '/api/drinks/1')).body.user.firstName, 'Ion');
    assert.equal(storedUser(server, 'legacy').nameSetByUser, true);
  });

  test('a form that resends the masked name does not unmask it', async () => {
    for (const body of [{ firstName: 'resend' }, { firstName: 'resend', nameChosen: false }, { firstName: 'resend', nameChosen: 'true' }]) {
      const res = await putName(server, 'resend', body);
      assert.equal(res.status, 200);
      assert.equal(res.body.needsName, true, JSON.stringify(body));
    }
    assert.equal((await call(server, '/api/users/resend')).body.firstName, undefined);
  });

  test('typing exactly the masked name is a choice, so the prompt does not stay open', async () => {
    const res = await putName(server, 'same', { firstName: 'same', nameChosen: true });
    assert.equal(res.body.needsName, false);
    assert.equal((await call(server, '/api/users/same')).body.firstName, 'same');
  });

  test('nothing usable leaves the user unnamed and unflagged', async () => {
    const blank = await putName(server, 'blank', { firstName: '   ', nameChosen: true });
    assert.equal(blank.body.needsName, true);
    assert.equal(storedUser(server, 'blank').nameSetByUser, undefined);
    const control = await putName(server, 'control', { firstName: '\u0007\u0008', nameChosen: true });
    assert.equal(control.body.needsName, true);
    assert.equal(storedUser(server, 'control').nameSetByUser, undefined);
  });

  test('nameChosen is not stored, and never names a user without a firstName', async () => {
    const res = await putName(server, 'flagtext', { bio: 'Only a bio', nameChosen: true });
    assert.equal(res.body.needsName, true);
    assert.equal(storedUser(server, 'flagtext').nameSetByUser, undefined);
    assert.ok(!('nameChosen' in storedUser(server, 'flagtext')));
  });

  test('clearing a name from Edit Profile makes the prompt due again', async () => {
    assert.equal((await putName(server, 'clearing', { firstName: '' })).body.needsName, true);
  });

  test('another user cannot save it', async () => {
    const res = await call(server, '/api/users/blank', { token: tokenFor('fresh'), method: 'PUT', body: { firstName: 'Hacked', nameChosen: true } });
    assert.equal(res.status, 403);
  });
});

describe('POST /api/users/:id/acknowledgements with type privacy', () => {
  let server;

  before(async () => {
    server = await startServer({}, { dbFixture: { users: [person('new'), person('other'), person('forger'), person('garbage', { privacyNoticeVersion: '1' })] } });
  });
  after(() => server?.stop());

  test('logged out gets 401 and a non-owner gets 403', async () => {
    assert.equal((await call(server, '/api/users/new/acknowledgements', { method: 'POST', body: NOTICE_BODY })).status, 401);
    assert.equal((await acknowledge(server, 'new', NOTICE_BODY, tokenFor('other'))).status, 403);
    assert.equal(storedUser(server, 'new').privacyNoticeVersion, undefined);
  });

  test('a bad version gets 400 and stores nothing', async () => {
    for (const version of [undefined, null, 0, -1, 2, 1.5, '1', [1], true]) {
      const res = await acknowledge(server, 'new', { type: 'privacy', version });
      assert.equal(res.status, 400, JSON.stringify(version));
    }
    assert.equal(storedUser(server, 'new').privacyNoticeVersion, undefined);
    assert.equal((await owner(server, 'new')).body.privacyNoticeVersion, null);
  });

  test('the first answer is stored, a repeat keeps its time, and both survive a restart', async () => {
    const first = await acknowledge(server, 'new');
    assert.equal(first.status, 200);
    assert.equal(first.body.privacyNoticeVersion, 1);
    assert.equal(first.body.privacyNoticeAt, undefined, 'the time stays internal');
    assert.equal(first.body.email, 'new@example.test', 'the owner view');
    const storedAt = storedUser(server, 'new').privacyNoticeAt;
    assert.ok(!Number.isNaN(Date.parse(storedAt)));

    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await acknowledge(server, 'new')).status, 200);
    assert.equal(storedUser(server, 'new').privacyNoticeAt, storedAt);

    await server.restart();
    assert.equal(storedUser(server, 'new').privacyNoticeAt, storedAt);
    assert.equal((await owner(server, 'new')).body.privacyNoticeVersion, 1);
  });

  test('the owner view has it on every response', async () => {
    const token = tokenFor('new');
    const edited = await call(server, '/api/users/new', { token, method: 'PUT', body: { bio: 'Hi' } });
    assert.equal(edited.body.privacyNoticeVersion, 1);
    assert.equal(edited.body.needsName, false);
    const avatar = await call(server, '/api/users/new/avatar', { token, method: 'POST', body: { imageData: PNG.toString('base64') } });
    assert.equal(avatar.status, 200);
    assert.equal(avatar.body.privacyNoticeVersion, 1);
    const age = await call(server, '/api/users/new/acknowledgements', { token, method: 'POST', body: { type: 'age', confirmed: true } });
    assert.equal(age.body.privacyNoticeVersion, 1);
  });

  test('it and the age answer do not stand in for each other', async () => {
    const res = await acknowledge(server, 'other');
    assert.equal(res.body.ageConfirmed, false);
    const age = await acknowledge(server, 'forger', { type: 'age', confirmed: true });
    assert.equal(age.body.ageConfirmed, true);
    assert.equal(age.body.privacyNoticeVersion, null);
    assert.equal((await acknowledge(server, 'garbage', { type: 'age', version: 1 })).status, 400);
  });

  test('a profile edit cannot set it', async () => {
    const res = await putName(server, 'forger', { privacyNoticeVersion: 1, privacyNoticeAt: CONFIRMED_AT, needsName: false });
    assert.equal(res.body.privacyNoticeVersion, null);
    assert.equal(storedUser(server, 'forger').privacyNoticeAt, undefined);
  });

  test('an unusable stored value counts as not seen, and can be answered', async () => {
    assert.equal((await owner(server, 'garbage')).body.privacyNoticeVersion, null);
    assert.equal((await acknowledge(server, 'garbage')).body.privacyNoticeVersion, 1);
  });
});

describe('a stale form holding the email prefix', () => {
  let server;

  before(async () => {
    server = await startServer({}, {
      dbFixture: {
        users: [
          person('aron', { firstName: 'Ion' }),
          unnamed('cleared'),
          person('quoted', { email: "o'brien@example.test", firstName: 'Ion' }),
          masked('blanked'),
          person('tidy', { firstName: 'Ion', bio: 'Old' }),
        ],
      },
    });
  });
  after(() => server?.stop());

  test('a set name is kept when the prefix is resent', async () => {
    for (const firstName of ['aron', 'ARON', ' aron ']) {
      const res = await putName(server, 'aron', { firstName });
      assert.equal(res.status, 200);
      assert.equal(res.body.firstName, 'Ion', firstName);
    }
    assert.equal((await call(server, '/api/users/aron')).body.firstName, 'Ion');
  });

  test('a cleared name stays cleared, unflagged and not public', async () => {
    const res = await putName(server, 'cleared', { firstName: 'cleared' });
    assert.equal(res.body.firstName, '');
    assert.equal(res.body.needsName, true);
    assert.equal(storedUser(server, 'cleared').nameSetByUser, undefined);
  });

  test('so does an escaped form opened earlier', async () => {
    const res = await putName(server, 'quoted', { firstName: 'o&#x27;brien' });
    assert.equal(res.body.firstName, 'Ion');
    assert.ok(!(await call(server, '/api/users/quoted')).text.includes('brien'));
  });

  test('the rest of the form is still saved, and other names still are', async () => {
    const res = await putName(server, 'tidy', { firstName: 'tidy', bio: 'New' });
    assert.equal(res.body.firstName, 'Ion');
    assert.equal(res.body.bio, 'New');
    assert.equal((await putName(server, 'tidy', { firstName: 'Vlad' })).body.firstName, 'Vlad');
  });

  test('a blank typed name removes the mask flag rather than setting it', async () => {
    const res = await putName(server, 'blanked', { firstName: '   ', nameChosen: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.needsName, true);
    assert.equal(res.body.firstName, '');
    assert.ok(!('nameSetByUser' in storedUser(server, 'blanked')));
  });
});

describe('a new account before the notice', () => {
  let server;
  const signIn = async (uid, body = {}) => {
    const res = await call(server, '/api/auth/mobile', { method: 'POST', body: { idToken: 'dev-fallback-token', uid, email: `${uid}@example.test`, ...body } });
    assert.equal(res.status, 200);
    return res.body.token;
  };

  before(async () => {
    server = await startServer({ ALLOW_INSECURE_DEV_AUTH: 'true' }, {
      dbFixture: { users: [person('older', { ageConfirmedAt: CONFIRMED_AT })] },
    });
  });
  after(() => server?.stop());

  test('is hidden, and the owner still gets their own name, with no name prompt for a provider name', async () => {
    const token = await signIn('newbie', { displayName: 'Ana Pop' });
    const publicView = await call(server, '/api/users/newbie');
    assert.equal(publicView.status, 200);
    assert.ok(!publicView.text.includes('Ana'));
    assert.ok(!publicView.text.includes('Pop'));
    assert.ok(!publicView.text.includes('noticePending'));
    assert.equal(publicView.body.avatar, null);

    const own = await call(server, '/api/users/newbie', { token });
    assert.equal(own.body.firstName, 'Ana');
    assert.equal(own.body.needsName, false);
    assert.ok(!own.text.includes('noticePending'));

    const search = await call(server, '/api/users/search?q=ana', { token: tokenFor('older') });
    assert.deepEqual(search.body, []);
  });

  test('a stored avatar is not served', async () => {
    const token = await signIn('photo', { displayName: 'Photo Person' });
    const upload = await call(server, '/api/users/photo/avatar', { token, method: 'POST', body: { imageData: PNG.toString('base64') } });
    assert.equal(upload.status, 200);
    assert.equal((await call(server, '/media/avatars/photo')).status, 404);
    assert.equal((await call(server, '/api/users/photo')).body.avatar, null);
    await acknowledge(server, 'photo');
    assert.equal((await call(server, '/media/avatars/photo')).status, 200);
  });

  test('a custom client\'s post and comment show a masked author', async () => {
    const token = await signIn('custom', { displayName: 'Custom Client' });
    const created = await call(server, '/api/drinks', {
      token,
      method: 'POST',
      body: { name: 'Tea', description: 'Tea', rating: 3, isAlcoholic: false, imageData: PNG.toString('base64') },
    });
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.equal((await call(server, `/api/drinks/${id}/comments`, { token, method: 'POST', body: { content: 'Hi' } })).status, 201);
    const detail = await call(server, `/api/drinks/${id}`);
    assert.ok(!detail.text.includes('Custom'));
    assert.equal(detail.body.user.firstName, undefined);
    assert.ok(!(await call(server, `/api/drinks/${id}/comments`)).text.includes('Custom'));
  });

  test('the acknowledgement makes it public, also after a restart', async () => {
    const token = await signIn('accepts', { displayName: 'Lia Accept' });
    assert.equal((await call(server, '/api/users/accepts')).body.firstName, undefined);
    const res = await acknowledge(server, 'accepts', NOTICE_BODY, token);
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('noticePending'));
    assert.ok(!('noticePending' in storedUser(server, 'accepts')));
    await server.restart();
    assert.equal((await call(server, '/api/users/accepts')).body.firstName, 'Lia');
    const search = await call(server, '/api/users/search?q=lia', { token: tokenFor('older') });
    assert.deepEqual(search.body.map((u) => u.id), ['accepts']);
  });

  test('it survives a restart while pending, and later sign-ins change nothing', async () => {
    await signIn('waiting', { displayName: 'Wait Ing' });
    await server.restart();
    await signIn('waiting', { displayName: 'Wait Ing' });
    assert.equal(storedUser(server, 'waiting').noticePending, true);
    assert.equal((await call(server, '/api/users/waiting')).body.firstName, undefined);
  });

  test('an existing user is never hidden, and signing in does not hide them', async () => {
    await signIn('older', { displayName: 'Other' });
    assert.ok(!('noticePending' in storedUser(server, 'older')));
    assert.equal((await call(server, '/api/users/older')).body.firstName, 'Named');
  });
});

describe('notice limits and failures', () => {
  test('it works at the storage limit, where growth is refused', async (t) => {
    const server = await startServer({ DB_GROWTH_MAX_BYTES: '1' }, { dbFixture: { users: [person('new')] } });
    t.after(() => server.stop());
    const res = await acknowledge(server, 'new');
    assert.equal(res.status, 200);
    assert.equal(res.body.privacyNoticeVersion, 1);
  });

  test('a failed save returns 503 and rolls back, and a retry works', async (t) => {
    const server = await startServer({ DB_FAULT: 'save', NODE_OPTIONS: `--import=${FAULT_PRELOAD}` }, {
      dbFixture: { users: [person('new')] },
    });
    t.after(() => server.stop());
    const marker = `${server.dbFile}.fail-saves`;
    fs.writeFileSync(marker, '');
    assert.equal((await acknowledge(server, 'new')).status, 503);
    fs.rmSync(marker);
    assert.equal((await owner(server, 'new')).body.privacyNoticeVersion, null);
    assert.equal(storedUser(server, 'new').privacyNoticeAt, undefined);
    assert.equal((await acknowledge(server, 'new')).body.privacyNoticeVersion, 1);
  });

  test('a failed profile save restores every field, and the flag', async (t) => {
    const server = await startServer({ DB_FAULT: 'save', NODE_OPTIONS: `--import=${FAULT_PRELOAD}` }, {
      dbFixture: { users: [masked('legacy', { city: 'Iasi', bio: 'Old' }), person('named')] },
    });
    t.after(() => server.stop());
    const marker = `${server.dbFile}.fail-saves`;
    fs.writeFileSync(marker, '');
    const failed = await putName(server, 'legacy', { firstName: 'Ion', lastName: 'Pop', city: 'Cluj', bio: 'New', nameChosen: true });
    assert.equal(failed.status, 503);
    assert.equal((await putName(server, 'named', { firstName: '' })).status, 503);
    fs.rmSync(marker);

    const own = (await owner(server, 'legacy')).body;
    assert.equal(own.firstName, 'legacy');
    assert.equal(own.lastName, '');
    assert.equal(own.city, 'Iasi');
    assert.equal(own.bio, 'Old');
    assert.equal(own.needsName, true, 'still masked');
    assert.equal((await call(server, '/api/users/legacy')).body.firstName, undefined);
    assert.equal((await owner(server, 'named')).body.firstName, 'Named');
    assert.equal((await owner(server, 'named')).body.needsName, false, 'the flag came back too');
  });

  test('a failed acknowledgement leaves a new account hidden', async (t) => {
    const server = await startServer({ DB_FAULT: 'save', NODE_OPTIONS: `--import=${FAULT_PRELOAD}` }, {
      dbFixture: { users: [person('new', { noticePending: true })] },
    });
    t.after(() => server.stop());
    const marker = `${server.dbFile}.fail-saves`;
    fs.writeFileSync(marker, '');
    assert.equal((await acknowledge(server, 'new')).status, 503);
    fs.rmSync(marker);
    assert.equal((await call(server, '/api/users/new')).body.firstName, undefined);
    assert.equal((await acknowledge(server, 'new')).status, 200);
    assert.equal((await call(server, '/api/users/new')).body.firstName, 'Named');
  });

  test('a failed name save answers 503, and the same name saved again is kept', async (t) => {
    const server = await startServer({ DB_FAULT: 'save', NODE_OPTIONS: `--import=${FAULT_PRELOAD}` }, {
      dbFixture: { users: [masked('legacy')] },
    });
    t.after(() => server.stop());
    const marker = `${server.dbFile}.fail-saves`;
    fs.writeFileSync(marker, '');
    const body = { firstName: 'Ion', nameChosen: true };
    assert.equal((await putName(server, 'legacy', body)).status, 503);
    fs.rmSync(marker);
    const retried = await putName(server, 'legacy', body);
    assert.equal(retried.status, 200);
    assert.equal(retried.body.needsName, false);
    const stored = storedUser(server, 'legacy');
    assert.equal(stored.firstName, 'Ion');
    assert.equal(stored.nameSetByUser, true);
  });
});

// The notice text in LocalizationContext.tsx, sentence by sentence. A failure here means the text must change.
describe('what the notice says', () => {
  let server;
  const ALCOHOLIC_POST = 'Hidden Whisky';
  const ALCOHOLIC_COMMENT = 'Hidden comment';

  before(async () => {
    server = await startServer({}, {
      dbFixture: {
        users: [
          person('author', { ageConfirmedAt: CONFIRMED_AT, avatar: PNG_DATA_URL }),
          person('partner', { ageConfirmedAt: CONFIRMED_AT }),
          person('partner2', { ageConfirmedAt: CONFIRMED_AT }),
          person('stranger', { ageConfirmedAt: CONFIRMED_AT }),
          person('minor'),
        ],
        drinks: [
          post(1, 'author', { name: 'Plain Tea', location: 'Teahouse' }),
          post(2, 'author', { name: ALCOHOLIC_POST, location: 'Secret Bar', isAlcoholic: true }),
        ],
        nextDrinkId: 3,
        commentsByDrink: {
          1: [{ id: 1, drinkId: 1, userId: 'author', content: 'Public comment', createdAt: '2026-01-01T00:00:00.000Z' }],
          2: [{ id: 2, drinkId: 2, userId: 'author', content: ALCOHOLIC_COMMENT, createdAt: '2026-01-01T00:00:00.000Z' }],
        },
        nextCommentId: 3,
        partnersByUser: { author: ['partner', 'partner2'], partner: ['author'], partner2: ['author'] },
        savedByUser: { author: [1] },
        smartBarByUser: { author: [{ id: 'gin', name: 'Gin', quantity: '1' }] },
      },
    });
  });
  after(() => server?.stop());

  test('name, photo, city and bio are public, with no account', async () => {
    const { status, body } = await call(server, '/api/users/author');
    assert.equal(status, 200);
    assert.equal(body.firstName, 'Named');
    assert.equal(body.city, 'Cluj');
    assert.equal(body.bio, 'Hello');
    assert.ok(body.avatar);
    assert.equal((await call(server, '/media/avatars/author')).status, 200);
  });

  test('non-alcoholic posts, their locations and comments are public, with no account', async () => {
    const list = await call(server, '/api/drinks/user/author');
    assert.deepEqual(list.body.items.map((d) => d.location), ['Teahouse']);
    assert.equal((await call(server, '/media/drinks/1')).status, 200);
    const comments = await call(server, '/api/drinks/1/comments');
    assert.ok(comments.text.includes('Public comment'));
  });

  test('alcoholic posts, their locations and comments need a signed-in, confirmed viewer', async () => {
    for (const token of [undefined, tokenFor('minor')]) {
      const list = await call(server, '/api/drinks/user/author', { token });
      assert.ok(!list.text.includes(ALCOHOLIC_POST));
      assert.ok(!list.text.includes('Secret Bar'));
      assert.equal((await call(server, '/api/drinks/2', { token })).status, 403);
      assert.equal((await call(server, '/media/drinks/2', { token })).status, 403);
      const comments = await call(server, '/api/drinks/2/comments', { token });
      assert.equal(comments.status, 403);
      assert.ok(!comments.text.includes(ALCOHOLIC_COMMENT));
    }
    const token = tokenFor('stranger');
    assert.ok((await call(server, '/api/drinks/2', { token })).text.includes('Secret Bar'));
    assert.ok((await call(server, '/api/drinks/2/comments', { token })).text.includes(ALCOHOLIC_COMMENT));
  });

  test('the partner list is for the owner and their partners only', async () => {
    const route = '/api/users/author/partners';
    assert.equal((await call(server, route)).status, 401);
    assert.equal((await call(server, route, { token: tokenFor('stranger') })).status, 403);
    assert.equal((await call(server, route, { token: tokenFor('partner') })).status, 200);
    assert.equal((await call(server, route, { token: tokenFor('author') })).status, 200);
    assert.equal((await call(server, '/api/users/author', { token: tokenFor('stranger') })).body.partnerCount, undefined);
  });

  test('post owners see who cheered or commented, and cheer counts are public', async () => {
    const token = tokenFor('stranger');
    assert.equal((await call(server, '/api/drinks/1/like', { token, method: 'POST' })).status, 200);
    assert.equal((await call(server, '/api/drinks/1/comments', { token, method: 'POST', body: { content: 'Nice' } })).status, 201);
    const { body } = await call(server, '/api/notifications', { token: tokenFor('author') });
    assert.ok(body.notifications.some((n) => n.type === 'cheer' && n.message.startsWith('Named Test')));
    assert.ok(body.notifications.some((n) => n.type === 'comment' && n.message.startsWith('Named Test')));
    assert.equal((await call(server, '/api/drinks/1')).body.cheersCount, 1);
  });

  test('a partner\'s other partners can see that you are partnered with them', async () => {
    const { body } = await call(server, '/api/users/author/partners', { token: tokenFor('partner') });
    assert.ok(body.some((u) => u.id === 'partner2'));
  });

  test('email, saved posts and the Smart Bar stay private', async () => {
    for (const token of [undefined, tokenFor('stranger')]) {
      assert.ok(!(await call(server, '/api/users/author', { token })).text.includes('author@example.test'));
      assert.ok(!(await call(server, '/api/drinks/1', { token })).text.includes('author@example.test'));
    }
    const saved = '/api/users/author/saved-drinks';
    assert.equal((await call(server, saved)).status, 401);
    assert.equal((await call(server, saved, { token: tokenFor('stranger') })).status, 403);
    assert.equal((await call(server, '/api/smart-bar')).status, 401);
    assert.ok(!(await call(server, '/api/smart-bar', { token: tokenFor('stranger') })).text.includes('Gin'));
    assert.equal((await call(server, '/api/drinks/1', { token: tokenFor('stranger') })).body.isSaved, false);
  });
});

// Its own server: only one can hold the test port at a time.
describe('what the notice says about moderators', () => {
  test('moderators can see reported content and who reported it', async (t) => {
    const moderated = await startServer({ ADMIN_USER_IDS: 'moderator' }, {
      dbFixture: { users: [person('moderator'), person('author'), person('reporter')], drinks: [post(1, 'author')], nextDrinkId: 2 },
    });
    t.after(() => moderated.stop());
    const reported = await call(moderated, '/api/reports', {
      token: tokenFor('reporter'),
      method: 'POST',
      body: { targetType: 'drink', targetId: 1, reason: 'spam' },
    });
    assert.equal(reported.status, 201);
    const { body } = await call(moderated, '/api/admin/reports', { token: tokenFor('moderator') });
    assert.equal(body.items[0].reporterId, 'reporter');
    assert.ok(JSON.stringify(body.items[0]).includes('Post 1'));
  });
});
