import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';

import { REAL_DB_FILE, assertRefusesToStart, startServer } from './helpers/harness.js';

const REQUEST_TIMEOUT_MS = 20_000;
const SYNTHETIC_DOMAIN = '@drinkme.app';
const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const GOOGLE_PHOTO = 'https://lh3.googleusercontent.com/a/ACg8ocK-test=s96-c';
const SMALL_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP////////////////////////////////////////////////////////////////' +
  '//////////////////////2wBDAf//////////////////////////////////////////////////////////////////////' +
  '////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/' +
  'xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AH//Z';

const STUB_PRELOAD = new URL('./helpers/firebase-auth-stub-preload.js', import.meta.url).href;

// Synthetic credentials. The key exists only in memory, for this test run.
const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const TEST_SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'drinkme-auth-test',
  private_key: privateKey,
  client_email: 'auth-test@drinkme-auth-test.example.test',
});

const firebaseEnv = {
  ALLOW_INSECURE_DEV_AUTH: undefined,
  FIREBASE_SERVICE_ACCOUNT_KEY: TEST_SERVICE_ACCOUNT,
  NODE_OPTIONS: `--import=${STUB_PRELOAD}`,
};

const stubToken = (claims) => `stub:${JSON.stringify(claims)}`;

const startOn = async (t, env, options) => {
  const server = await startServer(env, options);
  t.after(() => server.stop());
  return server;
};

const postJson = async (url, body, headers = {}) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: res.status, body: await res.json() };
};

const postAuth = (baseUrl, body) => postJson(`${baseUrl}/api/auth/mobile`, body);

const ownerToken = (uid) => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const content = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ uid })}`;
  const signature = crypto.createHmac('sha256', HARNESS_JWT_SECRET).update(content).digest('base64url');
  return `${content}.${signature}`;
};

// Reads the record as its owner: other viewers only get the public view, with no email.
const getUser = async (baseUrl, id) => {
  const res = await fetch(`${baseUrl}/api/users/${id}`, {
    headers: { Authorization: `Bearer ${ownerToken(id)}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assert.equal(res.status, 200);
  return res.json();
};

// emailVerified is stored only, and is checked in the file so no test relies on an API exposing it.
const readStoredUser = (dbFile, id) =>
  JSON.parse(fs.readFileSync(dbFile, 'utf8')).users.find((user) => user.id === id);

