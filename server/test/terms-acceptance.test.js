// Legal T-06: POST /api/users/:id/acknowledgements { type: 'terms', version } records the accepted Terms of
// Use version (highest kept), audits it as the user's own action, and is shown to the owner only.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { startServer } from './helpers/harness.js';

const SECRET = 'test-only-jwt-secret';
const tokenFor = (uid) => jwt.sign({ uid }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const person = (id, extra = {}) => ({
  id, email: `${id}@example.test`, firstName: `Name ${id}`, lastName: '', city: '', bio: '', avatar: null,
  nameSetByUser: true, ageConfirmedAt: '2026-01-01T00:00:00.000Z', privacyNoticeVersion: 2, ...extra,
});

const call = async (server, method, path, uid, body) => {
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tokenFor(uid)}`, ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
};

describe('terms acceptance (acknowledgements, type terms)', () => {
  let server;
  before(async () => {
    server = await startServer({ ADMIN_USER_IDS: 'admin' }, { dbFixture: { dbSchemaVersion: 2, users: [person('alice'), person('bob'), person('admin')] } });
  });
  after(() => server?.stop());

  test('owner sees termsVersion null before, 1 after; repeat and lower versions write nothing', async () => {
    assert.equal((await call(server, 'GET', '/api/users/alice', 'alice')).body.termsVersion, null);
    const accepted = await call(server, 'POST', '/api/users/alice/acknowledgements', 'alice', { type: 'terms', version: 1 });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.termsVersion, 1);
    const again = await call(server, 'POST', '/api/users/alice/acknowledgements', 'alice', { type: 'terms', version: 1 });
    assert.equal(again.status, 200);
    const audit = await call(server, 'GET', '/api/admin/audit?action=ack.terms_accepted', 'admin');
    assert.equal(audit.status, 200);
    const entries = (audit.body.items ?? audit.body.entries ?? []).filter((e) => e.action === 'ack.terms_accepted');
    assert.equal(entries.length, 1, 'one audit entry, not two');
    assert.deepEqual(entries[0].meta, { version: 1 });
  });

  test('versions outside 1..TERMS_VERSION and other users are refused', async () => {
    for (const version of [0, 2, '1', 1.5, undefined]) {
      assert.equal((await call(server, 'POST', '/api/users/bob/acknowledgements', 'bob', { type: 'terms', version })).status, 400, String(version));
    }
    assert.equal((await call(server, 'POST', '/api/users/bob/acknowledgements', 'alice', { type: 'terms', version: 1 })).status, 403);
  });

  test('other people never see termsVersion', async () => {
    const seen = await call(server, 'GET', '/api/users/alice', 'bob');
    assert.equal(seen.status, 200);
    assert.equal('termsVersion' in seen.body, false);
  });
});
