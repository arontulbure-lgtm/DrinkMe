import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { REAL_DB_FILE, startServer } from './helpers/harness.js';

const REQUEST_TIMEOUT_MS = 60_000;
const NO_BUFFERING_TIMEOUT_MS = 5_000;
const FAULT_PRELOAD = new URL('./helpers/db-fault-preload.js', import.meta.url).href;

const MIB = 1024 * 1024;
const AVATAR_MAX_BYTES = 2 * MIB;
const POST_IMAGE_MAX_BYTES = 7 * MIB;
const JSON_LIMIT_BYTES = 10 * MIB; // the body limit on POST /api/drinks
const AVATAR_JSON_LIMIT_BYTES = 3 * MIB;
const DEFAULT_BODY_LIMIT_BYTES = 100 * 1024;
const VALIDATOR_TOO_LARGE = 'Image too large';
const PARSER_TOO_LARGE = 'Payload too large';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

const ftypBox = (brand) => Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from(`ftyp${brand}`),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('mif1heic'),
]);
const HEIC = ftypBox('heic');

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
const HTML = Buffer.from('<!doctype html><html><script>alert(1)</script></html>');
const TEXT = Buffer.from('just some text, not an image');
const AVIF = ftypBox('avif');

const NOT_IMAGES = [['SVG', SVG], ['GIF', GIF], ['HTML', HTML], ['text', TEXT], ['AVIF', AVIF]];
const ALLOWED_ON_BOTH = [['jpeg', JPEG], ['png', PNG], ['webp', WEBP]];

const TRUNCATED = [
  ['JPEG, 2 bytes', JPEG.subarray(0, 2)],
  ['JPEG, third byte is not FF', Buffer.from([0xff, 0xd8, 0x00, 0xe0, 0x00, 0x10])],
  ['PNG, 7 bytes', PNG.subarray(0, 7)],
  ['PNG, wrong 8th byte', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00])],
  ['RIFF with no WEBP tag', Buffer.from('RIFF')],
  ['WebP, 11 bytes', WEBP.subarray(0, 11)],
  ['RIFF that is not WebP', Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WAVE')])],
  ['ftyp with no brand', HEIC.subarray(0, 8)],
  ['ftyp cut inside the brand', HEIC.subarray(0, 10)],
  ['ftyp shorter than its declared box', HEIC.subarray(0, 12)],
];

const toBase64 = (bytes) => bytes.toString('base64');
const dataUrl = (type, bytes) => `data:image/${type};base64,${toBase64(bytes)}`;
const padTo = (signature, size) => Buffer.concat([signature, Buffer.alloc(size - signature.length, 0x41)]);

const postBody = (imageData) => ({ name: 'Image test', description: 'Synthetic', rating: 4, isAlcoholic: false, imageData });

const send = async (baseUrl, method, path, token, init = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    ...init,
    headers: { ...init.headers, ...(token && { Authorization: `Bearer ${token}` }) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : undefined };
};

const sendJson = (baseUrl, method, path, token, body) => send(baseUrl, method, path, token, {
  headers: { 'Content-Type': 'application/json' },
  ...(body !== undefined && { body: JSON.stringify(body) }),
});

const sendAvatarFile = (baseUrl, userId, token, bytes, { mime = 'image/jpeg', field = 'avatar' } = {}) => {
  const form = new FormData();
  form.append(field, new Blob([bytes], { type: mime }), 'avatar.jpg');
  return send(baseUrl, 'POST', `/api/users/${userId}/avatar`, token, { body: form });
};

const signIn = async (baseUrl, uid) => {
  const { status, body } = await sendJson(baseUrl, 'POST', '/api/auth/mobile', undefined, {
    idToken: 'dev-fallback-token',
    uid,
  });
  assert.equal(status, 200);
  // Every route but the first-run ones needs the 18+ confirmation.
  const age = await sendJson(baseUrl, 'POST', `/api/users/${uid}/acknowledgements`, body.token, { type: 'age', confirmed: true });
  assert.equal(age.status, 200);
  return body.token;
};

const readDb = (dbFile) => JSON.parse(fs.readFileSync(dbFile, 'utf8'));
// Responses carry /media URLs, so what was accepted is checked on the stored record.
const storedPostImage = (server, id) => readDb(server.dbFile).drinks.find((drink) => drink.id === id).imageUrl;
const storedAvatar = (server, id) => readDb(server.dbFile).users.find((u) => u.id === id).avatar;

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