const devSignIn = async (baseUrl, fields = {}, uid = 'dev-user') => {
  const res = await postAuth(baseUrl, { idToken: 'dev-fallback-token', uid, ...fields });
  assert.equal(res.status, 200);
  return res.body.token;
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

describe('/api/auth/mobile in the dev fallback', () => {
  test('a valid email is stored', async (t) => {
    const { baseUrl } = await startOn(t);
    await devSignIn(baseUrl, { email: 'real@example.test' });
    assert.equal((await getUser(baseUrl, 'dev-user')).email, 'real@example.test');
  });

  test('an apostrophe in an email is allowed, and no name is derived from it', async (t) => {
    const { baseUrl } = await startOn(t);
    await devSignIn(baseUrl, { email: "o'brien@example.com" });
    const user = await getUser(baseUrl, 'dev-user');
    assert.equal(user.email, "o'brien@example.com");
    assert.equal(user.firstName, '');
  });

  for (const [label, email] of [
    ['a malformed string', 'not-an-email'],
    ['a non-string', { $ne: 1 }],
    ['quoted markup', '"<b>x"@example.com'],
  ]) {
    test(`an email that is ${label} is not stored and the user gets the synthetic address`, async (t) => {
      const { baseUrl } = await startOn(t);
      await devSignIn(baseUrl, { email });
      assert.equal((await getUser(baseUrl, 'dev-user')).email, `dev-user${SYNTHETIC_DOMAIN}`);
    });
  }

  for (const [label, photoURL] of [
    ['a javascript: URL', 'javascript:alert(1)'],
    ['an http URL', 'http://lh3.googleusercontent.com/a.jpg'],
    ['a data: URL', 'data:image/png;base64,AAAA'],
    ['a URL with no protocol', 'lh3.googleusercontent.com/a.jpg'],
    ['a URL over 2048 characters', `https://lh3.googleusercontent.com/${'a'.repeat(2048)}`],
    ['a non-string', { href: GOOGLE_PHOTO }],
    ['credentials on another host', 'https://user:pw@evil.example.com/a.jpg'],
    ['credentials on an allowed host', 'https://user:pw@lh3.googleusercontent.com/a.jpg'],
    ['a private IP', 'https://192.168.0.1/a.jpg'],
    ['a loopback IP', 'https://127.0.0.1/a.jpg'],
    ['an IPv6 loopback', 'https://[::1]/a.jpg'],
    ['a link-local metadata IP', 'https://169.254.169.254/x'],
    ['another host', 'https://example.com/a.jpg'],
    ['a look-alike host', 'https://evil-googleusercontent.com/a.jpg'],
    ['an allowed host as a prefix', 'https://lh3.googleusercontent.com.evil.example/a.jpg'],
    ['the bare parent domain', 'https://googleusercontent.com/a.jpg'],
    ['a custom port', 'https://lh3.googleusercontent.com:8443/a.jpg'],
    ['a caller-chosen subdomain', 'https://1.2.3.4.bc.googleusercontent.com/a.jpg'],
    ['a host outside the lh3 to lh6 range', 'https://lh7.googleusercontent.com/a.jpg'],
  ]) {
    test(`${label} leaves avatar null and login succeeds`, async (t) => {
      const { baseUrl } = await startOn(t);
      await devSignIn(baseUrl, { photoURL });
      assert.equal((await getUser(baseUrl, 'dev-user')).avatar, null);
    });
  }

  test('a valid https photoURL is stored for a new user', async (t) => {
    const { baseUrl } = await startOn(t);
    await devSignIn(baseUrl, { photoURL: GOOGLE_PHOTO });
    assert.equal((await getUser(baseUrl, 'dev-user')).avatar, GOOGLE_PHOTO);
  });

  test('a photoURL on another googleusercontent.com subdomain is stored', async (t) => {
    const { baseUrl } = await startOn(t);
    await devSignIn(baseUrl, { photoURL: 'https://lh4.googleusercontent.com/a.jpg' });
    assert.equal((await getUser(baseUrl, 'dev-user')).avatar, 'https://lh4.googleusercontent.com/a.jpg');
  });

  test('displayName is stored as plain text', async (t) => {
    const { baseUrl } = await startOn(t);
    await devSignIn(baseUrl, { displayName: '<b>x</b>' });
    const user = await getUser(baseUrl, 'dev-user');
    assert.equal(user.firstName, '<b>x</b>');
  });

  test('a non-string displayName is ignored', async (t) => {
    const { baseUrl } = await startOn(t);
    await devSignIn(baseUrl, { displayName: { first: 'x' } });
    assert.equal((await getUser(baseUrl, 'dev-user')).firstName, '');
  });

  for (const [label, idToken] of [['a number', 123], ['an object', { a: 1 }], ['an array', ['t']], ['empty', '']]) {
    test(`an idToken that is ${label} returns 400 and issues no JWT`, async (t) => {
      const { baseUrl } = await startOn(t);
      const { status, body } = await postAuth(baseUrl, { idToken, uid: 'dev-user' });
      assert.equal(status, 400);
      assert.equal(body.token, undefined);
    });
  }

  for (const [label, uid] of [
    ['a path traversal', '../x'],
    ['too long', 'a'.repeat(129)],
    ['an array that stringifies to a valid uid', ['dev-user']],
    ['a number', 123],
  ]) {
    test(`a uid that is ${label} returns 400 and issues no JWT`, async (t) => {
      const { baseUrl } = await startOn(t);
      const { status, body } = await postAuth(baseUrl, { idToken: 'dev-fallback-token', uid });
      assert.equal(status, 400);
      assert.equal(body.token, undefined);
    });
  }

  test('a uid of exactly 128 characters is accepted', async (t) => {
    const { baseUrl } = await startOn(t);
    await devSignIn(baseUrl, {}, 'a'.repeat(128));
  });

  test('an uploaded avatar survives a re-login with a valid photoURL', async (t) => {
    const { baseUrl } = await startOn(t);
    const token = await devSignIn(baseUrl, { photoURL: GOOGLE_PHOTO });

    const upload = await postJson(
      `${baseUrl}/api/users/dev-user/avatar`,
      { imageData: SMALL_JPEG_BASE64 },
      { Authorization: `Bearer ${token}` }
    );
    assert.equal(upload.status, 200);
    const uploaded = upload.body.avatar;
    assert.match(uploaded, /^\/media\/avatars\/dev-user\?v=[0-9a-f]{12}$/);

    await devSignIn(baseUrl, { photoURL: GOOGLE_PHOTO });
    assert.equal((await getUser(baseUrl, 'dev-user')).avatar, uploaded);
  });

  test('a user with no avatar gets the photoURL on a later login', async (t) => {
    const { baseUrl } = await startOn(t);
    await devSignIn(baseUrl);
    await devSignIn(baseUrl, { photoURL: GOOGLE_PHOTO });
    assert.equal((await getUser(baseUrl, 'dev-user')).avatar, GOOGLE_PHOTO);
  });

  test('the dev fallback never overwrites a stored email', async (t) => {
    const { baseUrl } = await startOn(t);
    await devSignIn(baseUrl, { email: 'first@example.test' });
    await devSignIn(baseUrl, { email: 'second@example.test' });
    assert.equal((await getUser(baseUrl, 'dev-user')).email, 'first@example.test');
  });

  test('the dev fallback stores no emailVerified', async (t) => {
    const { baseUrl, dbFile } = await startOn(t);
    await devSignIn(baseUrl, { email: 'real@example.test', email_verified: true, emailVerified: true });
    assert.equal(readStoredUser(dbFile, 'dev-user').emailVerified, undefined);
  });
});

describe('/api/auth/mobile in Firebase mode (firebase-admin/auth stubbed)', () => {
  const forgedUser = {
    id: 'fb-user',
    email: 'forged@example.test',
    firstName: 'Fb',
    lastName: '',
    city: 'Bucharest',
    bio: 'DrinkMe explorer',
    avatar: null,
  };

  test('a body email that differs from the token email stores the token email', async (t) => {
    const { baseUrl } = await startOn(t, firebaseEnv);
    const { status, body } = await postAuth(baseUrl, {
      idToken: stubToken({ uid: 'fb-user', email: 'token@example.test' }),
      uid: 'fb-user',
      email: 'body@example.test',
    });
    assert.equal(status, 200);
    assert.ok(body.token);
    assert.equal((await getUser(baseUrl, 'fb-user')).email, 'token@example.test');
  });

  test('a stored forged email is corrected by the token email', async (t) => {
    const { baseUrl } = await startOn(t, firebaseEnv, { dbFixture: { users: [forgedUser] } });
    const { status } = await postAuth(baseUrl, {
      idToken: stubToken({ uid: 'fb-user', email: 'token@example.test' }),
      uid: 'fb-user',
      email: 'forged@example.test',
    });
    assert.equal(status, 200);
    assert.equal((await getUser(baseUrl, 'fb-user')).email, 'token@example.test');
  });

  test('a token with no email keeps the stored email and ignores the body email', async (t) => {
    const { baseUrl } = await startOn(t, firebaseEnv, { dbFixture: { users: [forgedUser] } });
    const { status } = await postAuth(baseUrl, {
      idToken: stubToken({ uid: 'fb-user' }),
      uid: 'fb-user',
      email: 'body@example.test',
    });
    assert.equal(status, 200);
    assert.equal((await getUser(baseUrl, 'fb-user')).email, forgedUser.email);
  });

  test('a new user whose token has no email gets the synthetic address, not the body email', async (t) => {
    const { baseUrl } = await startOn(t, firebaseEnv);
    const { status } = await postAuth(baseUrl, {
      idToken: stubToken({ uid: 'fb-user' }),
      uid: 'fb-user',
      email: 'body@example.test',
    });
    assert.equal(status, 200);
    assert.equal((await getUser(baseUrl, 'fb-user')).email, `fb-user${SYNTHETIC_DOMAIN}`);
  });

  for (const [label, claim, expected] of [
    ['true', true, true],
    ['false', false, false],
    ['absent', undefined, false],
    ['a non-boolean', 'true', false],
  ]) {
    test(`email_verified ${label} stores emailVerified ${expected} and sign-in succeeds`, async (t) => {
      const { baseUrl, dbFile } = await startOn(t, firebaseEnv);
      const { status, body } = await postAuth(baseUrl, {
        idToken: stubToken({ uid: 'fb-user', email: 'token@example.test', email_verified: claim }),
        uid: 'fb-user',
        emailVerified: !expected, // the body must never decide this
      });
      assert.equal(status, 200);
      assert.ok(body.token);
      assert.equal(readStoredUser(dbFile, 'fb-user').emailVerified, expected);
    });
  }

  test('emailVerified is updated on an existing user at each login', async (t) => {
    const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [forgedUser] } });
    for (const claim of [false, true]) {
      await postAuth(baseUrl, {
        idToken: stubToken({ uid: 'fb-user', email: 'token@example.test', email_verified: claim }),
        uid: 'fb-user',
      });
      assert.equal(readStoredUser(dbFile, 'fb-user').emailVerified, claim);
    }
  });

  test('the real client payload with null fields stores the token email', async (t) => {
    const { baseUrl } = await startOn(t, firebaseEnv);
    const { status, body } = await postAuth(baseUrl, {
      idToken: stubToken({ uid: 'fb-user', email: 'token@example.test' }),
      uid: 'fb-user',
      email: null,
      displayName: null,
      photoURL: null,
    });
    assert.equal(status, 200);
    assert.ok(body.token);
    const user = await getUser(baseUrl, 'fb-user');
    assert.equal(user.email, 'token@example.test');
    assert.equal(user.firstName, '');
    assert.equal(user.avatar, null);
  });

  test('the real client payload with null fields and no token email gets the synthetic address', async (t) => {
    const { baseUrl } = await startOn(t, firebaseEnv);
    const { status, body } = await postAuth(baseUrl, {
      idToken: stubToken({ uid: 'fb-user' }),
      uid: 'fb-user',
      email: null,
      displayName: null,
      photoURL: null,
    });
    assert.equal(status, 200);
    assert.ok(body.token);
    const user = await getUser(baseUrl, 'fb-user');
    assert.equal(user.email, `fb-user${SYNTHETIC_DOMAIN}`);
    assert.equal(user.avatar, null);
  });

  test('the photo comes from the token: a photoURL in the body is ignored', async (t) => {
    const { baseUrl } = await startOn(t, firebaseEnv);
    const { status } = await postAuth(baseUrl, {
      idToken: stubToken({ uid: 'fb-user', email: 'token@example.test' }),
      uid: 'fb-user',
      photoURL: GOOGLE_PHOTO,
    });
    assert.equal(status, 200);
    assert.equal((await getUser(baseUrl, 'fb-user')).avatar, null);

    await postAuth(baseUrl, {
      idToken: stubToken({ uid: 'fb-user', email: 'token@example.test', picture: GOOGLE_PHOTO }),
      uid: 'fb-user',
      photoURL: 'https://lh4.googleusercontent.com/other.jpg',
    });
    assert.equal((await getUser(baseUrl, 'fb-user')).avatar, GOOGLE_PHOTO);
  });

  test('a token picture on another host is not stored', async (t) => {
    const { baseUrl } = await startOn(t, firebaseEnv);
    await postAuth(baseUrl, {
      idToken: stubToken({ uid: 'fb-user', email: 'token@example.test', picture: 'https://1.2.3.4.bc.googleusercontent.com/a.jpg' }),
      uid: 'fb-user',
    });
    assert.equal((await getUser(baseUrl, 'fb-user')).avatar, null);
  });

  test('an existing avatar survives a login with a valid photo', async (t) => {
    const avatar = `data:image/jpeg;base64,${SMALL_JPEG_BASE64}`;
    const { baseUrl } = await startOn(t, firebaseEnv, { dbFixture: { users: [{ ...forgedUser, avatar }] } });
    const { status } = await postAuth(baseUrl, {
      idToken: stubToken({ uid: 'fb-user', email: 'token@example.test', picture: GOOGLE_PHOTO }),
      uid: 'fb-user',
    });
    assert.equal(status, 200);
    assert.match((await getUser(baseUrl, 'fb-user')).avatar, /^\/media\/avatars\/fb-user\?v=/);
  });

  test('no name is derived from the token email', async (t) => {
    const { baseUrl } = await startOn(t, firebaseEnv);
    await postAuth(baseUrl, { idToken: stubToken({ uid: 'fb-user', email: '"<b>x"@example.com' }), uid: 'fb-user' });
    assert.equal((await getUser(baseUrl, 'fb-user')).firstName, '');
  });

  describe('a token email that differs from the stored one', () => {
    const signInWithNewEmail = (baseUrl) => postAuth(baseUrl, {
      idToken: stubToken({ uid: 'fb-user', email: 'new.address@example.test' }),
      uid: 'fb-user',
    });
    const readPublicText = async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/users/fb-user`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      assert.equal(res.status, 200);
      return res.text();
    };

    test('clears a name derived from the old email, so the old prefix is not unmasked', async (t) => {
      const legacy = { ...forgedUser, email: 'oldprefix@example.test', firstName: 'oldprefix' };
      const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [legacy] } });
      assert.equal((await signInWithNewEmail(baseUrl)).status, 200);
      const stored = readStoredUser(dbFile, 'fb-user');
      assert.equal(stored.email, 'new.address@example.test');
      assert.equal(stored.firstName, '');
      assert.ok(!(await readPublicText(baseUrl)).includes('oldprefix'));
    });

    test('keeps a name the user set, even one equal to the old prefix', async (t) => {
      const owned = { ...forgedUser, email: 'aron@example.test', firstName: 'Aron', nameSetByUser: true };
      const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [owned] } });
      assert.equal((await signInWithNewEmail(baseUrl)).status, 200);
      assert.equal(readStoredUser(dbFile, 'fb-user').firstName, 'Aron');
      assert.ok((await readPublicText(baseUrl)).includes('Aron'));
    });

    test('keeps a name that never came from the email', async (t) => {
      const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [forgedUser] } });
      assert.equal((await signInWithNewEmail(baseUrl)).status, 200);
      assert.equal(readStoredUser(dbFile, 'fb-user').firstName, 'Fb');
    });

    test('an unchanged email leaves a masked name stored, for its owner', async (t) => {
      const legacy = { ...forgedUser, email: 'oldprefix@example.test', firstName: 'oldprefix' };
      const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [legacy] } });
      const { status } = await postAuth(baseUrl, {
        idToken: stubToken({ uid: 'fb-user', email: 'oldprefix@example.test' }),
        uid: 'fb-user',
      });
      assert.equal(status, 200);
      assert.equal(readStoredUser(dbFile, 'fb-user').firstName, 'oldprefix');
      assert.ok(!(await readPublicText(baseUrl)).includes('oldprefix'));
    });
  });

  describe('the name of a user', () => {
    const signIn = (baseUrl, { email = 'token@example.test', name, displayName } = {}) => postAuth(baseUrl, {
      idToken: stubToken({ uid: 'fb-user', email, ...(name !== undefined && { name }) }),
      uid: 'fb-user',
      displayName,
    });
    const readPublic = async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/users/fb-user`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      assert.equal(res.status, 200);
      return res.json();
    };
    const putOwner = async (baseUrl, body) => {
      const res = await fetch(`${baseUrl}/api/users/fb-user`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken('fb-user')}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return { status: res.status, body: await res.json() };
    };
    const emptyName = { ...forgedUser, firstName: '', email: 'aron@example.test' };
    // A new account is hidden until this.
    const acknowledgeNotice = (baseUrl) => postJson(
      `${baseUrl}/api/users/fb-user/acknowledgements`,
      { type: 'privacy', version: 1 },
      { Authorization: `Bearer ${ownerToken('fb-user')}` }
    );

    test('a new Google user whose token name equals the email prefix is public', async (t) => {
      const { baseUrl, dbFile } = await startOn(t, firebaseEnv);
      const { status } = await signIn(baseUrl, { email: 'aron@gmail.com', name: 'Aron', displayName: 'Aron' });
      assert.equal(status, 200);
      assert.equal(readStoredUser(dbFile, 'fb-user').nameSetByUser, true);
      await acknowledgeNotice(baseUrl);
      const publicUser = await readPublic(baseUrl);
      assert.equal(publicUser.firstName, 'Aron');
      assert.equal('nameSetByUser' in publicUser, false);
    });

    test('the token name wins over a different body displayName', async (t) => {
      const { baseUrl } = await startOn(t, firebaseEnv);
      await signIn(baseUrl, { name: 'Ana Pop', displayName: 'Somebody Else' });
      await acknowledgeNotice(baseUrl);
      const publicUser = await readPublic(baseUrl);
      assert.equal(publicUser.firstName, 'Ana');
      assert.equal(publicUser.lastName, 'Pop');
    });

    test('a token name with an @ is not stored', async (t) => {
      const { baseUrl, dbFile } = await startOn(t, firebaseEnv);
      await signIn(baseUrl, { name: 'token@example.test' });
      const stored = readStoredUser(dbFile, 'fb-user');
      assert.equal(stored.firstName, '');
      assert.equal(stored.nameSetByUser, undefined);
    });

    for (const [label, email, displayName] of [
      ['equal to the prefix', 'aron@gmail.com', 'aron'],
      ['equal in another case', 'aron@gmail.com', 'ARON'],
      ['equal with an apostrophe', "o'brien@example.test", "o'brien"],
      ['starting with the prefix', 'aron@gmail.com', 'Aron Pop'],
      ['holding an @', 'aron@gmail.com', 'other@example.test'],
      ['holding an @ in a later word', 'aron@gmail.com', 'Ana a@b.test'],
    ]) {
      test(`a body displayName ${label} leaves the name empty and sets no flag`, async (t) => {
        const { baseUrl, dbFile } = await startOn(t, firebaseEnv);
        assert.equal((await signIn(baseUrl, { email, displayName })).status, 200);
        const stored = readStoredUser(dbFile, 'fb-user');
        assert.equal(stored.firstName, '');
        assert.equal(stored.lastName, '');
        assert.equal(stored.nameSetByUser, undefined);
      });
    }

    test('a different body displayName is stored when the token has no name', async (t) => {
      const { baseUrl, dbFile } = await startOn(t, firebaseEnv);
      await signIn(baseUrl, { email: 'aron@gmail.com', displayName: 'Ana Pop' });
      assert.equal(readStoredUser(dbFile, 'fb-user').nameSetByUser, true);
      await acknowledgeNotice(baseUrl);
      assert.equal((await readPublic(baseUrl)).firstName, 'Ana');
    });

    test('with no email in the token, the synthetic prefix is the one compared', async (t) => {
      const { baseUrl, dbFile } = await startOn(t, firebaseEnv);
      const { status } = await postAuth(baseUrl, { idToken: stubToken({ uid: 'fb-user' }), uid: 'fb-user', displayName: 'fb-user' });
      assert.equal(status, 200);
      assert.equal(readStoredUser(dbFile, 'fb-user').firstName, '');
    });

    for (const [label, displayName] of [['absent', undefined], ['null', null], ['empty', ''], ['only spaces', '   ']]) {
      test(`a new user with a displayName that is ${label} gets no flag`, async (t) => {
        const { baseUrl, dbFile } = await startOn(t, firebaseEnv);
        assert.equal((await signIn(baseUrl, { displayName })).status, 200);
        const stored = readStoredUser(dbFile, 'fb-user');
        assert.equal(stored.firstName, '');
        assert.equal(stored.nameSetByUser, undefined);
      });
    }

    test('the dev fallback applies the body rules to a new user', async (t) => {
      const { baseUrl, dbFile } = await startOn(t);
      await devSignIn(baseUrl, { displayName: 'Ana' });
      assert.equal(readStoredUser(dbFile, 'dev-user').nameSetByUser, true);
      await devSignIn(baseUrl, { email: 'aron@example.test', displayName: 'Aron' }, 'prefix-user');
      assert.equal(readStoredUser(dbFile, 'prefix-user').firstName, '');
    });

    test('a legacy user with a prefix name is not changed by a sign-in', async (t) => {
      const legacy = { ...forgedUser, email: 'aron@example.test', firstName: 'aron' };
      const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [legacy] } });
      await signIn(baseUrl, { email: 'aron@example.test', name: 'Aron Pop', displayName: 'Aron Pop' });
      const stored = readStoredUser(dbFile, 'fb-user');
      assert.equal(stored.firstName, 'aron');
      assert.equal(stored.nameSetByUser, undefined);
      assert.equal('firstName' in await readPublic(baseUrl), false);
    });

    test('an existing user with an empty name is not refilled', async (t) => {
      const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [emptyName] } });
      await signIn(baseUrl, { email: 'aron@example.test', name: 'Ana Pop', displayName: 'Ana Pop' });
      const stored = readStoredUser(dbFile, 'fb-user');
      assert.equal(stored.firstName, '');
      assert.equal(stored.nameSetByUser, undefined);
    });

    test('after an email change a cleared name stays empty, a provider name is not applied, and no prefix is kept', async (t) => {
      const legacy = { ...forgedUser, email: 'oldprefix@example.test', firstName: 'oldprefix' };
      const { baseUrl, dbFile } = await startOn(t, firebaseEnv, { dbFixture: { users: [legacy] } });
      for (const displayName of ['OldPrefix', 'Ana Pop']) {
        await signIn(baseUrl, { email: 'new.address@example.test', name: displayName, displayName });
        const stored = readStoredUser(dbFile, 'fb-user');
        assert.equal(stored.email, 'new.address@example.test');
        assert.equal(stored.firstName, '');
        assert.equal(stored.nameSetByUser, undefined);
        assert.equal('retiredEmailPrefixes' in stored, false);
        assert.ok(!JSON.stringify(stored).toLowerCase().includes('oldprefix'));
      }
    });

    test('a name the owner cleared stays empty after the next sign-in', async (t) => {
      const { baseUrl, dbFile } = await startOn(t, firebaseEnv);
      await signIn(baseUrl, { name: 'Ana Pop', displayName: 'Ana Pop' });
      assert.equal((await putOwner(baseUrl, { firstName: '' })).status, 200);
      await signIn(baseUrl, { name: 'Ana Pop', displayName: 'Ana Pop' });
      assert.equal(readStoredUser(dbFile, 'fb-user').firstName, '');
    });

    test('every owner response has exactly the allowlisted fields', async (t) => {
      const user = { ...forgedUser, emailVerified: true, nameSetByUser: true, internalNote: 'private' };
      const { baseUrl } = await startOn(t, firebaseEnv, { dbFixture: { users: [user] } });
      const fields = ['ageConfirmed', 'avatar', 'bio', 'city', 'email', 'emailVerified', 'firstName', 'id', 'lastName', 'needsName', 'privacyNoticeVersion'];

      // Only the profile read adds the count, which is not a field of the user record.
      assert.deepEqual(Object.keys(await getUser(baseUrl, 'fb-user')).filter((key) => key !== 'partnerCount').sort(), fields);
      assert.deepEqual(Object.keys((await putOwner(baseUrl, { bio: 'Updated' })).body).sort(), fields);
      const upload = await postJson(
        `${baseUrl}/api/users/fb-user/avatar`,
        { imageData: SMALL_JPEG_BASE64 },
        { Authorization: `Bearer ${ownerToken('fb-user')}` }
      );
      assert.equal(upload.status, 200);
      assert.deepEqual(Object.keys(upload.body).sort(), fields);
    });
  });

  test('the stub refuses to load outside NODE_ENV=test', async () => {
    const { stderr } = await assertRefusesToStart({ ...firebaseEnv, NODE_ENV: 'development' });
    assert.match(stderr, /firebase-auth stub is test-only/);
  });

  test('a UID mismatch keeps its 401 and registers nobody', async (t) => {
    const { baseUrl, dbFile } = await startOn(t, firebaseEnv);
    const { status, body } = await postAuth(baseUrl, {
      idToken: stubToken({ uid: 'fb-user', email: 'token@example.test' }),
      uid: 'someone-else',
    });
    assert.equal(status, 401);
    assert.equal(body.token, undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(dbFile, 'utf8')).users, []);
  });

  test('a token that fails verification gets 401', async (t) => {
    const { baseUrl } = await startOn(t, firebaseEnv);
    const { status, body } = await postAuth(baseUrl, { idToken: 'not-a-stub-token', uid: 'fb-user' });
    assert.equal(status, 401);
    assert.equal(body.token, undefined);
  });

  test('a non-string idToken returns 400 before verification', async (t) => {
    const { baseUrl } = await startOn(t, firebaseEnv);
    const { status } = await postAuth(baseUrl, { idToken: 123, uid: 'fb-user' });
    assert.equal(status, 400);
  });
});
