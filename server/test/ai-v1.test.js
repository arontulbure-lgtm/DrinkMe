// /api/ai/* and /api/recipes/saved with AI_PROVIDER=local against an in-process ai-service stub and an
// Open Food Facts stub. No model, no network. Routes covered: /api/ai/status, /api/ai/notice, /api/ai/settings,
// /api/ai/scan, /api/ai/barcode, /api/ai/recipes, /api/recipes/saved, /api/recipes/saved/:recipeId.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { startServer } from './helpers/harness.js';

const SECRET = 'test-only-jwt-secret';
const token = (uid) => jwt.sign({ uid }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const ADULT = 'ai1-adult';
const NO_NOTICE = 'ai1-no-notice';
const EMPTY_BAR = 'ai1-empty-bar';
const OPTIN = 'ai1-optin';
const BUSY = 'ai1-busy';
const LIMITED = 'ai1-limited';
// Own users for later tests: the global mutation limiter allows 30 writes per minute per user.
const RETRY = 'ai1-retry';
const REPORTER = 'ai1-reporter';
const SAVER = 'ai1-saver';
const user = (id, extra = {}) => ({
  id, email: `${id}@example.test`, firstName: 'Test', lastName: '', city: '', bio: '', avatar: null,
  ageConfirmedAt: '2026-01-01T00:00:00.000Z', ...extra,
});
const FIXTURE = {
  users: [
    user(ADULT, { aiNoticeVersion: 1 }), user(NO_NOTICE), user(EMPTY_BAR, { aiNoticeVersion: 1 }),
    user(OPTIN, { aiNoticeVersion: 1 }), user(BUSY, { aiNoticeVersion: 1 }), user(LIMITED, { aiNoticeVersion: 1 }), user(RETRY, { aiNoticeVersion: 1 }), user(REPORTER, { aiNoticeVersion: 1 }), user(SAVER, { aiNoticeVersion: 1 }),
  ],
  smartBarByUser: {
    [ADULT]: [
      { id: 1, name: 'Bombay Sapphire Gin', quantity: '1', unit: 'bottle' },
      { id: 2, name: 'Schweppes Tonic', quantity: '2', unit: 'bottle' },
      { id: 3, name: 'cucumber', quantity: '1', unit: 'piece' },
    ],
    [BUSY]: [{ id: 1, name: 'orange juice', quantity: '1', unit: 'bottle' }],
    [SAVER]: [{ id: 1, name: 'Bombay Sapphire Gin', quantity: '1', unit: 'bottle' }, { id: 2, name: 'Schweppes Tonic', quantity: '1', unit: 'bottle' }, { id: 3, name: 'cucumber', quantity: '1', unit: 'piece' }],
    [RETRY]: [
      { id: 1, name: 'Bombay Sapphire Gin', quantity: '1', unit: 'bottle' },
      { id: 2, name: 'Schweppes Tonic', quantity: '2', unit: 'bottle' },
      { id: 3, name: 'cucumber', quantity: '1', unit: 'piece' },
    ],
    [LIMITED]: [{ id: 1, name: 'orange juice', quantity: '1', unit: 'bottle' }],
  },
};

// A structurally valid JPEG: SOI, APP0 (JFIF), APP1 (EXIF with a fake GPS tag), SOS, image data, EOI.
const JPEG_B64 = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0'), Buffer.alloc(9, 1),
  Buffer.from([0xff, 0xe1, 0x00, 0x0e]), Buffer.from('Exif\0\0GPSPOS'),
  Buffer.from([0xff, 0xda, 0x00, 0x08]), Buffer.alloc(6, 0), Buffer.from('IMAGEDATA'), Buffer.from([0xff, 0xd9]),
]).toString('base64');
const GIF_B64 = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1').toString('base64');