// Separate servers keep each group under the limits of 100 requests per IP and 30 mutations per
// minute. Each test signs in its own user, because the second limit is per user.
describe('post images', () => {
  let server;
  let userCount = 0;

  const newUser = () => signIn(server.baseUrl, `post-user-${++userCount}`);
  const createPost = (token, imageData) => sendJson(server.baseUrl, 'POST', '/api/drinks', token, postBody(imageData));

  before(async () => {
    server = await startServer();
  });

  after(() => server?.stop());

  test('each allowed type is accepted as raw base64 and stored with its detected type', async () => {
    const token = await newUser();
    for (const [type, bytes] of [...ALLOWED_ON_BOTH, ['heic', HEIC]]) {
      const { status, body } = await createPost(token, toBase64(bytes));
      assert.equal(status, 201, type);
      assert.equal(storedPostImage(server, body.id), dataUrl(type, bytes));
    }
    const stored = readDb(server.dbFile).drinks[0].imageUrl;
    assert.equal(stored, dataUrl('heic', HEIC));
  });

  test('each allowed type is accepted with a matching prefix', async () => {
    const token = await newUser();
    for (const [type, bytes] of [...ALLOWED_ON_BOTH, ['heic', HEIC]]) {
      const { status, body } = await createPost(token, dataUrl(type, bytes));
      assert.equal(status, 201, type);
      assert.equal(storedPostImage(server, body.id), dataUrl(type, bytes));
    }
  });

  test('every HEIC-family brand is accepted and stored as heic', async () => {
    const token = await newUser();
    for (const brand of ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']) {
      const bytes = ftypBox(brand);
      const { status, body } = await createPost(token, toBase64(bytes));
      assert.equal(status, 201, brand);
      assert.equal(storedPostImage(server, body.id), dataUrl('heic', bytes));
    }
  });

  test('raw base64 PNG is stored as png, not jpeg', async () => {
    const token = await newUser();
    const { body } = await createPost(token, toBase64(PNG));
    assert.equal(body.imageUrl, `/media/drinks/${body.id}`);
    const stored = readDb(server.dbFile).drinks.find((drink) => drink.id === body.id);
    assert.equal(stored.imageUrl, dataUrl('png', PNG));
  });

  test('data:image/jpg stays accepted and is normalized to jpeg', async () => {
    const token = await newUser();
    const { status, body } = await createPost(token, dataUrl('jpg', JPEG));
    assert.equal(status, 201);
    assert.equal(storedPostImage(server, body.id), dataUrl('jpeg', JPEG));
  });

  test('a prefix that disagrees with allowed bytes is replaced by the detected type', async () => {
    const token = await newUser();
    for (const [declared, type, bytes] of [
      ['png', 'jpeg', JPEG],
      ['jpeg', 'png', PNG],
      ['svg+xml', 'png', PNG],
      ['gif', 'webp', WEBP],
    ]) {
      const { status, body } = await createPost(token, dataUrl(declared, bytes));
      assert.equal(status, 201, declared);
      assert.equal(storedPostImage(server, body.id), dataUrl(type, bytes));
    }
  });

  test('a prefix claiming an allowed type does not save disallowed bytes', async () => {
    const token = await newUser();
    for (const [label, bytes] of NOT_IMAGES) {
      assert.equal((await createPost(token, dataUrl('png', bytes))).status, 400, label);
    }
  });

  test('a non-image or non-base64 data URL is rejected, even with image bytes', async () => {
    const token = await newUser();
    for (const imageData of [
      `data:text/html;base64,${toBase64(JPEG)}`,
      `data:application/octet-stream;base64,${toBase64(JPEG)}`,
      `data:image/png,${toBase64(PNG)}`,
      `data:image/png;charset=utf-8;base64,${toBase64(PNG)}`,
      `DATA:IMAGE/PNG;BASE64,${toBase64(PNG)}`,
      `data:image/svg+xml,${encodeURIComponent(SVG.toString())}`,
    ]) {
      assert.equal((await createPost(token, imageData)).status, 400, imageData.slice(0, 30));
    }
  });

  test('SVG, GIF, HTML, text and AVIF are rejected as raw base64', async () => {
    const token = await newUser();
    for (const [label, bytes] of NOT_IMAGES) {
      assert.equal((await createPost(token, toBase64(bytes))).status, 400, label);
    }
  });

  test('truncated signatures are rejected', async () => {
    const token = await newUser();
    for (const [label, bytes] of TRUNCATED) {
      assert.equal((await createPost(token, toBase64(bytes))).status, 400, label);
    }
  });

  test('invalid base64 is rejected', async () => {
    const token = await newUser();
    const valid = toBase64(JPEG);
    for (const [label, imageData] of [
      ['too short', 'abc'],
      ['the old fixture', 'AAAA'],
      ['symbols', 'not base64!!'],
      ['URL-safe alphabet', '_9j_4AAQ'],
      ['missing padding', toBase64(Buffer.concat([JPEG, Buffer.from([1])])).replace(/=+$/, '')],
      ['too much padding', `${valid.slice(0, 12)}====`],
      ['padding in the middle', `/9j/4A==${valid}`],
      ['only padding', '===='],
      ['a space inside', `${valid.slice(0, 8)} ${valid.slice(8)}`],
      ['a trailing newline', `${valid}\n`],
      ['a line break inside', `${valid.slice(0, 8)}\r\n${valid.slice(8)}`],
      ['leading space', ` ${valid}`],
      ['empty after the prefix', 'data:image/png;base64,'],
      ['invalid after the prefix', 'data:image/png;base64,@@@@'],
    ]) {
      assert.equal((await createPost(token, imageData)).status, 400, label);
    }
  });

  test('empty, missing and non-string imageData are rejected', async () => {
    const token = await newUser();
    for (const imageData of ['', undefined, null, 123, true, {}, [toBase64(JPEG)], { 0: toBase64(JPEG) }]) {
      assert.equal((await createPost(token, imageData)).status, 400, JSON.stringify(imageData));
    }
  });

  test('a rejected image stores nothing and uses no drink id', async () => {
    const token = await newUser();
    const dbBefore = readDb(server.dbFile);
    assert.equal((await createPost(token, toBase64(SVG))).status, 400);
    const dbAfter = readDb(server.dbFile);
    assert.equal(dbAfter.drinks.length, dbBefore.drinks.length);
    assert.equal(dbAfter.nextDrinkId, dbBefore.nextDrinkId);
  });
});

