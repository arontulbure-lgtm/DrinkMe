// Decisions of 2026-11-22: per-user daily AI limits (AI_DAILY_SCAN_LIMIT / AI_DAILY_RECIPE_LIMIT), no photo
// opt-in at launch (AI_PHOTO_OPT_IN_ENABLED off by default), and AI only with an explicit AI_PROVIDER=local
// (the OpenAI provider is gone). Routes: /api/ai/scan, /api/ai/recipes, /api/ai/settings, /api/ai/status.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { startServer } from './helpers/harness.js';

const token = (uid) => jwt.sign({ uid }, 'test-only-jwt-secret', { algorithm: 'HS256', expiresIn: '1h' });
const user = (id) => ({
  id, email: `${id}@example.test`, firstName: 'Test', lastName: '', city: '', bio: '', avatar: null,
  ageConfirmedAt: '2026-01-01T00:00:00.000Z', aiNoticeVersion: 1,
});
const JPEG_B64 = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0'), Buffer.alloc(9, 1),
  Buffer.from([0xff, 0xda, 0x00, 0x04, 0, 0]), Buffer.from('DATA'), Buffer.from([0xff, 0xd9]),
]).toString('base64');
const MOCKTAIL = {
  name: 'Tonic Cooler', description: '', ingredients: [{ name: 'tonic water', amount: 150, unit: 'ml', abv: 0, optional: false }],
  steps: ['Build.'], glass: 'highball', garnish: null, method: 'build', isAlcoholic: false, tags: [], language: 'en',
  estimatedAbv: 0, standardDrinks: 0, aiGenerated: true,
};

const stub = { down: false, n: 0 };
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const aiStub = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (req.url === '/v1/health') return send(res, 200, { status: 'ok', schemaVersion: '1', models: {}, ollama: true, modelsPresent: true, ocr: true });
    if (stub.down) return send(res, 503, { error: { code: 'model_unavailable', message: 'down' } });
    if (req.url === '/v1/scan') {
      return send(res, 200, { schemaVersion: '1', status: 'not_ingredient', item: null, suggestBarcode: false, model: 's', timings: { ocrMs: 0, visionMs: 0, totalMs: 0 } });
    }
    stub.n += 1;
    return send(res, 200, { schemaVersion: '1', recipes: [{ ...MOCKTAIL, name: `Tonic Cooler ${stub.n}` }], dropped: 0, model: 's', timings: { totalMs: 1 } });
  });
});