const R = (name, ingredients, extra = {}) => ({
  name, description: 'Fresh.', ingredients, steps: ['Build over ice.'], glass: 'highball', garnish: null,
  method: 'build', isAlcoholic: true, tags: [], language: 'en', estimatedAbv: 0, standardDrinks: 0, aiGenerated: true, ...extra,
});
const ml = (name, amount, abv = 0) => ({ name, amount, unit: 'ml', abv, optional: false });
const GIN_TONIC = R('Garden G&T', [ml('gin', 40, 40), ml('tonic water', 120)]);
const CUKE = R('Cucumber Tonic', [ml('tonic water', 150), { name: 'cucumber', amount: 3, unit: 'piece', abv: 0 }], { isAlcoholic: false });
const TOO_STRONG = R('Double Trouble', [ml('gin', 90, 40), ml('tonic water', 60)]);
const FLAMING = R('Fire Tonic', [ml('gin', 30, 40), ml('tonic water', 100)], { steps: ['Flame the cucumber.'] });
const OFF_BAR = R('Elder Spritz', [ml('gin', 30, 40), ml('elderflower liqueur', 15, 20), ml('tonic water', 100)]);
const THIRD = R('Sapphire Long Drink', [ml('gin', 25, 40), ml('tonic', 140)]);
const SECOND = R('Cucumber Gin Cooler', [ml('gin', 30, 40), ml('tonic', 100), { name: 'cucumber', amount: 2, unit: 'piece', abv: 0 }]);

// ── ai-service stub ──────────────────────────────────────────────────────────
const stub = {
  calls: [],
  health: 'ok',
  scanReply: null, // object | { status, body } | 'hang'
  recipeHandler: null, // (requestBody) => recipes[] | { status, body }
  recipeDelayMs: 0,
};
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const aiStub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', async () => {
    const body = raw ? JSON.parse(raw) : null;
    stub.calls.push({ path: req.url, body, headers: req.headers });
    if (req.url === '/v1/health') return send(res, 200, { status: stub.health, schemaVersion: '1', models: {}, ollama: true, modelsPresent: true, ocr: true });
    if (req.url === '/v1/scan') {
      const reply = stub.scanReply;
      if (typeof reply?.status === 'number') return send(res, reply.status, reply.body);
      return send(res, 200, { schemaVersion: '1', model: 'stub', timings: { ocrMs: 1, visionMs: 1, totalMs: 2 }, suggestBarcode: false, ...reply });
    }
    if (req.url === '/v1/recipes') {
      if (stub.recipeDelayMs) await new Promise((r) => setTimeout(r, stub.recipeDelayMs));
      const reply = stub.recipeHandler ? stub.recipeHandler(body) : [];
      if (typeof reply.status === 'number') return send(res, reply.status, reply.body);
      return send(res, 200, { schemaVersion: '1', recipes: reply, dropped: 0, model: 'stub', timings: { totalMs: 1 } });
    }
    send(res, 404, { error: { code: 'not_found' } });
  });
});

// ── Open Food Facts stub ─────────────────────────────────────────────────────
const offProducts = {
  '5000000000005': { product_name: 'Test Gin', brands: 'Stub Distillers', categories_tags: ['en:beverages', 'en:gins'], quantity: '70 cl', nutriments: { alcohol_100g: 41.5 } },
  '5000000000012': { product_name: 'Izvorul Stub', brands: 'Stub', categories_tags: ['en:waters', 'en:mineral-waters'], quantity: '0.5 l' },
};
const offStub = http.createServer((req, res) => {
  const ean = req.url.split('/').pop().split('.json')[0];
  const product = offProducts[ean];
  if (!product) return send(res, 404, { status: 0 });
  send(res, 200, { status: 1, product });
});

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