describe('avatar images, JSON path', () => {
  let server;
  let userCount = 0;

  const newUser = async () => {
    const id = `json-avatar-user-${++userCount}`;
    return { id, token: await signIn(server.baseUrl, id) };
  };
  const setAvatar = ({ id, token }, imageData) =>
    sendJson(server.baseUrl, 'POST', `/api/users/${id}/avatar`, token, { imageData });

  before(async () => {
    server = await startServer();
  });

  after(() => server?.stop());

  test('JPEG, PNG and WebP are accepted, raw and prefixed, and stored with the detected type', async () => {
    const user = await newUser();
    for (const [type, bytes] of ALLOWED_ON_BOTH) {
      for (const imageData of [toBase64(bytes), dataUrl(type, bytes)]) {
        const { status, body } = await setAvatar(user, imageData);
        assert.equal(status, 200, type);
        assert.equal(storedAvatar(server, user.id), dataUrl(type, bytes));
        assert.match(body.avatar, /^\/media\/avatars\//);
      }
    }
    const stored = readDb(server.dbFile).users.find((u) => u.id === user.id);
    assert.equal(stored.avatar, dataUrl('webp', WEBP));
  });

  test('HEIC is rejected, raw and with any prefix', async () => {
    const user = await newUser();
    for (const imageData of [toBase64(HEIC), dataUrl('heic', HEIC), dataUrl('jpeg', HEIC)]) {
      assert.equal((await setAvatar(user, imageData)).status, 400);
    }
  });

  test('a spoofed prefix is replaced by the detected type', async () => {
    const user = await newUser();
    const { status } = await setAvatar(user, dataUrl('svg+xml', PNG));
    assert.equal(status, 200);
    assert.equal(storedAvatar(server, user.id), dataUrl('png', PNG));
  });

  test('other formats, truncated signatures and bad input are rejected, and the avatar stays', async () => {
    const user = await newUser();
    assert.equal((await setAvatar(user, toBase64(PNG))).status, 200);
    const rejected = [
      ...NOT_IMAGES.map(([, bytes]) => dataUrl('jpeg', bytes)),
      ...TRUNCATED.map(([, bytes]) => toBase64(bytes)),
      'abc', '', 123, {}, null,
    ];
    for (const imageData of rejected) {
      assert.equal((await setAvatar(user, imageData)).status, 400, String(imageData).slice(0, 40));
    }
    assert.equal(storedAvatar(server, user.id), dataUrl('png', PNG));
  });
});

describe('avatar images, multipart path', () => {
  let server;
  let userCount = 0;

  const newUser = async () => {
    const id = `file-avatar-user-${++userCount}`;
    return { id, token: await signIn(server.baseUrl, id) };
  };

  before(async () => {
    server = await startServer();
  });

  after(() => server?.stop());

  test('JPEG, PNG and WebP are accepted and stored with the detected type', async () => {
    const { id, token } = await newUser();
    for (const [type, bytes] of ALLOWED_ON_BOTH) {
      const { status } = await sendAvatarFile(server.baseUrl, id, token, bytes);
      assert.equal(status, 200, type);
      assert.equal(storedAvatar(server, id), dataUrl(type, bytes));
    }
  });

  test('a spoofed client MIME type never decides the stored type', async () => {
    const { id, token } = await newUser();
    for (const mime of ['image/jpeg', 'image/svg+xml', 'text/html', 'application/octet-stream']) {
      const { status } = await sendAvatarFile(server.baseUrl, id, token, PNG, { mime });
      assert.equal(status, 200, mime);
      assert.equal(storedAvatar(server, id), dataUrl('png', PNG), mime);
    }
  });

  test('SVG, GIF, HTML, text, AVIF and HEIC are rejected, whatever MIME they claim', async () => {
    const { id, token } = await newUser();
    for (const [label, bytes] of [...NOT_IMAGES, ['HEIC', HEIC]]) {
      for (const mime of ['image/jpeg', 'image/png']) {
        const { status } = await sendAvatarFile(server.baseUrl, id, token, bytes, { mime });
        assert.equal(status, 400, `${label} as ${mime}`);
      }
    }
    const { body } = await send(server.baseUrl, 'GET', `/api/users/${id}`, token);
    assert.equal(body.avatar, null);
  });

  test('truncated signatures and an empty file are rejected', async () => {
    const { id, token } = await newUser();
    for (const [label, bytes] of [...TRUNCATED, ['empty', Buffer.alloc(0)]]) {
      assert.equal((await sendAvatarFile(server.baseUrl, id, token, bytes)).status, 400, label);
    }
  });

  test('other multer errors become 400, with no multer detail in the response', async () => {
    const { id, token } = await newUser();
    const wrongField = await sendAvatarFile(server.baseUrl, id, token, JPEG, { field: 'other' });
    assert.equal(wrongField.status, 400);
    assert.ok(!wrongField.text.includes('other'));

    const twoFiles = new FormData();
    twoFiles.append('avatar', new Blob([JPEG]), 'a.jpg');
    twoFiles.append('avatar', new Blob([JPEG]), 'b.jpg');
    const tooMany = await send(server.baseUrl, 'POST', `/api/users/${id}/avatar`, token, { body: twoFiles });
    assert.equal(tooMany.status, 400);
  });

  test('more than one text field gets 400, even when the avatar itself is valid', async () => {
    const { id, token } = await newUser();
    const withField = new FormData();
    withField.append('imageData', toBase64(PNG));
    withField.append('extra', 'value');
    const twoFields = await send(server.baseUrl, 'POST', `/api/users/${id}/avatar`, token, { body: withField });
    assert.equal(twoFields.status, 400);
    const { body } = await send(server.baseUrl, 'GET', `/api/users/${id}`, token);
    assert.equal(body.avatar, null);
  });

  test('a multipart request with no file gets 400', async () => {
    const { id, token } = await newUser();
    const form = new FormData();
    form.append('unrelated', 'value');
    assert.equal((await send(server.baseUrl, 'POST', `/api/users/${id}/avatar`, token, { body: form })).status, 400);
  });

  test('a multipart imageData field goes through the same validation', async () => {
    const { id, token } = await newUser();
    const good = new FormData();
    good.append('imageData', toBase64(PNG));
    const accepted = await send(server.baseUrl, 'POST', `/api/users/${id}/avatar`, token, { body: good });
    assert.equal(accepted.status, 200);
    assert.equal(storedAvatar(server, id), dataUrl('png', PNG));

    const bad = new FormData();
    bad.append('imageData', toBase64(HEIC));
    assert.equal((await send(server.baseUrl, 'POST', `/api/users/${id}/avatar`, token, { body: bad })).status, 400);
  });
});

describe('size caps', () => {
  let server;
  let userCount = 0;

  const newUser = async () => {
    const id = `cap-user-${++userCount}`;
    return { id, token: await signIn(server.baseUrl, id) };
  };
  const drinkCount = () => readDb(server.dbFile).drinks.length;

  before(async () => {
    server = await startServer();
  });

  after(() => server?.stop());

  test('a JSON avatar of exactly 2 MB is accepted', async () => {
    const { id, token } = await newUser();
    const bytes = padTo(PNG, AVATAR_MAX_BYTES);
    const { status } = await sendJson(server.baseUrl, 'POST', `/api/users/${id}/avatar`, token, { imageData: toBase64(bytes) });
    assert.equal(status, 200);
    assert.equal(Buffer.from(storedAvatar(server, id).split(',')[1], 'base64').length, AVATAR_MAX_BYTES);
  });

  test('a JSON avatar one byte over 2 MB gets 413 and is not stored', async () => {
    const { id, token } = await newUser();
    const bytes = padTo(PNG, AVATAR_MAX_BYTES + 1);
    const { status, body } = await sendJson(server.baseUrl, 'POST', `/api/users/${id}/avatar`, token, { imageData: dataUrl('png', bytes) });
    assert.equal(status, 413);
    assert.equal(typeof body.error, 'string');
    assert.equal(readDb(server.dbFile).users.find((u) => u.id === id).avatar, null);
  });

  test('a multipart avatar of exactly 2 MB is accepted', async () => {
    const { id, token } = await newUser();
    const { status } = await sendAvatarFile(server.baseUrl, id, token, padTo(JPEG, AVATAR_MAX_BYTES));
    assert.equal(status, 200);
    assert.equal(Buffer.from(storedAvatar(server, id).split(',')[1], 'base64').length, AVATAR_MAX_BYTES);
  });

  test('a multipart avatar one byte over 2 MB gets 413, not 500', async () => {
    const { id, token } = await newUser();
    const { status, body } = await sendAvatarFile(server.baseUrl, id, token, padTo(JPEG, AVATAR_MAX_BYTES + 1));
    assert.equal(status, 413);
    assert.equal(typeof body.error, 'string');
    assert.equal(readDb(server.dbFile).users.find((u) => u.id === id).avatar, null);
  });

  test('a post image of exactly 7 MB is accepted', async () => {
    const { token } = await newUser();
    const bytes = padTo(JPEG, POST_IMAGE_MAX_BYTES);
    const { status, body } = await sendJson(server.baseUrl, 'POST', '/api/drinks', token, postBody(toBase64(bytes)));
    assert.equal(status, 201);
    assert.equal(Buffer.from(storedPostImage(server, body.id).split(',')[1], 'base64').length, POST_IMAGE_MAX_BYTES);
  });

  test('a post image one byte over 7 MB is refused by the validator and not stored', async () => {
    const { token } = await newUser();
    const count = drinkCount();
    const bytes = padTo(JPEG, POST_IMAGE_MAX_BYTES + 1);
    const { status, body } = await sendJson(server.baseUrl, 'POST', '/api/drinks', token, postBody(toBase64(bytes)));
    assert.equal(status, 413);
    assert.equal(body.error, VALIDATOR_TOO_LARGE);
    assert.equal(drinkCount(), count);
  });

  test('the largest body that fits the JSON limit reaches the validator, and one over does not', async () => {
    const { token } = await newUser();
    const count = drinkCount();
    const wrapperBytes = JSON.stringify(postBody('')).length;
    const maxBytes = Math.floor((JSON_LIMIT_BYTES - wrapperBytes) / 4) * 3;

    const fits = await sendJson(server.baseUrl, 'POST', '/api/drinks', token, postBody(toBase64(padTo(JPEG, maxBytes))));
    assert.equal(fits.status, 413);
    assert.equal(fits.body.error, VALIDATOR_TOO_LARGE);

    const over = await sendJson(server.baseUrl, 'POST', '/api/drinks', token, postBody(toBase64(padTo(JPEG, maxBytes + 3))));
    assert.equal(over.status, 413);
    assert.equal(over.body.error, PARSER_TOO_LARGE);
    assert.equal(drinkCount(), count);
  });

  test('the JSON limit enforces post images of 8 MB and just over, before the validator', async () => {
    const { token } = await newUser();
    const count = drinkCount();
    for (const size of [8 * MIB, 8 * MIB + 1]) {
      const { status, body } = await sendJson(server.baseUrl, 'POST', '/api/drinks', token, postBody(toBase64(padTo(JPEG, size))));
      assert.equal(status, 413, String(size));
      assert.equal(body.error, PARSER_TOO_LARGE);
    }
    assert.equal(drinkCount(), count);
  });

  test('a JSON avatar body over its own limit gets 413 from the parser', async () => {
    const { id, token } = await newUser();
    const { status, body } = await sendJson(server.baseUrl, 'POST', `/api/users/${id}/avatar`, token, {
      imageData: toBase64(padTo(PNG, AVATAR_JSON_LIMIT_BYTES)),
    });
    assert.equal(status, 413);
    assert.equal(body.error, PARSER_TOO_LARGE);
  });

  test('a multipart imageData field is capped by fieldSize, and 2 MB of image still fits', async () => {
    const { id, token } = await newUser();
    const sendField = (bytes) => {
      const form = new FormData();
      form.append('imageData', toBase64(bytes));
      return send(server.baseUrl, 'POST', `/api/users/${id}/avatar`, token, { body: form });
    };
    assert.equal((await sendField(padTo(PNG, AVATAR_MAX_BYTES))).status, 200);
    assert.equal((await sendField(padTo(PNG, AVATAR_MAX_BYTES + 3))).status, 400);
  });
});

describe('avatar ownership and authentication', () => {
  let server;
  let ownerToken;
  let otherToken;
  const OWNER_ID = 'avatar-owner';

  const avatarPath = `/api/users/${OWNER_ID}/avatar`;
  const ownerAvatar = async () => (await send(server.baseUrl, 'GET', `/api/users/${OWNER_ID}`, ownerToken)).body.avatar;

  // Sends part of a body and never finishes it, so only a response that does not wait for the
  // body can arrive.
  const statusOfUnfinishedUpload = (token, { path = avatarPath, json = false } = {}) => new Promise((resolve, reject) => {
    const boundary = 'unfinishedboundary';
    const { hostname, port } = new URL(server.baseUrl);
    const req = http.request({
      hostname,
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': json ? 'application/json' : `multipart/form-data; boundary=${boundary}`,
        ...(token && { Authorization: `Bearer ${token}` }),
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('The server waited for the upload body'));
    }, NO_BUFFERING_TIMEOUT_MS);
    req.on('response', (res) => {
      clearTimeout(timer);
      res.resume();
      req.destroy();
      resolve(res.statusCode);
    });
    req.on('error', () => {}); // destroying the request is expected here
    if (json) {
      req.write('{"imageData":"');
      return;
    }
    req.write(`--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="a.jpg"\r\n\r\n`);
    req.write(JPEG);
  });

  before(async () => {
    server = await startServer();
    ownerToken = await signIn(server.baseUrl, OWNER_ID);
    otherToken = await signIn(server.baseUrl, 'avatar-other');
  });

  after(() => server?.stop());

  test('a non-owner gets 403 on both paths, and the avatar stays', async () => {
    const json = await sendJson(server.baseUrl, 'POST', avatarPath, otherToken, { imageData: toBase64(JPEG) });
    assert.equal(json.status, 403);
    assert.equal((await sendAvatarFile(server.baseUrl, OWNER_ID, otherToken, JPEG)).status, 403);
    assert.equal(await ownerAvatar(), null);
  });

  test('a non-owner gets 403, not 413, for an oversized upload', async () => {
    const { status } = await sendAvatarFile(server.baseUrl, OWNER_ID, otherToken, padTo(JPEG, AVATAR_MAX_BYTES + 1));
    assert.equal(status, 403);
    assert.equal(await ownerAvatar(), null);
  });

  test('a non-owner gets 403 before the upload body has finished', async () => {
    assert.equal(await statusOfUnfinishedUpload(otherToken), 403);
  });

  test('JSON image bodies are not parsed before auth and ownership', async () => {
    assert.equal(await statusOfUnfinishedUpload(otherToken, { json: true }), 403);
    assert.equal(await statusOfUnfinishedUpload(undefined, { json: true }), 401);
    assert.equal(await statusOfUnfinishedUpload(undefined, { path: '/api/drinks', json: true }), 401);
  });

  test('logged out gets 401 on both paths and on posts', async () => {
    assert.equal((await sendJson(server.baseUrl, 'POST', avatarPath, undefined, { imageData: toBase64(JPEG) })).status, 401);
    assert.equal((await sendAvatarFile(server.baseUrl, OWNER_ID, undefined, JPEG)).status, 401);
    assert.equal((await sendAvatarFile(server.baseUrl, OWNER_ID, 'not-a-token', JPEG)).status, 401);
    assert.equal((await sendJson(server.baseUrl, 'POST', '/api/drinks', undefined, postBody(toBase64(JPEG)))).status, 401);
    assert.equal(await statusOfUnfinishedUpload(undefined), 401);
    assert.equal(await ownerAvatar(), null);
  });

  test('the owner can still upload', async () => {
    assert.equal((await sendAvatarFile(server.baseUrl, OWNER_ID, ownerToken, JPEG)).status, 200);
    assert.match(await ownerAvatar(), /^\/media\/avatars\//);
    assert.equal(storedAvatar(server, OWNER_ID), dataUrl('jpeg', JPEG));
  });
});

describe('failed saves', () => {
  let server;
  let tokenA;
  let tokenB;
  let drinkId;
  const USER_A = 'save-user-a';
  const USER_B = 'save-user-b';
  const LOG_SENTINEL = Buffer.from('LOGSENTINELLOGSENTINEL');

  const markerFile = () => `${server.dbFile}.fail-saves`; // must match the preload
  const failSaves = () => fs.writeFileSync(markerFile(), '');
  const allowSaves = () => fs.rmSync(markerFile(), { force: true });
  const call = (method, path, token, body) => sendJson(server.baseUrl, method, path, token, body);

  const assertSaveFailed = ({ status, body }, label) => {
    assert.equal(status, 503, label);
    assert.equal(typeof body.error, 'string', label);
    assert.equal(Object.keys(body).length, 1, label);
  };

  before(async () => {
    server = await startServer({
      DB_FAULT: 'save',
      NODE_OPTIONS: `--import=${FAULT_PRELOAD}`,
    });
    tokenA = await signIn(server.baseUrl, USER_A);
    tokenB = await signIn(server.baseUrl, USER_B);
    const created = await call('POST', '/api/drinks', tokenA, postBody(toBase64(JPEG)));
    assert.equal(created.status, 201);
    drinkId = created.body.id;
    assert.equal((await call('POST', '/api/smart-bar', tokenA, { name: 'Gin', quantity: '1' })).status, 201);
  });

  after(async () => {
    allowSaves();
    await server?.stop();
  });

  test('every route that saves returns 503 instead of success, and the file is not replaced', async () => {
    const dbBytes = fs.readFileSync(server.dbFile);
    const avatarForm = new FormData();
    avatarForm.append('avatar', new Blob([PNG]), 'a.jpg');
    failSaves();
    try {
      const routes = [
        ['sign-in, existing user', () => call('POST', '/api/auth/mobile', undefined, { idToken: 'x', uid: USER_A })],
        ['sign-in, new user', () => call('POST', '/api/auth/mobile', undefined, { idToken: 'x', uid: 'save-user-new' })],
        ['profile update', () => call('PUT', `/api/users/${USER_A}`, tokenA, { bio: 'Unsaved' })],
        ['avatar, JSON', () => call('POST', `/api/users/${USER_A}/avatar`, tokenA, { imageData: toBase64(PNG) })],
        ['avatar, multipart', () => send(server.baseUrl, 'POST', `/api/users/${USER_A}/avatar`, tokenA, { body: avatarForm })],
        ['partner', () => call('POST', `/api/drink-partners/${USER_B}`, tokenA)],
        ['post', () => call('POST', '/api/drinks', tokenA, postBody(toBase64(JPEG)))],
        ['comment', () => call('POST', `/api/drinks/${drinkId}/comments`, tokenB, { content: 'Unsaved' })],
        ['cheers', () => call('POST', `/api/drinks/${drinkId}/like`, tokenB)],
        ['save', () => call('POST', `/api/drinks/${drinkId}/save`, tokenB)],
        ['notifications read', () => call('POST', '/api/notifications/read', tokenA)],
        ['smart bar add', () => call('POST', '/api/smart-bar', tokenA, { name: 'Rum', quantity: '1' })],
        ['smart bar delete', () => call('DELETE', '/api/smart-bar/1', tokenA)],
      ];
      for (const [label, run] of routes) {
        assertSaveFailed(await run(), label);
      }
      assert.deepEqual(fs.readFileSync(server.dbFile), dbBytes);
      const names = fs.readdirSync(path.dirname(server.dbFile));
      assert.deepEqual(names.filter((name) => name.includes('.tmp-')), []);
    } finally {
      allowSaves();
    }
  });

  const whileSavesFail = async (run) => {
    failSaves();
    try {
      return await run();
    } finally {
      allowSaves();
    }
  };

  test('a post that failed to save never appears, and a retry creates exactly one', async () => {
    const body = { ...postBody(toBase64(JPEG)), name: 'Rollback post' };
    const nextId = readDb(server.dbFile).nextDrinkId;
    assertSaveFailed(await whileSavesFail(() => call('POST', '/api/drinks', tokenB, body)), 'post');
    const namedRollback = (drinks) => drinks.filter((drink) => drink.name === 'Rollback post');
    assert.deepEqual(namedRollback((await call('GET', '/api/drinks', tokenA)).body.items), []);

    const retry = await call('POST', '/api/drinks', tokenB, body);
    assert.equal(retry.status, 201);
    assert.equal(retry.body.id, nextId);
    assert.equal(namedRollback((await call('GET', '/api/drinks', tokenA)).body.items).length, 1);
    assert.equal(namedRollback(readDb(server.dbFile).drinks).length, 1);
  });

  test('a comment that failed to save leaves no comment or notification, and a retry creates one of each', async () => {
    const path = `/api/drinks/${drinkId}/comments`;
    const comments = async () => (await call('GET', path, tokenA)).body.items.filter((c) => c.content === 'Rollback comment');
    const notifications = async () => (await call('GET', '/api/notifications', tokenA)).body.notifications
      .filter((n) => n.type === 'comment');
    const notificationsBefore = (await notifications()).length;

    assertSaveFailed(await whileSavesFail(() => call('POST', path, tokenB, { content: 'Rollback comment' })), 'comment');
    assert.deepEqual(await comments(), []);
    assert.equal((await notifications()).length, notificationsBefore);

    assert.equal((await call('POST', path, tokenB, { content: 'Rollback comment' })).status, 201);
    assert.equal((await comments()).length, 1);
    assert.equal((await notifications()).length, notificationsBefore + 1);
    const ids = (await call('GET', '/api/notifications', tokenA)).body.notifications.map((n) => n.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('a smart bar item that failed to save never appears, and a retry creates exactly one', async () => {
    const item = { name: 'Rollback item', quantity: '1' };
    const items = async () => (await call('GET', '/api/smart-bar', tokenB)).body.filter((i) => i.name === item.name);
    assertSaveFailed(await whileSavesFail(() => call('POST', '/api/smart-bar', tokenB, item)), 'smart bar');
    assert.deepEqual(await items(), []);

    assert.equal((await call('POST', '/api/smart-bar', tokenB, item)).status, 201);
    assert.equal((await items()).length, 1);
  });

  test('an avatar that failed to save restores the previous one', async () => {
    const path = `/api/users/${USER_B}/avatar`;
    const saved = await call('POST', path, tokenB, { imageData: toBase64(JPEG) });
    assert.equal(saved.status, 200);
    // The avatar of a new account is not served until this.
    assert.equal((await call('POST', `/api/users/${USER_B}/acknowledgements`, tokenB, { type: 'privacy', version: 1 })).status, 200);
    assertSaveFailed(await whileSavesFail(() => call('POST', path, tokenB, { imageData: toBase64(PNG) })), 'avatar');
    // The memory state, not the file: the URL and the bytes both went back to the saved avatar.
    assert.equal((await call('GET', `/api/users/${USER_B}`, tokenB)).body.avatar, saved.body.avatar);
    const image = await fetch(`${server.baseUrl}${saved.body.avatar}`, { headers: { Authorization: `Bearer ${tokenA}` } });
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), JPEG);
  });

  test('a failed sign-in returns no token, and a retry works once saves recover', async () => {
    failSaves();
    let failed;
    try {
      failed = await call('POST', '/api/auth/mobile', undefined, { idToken: 'x', uid: 'save-user-retry' });
    } finally {
      allowSaves();
    }
    assert.equal(failed.status, 503);
    assert.ok(!failed.text.includes('token'));

    const token = await signIn(server.baseUrl, 'save-user-retry');
    assert.equal(typeof token, 'string');
    assert.ok(readDb(server.dbFile).users.some((user) => user.id === 'save-user-retry'));
  });

  test('a request rejected before saving keeps its own status while saves are failing', async () => {
    failSaves();
    try {
      assert.equal((await call('POST', '/api/drinks', tokenA, postBody(toBase64(SVG)))).status, 400);
      assert.equal((await call('POST', `/api/users/${USER_A}/avatar`, tokenB, { imageData: toBase64(PNG) })).status, 403);
      assert.equal((await call('POST', '/api/drinks/999999/like', tokenA)).status, 404);
    } finally {
      allowSaves();
    }
  });

  test('image bytes never reach the logs', async () => {
    const bytes = Buffer.concat([JPEG, LOG_SENTINEL]);
    failSaves();
    try {
      assertSaveFailed(await call('POST', '/api/drinks', tokenB, postBody(toBase64(bytes))), 'post');
    } finally {
      allowSaves();
    }
    assert.ok(!server.getOutput().includes(toBase64(bytes)));
    assert.ok(!server.getOutput().includes(LOG_SENTINEL.toString()));
  });
});

test('the first-start save failing does not stop the server', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drinkme-images-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const dbFile = path.join(dir, 'db.json');
  fs.writeFileSync(`${dbFile}.fail-saves`, '');

  const firstStart = await startServer({
    DB_FILE: dbFile,
    DB_FAULT: 'save',
    NODE_OPTIONS: `--import=${FAULT_PRELOAD}`,
  });
  t.after(() => firstStart.stop());

  assert.equal(fs.existsSync(dbFile), false);
  assert.equal((await fetch(`${firstStart.baseUrl}/healthz`)).status, 200);
});

describe('malformed requests', () => {
  let server;
  let token;
  const USER_ID = 'malformed-user';
  const BOUNDARY = 'zz';
  const MULTIPART = `multipart/form-data; boundary=${BOUNDARY}`;
  const CASES = [
    ['no boundary', 'multipart/form-data', 'x'],
    ['a truncated body', MULTIPART, `--${BOUNDARY}\r\nContent-Disposition: form-data; name="avatar"; filename="a.jpg"\r\n\r\nabc`],
    ['a malformed part header', MULTIPART, `--${BOUNDARY}\r\nNot a header\r\n\r\nabc\r\n--${BOUNDARY}--\r\n`],
    ['an empty body', MULTIPART, ''],
  ];

  const sendRaw = (path, contentType, body) => send(server.baseUrl, 'POST', path, token, {
    headers: { 'Content-Type': contentType },
    body,
  });

  before(async () => {
    server = await startServer();
    token = await signIn(server.baseUrl, USER_ID);
  });

  after(() => server?.stop());

  test('malformed multipart gets 400 on the avatar route, with no stack trace logged', async () => {
    for (const [label, contentType, body] of CASES) {
      const { status, body: response } = await sendRaw(`/api/users/${USER_ID}/avatar`, contentType, body);
      assert.equal(status, 400, label);
      assert.equal(typeof response.error, 'string', label);
    }
    assert.doesNotMatch(server.getOutput(), /\n\s+at /);
    assert.doesNotMatch(server.getOutput(), /Error:/);
  });

  test('invalid JSON gets 400 on every parser', async () => {
    for (const path of ['/api/smart-bar', '/api/drinks', `/api/users/${USER_ID}/avatar`]) {
      const { status, body } = await sendRaw(path, 'application/json', '{ not json');
      assert.equal(status, 400, path);
      assert.equal(body.error, 'Invalid JSON', path);
    }
    assert.doesNotMatch(server.getOutput(), /\n\s+at /);
  });

  test('other routes accept bodies under about 100 KB and refuse larger ones with 413', async () => {
    const bio = 'b'.repeat(DEFAULT_BODY_LIMIT_BYTES - 100);
    assert.equal((await sendJson(server.baseUrl, 'PUT', `/api/users/${USER_ID}`, token, { bio })).status, 200);

    const tooLarge = 'b'.repeat(DEFAULT_BODY_LIMIT_BYTES + 1);
    for (const [method, path, body] of [
      ['PUT', `/api/users/${USER_ID}`, { bio: tooLarge }],
      ['POST', '/api/smart-bar', { name: tooLarge, quantity: '1' }],
      ['POST', '/api/auth/mobile', { idToken: tooLarge, uid: USER_ID }],
    ]) {
      const response = await sendJson(server.baseUrl, method, path, token, body);
      assert.equal(response.status, 413, path);
      assert.equal(response.body.error, PARSER_TOO_LARGE, path);
    }
    const urlencoded = await sendRaw('/api/smart-bar', 'application/x-www-form-urlencoded', `name=${tooLarge}`);
    assert.equal(urlencoded.status, 413);
  });
});

test('the mutation limiter runs before body parsing', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const MUTATION_LIMIT = 30;
  const sendBadJson = () => fetch(`${server.baseUrl}/api/smart-bar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ not json',
  });
  // Logged out, so the sign-in gate refuses each one before the body is parsed, after the limiter counted it.
  for (let i = 0; i < MUTATION_LIMIT; i++) {
    assert.equal((await sendBadJson()).status, 401);
  }
  assert.equal((await sendBadJson()).status, 429);
});

describe('total image storage', () => {
  const STORAGE_LIMIT = 1000;
  const SMALL_IMAGE = dataUrl('jpeg', JPEG);
  const FILLER_ID = 'storage-filler';
  const OTHER_ID = 'storage-other';
  const filler = 'data:image/png;base64,'.padEnd(STORAGE_LIMIT - SMALL_IMAGE.length, 'A');
  const baseUser = { email: 'x@example.test', firstName: 'X', lastName: '', city: '', bio: '' };
  let server;
  let fillerToken;
  let otherToken;

  const createPost = (token) => sendJson(server.baseUrl, 'POST', '/api/drinks', token, postBody(SMALL_IMAGE));

  before(async () => {
    server = await startServer({ IMAGE_STORAGE_MAX_BYTES: String(STORAGE_LIMIT) }, {
      dbFixture: {
        users: [
          { ...baseUser, id: FILLER_ID, avatar: filler },
          { ...baseUser, id: OTHER_ID, avatar: `https://lh3.googleusercontent.com/${'p'.repeat(5000)}` },
        ],
      },
    });
    fillerToken = await signIn(server.baseUrl, FILLER_ID);
    otherToken = await signIn(server.baseUrl, OTHER_ID);
  });

  after(() => server?.stop());

  test('an image that lands exactly on the limit is accepted, and the next gets 507 and is not stored', async () => {
    assert.equal((await createPost(otherToken)).status, 201);
    const count = readDb(server.dbFile).drinks.length;

    const { status, body } = await createPost(otherToken);
    assert.equal(status, 507);
    assert.equal(typeof body.error, 'string');
    assert.equal(readDb(server.dbFile).drinks.length, count);
  });

  test('an avatar over the limit gets 507 on both paths, and the provider photo stays', async () => {
    const path = `/api/users/${OTHER_ID}/avatar`;
    assert.equal((await sendJson(server.baseUrl, 'POST', path, otherToken, { imageData: SMALL_IMAGE })).status, 507);
    assert.equal((await sendAvatarFile(server.baseUrl, OTHER_ID, otherToken, JPEG)).status, 507);
    assert.ok(storedAvatar(server, OTHER_ID).startsWith('https://'));
  });

  test('non-image mutations keep working when storage is full', async () => {
    assert.equal((await sendJson(server.baseUrl, 'PUT', `/api/users/${OTHER_ID}`, otherToken, { bio: 'Still works' })).status, 200);
    assert.equal((await sendJson(server.baseUrl, 'POST', '/api/smart-bar', otherToken, { name: 'Gin', quantity: '1' })).status, 201);
  });

  test('replacing an avatar counts only the difference, which frees room for a post', async () => {
    const path = `/api/users/${FILLER_ID}/avatar`;
    assert.equal((await sendJson(server.baseUrl, 'POST', path, fillerToken, { imageData: SMALL_IMAGE })).status, 200);
    assert.equal((await createPost(otherToken)).status, 201);
  });

  for (const [label, env] of [
    ['a non-numeric override', { IMAGE_STORAGE_MAX_BYTES: 'abc' }],
    ['a zero override', { IMAGE_STORAGE_MAX_BYTES: '0' }],
    ['an override outside tests', { IMAGE_STORAGE_MAX_BYTES: '1', NODE_ENV: 'development' }],
  ]) {
    test(`${label} is ignored`, async (t) => {
      await server.stop();
      const ignored = await startServer(env);
      t.after(() => ignored.stop());
      const token = await signIn(ignored.baseUrl, 'override-user');
      assert.equal((await sendJson(ignored.baseUrl, 'POST', '/api/drinks', token, postBody(SMALL_IMAGE))).status, 201);
    });
  }
});

