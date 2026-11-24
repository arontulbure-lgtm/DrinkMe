// Post and avatar photos are stored without metadata (EXIF with GPS, XMP, IPTC, text chunks): server/imageMetadata.js,
// legal LC-17, privacy policy "no GPS". Unit tests on hand-built files, then the routes end to end.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';

import { removeImageMetadata, stripJpeg, stripPng, stripWebp } from '../imageMetadata.js';
import { startServer } from './helpers/harness.js';

const REQUEST_TIMEOUT_MS = 30_000;
const GPS = 'GPS-CANARY-47.1585N-27.6014E';

const segment = (marker, payload) => {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
};
const latin1 = (text) => Buffer.from(text, 'latin1');

const JFIF = segment(0xe0, latin1('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'));
const EXIF = segment(0xe1, Buffer.concat([latin1('Exif\0\0MM\0*'), latin1(GPS)]));
const XMP = segment(0xe1, latin1(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${GPS}</x:xmpmeta>`));
const ICC = segment(0xe2, latin1('ICC_PROFILE\0\x01\x01colour-profile-bytes'));
const MPF = segment(0xe2, latin1('MPF\0II*\0index'));
const IPTC = segment(0xed, latin1(`Photoshop 3.0\u00008BIM${GPS}`));
const COMMENT = segment(0xfe, latin1(`taken at ${GPS}`));
const DQT = segment(0xdb, Buffer.from([0, 1, 2, 3]));
const SOS = segment(0xda, Buffer.from([1, 1, 0]));
const SCAN = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]); // stuffed FF and a restart marker
const EOI = Buffer.from([0xff, 0xd9]);
const SOI = Buffer.from([0xff, 0xd8]);
// A second image appended after the first one's end (depth map / HDR gain map), with its own EXIF.
const APPENDED = Buffer.concat([SOI, EXIF, DQT, SOS, SCAN, EOI]);

const PHONE_JPEG = Buffer.concat([SOI, JFIF, EXIF, XMP, ICC, MPF, IPTC, COMMENT, DQT, SOS, SCAN, EOI, APPENDED]);
const CLEAN_JPEG = Buffer.concat([SOI, JFIF, ICC, DQT, SOS, SCAN, EOI]);

const pngChunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data, Buffer.alloc(4)]); // CRC not checked here
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR = pngChunk('IHDR', Buffer.alloc(13, 1));
const IDAT = pngChunk('IDAT', Buffer.from([9, 8, 7]));
const IEND = pngChunk('IEND', Buffer.alloc(0));
const PHONE_PNG = Buffer.concat([
  PNG_SIGNATURE, IHDR, pngChunk('eXIf', latin1(`MM\0*${GPS}`)), pngChunk('tEXt', latin1(`Location\0${GPS}`)),
  pngChunk('iTXt', latin1(`XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>${GPS}`)), pngChunk('tIME', Buffer.alloc(7)), IDAT, IEND,
]);
const CLEAN_PNG = Buffer.concat([PNG_SIGNATURE, IHDR, IDAT, IEND]);

const riffChunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};
const riff = (chunks) => {
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
};
const VP8X = (flags) => riffChunk('VP8X', Buffer.from([flags, 0, 0, 0, 9, 0, 0, 9, 0, 0]));
const VP8 = riffChunk('VP8 ', Buffer.from([1, 2, 3, 4, 5]));
const PHONE_WEBP = riff([VP8X(0x08 | 0x04 | 0x10), VP8, riffChunk('EXIF', latin1(`MM\0*${GPS}`)), riffChunk('XMP ', latin1(`<x:xmpmeta>${GPS}</x:xmpmeta>`))]);
const CLEAN_WEBP = riff([VP8X(0x10), VP8]);

const HEIC_WITH_EXIF = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), latin1('ftypheic\0\0\0\0mif1heic'), latin1(`meta....Exif\0\0MM\0*${GPS}`)]);

describe('removeImageMetadata', () => {
  test('JPEG: EXIF, XMP, IPTC, MPF and comments go; ICC and the image stay; appended images are cut', () => {
    assert.deepEqual(stripJpeg(PHONE_JPEG), CLEAN_JPEG);
    assert.deepEqual(removeImageMetadata(PHONE_JPEG, 'jpeg'), CLEAN_JPEG);
    assert.ok(!removeImageMetadata(PHONE_JPEG, 'jpeg').includes(latin1(GPS)));
  });

  test('PNG: eXIf, tEXt, iTXt and tIME go; image chunks stay', () => {
    assert.deepEqual(stripPng(PHONE_PNG), CLEAN_PNG);
    assert.deepEqual(removeImageMetadata(PHONE_PNG, 'png'), CLEAN_PNG);
  });

  test('WebP: EXIF and XMP chunks go, their VP8X flags are cleared and the RIFF size is updated', () => {
    const out = stripWebp(PHONE_WEBP);
    assert.deepEqual(out, CLEAN_WEBP);
    assert.equal(out.readUInt32LE(4), out.length - 8);
    assert.equal(out[20] & 0x0c, 0, 'EXIF and XMP flags cleared');
    assert.equal(out[20] & 0x10, 0x10, 'the alpha flag stays');
  });

  test('a clean file passes unchanged', () => {
    assert.deepEqual(removeImageMetadata(CLEAN_JPEG, 'jpeg'), CLEAN_JPEG);
    assert.deepEqual(removeImageMetadata(CLEAN_PNG, 'png'), CLEAN_PNG);
    assert.deepEqual(removeImageMetadata(CLEAN_WEBP, 'webp'), CLEAN_WEBP);
  });

  test('a file that cannot be walked is kept only without metadata markers', () => {
    const truncatedClean = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    assert.deepEqual(removeImageMetadata(truncatedClean, 'jpeg'), truncatedClean);
    const truncatedExif = PHONE_JPEG.subarray(0, SOI.length + JFIF.length + 12);
    assert.equal(removeImageMetadata(truncatedExif, 'jpeg'), null);
    assert.equal(removeImageMetadata(HEIC_WITH_EXIF, 'heic'), null, 'HEIC cannot be stripped: refused when it holds EXIF');
    const heicClean = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), latin1('ftypheic\0\0\0\0mif1heic')]);
    assert.deepEqual(removeImageMetadata(heicClean, 'heic'), heicClean);
  });

  test('a JPEG whose data still holds EXIF after the walk is refused', () => {
    const exifInScan = Buffer.concat([SOI, DQT, SOS, latin1('Exif\0\0'), EOI]);
    assert.equal(removeImageMetadata(exifInScan, 'jpeg'), null);
  });
});

// ── The routes ─────────────────────────────────────────────────────────────────
const send = async (baseUrl, method, path, token, init = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    ...init,
    headers: { ...init.headers, ...(token && { Authorization: `Bearer ${token}` }) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};
const sendJson = (baseUrl, method, path, token, body) => send(baseUrl, method, path, token, {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const signIn = async (baseUrl, uid) => {
  const { status, body } = await sendJson(baseUrl, 'POST', '/api/auth/mobile', undefined, { idToken: 'dev-fallback-token', uid });
  assert.equal(status, 200);
  const age = await sendJson(baseUrl, 'POST', `/api/users/${uid}/acknowledgements`, body.token, { type: 'age', confirmed: true });
  assert.equal(age.status, 200);
  return body.token;
};
const readDb = (server) => JSON.parse(fs.readFileSync(server.dbFile, 'utf8'));
const decodeDataUrl = (url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');

describe('uploads are stored without metadata', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server?.stop());

  test('a post photo with GPS EXIF is stored without it, for JPEG, PNG and WebP', async () => {
    const token = await signIn(server.baseUrl, 'meta-poster');
    for (const [type, bytes, clean] of [['jpeg', PHONE_JPEG, CLEAN_JPEG], ['png', PHONE_PNG, CLEAN_PNG], ['webp', PHONE_WEBP, CLEAN_WEBP]]) {
      const { status, body } = await sendJson(server.baseUrl, 'POST', '/api/drinks', token, {
        name: 'Metadata test', description: 'Synthetic', rating: 4, isAlcoholic: false, imageData: bytes.toString('base64'),
      });
      assert.equal(status, 201, type);
      const stored = readDb(server).drinks.find((d) => d.id === body.id).imageUrl;
      assert.ok(stored.startsWith(`data:image/${type};base64,`), type);
      assert.deepEqual(decodeDataUrl(stored), clean, type);
      assert.ok(!decodeDataUrl(stored).includes(latin1(GPS)), `${type}: no location left`);
    }
  });

  test('an avatar with GPS EXIF is stored without it (JSON and multipart)', async () => {
    const token = await signIn(server.baseUrl, 'meta-avatar');
    const json = await sendJson(server.baseUrl, 'POST', '/api/users/meta-avatar/avatar', token, { imageData: PHONE_JPEG.toString('base64') });
    assert.equal(json.status, 200);
    assert.deepEqual(decodeDataUrl(readDb(server).users.find((u) => u.id === 'meta-avatar').avatar), CLEAN_JPEG);

    const form = new FormData();
    form.append('avatar', new Blob([PHONE_PNG], { type: 'image/png' }), 'avatar.png');
    const multipart = await send(server.baseUrl, 'POST', '/api/users/meta-avatar/avatar', token, { body: form });
    assert.equal(multipart.status, 200);
    assert.deepEqual(decodeDataUrl(readDb(server).users.find((u) => u.id === 'meta-avatar').avatar), CLEAN_PNG);
  });

  test('a HEIC post photo that holds EXIF is refused with image_metadata, and nothing is stored', async () => {
    const token = await signIn(server.baseUrl, 'meta-heic');
    const before = readDb(server).drinks.length;
    const { status, body } = await sendJson(server.baseUrl, 'POST', '/api/drinks', token, {
      name: 'HEIC', description: 'Synthetic', rating: 3, isAlcoholic: false, imageData: HEIC_WITH_EXIF.toString('base64'),
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'image_metadata');
    assert.equal(readDb(server).drinks.length, before);
  });
});
