// /api rate limits: 100 requests / 15 min per signed-in user (per IP when signed out) under a per-IP
// ceiling of 1000. Many users behind one IP (bar Wi-Fi, carrier CGNAT) must not block each other.
// The limiters run before the sign-in gate, so any /api answer that is not 429 counts as "let through".
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { startServer } from './helpers/harness.js';

const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const SERVER_TEST_TIMEOUT_MS = 180_000;
const tokenFor = (uid) => jwt.sign({ uid }, HARNESS_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

const statusOf = async (baseUrl, token) => {
  const res = await fetch(`${baseUrl}/api/notifications`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(20_000),
  });
  await res.arrayBuffer();
  return res.status;
};

const burst = async (baseUrl, token, count) => {
  const statuses = [];
  for (let i = 0; i < count; i += 1) statuses.push(await statusOf(baseUrl, token));
  return statuses;
};

describe('/api rate limits', () => {
  test('per user: the 101st request of one user gets 429, other users and signed-out calls on the same IP do not', { timeout: SERVER_TEST_TIMEOUT_MS }, async (t) => {
    const server = await startServer();
    t.after(() => server.stop());
    const alice = tokenFor('rate-alice');

    const first = await burst(server.baseUrl, alice, 100);
    assert.ok(first.every((status) => status !== 429), 'the first 100 pass');
    assert.equal(await statusOf(server.baseUrl, alice), 429);

    assert.notEqual(await statusOf(server.baseUrl, tokenFor('rate-bob')), 429, 'another user on the same IP');
    assert.notEqual(await statusOf(server.baseUrl, undefined), 429, 'signed out: its own per-IP bucket');
    assert.notEqual(await statusOf(server.baseUrl, 'not-a-valid-token'), 429, 'an invalid token falls back to the IP bucket');
  });

  test('per IP: the ceiling of 1000 requests applies across all users', { timeout: SERVER_TEST_TIMEOUT_MS }, async (t) => {
    const server = await startServer();
    t.after(() => server.stop());

    for (let user = 0; user < 10; user += 1) {
      const statuses = await burst(server.baseUrl, tokenFor(`rate-user-${user}`), 100);
      assert.ok(statuses.every((status) => status !== 429), `user ${user} stays under both limits`);
    }
    assert.equal(await statusOf(server.baseUrl, tokenFor('rate-user-new')), 429, 'the IP ceiling is reached');
  });
});