describe('per-user post limits', () => {
  const HOUR_MS = 60 * 60 * 1000;
  const SMALL_IMAGE = dataUrl('jpeg', JPEG);
  const DAILY_BYTES = 50 * MIB;
  const baseUser = { email: 'x@example.test', firstName: 'X', lastName: '', city: '', bio: '', avatar: null };
  const ago = (hours) => new Date(Date.now() - hours * HOUR_MS).toISOString();
  let nextId = 1;
  const drinkOf = (userId, hours, imageUrl = SMALL_IMAGE) => ({
    id: nextId++, userId, name: 'Old', description: 'Old', rating: 4, isAlcoholic: false, tags: [], cheersCount: 0, createdAt: ago(hours), imageUrl,
  });
  const repeat = (count, make) => Array.from({ length: count }, make);
  const USERS = ['count-user', 'old-posts-user', 'bytes-user', 'old-bytes-user'];
  let server;

  const createPost = async (uid) => {
    const token = await signIn(server.baseUrl, uid);
    return sendJson(server.baseUrl, 'POST', '/api/drinks', token, postBody(SMALL_IMAGE));
  };

  before(async () => {
    const dailyFiller = 'data:image/png;base64,'.padEnd(DAILY_BYTES - SMALL_IMAGE.length, 'A');
    const drinks = [
      ...repeat(19, () => drinkOf('count-user', 1)),
      ...repeat(25, () => drinkOf('old-posts-user', 25)),
      drinkOf('bytes-user', 23, dailyFiller),
      drinkOf('old-bytes-user', 25, `${dailyFiller}AAAA`),
    ];
    server = await startServer({}, {
      dbFixture: { users: USERS.map((id) => ({ ...baseUser, id })), drinks, nextDrinkId: nextId },
    });
  });

  after(() => server?.stop());

  test('the 20th post in 24 hours is accepted, the 21st gets 429, and a restart does not reset it', async () => {
    assert.equal((await createPost('count-user')).status, 201);
    const count = readDb(server.dbFile).drinks.length;
    const refused = await createPost('count-user');
    assert.equal(refused.status, 429);
    assert.equal(typeof refused.body.error, 'string');
    assert.equal(readDb(server.dbFile).drinks.length, count);

    await server.restart();
    assert.equal((await createPost('count-user')).status, 429);
  });

  test('image bytes up to exactly 50 MB in 24 hours are accepted, and more get 429', async () => {
    assert.equal((await createPost('bytes-user')).status, 201);
    assert.equal((await createPost('bytes-user')).status, 429);
  });

  test('posts older than 24 hours count toward neither limit', async () => {
    assert.equal((await createPost('old-posts-user')).status, 201);
    assert.equal((await createPost('old-bytes-user')).status, 201);
  });
});

