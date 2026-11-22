// GET /readyz: the readiness answer for host health checks (docker-compose, Railway, Render). Public like
// /healthz, outside /api (no rate limit, no sign-in), 200 only when the database is loaded and, under
// production rules, firebase-admin is initialised; otherwise 503 with a fixed reason code and no details.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, test } from 'node:test';

import { READINESS_REASONS, readinessReason } from '../operations.js';
import { startServer } from './helpers/harness.js';

const REQUEST_TIMEOUT_MS = 20_000;
const SERVER_TEST_TIMEOUT_MS = 60_000;

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const productionEnv = (overrides = {}) => ({
  NODE_ENV: 'production',
  AI_PROVIDER: 'off',
  ALLOW_INSECURE_DEV_AUTH: undefined,
  JWT_SECRET: 'abcdefghijklmnopqrstuvwxyz012345',
  FIREBASE_SERVICE_ACCOUNT_KEY: JSON.stringify({
    type: 'service_account',
    project_id: 'drinkme-ready-test',
    private_key: privateKey,
    client_email: 'ready-test@drinkme-ready-test.example.test',
  }),
  ALLOW_EMPTY_DB: 'true',
  ...overrides,
});

const getReadyz = async (baseUrl, headers = {}) => {
  const res = await fetch(`${baseUrl}/readyz`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  return { status: res.status, headers: res.headers, body: await res.json() };
};

const startOn = async (t, env, options) => {
  const server = await startServer(env, options);
  t.after(() => server.stop());
  return server;
};

describe('readinessReason', () => {
  const ready = { dbLoaded: true, firebaseRequired: true, firebaseReady: true, shuttingDown: false };

  test('ready when the database is loaded and Firebase is initialised', () => {
    assert.equal(readinessReason(ready), null);
  });

  test('Firebase is only needed when required (production rules)', () => {
    assert.equal(readinessReason({ ...ready, firebaseRequired: false, firebaseReady: false }), null);
    assert.equal(readinessReason({ ...ready, firebaseReady: false }), READINESS_REASONS.AUTH_NOT_INITIALIZED);
  });

  test('a database that is not loaded is not ready', () => {
    assert.equal(readinessReason({ ...ready, dbLoaded: false }), READINESS_REASONS.DB_NOT_LOADED);
    assert.equal(readinessReason({ ...ready, dbLoaded: false, firebaseReady: false }), READINESS_REASONS.DB_NOT_LOADED);
  });

  test('shutting down wins over everything else', () => {
    assert.equal(readinessReason({ ...ready, shuttingDown: true }), READINESS_REASONS.SHUTTING_DOWN);
    assert.equal(readinessReason({ ...ready, dbLoaded: false, shuttingDown: true }), READINESS_REASONS.SHUTTING_DOWN);
  });

  test('reason codes are short fixed strings', () => {
    assert.deepEqual(Object.values(READINESS_REASONS).sort(), ['auth_not_initialized', 'db_not_loaded', 'shutting_down']);
    for (const code of Object.values(READINESS_REASONS)) assert.match(code, /^[a-z_]{1,32}$/);
  });
});

describe('GET /readyz', () => {
  test('test mode: 200 ready without a session, never cached, liveness unchanged', async (t) => {
    const { baseUrl } = await startOn(t, {});
    const { status, headers, body } = await getReadyz(baseUrl);
    assert.equal(status, 200);
    assert.deepEqual(body, { status: 'ready' });
    assert.equal(headers.get('cache-control'), 'no-store');

    const health = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
  });

  test('a bad bearer token changes nothing: the route is public', async (t) => {
    const { baseUrl } = await startOn(t, {});
    const { status, body } = await getReadyz(baseUrl, { Authorization: 'Bearer not-a-token' });
    assert.equal(status, 200);
    assert.deepEqual(body, { status: 'ready' });
  });

  test('outside /api: health checks never use up the /api rate limit', { timeout: SERVER_TEST_TIMEOUT_MS }, async (t) => {
    const { baseUrl } = await startOn(t, {});
    for (let i = 0; i < 105; i += 1) {
      const res = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      assert.equal(res.status, 200, `request ${i + 1}`);
      await res.arrayBuffer();
    }
    const api = await fetch(`${baseUrl}/api/drinks`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    assert.equal(api.status, 401, 'the /api limiter is untouched (401, not 429)');
  });

  test('production, first deploy (ALLOW_EMPTY_DB): ready, so a healthcheck on /readyz lets it start', { timeout: SERVER_TEST_TIMEOUT_MS }, async (t) => {
    const { baseUrl } = await startOn(t, productionEnv());
    const { status, body } = await getReadyz(baseUrl);
    assert.equal(status, 200);
    assert.deepEqual(body, { status: 'ready' });
  });

  test('production with an existing database: ready, and the answer holds no detail', { timeout: SERVER_TEST_TIMEOUT_MS }, async (t) => {
    const fixture = {
      dbSchemaVersion: 2,
      users: [{ id: 'reader', email: 'reader@example.test', firstName: 'R', lastName: '', city: '', bio: '', avatar: null }],
      drinks: [],
      nextDrinkId: 1,
    };
    const { baseUrl } = await startOn(t, productionEnv({ ALLOW_EMPTY_DB: undefined }), { dbFixture: fixture });
    const { status, body } = await getReadyz(baseUrl);
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body), ['status']);
  });
});