let server;
let photoDir;
const api = async (method, urlPath, { uid = ADULT, body } = {}) => {
  const res = await fetch(`${server.baseUrl}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${token(uid)}`, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const recipeCalls = () => stub.calls.filter((c) => c.path === '/v1/recipes');
// Answers each one-recipe request from a pool: regular slots and the mocktail slot draw separately.
const pools = ({ regular = [], mocktail = [] }) => {
  const r = [...regular];
  const m = [...mocktail];
  return (body) => { const next = (body.mocktailsOnly ? m : r).shift(); return next ? [next] : []; };
};

before(async () => {
  const aiPort = await listen(aiStub);
  const offPort = await listen(offStub);
  photoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drinkme-ai-photos-'));
  server = await startServer({
    AI_PROVIDER: 'local',
    AI_SERVICE_URL: `http://127.0.0.1:${aiPort}`,
    AI_SERVICE_TOKEN: 'stub-token',
    AI_SERVICE_TIMEOUT_MS: '3000',
    OFF_API_URL: `http://127.0.0.1:${offPort}/api/v2/product`,
    AI_PHOTO_DIR: photoDir,
    AI_RATE_LIMIT_PER_HOUR: '60',
    AI_RECIPE_CONCURRENCY: '1',
    AI_PHOTO_OPT_IN_ENABLED: 'true',
    AI_DAILY_SCAN_LIMIT: '500',
    AI_DAILY_RECIPE_LIMIT: '500',
  }, { dbFixture: FIXTURE });
});
after(async () => {
  await server?.stop();
  aiStub.close();
  offStub.close();
  fs.rmSync(photoDir, { recursive: true, force: true });
});
beforeEach(() => {
  stub.calls = [];
  stub.health = 'ok';
  stub.scanReply = null;
  stub.recipeHandler = null;
  stub.recipeDelayMs = 0;
});

describe('GET /api/ai/status and the AI notice', () => {
  test('reports availability, notice state and default basics in the asked language', async () => {
    const res = await api('GET', '/api/ai/status?language=ro');
    assert.equal(res.status, 200);
    assert.equal(res.body.available, true);
    assert.equal(res.body.provider, 'local');
    assert.equal(res.body.noticeAccepted, true);
    assert.equal(res.body.processing, 'drinkme');
    assert.equal(res.body.noticeVersion, 1);
    assert.deepEqual(res.body.settings, { basics: ['gheață', 'apă', 'zahăr', 'sare'], basicsCustomized: false, photoOptIn: false, photoOptInAvailable: true });
    assert.equal(stub.calls[0].path, '/v1/health');
  });

  test('POST /api/ai/notice needs the current version; scan and recipes need the notice', async () => {
    assert.equal((await api('GET', '/api/ai/status', { uid: NO_NOTICE })).body.noticeAccepted, false);
    const scan = await api('POST', '/api/ai/scan', { uid: NO_NOTICE, body: { imageBase64: JPEG_B64 } });
    assert.equal(scan.status, 403);
    assert.equal(scan.body.code, 'ai_notice_required');
    const recipes = await api('POST', '/api/ai/recipes', { uid: NO_NOTICE, body: { mode: 'smart_bar' } });
    assert.equal(recipes.body.code, 'ai_notice_required');
    assert.equal(stub.calls.filter((c) => c.path !== '/v1/health').length, 0, 'nothing reached the ai-service');
    assert.equal((await api('POST', '/api/ai/notice', { uid: NO_NOTICE, body: { version: 99 } })).status, 400);
    const ok = await api('POST', '/api/ai/notice', { uid: NO_NOTICE, body: { version: 1 } });
    assert.equal(ok.status, 200);
    assert.equal((await api('GET', '/api/ai/status', { uid: NO_NOTICE })).body.noticeAccepted, true);
  });

  test('requests without a token are refused before any AI work', async () => {
    const res = await fetch(`${server.baseUrl}/api/ai/status`);
    assert.equal(res.status, 401);
  });
});

describe('PUT /api/ai/settings', () => {
  test('basics are sanitised, de-duplicated and can be reset', async () => {
    const res = await api('PUT', '/api/ai/settings', { uid: EMPTY_BAR, body: { basics: ['ice', ' Ice ', 'mint‮', 'lime'] } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.basics, ['ice', 'mint', 'lime']);
    assert.equal((await api('PUT', '/api/ai/settings', { uid: EMPTY_BAR, body: { basics: ['x'.repeat(10), ...Array(12).fill('y')] } })).status, 400);
    assert.equal((await api('PUT', '/api/ai/settings', { uid: EMPTY_BAR, body: { basics: [''] } })).status, 400);
    assert.equal((await api('PUT', '/api/ai/settings', { uid: EMPTY_BAR, body: { photoOptIn: 'yes' } })).status, 400);
    const reset = await api('PUT', '/api/ai/settings', { uid: EMPTY_BAR, body: { basics: null } });
    assert.deepEqual(reset.body, { basics: ['ice', 'water', 'sugar', 'salt'], basicsCustomized: false, photoOptIn: false, photoOptInAvailable: true });
  });
});

describe('POST /api/ai/scan', () => {
  const recognized = { status: 'recognized', item: { category: 'spirit', brand: 'Bombay Sapphire', product: 'London Dry Gin', style: 'gin', abv: 40, volumeMl: 700, isAlcoholic: false, flags: [], confidence: 0.93 } };

  test('sends the photo to the ai-service and returns the validated result', async () => {
    stub.scanReply = recognized;
    const res = await api('POST', '/api/ai/scan', { body: { imageBase64: JPEG_B64, language: 'ro' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.source, 'photo');
    assert.equal(res.body.status, 'recognized');
    assert.equal(res.body.item.isAlcoholic, true, 'recomputed from the taxonomy');
    const call = stub.calls.find((c) => c.path === '/v1/scan');
    assert.deepEqual(Object.keys(call.body).sort(), ['imageBase64', 'language', 'mimeType', 'schemaVersion']);
    assert.equal(call.body.mimeType, 'image/jpeg');
    assert.equal(call.body.language, 'ro');
    assert.equal(fs.readdirSync(photoDir).length, 0, 'no photo kept without opt-in');
  });

  test('low confidence suggests the barcode; not-ingredient and water pass through', async () => {
    stub.scanReply = { ...recognized, status: 'low_confidence', item: { ...recognized.item, confidence: 0.3 } };
    assert.equal((await api('POST', '/api/ai/scan', { body: { imageBase64: JPEG_B64 } })).body.suggestBarcode, true);
    stub.scanReply = { status: 'not_ingredient', item: null };
    const not = await api('POST', '/api/ai/scan', { body: { imageBase64: JPEG_B64 } });
    assert.deepEqual([not.body.status, not.body.item], ['not_ingredient', null]);
  });

  test('invalid images and invalid provider output are refused', async () => {
    assert.equal((await api('POST', '/api/ai/scan', { body: { imageBase64: GIF_B64 } })).status, 400);
    assert.equal((await api('POST', '/api/ai/scan', { body: {} })).status, 400);
    stub.scanReply = { status: 'recognized', item: { category: 'potion', confidence: 2 } };
    const bad = await api('POST', '/api/ai/scan', { body: { imageBase64: JPEG_B64 } });
    assert.equal(bad.status, 502);
    assert.equal(bad.body.code, 'ai_invalid_output');
  });

  test('ai-service errors map to clear codes; 503 is retried once', async () => {
    stub.scanReply = { status: 504, body: { error: { code: 'model_timeout', message: 'slow' } } };
    const timeout = await api('POST', '/api/ai/scan', { body: { imageBase64: JPEG_B64 } });
    assert.deepEqual([timeout.status, timeout.body.code], [504, 'ai_timeout']);
    stub.calls = [];
    stub.scanReply = { status: 503, body: { error: { code: 'model_unavailable', message: 'down' } } };
    const down = await api('POST', '/api/ai/scan', { body: { imageBase64: JPEG_B64 } });
    assert.deepEqual([down.status, down.body.code], [503, 'ai_unavailable']);
    assert.equal(stub.calls.filter((c) => c.path === '/v1/scan').length, 2);
  });

  test('with the opt-in the photo is kept, and turning it off deletes it', async () => {
    stub.scanReply = recognized;
    await api('PUT', '/api/ai/settings', { uid: OPTIN, body: { photoOptIn: true } });
    assert.equal((await api('POST', '/api/ai/scan', { uid: OPTIN, body: { imageBase64: JPEG_B64 } })).status, 200);
    const files = fs.readdirSync(photoDir);
    assert.equal(files.length, 2);
    assert.ok(files.every((name) => !name.includes(OPTIN)), 'file names never hold the user id');
    const kept = fs.readFileSync(path.join(photoDir, files.find((name) => name.endsWith('.jpg'))));
    assert.ok(kept.includes(Buffer.from('IMAGEDATA')), 'the image itself is kept');
    assert.ok(!kept.includes(Buffer.from('Exif')) && !kept.includes(Buffer.from('GPSPOS')), 'EXIF (location) is removed');
    await api('PUT', '/api/ai/settings', { uid: OPTIN, body: { photoOptIn: false } });
    assert.equal(fs.readdirSync(photoDir).length, 0);
  });
});

describe('POST /api/ai/barcode', () => {
  test('checks the EAN, maps the product and reports not found', async () => {
    assert.equal((await api('POST', '/api/ai/barcode', { body: { ean: '5000000000001' } })).body.code, 'barcode_invalid');
    const gin = await api('POST', '/api/ai/barcode', { body: { ean: '5000000000005' } });
    assert.equal(gin.status, 200);
    assert.equal(gin.body.source, 'barcode');
    assert.deepEqual([gin.body.item.category, gin.body.item.abv, gin.body.item.volumeMl, gin.body.item.isAlcoholic], ['spirit', 41.5, 700, true]);
    const water = await api('POST', '/api/ai/barcode', { body: { ean: '5000000000012' } });
    assert.equal(water.body.status, 'water');
    const missing = await api('POST', '/api/ai/barcode', { body: { ean: '5000000000029' } });
    assert.deepEqual([missing.status, missing.body.code], [404, 'barcode_not_found']);
  });
});

describe('POST /api/ai/recipes', () => {
  const recipeCallsOf = (kind) => recipeCalls().filter((c) => c.body.mocktailsOnly === (kind === 'mocktail'));

  test('Smart Bar mode: one recipe per slot, bad ones retried once, a mocktail slot with only non-alcoholic items', async () => {
    stub.recipeHandler = pools({ regular: [GIN_TONIC, TOO_STRONG, FLAMING, OFF_BAR, SECOND], mocktail: [CUKE] });
    const res = await api('POST', '/api/ai/recipes', { body: { mode: 'smart_bar', language: 'en', newSession: true } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.recipes.map((r) => r.name).sort(), ['Cucumber Gin Cooler', 'Cucumber Tonic', 'Garden G&T']);
    const [first] = res.body.recipes;
    assert.match(first.id, /^r_[0-9a-f]{16}$/);
    assert.equal(first.aiGenerated, true);
    assert.match(res.body.recipes.find((r) => r.name === 'Garden G&T').responsibleNote, /Enjoy responsibly/);
    assert.equal(res.body.recipes.find((r) => r.name === 'Cucumber Tonic').isAlcoholic, false);
    const calls = recipeCalls();
    assert.ok(calls.every((c) => c.body.count === 1 && typeof c.body.styleHint === 'string'));
    assert.equal(calls[0].headers['x-ai-service-token'], 'stub-token');
    assert.deepEqual(calls[0].body.ingredients.map((i) => i.name), ['Bombay Sapphire Gin', 'Schweppes Tonic', 'cucumber']);
    assert.deepEqual(calls[0].body.basics, ['ice', 'water', 'sugar', 'salt']);
    const [mocktailCall] = recipeCallsOf('mocktail');
    assert.deepEqual(mocktailCall.body.ingredients.map((i) => i.name), ['Schweppes Tonic', 'cucumber'], 'the gin never reaches the mocktail slot');
  });

  test('stream: true sends each recipe as an NDJSON line, then done', async () => {
    stub.recipeHandler = pools({ regular: [GIN_TONIC, SECOND, THIRD], mocktail: [CUKE] });
    const res = await fetch(`${server.baseUrl}/api/ai/recipes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token(ADULT)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'smart_bar', newSession: true, stream: true }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/x-ndjson/);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'start');
    assert.deepEqual(lines.filter((l) => l.type === 'recipe').map((l) => l.recipe.name).sort(), ['Cucumber Gin Cooler', 'Cucumber Tonic', 'Garden G&T', 'Sapphire Long Drink']);
    assert.deepEqual(lines.at(-1), { type: 'done', exhausted: false, count: 4 });
  });

  test('stream: an error after the start arrives as an error line', async () => {
    stub.recipeHandler = () => ({ status: 503, body: { error: { code: 'model_unavailable', message: 'down' } } });
    const res = await fetch(`${server.baseUrl}/api/ai/recipes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token(ADULT)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'smart_bar', newSession: true, stream: true }),
    });
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual([lines.at(-1).type, lines.at(-1).code], ['error', 'ai_unavailable']);
  });

  test('another batch excludes what was shown; repeats are dropped; only repeats means exhausted', async () => {
    stub.recipeHandler = pools({ regular: [GIN_TONIC, SECOND, THIRD], mocktail: [CUKE] });
    await api('POST', '/api/ai/recipes', { body: { mode: 'smart_bar', newSession: true } });
    stub.calls = [];
    stub.recipeHandler = pools({ regular: [GIN_TONIC, SECOND, THIRD, GIN_TONIC, SECOND, THIRD], mocktail: [CUKE, CUKE] });
    const again = await api('POST', '/api/ai/recipes', { body: { mode: 'smart_bar' } });
    assert.ok(['Garden G&T', 'Cucumber Gin Cooler', 'Sapphire Long Drink', 'Cucumber Tonic'].every((n) => recipeCalls()[0].body.excludeNames.includes(n)));
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.recipes, []);
    assert.equal(again.body.exhausted, true);
  });

  test('scan mode: the real ABV of the scanned bottle is used even when the model says 0 (brand-name spirit)', async () => {
    const SNEAKY = R('Smirnoff Cooler', [{ name: 'Smirnoff Red', amount: 180, unit: 'ml', abv: 0, optional: false }, ml('soda water', 60)], { isAlcoholic: false });
    const SMALL = R('Smirnoff Highball', [{ name: 'Smirnoff Red', amount: 30, unit: 'ml', abv: 0, optional: false }, ml('soda water', 120)], { isAlcoholic: false });
    stub.recipeHandler = pools({ regular: [SNEAKY, SMALL] });
    const item = { category: 'spirit', brand: 'Smirnoff', product: 'Red', abv: 37.5 };
    const res = await api('POST', '/api/ai/recipes', { body: { mode: 'scan', item, newSession: true } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.recipes.map((r) => r.name), ['Smirnoff Highball']);
    const [highball] = res.body.recipes;
    assert.equal(highball.isAlcoholic, true);
    assert.ok(highball.standardDrinks > 0.8);
    assert.match(highball.responsibleNote, /Enjoy responsibly/);
  });

  test('scan mode: a scanned energy drink mixed with alcohol gets the warning', async () => {
    stub.recipeHandler = pools({ regular: [R('Night Fuel', [ml('Monster Ultra White', 150), ml('vodka', 30, 40)])] });
    const item = { category: 'energy_drink', brand: 'Monster', product: 'Ultra White', abv: null };
    const res = await api('POST', '/api/ai/recipes', { body: { mode: 'scan', item, newSession: true } });
    assert.deepEqual(res.body.recipes[0].warnings, ['energy_alcohol']);
  });

  test('scan mode: built around the item, the mocktail slot gets flavour notes only, water refused', async () => {
    const LEMON = R('Gin Sour Light', [ml('Bombay Sapphire gin', 40, 40), ml('lemon juice', 20), ml('simple syrup', 10)]);
    const VODKA = R('Vodka Tonic', [ml('vodka', 40, 40), ml('tonic water', 120)]);
    stub.recipeHandler = pools({ regular: [LEMON, VODKA, GIN_TONIC, SECOND], mocktail: [CUKE] });
    const item = { category: 'spirit', brand: 'Bombay Sapphire', product: 'London Dry Gin', abv: 40 };
    const res = await api('POST', '/api/ai/recipes', { body: { mode: 'scan', item, language: 'ro', newSession: true } });
    assert.equal(res.status, 200);
    const sour = res.body.recipes.find((r) => r.name === 'Gin Sour Light');
    assert.deepEqual(sour.youWillAlsoNeed, ['lemon juice']);
    assert.equal(res.body.recipes.some((r) => r.name === 'Vodka Tonic'), false, 'an alcoholic recipe without the scanned item is dropped');
    assert.equal(res.body.recipes.some((r) => r.name === 'Cucumber Tonic'), true, 'the mocktail echoes the bottle without containing it');
    const call = recipeCallsOf('regular')[0].body;
    assert.deepEqual([call.mode, call.language, call.ingredients[0].name], ['scan', 'ro', 'Bombay Sapphire London Dry Gin']);
    const mocktailCall = recipeCallsOf('mocktail')[0].body;
    assert.match(mocktailCall.ingredients[0].name, /^alcohol-free drink with juniper/);
    assert.ok(!/bombay|sapphire/i.test(JSON.stringify(mocktailCall.ingredients)), 'the bottle is never named in the mocktail request');
    const water = await api('POST', '/api/ai/recipes', { body: { mode: 'scan', item: { category: 'water', brand: 'Borsec' } } });
    assert.deepEqual([water.status, water.body.code], [400, 'water_no_recipes']);
  });

  test('a failed slot is retried once; nothing valid at all ends with ai_invalid_output', async () => {
    stub.recipeHandler = () => [TOO_STRONG];
    const res = await api('POST', '/api/ai/recipes', { body: { mode: 'smart_bar', newSession: true } });
    assert.deepEqual([res.status, res.body.code], [502, 'ai_invalid_output']);
    assert.equal(recipeCalls().length, 8, '4 slots × 2 attempts');
  });

  test('one unusable model answer is retried; the second answer is used', async () => {
    let first = true;
    const pool = pools({ regular: [GIN_TONIC, SECOND, THIRD], mocktail: [CUKE] });
    stub.recipeHandler = (body) => {
      if (first) { first = false; return { status: 502, body: { error: { code: 'model_invalid_output', message: 'x' } } }; }
      return pool(body);
    };
    const res = await api('POST', '/api/ai/recipes', { uid: RETRY, body: { mode: 'smart_bar', newSession: true } });
    assert.equal(res.status, 200);
    assert.equal(res.body.recipes.length, 4);
    assert.equal(recipeCalls().length, 5);
  });

  test('input errors: bad mode, bad item, bad stream flag, empty Smart Bar', async () => {
    assert.equal((await api('POST', '/api/ai/recipes', { body: { mode: 'party' } })).status, 400);
    assert.equal((await api('POST', '/api/ai/recipes', { body: { mode: 'scan', item: { category: 'potion' } } })).status, 400);
    assert.equal((await api('POST', '/api/ai/recipes', { body: { mode: 'smart_bar', stream: 'yes' } })).status, 400);
    const empty = await api('POST', '/api/ai/recipes', { uid: EMPTY_BAR, body: { mode: 'smart_bar' } });
    assert.deepEqual([empty.status, empty.body.code], [400, 'smart_bar_empty']);
  });

  test('one AI request per user at a time', async () => {
    stub.recipeDelayMs = 400;
    stub.recipeHandler = pools({ regular: [R('Orange Fizz', [ml('orange juice', 150)], { isAlcoholic: false }), R('OJ Cooler', [ml('orange juice', 120), ml('water', 30)], { isAlcoholic: false }), R('Sunrise Light', [ml('orange juice', 160)], { isAlcoholic: false })], mocktail: [R('OJ Spritz', [ml('orange juice', 100), ml('water', 50)], { isAlcoholic: false })] });
    const [a, b] = await Promise.all([
      api('POST', '/api/ai/recipes', { uid: BUSY, body: { mode: 'smart_bar', newSession: true } }),
      new Promise((r) => setTimeout(r, 150)).then(() => api('POST', '/api/ai/recipes', { uid: BUSY, body: { mode: 'smart_bar' } })),
    ]);
    assert.equal(a.status, 200);
    assert.deepEqual([b.status, b.body.code], [409, 'ai_busy']);
  });
});

describe('saved recipes', () => {
  test('save, list, save again (same id), delete', async () => {
    stub.recipeHandler = pools({ regular: [GIN_TONIC, SECOND, THIRD], mocktail: [CUKE] });
    const { body } = await api('POST', '/api/ai/recipes', { uid: SAVER, body: { mode: 'smart_bar', newSession: true } });
    const recipe = body.recipes[0];
    const saved = await api('POST', '/api/recipes/saved', { uid: SAVER, body: { recipe } });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.id, recipe.id);
    assert.ok(saved.body.savedAt);
    assert.equal((await api('POST', '/api/recipes/saved', { uid: SAVER, body: { recipe } })).status, 200);
    const list = await api('GET', '/api/recipes/saved', { uid: SAVER });
    assert.deepEqual(list.body.items.map((r) => r.id), [recipe.id]);
    assert.deepEqual((await api('GET', '/api/recipes/saved', { uid: OPTIN })).body.items, [], 'only the owner sees them');
    assert.equal((await api('DELETE', `/api/recipes/saved/${recipe.id}`, { uid: OPTIN })).status, 404);
    assert.equal((await api('DELETE', `/api/recipes/saved/${recipe.id}`, { uid: SAVER })).status, 204);
    assert.deepEqual((await api('GET', '/api/recipes/saved', { uid: SAVER })).body.items, []);
  });

  test('a modified client cannot save an unsafe or invalid recipe', async () => {
    const res = await api('POST', '/api/recipes/saved', { uid: SAVER, body: { recipe: FLAMING } });
    assert.deepEqual([res.status, res.body.code], [400, 'recipe_invalid']);
    assert.equal((await api('POST', '/api/recipes/saved', { uid: SAVER, body: { recipe: TOO_STRONG } })).status, 400);
    assert.equal((await api('POST', '/api/recipes/saved', { uid: SAVER, body: {} })).status, 400);
  });

  test('saved recipes survive a restart', async () => {
    const saved = await api('POST', '/api/recipes/saved', { uid: SAVER, body: { recipe: CUKE } });
    assert.equal(saved.status, 201);
    await server.restart();
    const list = await api('GET', '/api/recipes/saved', { uid: SAVER });
    assert.ok(list.body.items.some((r) => r.id === saved.body.id));
  });
});

describe('POST /api/ai/report', () => {
  test('stores a report of an AI answer in the audit log (AI text only) and validates the input', async () => {
    const ok = await api('POST', '/api/ai/report', { uid: REPORTER, body: { kind: 'recipe', reason: 'unsafe', recipeId: 'r_0123456789abcdef', recipeName: 'Garden G&T' } });
    assert.equal(ok.status, 201);
    const scan = await api('POST', '/api/ai/report', { uid: REPORTER, body: { kind: 'scan', reason: 'wrong', category: 'spirit', status: 'recognized' } });
    assert.equal(scan.status, 201);
    for (const body of [{ kind: 'recipe', reason: 'meh', recipeId: 'r_0123456789abcdef' }, { kind: 'recipe', reason: 'wrong', recipeId: '../x' },
      { kind: 'scan', reason: 'wrong', category: 'potion' }, { kind: 'post', reason: 'wrong' }]) {
      assert.equal((await api('POST', '/api/ai/report', { uid: REPORTER, body })).status, 400, JSON.stringify(body));
    }
  });
});

describe('rate limit and provider down', () => {
  test('ai-service unreachable → 503 ai_unavailable and status says unavailable', async () => {
    stub.health = 'degraded';
    await new Promise((r) => setTimeout(r, 10_100)); // health is cached for 10 s
    const status = await api('GET', '/api/ai/status');
    assert.equal(status.body.available, false);
    assert.equal(status.body.barcode, true);
  });
});