let server;
const api = async (method, path, { uid = 'lim-user', body } = {}) => {
  const res = await fetch(`${server.baseUrl}${path}`, {
    method, headers: { Authorization: `Bearer ${token(uid)}`, ...(body && { 'Content-Type': 'application/json' }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

describe('daily limits and the photo opt-in flag (AI_PROVIDER=local)', () => {
  before(async () => {
    await new Promise((r) => aiStub.listen(0, '127.0.0.1', r));
    server = await startServer({
      AI_PROVIDER: 'local', AI_SERVICE_URL: `http://127.0.0.1:${aiStub.address().port}`,
      AI_DAILY_SCAN_LIMIT: '2', AI_DAILY_RECIPE_LIMIT: '1', AI_RECIPE_CONCURRENCY: '1',
    }, {
      dbFixture: {
        users: [user('lim-user'), user('lim-bar')],
        smartBarByUser: { 'lim-user': [{ id: 1, name: 'tonic water', quantity: '1', unit: 'bottle' }], 'lim-bar': [{ id: 1, name: 'tonic water', quantity: '1', unit: 'bottle' }] },
      },
    });
  });
  after(async () => { await server?.stop(); aiStub.close(); });

  test('scans: a provider outage gives the unit back; the limit then answers 429 ai_daily_limit', async () => {
    stub.down = true;
    assert.equal((await api('POST', '/api/ai/scan', { body: { imageBase64: JPEG_B64 } })).body.code, 'ai_unavailable');
    stub.down = false;
    assert.equal((await api('POST', '/api/ai/scan', { body: { imageBase64: JPEG_B64 } })).status, 200);
    assert.equal((await api('POST', '/api/ai/scan', { body: { imageBase64: JPEG_B64 } })).status, 200);
    const third = await api('POST', '/api/ai/scan', { body: { imageBase64: JPEG_B64 } });
    assert.deepEqual([third.status, third.body.code, third.body.kind, third.body.limit], [429, 'ai_daily_limit', 'scan', 2]);
    const status = await api('GET', '/api/ai/status');
    assert.deepEqual(status.body.dailyLeft, { scans: 0, recipeBatches: 1 });
    assert.deepEqual(status.body.dailyLimits, { scans: 2, recipeBatches: 1 });
  });

  test('recipe batches count separately from scans', async () => {
    assert.equal((await api('POST', '/api/ai/recipes', { uid: 'lim-bar', body: { mode: 'smart_bar', newSession: true } })).status, 200);
    const second = await api('POST', '/api/ai/recipes', { uid: 'lim-bar', body: { mode: 'smart_bar' } });
    assert.deepEqual([second.status, second.body.code, second.body.kind], [429, 'ai_daily_limit', 'recipes']);
  });

  test('the photo opt-in is not offered by default', async () => {
    const res = await api('PUT', '/api/ai/settings', { body: { photoOptIn: true } });
    assert.deepEqual([res.status, res.body.code], [400, 'photo_opt_in_unavailable']);
    const status = await api('GET', '/api/ai/status');
    assert.equal(status.body.settings.photoOptInAvailable, false);
    assert.equal(status.body.settings.photoOptIn, false);
    assert.equal((await api('PUT', '/api/ai/settings', { body: { photoOptIn: false } })).status, 200, 'turning it off is always allowed');
  });
});

describe('AI_PROVIDER=openai is no longer a provider (D-24)', () => {
  test('AI stays off and the old OpenAI routes are gone', async (t) => {
    const s = await startServer({ AI_PROVIDER: 'openai', AI_ENABLED: 'true', OPENAI_API_KEY: 'sk-unused' }, { dbFixture: { users: [user('o-user')] } });
    t.after(() => s.stop());
    const res = await fetch(`${s.baseUrl}/api/ai/status`, { headers: { Authorization: `Bearer ${token('o-user')}` } });
    const body = await res.json();
    assert.deepEqual([body.available, body.provider], [false, 'off']);
    const legacy = await fetch(`${s.baseUrl}/api/detect-product`, { method: 'POST', headers: { Authorization: `Bearer ${token('o-user')}` } });
    assert.equal(legacy.status, 404);
    assert.match(s.getOutput(), /OpenAI provider was removed/);
  });
});

describe('no photo retention at launch (D-21, LC-49)', () => {
  test('photos kept before the flag are deleted at start and old opt-ins are cleared', async (t) => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drinkme-old-scans-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'abc_1700000000000_ffff.jpg'), 'old photo');
    fs.writeFileSync(path.join(dir, 'abc_1700000000000_ffff.json'), '{}');
    const s = await startServer({ AI_PHOTO_DIR: dir }, {
      dbFixture: { users: [{ ...user('old-optin'), aiPhotoOptIn: true, aiPhotoOptInAt: '2026-11-01T00:00:00.000Z', aiPhotoConsentVersion: 1 }] },
    });
    t.after(() => s.stop());
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.match(s.getOutput(), /deleted 2 kept file\(s\), cleared the opt-in on 1 account\(s\)/);
    const saved = JSON.parse(fs.readFileSync(s.dbFile, 'utf8')).users.find((u) => u.id === 'old-optin');
    assert.equal('aiPhotoOptIn' in saved, false);
    assert.equal('aiPhotoOptInAt' in saved, false);
  });
});
