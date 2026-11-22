// App Check on /api (server/app-check.js, APP_CHECK_MODE). Real tokens need a native app, so the server
// tests use APP_CHECK_TEST_TOKEN (honoured only with NODE_ENV=test) as the one valid token.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, test } from 'node:test';

import { createAppCheckMiddleware, createAppCheckStats, parseAppCheckMode } from '../app-check.js';
import { assertRefusesToStart, startServer } from './helpers/harness.js';

const TOKEN = 'test-app-check-token';
const TIMEOUT = 60_000;

const get = async (server, path, headers = {}) => {
  const res = await fetch(`${server.baseUrl}${path}`, { headers, signal: AbortSignal.timeout(20_000) });
  let body;
  try { body = await res.json(); } catch { body = undefined; }
  return { status: res.status, body };
};

describe('parseAppCheckMode', () => {
  test('off by default, the three modes, anything else invalid (treated as off)', () => {
    assert.deepEqual(parseAppCheckMode(undefined), { mode: 'off', valid: true });
    assert.deepEqual(parseAppCheckMode(' Enforce '), { mode: 'enforce', valid: true });
    assert.deepEqual(parseAppCheckMode('monitor'), { mode: 'monitor', valid: true });
    assert.deepEqual(parseAppCheckMode('enforced'), { mode: 'off', valid: false });
  });
});

describe('createAppCheckMiddleware', () => {
  const run = async (mode, headerValue, verify = async (t) => { if (t !== 'ok') throw new Error('bad'); }) => {
    const results = [];
    const middleware = createAppCheckMiddleware({ mode, verify, onResult: (r) => results.push(r) });
    let nextCalled = false;
    let status = null;
    const res = { set() { return res; }, status(code) { status = code; return { json() {} }; } };
    await middleware({ get: () => headerValue }, res, () => { nextCalled = true; });
    return { nextCalled, status, results };
  };

  test('enforce: valid passes, missing and invalid get 401', async () => {
    assert.deepEqual(await run('enforce', 'ok'), { nextCalled: true, status: null, results: ['valid'] });
    assert.deepEqual(await run('enforce', undefined), { nextCalled: false, status: 401, results: ['missing'] });
    assert.deepEqual(await run('enforce', 'forged'), { nextCalled: false, status: 401, results: ['invalid'] });
  });

  test('monitor counts but never refuses; off does nothing', async () => {
    assert.deepEqual(await run('monitor', undefined), { nextCalled: true, status: null, results: ['missing'] });
    assert.deepEqual(await run('off', undefined), { nextCalled: true, status: null, results: [] });
  });

  test('stats log a line only when something changed', () => {
    const stats = createAppCheckStats();
    stats.record('missing');
    assert.match(stats.summary(), /0 valid, 1 missing, 0 invalid/);
    assert.equal(stats.summary(), null);
  });
});

describe('APP_CHECK_MODE on the server', () => {
  test('enforce: /api without a valid token is refused before the sign-in gate; /healthz is not affected', { timeout: TIMEOUT }, async (t) => {
    const server = await startServer({ APP_CHECK_MODE: 'enforce', APP_CHECK_TEST_TOKEN: TOKEN });
    t.after(() => server.stop());
    assert.equal((await get(server, '/healthz')).status, 200);
    const missing = await get(server, '/api/drinks');
    assert.deepEqual([missing.status, missing.body?.code], [401, 'app_check_failed']);
    const forged = await get(server, '/api/drinks', { 'X-Firebase-AppCheck': 'forged' });
    assert.deepEqual([forged.status, forged.body?.code], [401, 'app_check_failed']);
    // With the token, the request reaches the sign-in gate (no JWT: 401 without the App Check code).
    const valid = await get(server, '/api/drinks', { 'X-Firebase-AppCheck': TOKEN });
    assert.equal(valid.status, 401);
    assert.notEqual(valid.body?.code, 'app_check_failed');
    assert.match(server.getOutput(), /\[app-check\] enforce mode for \/api/);
  });

  test('monitor: nothing is refused and a count is logged', { timeout: TIMEOUT }, async (t) => {
    const server = await startServer({ APP_CHECK_MODE: 'monitor', APP_CHECK_TEST_TOKEN: TOKEN });
    t.after(() => server.stop());
    const res = await get(server, '/api/drinks');
    assert.notEqual(res.body?.code, 'app_check_failed');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.match(server.getOutput(), /\[app-check\] since start: 0 valid, 1 missing, 0 invalid/);
  });

  test('off by default: no App Check at all', { timeout: TIMEOUT }, async (t) => {
    const server = await startServer({});
    t.after(() => server.stop());
    assert.notEqual((await get(server, '/api/drinks')).body?.code, 'app_check_failed');
    assert.doesNotMatch(server.getOutput(), /\[app-check\]/);
  });

  test('production refuses a mistyped APP_CHECK_MODE', { timeout: TIMEOUT }, async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const { output } = await assertRefusesToStart({
      NODE_ENV: 'production',
      JWT_SECRET: 'abcdefghijklmnopqrstuvwxyz012345',
      FIREBASE_SERVICE_ACCOUNT_KEY: JSON.stringify({
        type: 'service_account', project_id: 'drinkme-appcheck-test', private_key: privateKey,
        client_email: 'appcheck-test@drinkme-appcheck-test.example.test',
      }),
      ALLOW_EMPTY_DB: 'true',
      APP_CHECK_MODE: 'enforced',
    });
    assert.match(output, /APP_CHECK_MODE \(off, monitor or enforce\)/);
  });
});