describe('data stored before this validation', () => {
  const GOOGLE_PHOTO = 'https://lh3.googleusercontent.com/a/ACg8ocK-test=s96-c';
  const LEGACY_SVG_AVATAR = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
  const LEGACY_IMAGE = 'data:image/png;base64,AAAA';
  let server;

  before(async () => {
    server = await startServer({}, {
      dbFixture: {
        users: [
          { id: 'legacy-photo', email: 'a@example.test', firstName: 'A', lastName: '', city: '', bio: '', avatar: GOOGLE_PHOTO },
          { id: 'legacy-data', email: 'b@example.test', firstName: 'B', lastName: '', city: '', bio: '', avatar: LEGACY_SVG_AVATAR },
        ],
        drinks: [{ id: 1, userId: 'legacy-photo', name: 'Old', description: 'Old', rating: 4, isAlcoholic: false, tags: [], cheersCount: 0, imageUrl: LEGACY_IMAGE }],
        nextDrinkId: 2,
      },
    });
  });

  after(() => server?.stop());

  test('stored avatars, provider photo URLs and posts are not rewritten by later saves', async () => {
    const token = await signIn(server.baseUrl, 'legacy-photo');
    assert.equal((await sendJson(server.baseUrl, 'PUT', '/api/users/legacy-photo', token, { bio: 'Updated' })).status, 200);

    const db = readDb(server.dbFile);
    assert.equal(db.users.find((u) => u.id === 'legacy-photo').avatar, GOOGLE_PHOTO);
    assert.equal(db.users.find((u) => u.id === 'legacy-data').avatar, LEGACY_SVG_AVATAR);
    assert.equal(db.drinks[0].imageUrl, LEGACY_IMAGE);

    assert.equal((await send(server.baseUrl, 'GET', '/api/users/legacy-photo', token)).body.avatar, GOOGLE_PHOTO);
    assert.equal((await send(server.baseUrl, 'GET', '/api/users/legacy-data', token)).body.avatar, null);
    assert.equal((await send(server.baseUrl, 'GET', '/api/drinks/1', token)).body.imageUrl, '/media/drinks/1');
  });
});
