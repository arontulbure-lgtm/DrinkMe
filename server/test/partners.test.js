import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { startServer } from './helpers/harness.js';

const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const FAULT_PRELOAD = new URL('./helpers/db-fault-preload.js', import.meta.url).href;
const FAULT_ENV = { DB_FAULT: 'save', NODE_OPTIONS: `--import=${FAULT_PRELOAD}` };
const CONFIRMED_AT = '2026-01-02T03:04:05.000Z';
const OLD = '2026-01-01T00:00:00.000Z';
const FLAG_OFF = { PARTNER_CONSENT_REQUIRED: 'false' };

const tokenFor = (uid) => jwt.sign({ uid }, HARNESS_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const readDb = (server) => JSON.parse(fs.readFileSync(server.dbFile, 'utf8'));
const failSaves = (server) => fs.writeFileSync(`${server.dbFile}.fail-saves`, '');
const allowSaves = (server) => fs.rmSync(`${server.dbFile}.fail-saves`);

const person = (id) => ({
  id, email: `${id}@example.test`, firstName: id, lastName: 'Test', city: 'Cluj', bio: '', nameSetByUser: true, avatar: null, ageConfirmedAt: CONFIRMED_AT,
});
const post = (id, userId) => ({
  id, userId, name: `Post ${id}`, description: 'Plain', rating: 4, location: null, isAlcoholic: false, createdAt: OLD, cheersCount: 0, tags: [],
});
const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const RECENT = daysAgo(1); // one value, so a request read back from the file compares equal
const request = (fromId, createdAt = RECENT) => ({ fromId, createdAt });
const limitEvents = (count) => Array.from({ length: count }, () => ({ kind: 'partner_request', at: daysAgo(0.5) }));

const call = async (server, method, route, uid) => {
  const res = await fetch(`${server.baseUrl}${route}`, {
    method,
    headers: uid ? { Authorization: `Bearer ${tokenFor(uid)}` } : {},
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = undefined; }
  return { status: res.status, text, body };
};
const ask = (server, from, to) => call(server, 'POST', `/api/drink-partners/${to}`, from);
const idsOf = (res) => res.body.items.map((item) => item.id);
const noticesOf = async (server, uid) => (await call(server, 'GET', '/api/notifications', uid)).body.notifications;
const statusOf = async (server, viewer, other) => (await call(server, 'GET', `/api/users/${other}`, viewer)).body.partnerStatus;

const fixture = (extra = {}) => ({
  users: [person('alice'), person('bob'), person('carol')],
  drinks: [post(1, 'alice'), post(2, 'bob'), post(3, 'carol')],
  nextDrinkId: 4,
  ...extra,
});
const partnered = () => ({ alice: ['bob'], bob: ['alice'] });

const start = async (t, env, dbFixture) => {
  const server = await startServer(env, { dbFixture });
  t.after(() => server.stop());
  return server;
};

describe('POST /api/drink-partners/:targetId with consent on', () => {
  test('a request partners nobody and changes neither feed', async (t) => {
    const server = await start(t, {}, fixture());
    const feeds = async (uid) => ({
      partners: idsOf(await call(server, 'GET', '/api/drinks/partners', uid)),
      discover: idsOf(await call(server, 'GET', '/api/drinks?scope=discover', uid)),
    });
    const before = { alice: await feeds('alice'), bob: await feeds('bob') };

    const res = await ask(server, 'alice', 'bob');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'requested', isPartner: false });

    assert.deepEqual({ alice: await feeds('alice'), bob: await feeds('bob') }, before);
    assert.deepEqual((await call(server, 'GET', '/api/drink-partners', 'alice')).body, []);
    assert.deepEqual((await call(server, 'GET', '/api/drink-partners', 'bob')).body, []);
    assert.equal((await call(server, 'GET', '/api/drinks/2', 'alice')).body.isPartner, false);
    assert.equal((await call(server, 'GET', '/api/friends/count', 'bob')).body, 0);
    assert.equal((await call(server, 'GET', '/api/users/bob/partners', 'alice')).status, 403);
    assert.equal(await statusOf(server, 'alice', 'bob'), 'requested');
    assert.equal(await statusOf(server, 'bob', 'alice'), 'incoming');

    const notices = await noticesOf(server, 'bob');
    assert.deepEqual(notices.map((n) => n.type), ['partner_request']);
    assert.equal(notices[0].message, 'alice Test sent you a drink partner request.');
  });

  test('a repeat changes nothing and sends nothing', async (t) => {
    const server = await start(t, {}, fixture());
    await ask(server, 'alice', 'bob');
    const dbBefore = fs.readFileSync(server.dbFile);
    const repeat = await ask(server, 'alice', 'bob');
    assert.deepEqual(repeat.body, { status: 'requested', isPartner: false });
    assert.deepEqual(fs.readFileSync(server.dbFile), dbBefore);
  });

  test('checks the caller and the target', async (t) => {
    const server = await start(t, {}, fixture());
    assert.equal((await ask(server, undefined, 'bob')).status, 401);
    assert.equal((await ask(server, 'alice', 'alice')).status, 400);
    assert.equal((await ask(server, 'alice', 'nobody')).status, 404);
    assert.equal(readDb(server).partnerRequestsByUser?.bob, undefined);
  });

  test('crossed requests accept each other', async (t) => {
    const server = await start(t, {}, fixture());
    await ask(server, 'alice', 'bob');
    const crossed = await ask(server, 'bob', 'alice');
    assert.deepEqual(crossed.body, { status: 'partner', isPartner: true });
    const db = readDb(server);
    assert.deepEqual(db.partnersByUser.alice, ['bob']);
    assert.deepEqual(db.partnersByUser.bob, ['alice']);
    assert.deepEqual(db.partnerRequestsByUser, {});
    assert.deepEqual((await noticesOf(server, 'alice')).map((n) => n.type), ['partner']);
  });

  test('already partners: returns the state and no longer removes anyone', async (t) => {
    const server = await start(t, {}, fixture({ partnersByUser: partnered() }));
    const res = await ask(server, 'alice', 'bob');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'partner', isPartner: true });
    assert.deepEqual(readDb(server).partnersByUser.alice, ['bob']);
    assert.deepEqual(await noticesOf(server, 'bob'), []);
  });

  test('at most 50 pending outgoing, counting only live ones', async (t) => {
    const others = Array.from({ length: 51 }, (_, i) => `user${i}`);
    const pending = Object.fromEntries(others.slice(0, 50).map((id) => [id, [request('alice')]]));
    const server = await start(t, {}, {
      users: [person('alice'), person('bob'), ...others.map(person)],
      partnerRequestsByUser: pending,
    });
    const refused = await ask(server, 'alice', 'user50');
    assert.equal(refused.status, 429);
    assert.equal(refused.body.code, 'partner_request_limit');
    assert.equal((await ask(server, 'alice', 'user0')).body.status, 'requested', 'a repeat is not refused');
    assert.equal((await ask(server, 'bob', 'alice')).body.status, 'requested', 'other users are not counted');

    assert.equal((await call(server, 'DELETE', '/api/drink-partners/user0', 'alice')).status, 204);
    assert.equal((await ask(server, 'alice', 'user50')).status, 200);
  });

  test('a pending request to someone in a block with the asker does not use up the cap', async (t) => {
    const others = Array.from({ length: 49 }, (_, i) => `user${i}`);
    const pending = Object.fromEntries(others.map((id) => [id, [request('alice')]]));
    const server = await start(t, {}, {
      users: [person('alice'), person('blocker'), person('bob'), person('carol'), ...others.map(person)],
      partnerRequestsByUser: { ...pending, blocker: [request('alice')] },
      blocksByUser: { blocker: ['alice'] },
    });
    assert.equal((await ask(server, 'alice', 'bob')).body.status, 'requested', 'the 50th live one');
    assert.equal((await ask(server, 'alice', 'carol')).body.code, 'partner_request_limit');
  });

  test('at most 100 new requests per 24 hours, and cancelling gives none back', async (t) => {
    const server = await start(t, {}, fixture({
      users: [person('alice'), person('bob'), person('carol'), person('dana')],
      limitEventsByUser: { alice: limitEvents(99) },
      partnerRequestsByUser: { alice: [request('dana')] },
    }));
    assert.equal((await ask(server, 'alice', 'bob')).body.status, 'requested', 'the 100th');
    assert.equal(readDb(server).limitEventsByUser.alice.length, 100);
    assert.equal((await ask(server, 'alice', 'bob')).body.status, 'requested', 'a repeat is not counted or refused');
    assert.equal(readDb(server).limitEventsByUser.alice.length, 100);

    assert.equal((await call(server, 'DELETE', '/api/drink-partners/bob', 'alice')).status, 204);
    const refused = await ask(server, 'alice', 'carol');
    assert.equal(refused.status, 429);
    assert.equal(refused.body.code, 'partner_request_limit');
    assert.equal(await statusOf(server, 'alice', 'carol'), 'none');
    assert.equal(readDb(server).limitEventsByUser.alice.length, 100);

    assert.equal((await ask(server, 'alice', 'dana')).body.status, 'partner', 'an accept is not a new request');
    assert.equal((await ask(server, 'bob', 'carol')).body.status, 'requested', 'other users are not counted');
    await server.restart();
    assert.equal((await ask(server, 'alice', 'carol')).status, 429, 'the count survives a restart');
  });

  test('events outside the 24 hours and of another kind are not counted', async (t) => {
    const old = Array.from({ length: 100 }, () => ({ kind: 'partner_request', at: daysAgo(1.1) }));
    const comments = Array.from({ length: 100 }, () => ({ kind: 'comment', at: daysAgo(0.5) }));
    const server = await start(t, {}, fixture({ limitEventsByUser: { alice: [...old, ...comments] } }));
    assert.equal((await ask(server, 'alice', 'bob')).body.status, 'requested');
  });

  test('an unread notification past its 7 days does not stop a new one', async (t) => {
    const expired = { id: 1, type: 'partner_request', message: 'Old', actorId: 'alice', read: false, createdAt: daysAgo(8) };
    const server = await start(t, {}, fixture({ notificationsByUser: { bob: [expired] }, nextNotificationId: 2 }));
    await ask(server, 'alice', 'bob');
    assert.deepEqual((await noticesOf(server, 'bob')).map((n) => n.id), [2]);
  });

  test('cancelling and asking again does not repeat an unread notification', async (t) => {
    const server = await start(t, {}, fixture());
    await ask(server, 'alice', 'bob');
    await call(server, 'DELETE', '/api/drink-partners/bob', 'alice');
    await ask(server, 'alice', 'bob');
    assert.equal((await noticesOf(server, 'bob')).length, 1);
    await call(server, 'POST', '/api/notifications/read', 'bob');
    await call(server, 'DELETE', '/api/drink-partners/bob', 'alice');
    await ask(server, 'alice', 'bob');
    assert.equal((await noticesOf(server, 'bob')).length, 2, 'once read, a new request is news again');
  });
});

describe('answering a request', () => {
  const pendingFromBob = () => fixture({ partnerRequestsByUser: { alice: [request('bob')] } });

  test('accept partners both sides, notifies the asker and changes the feeds', async (t) => {
    const server = await start(t, {}, pendingFromBob());
    const res = await call(server, 'POST', '/api/drink-partners/requests/bob/accept', 'alice');
    assert.deepEqual(res.body, { status: 'partner', isPartner: true });

    assert.deepEqual((await call(server, 'GET', '/api/drink-partners', 'alice')).body.map((u) => u.id), ['bob']);
    assert.deepEqual((await call(server, 'GET', '/api/drink-partners', 'bob')).body.map((u) => u.id), ['alice']);
    assert.deepEqual(idsOf(await call(server, 'GET', '/api/drinks/partners', 'alice')), [2, 1]);
    assert.equal((await call(server, 'GET', '/api/drinks/2', 'alice')).body.isPartner, true);
    assert.equal((await call(server, 'GET', '/api/friends/count', 'alice')).body, 1);
    const notices = await noticesOf(server, 'bob');
    assert.deepEqual(notices.map((n) => n.type), ['partner']);
    assert.equal(notices[0].message, 'alice Test accepted your drink partner request.');

    assert.equal((await call(server, 'POST', '/api/drink-partners/requests/bob/accept', 'alice')).body.status, 'partner', 'a repeat');
    assert.equal((await noticesOf(server, 'bob')).length, 1);
  });

  test('only the one asked can accept, and only a request that exists', async (t) => {
    const server = await start(t, {}, pendingFromBob());
    assert.equal((await call(server, 'POST', '/api/drink-partners/requests/bob/accept')).status, 401);
    assert.equal((await call(server, 'POST', '/api/drink-partners/requests/alice/accept', 'bob')).status, 404, 'the asker cannot accept their own');
    assert.equal((await call(server, 'POST', '/api/drink-partners/requests/bob/accept', 'carol')).status, 404);
    assert.equal((await call(server, 'POST', '/api/drink-partners/requests/nobody/accept', 'alice')).status, 404);
    assert.deepEqual(readDb(server).partnersByUser ?? {}, {});
  });

  test('a decline is silent and allows a new request', async (t) => {
    const server = await start(t, {}, pendingFromBob());
    assert.equal((await call(server, 'DELETE', '/api/drink-partners/requests/bob')).status, 401);
    assert.equal((await call(server, 'DELETE', '/api/drink-partners/requests/bob', 'alice')).status, 204);
    assert.equal((await call(server, 'DELETE', '/api/drink-partners/requests/bob', 'alice')).status, 204, 'idempotent');
    assert.deepEqual(await noticesOf(server, 'bob'), [], 'silent');
    assert.equal(await statusOf(server, 'bob', 'alice'), 'none');
    assert.deepEqual(readDb(server).partnerRequestsByUser, {});
    assert.equal((await ask(server, 'bob', 'alice')).body.status, 'requested');
  });

  test('a stranger cannot decline for someone else', async (t) => {
    const server = await start(t, {}, pendingFromBob());
    assert.equal((await call(server, 'DELETE', '/api/drink-partners/requests/bob', 'carol')).status, 204);
    assert.equal(await statusOf(server, 'alice', 'bob'), 'incoming');
  });
});

describe('DELETE /api/drink-partners/:targetId', () => {
  test('cancels an outgoing request, and leaves an incoming one alone', async (t) => {
    const server = await start(t, {}, fixture());
    await ask(server, 'alice', 'bob');
    assert.equal((await call(server, 'DELETE', '/api/drink-partners/alice', 'bob')).status, 204, 'the other side');
    assert.equal(await statusOf(server, 'alice', 'bob'), 'requested');

    const cancelled = await call(server, 'DELETE', '/api/drink-partners/bob', 'alice');
    assert.equal(cancelled.status, 204);
    assert.equal(cancelled.text, '');
    assert.equal(await statusOf(server, 'alice', 'bob'), 'none');
    assert.equal((await call(server, 'POST', '/api/drink-partners/requests/alice/accept', 'bob')).status, 404, 'nothing left to accept');
  });

  test('either side removes a partnership, with no notification', async (t) => {
    const server = await start(t, {}, fixture({ partnersByUser: partnered() }));
    assert.equal((await call(server, 'DELETE', '/api/drink-partners/alice', 'bob')).status, 204);
    const db = readDb(server);
    assert.deepEqual(db.partnersByUser.alice, []);
    assert.deepEqual(db.partnersByUser.bob, []);
    assert.deepEqual(await noticesOf(server, 'alice'), []);
    assert.equal((await call(server, 'GET', '/api/users/alice/partners', 'bob')).status, 403);
    assert.equal((await call(server, 'DELETE', '/api/drink-partners/alice', 'bob')).status, 204, 'idempotent');
  });

  test('?expect= acts only on the state the button showed, and otherwise answers 409 with the current one', async (t) => {
    const server = await start(t, {}, fixture({
      users: [person('alice'), person('bob'), person('carol'), person('dana')],
      partnersByUser: partnered(),
      partnerRequestsByUser: { carol: [request('alice')], alice: [request('dana')] },
    }));
    const remove = (target, expect) => call(server, 'DELETE', `/api/drink-partners/${target}?expect=${expect}`, 'alice');
    const dbBefore = fs.readFileSync(server.dbFile);
    for (const [target, expect, status] of [
      ['bob', 'request', 'partner'],
      ['carol', 'partner', 'requested'],
      ['dana', 'request', 'incoming'],
      ['dana', 'partner', 'incoming'],
    ]) {
      const res = await remove(target, expect);
      assert.equal(res.status, 409, `${target} ${expect}`);
      assert.equal(res.body.status, status);
      assert.equal(res.body.isPartner, status === 'partner');
      assert.equal(res.body.code, 'partner_state_changed');
    }
    assert.deepEqual(fs.readFileSync(server.dbFile), dbBefore, 'nothing changed');
    assert.equal((await call(server, 'DELETE', '/api/drink-partners/bob?expect=nonsense', 'alice')).status, 400);
    assert.equal((await call(server, 'DELETE', '/api/drink-partners/bob?expect=partner&expect=request', 'alice')).status, 400);
    assert.equal(await statusOf(server, 'alice', 'bob'), 'partner');

    assert.equal((await remove('bob', 'partner')).status, 204);
    assert.equal(await statusOf(server, 'alice', 'bob'), 'none');
    assert.equal((await remove('carol', 'request')).status, 204);
    assert.equal(await statusOf(server, 'alice', 'carol'), 'none');
    assert.equal((await remove('carol', 'request')).body.status, 'none', 'already gone');
  });

  test('without expect, a stale "Requested" press still removes a new partnership', async (t) => {
    const server = await start(t, {}, fixture({ partnersByUser: partnered() }));
    assert.equal((await call(server, 'DELETE', '/api/drink-partners/bob', 'alice')).status, 204);
    assert.equal(await statusOf(server, 'alice', 'bob'), 'none');
  });

  test('checks the caller and the target', async (t) => {
    const server = await start(t, {}, fixture({ blocksByUser: { bob: ['alice'] } }));
    assert.equal((await call(server, 'DELETE', '/api/drink-partners/bob')).status, 401);
    assert.equal((await call(server, 'DELETE', '/api/drink-partners/alice', 'alice')).status, 400);
    assert.equal((await call(server, 'DELETE', '/api/drink-partners/nobody', 'alice')).status, 404);
    assert.equal((await call(server, 'DELETE', '/api/drink-partners/bob', 'alice')).status, 404);
  });
});

describe('GET /api/drink-partners/requests', () => {
  test('lists both directions as public users, newest first, with no email', async (t) => {
    const server = await start(t, {}, fixture({
      partnerRequestsByUser: {
        alice: [request('bob', daysAgo(3)), request('carol', daysAgo(2))],
        carol: [request('bob', daysAgo(1))],
      },
    }));
    assert.equal((await call(server, 'GET', '/api/drink-partners/requests')).status, 401);

    const alice = await call(server, 'GET', '/api/drink-partners/requests', 'alice');
    assert.deepEqual(alice.body.incoming.map((u) => u.id), ['carol', 'bob']);
    assert.ok(alice.body.incoming.every((u) => typeof u.createdAt === 'string'));
    assert.deepEqual(alice.body.outgoing, []);
    assert.equal(alice.body.incoming[0].firstName, 'carol');
    assert.ok(!alice.text.includes('@example.test'));

    const bob = await call(server, 'GET', '/api/drink-partners/requests', 'bob');
    assert.deepEqual(bob.body.incoming, []);
    assert.deepEqual(bob.body.outgoing.map((u) => u.id), ['carol', 'alice']);
    assert.ok(!bob.text.includes('@example.test'));
  });

  test('entries for a user who no longer exists, and malformed ones, are dropped', async (t) => {
    const server = await start(t, {}, fixture({
      partnerRequestsByUser: {
        alice: [request('ghost'), null, 'x', { fromId: 'bob' }, request('carol')],
        ghost: [request('alice')],
      },
    }));
    const res = await call(server, 'GET', '/api/drink-partners/requests', 'alice');
    assert.deepEqual(res.body.incoming.map((u) => u.id), ['carol']);
    assert.deepEqual(res.body.outgoing, []);

    await call(server, 'POST', '/api/notifications/read', 'alice');
    assert.deepEqual(readDb(server).partnerRequestsByUser, { alice: [request('carol')] });
  });

  test('a request left across a block in the file is neither listed nor accepted', async (t) => {
    const server = await start(t, {}, fixture({
      partnerRequestsByUser: { alice: [request('bob')] },
      blocksByUser: { alice: ['bob'] },
    }));
    for (const uid of ['alice', 'bob']) {
      const { body } = await call(server, 'GET', '/api/drink-partners/requests', uid);
      assert.deepEqual([body.incoming, body.outgoing], [[], []], uid);
    }
    assert.equal((await call(server, 'POST', '/api/drink-partners/requests/bob/accept', 'alice')).status, 404);
  });

  test('a request is pending for 90 days and gone after that', async (t) => {
    const server = await start(t, {}, fixture({
      partnerRequestsByUser: { alice: [request('bob', daysAgo(89)), request('carol', daysAgo(91))], bob: [{ fromId: 'carol', createdAt: 'not a date' }] },
    }));
    const { body } = await call(server, 'GET', '/api/drink-partners/requests', 'alice');
    assert.deepEqual(body.incoming.map((u) => u.id), ['bob']);
    assert.equal(await statusOf(server, 'alice', 'carol'), 'none');
    assert.equal((await call(server, 'POST', '/api/drink-partners/requests/carol/accept', 'alice')).status, 404);
    await call(server, 'POST', '/api/notifications/read', 'alice');
    const saved = readDb(server).partnerRequestsByUser;
    assert.deepEqual(saved.alice.map((r) => r.fromId), ['bob']);
    assert.equal(saved.bob, undefined);
  });
});

describe('GET /api/users/:id/partners', () => {
  const dbFixture = () => fixture({
    users: [person('alice'), person('bob'), person('carol'), person('dana')],
    partnersByUser: { alice: ['bob', 'dana'], bob: ['alice'], dana: ['alice'] },
    blocksByUser: { bob: ['dana'] },
  });

  for (const [label, env] of [['consent on', {}], ['consent off', FLAG_OFF]]) {
    test(`${label}: 401 logged out, 403 stranger, 200 partner and owner, no email`, async (t) => {
      const server = await start(t, env, dbFixture());
      assert.equal((await call(server, 'GET', '/api/users/alice/partners')).status, 401);

      const stranger = await call(server, 'GET', '/api/users/alice/partners', 'carol');
      assert.equal(stranger.status, 403);
      assert.equal(stranger.body.code, 'partner_list_private');
      assert.ok(!stranger.text.includes('dana'));

      const owner = await call(server, 'GET', '/api/users/alice/partners', 'alice');
      assert.deepEqual(owner.body.map((u) => [u.id, u.isPartner]), [['bob', true], ['dana', true]]);
      assert.ok(!owner.text.includes('@example.test'));
      const ownList = await call(server, 'GET', '/api/drink-partners', 'alice');
      assert.equal(ownList.body.length, 2);
      assert.ok(!ownList.text.includes('@example.test'));
      const otherProfile = await call(server, 'GET', '/api/users/alice', 'bob');
      assert.equal(otherProfile.body.partnerCount, 1, 'matches the list this viewer may see');
      assert.ok(!otherProfile.text.includes('@example.test'));

      const partner = await call(server, 'GET', '/api/users/alice/partners', 'bob');
      assert.equal(partner.status, 200);
      assert.deepEqual(partner.body.map((u) => u.id), ['bob'], 'someone in a block with the viewer stays out');
    });
  }

  test('someone with a pending request is still a stranger', async (t) => {
    const server = await start(t, {}, dbFixture());
    await ask(server, 'carol', 'alice');
    assert.equal((await call(server, 'GET', '/api/users/alice/partners', 'carol')).status, 403);
    assert.equal((await call(server, 'GET', '/api/users/nobody/partners', 'carol')).status, 404);
  });
});

describe('partnerStatus and partnerCount', () => {
  test('never for a logged-out viewer, who gets nothing at all', async (t) => {
    const server = await start(t, {}, fixture({ partnersByUser: partnered(), partnerRequestsByUser: { alice: [request('carol')] } }));
    const res = await call(server, 'GET', '/api/users/alice');
    assert.equal(res.status, 401);
    assert.ok(!res.text.includes('partnerStatus') && !res.text.includes('partnerCount'));
    const list = await call(server, 'GET', '/api/drinks');
    assert.equal(list.status, 401);
    assert.ok(!list.text.includes('partnerStatus') && !list.text.includes('partnerCount'));
  });

  test('the count goes to the owner and partners only, and a third party learns nothing of a request', async (t) => {
    const server = await start(t, {}, fixture({ partnersByUser: partnered(), partnerRequestsByUser: { alice: [request('carol')] } }));
    const profile = (viewer, id) => call(server, 'GET', `/api/users/${id}`, viewer);

    assert.equal((await profile('alice', 'alice')).body.partnerCount, 1);
    assert.equal('partnerStatus' in (await profile('alice', 'alice')).body, false);
    assert.equal((await profile('bob', 'alice')).body.partnerCount, 1);
    assert.equal((await profile('bob', 'alice')).body.partnerStatus, 'partner');

    const third = await profile('carol', 'bob');
    assert.equal(third.body.partnerStatus, 'none');
    assert.equal('partnerCount' in third.body, false);
    const asker = await profile('carol', 'alice');
    assert.equal(asker.body.partnerStatus, 'requested');
    assert.equal('partnerCount' in asker.body, false, 'a request does not open the count');

    const aboutCarol = await profile('bob', 'carol');
    assert.equal(aboutCarol.body.partnerStatus, 'none', 'bob cannot see that carol asked alice');
    assert.ok(!(await call(server, 'GET', '/api/drinks/1', 'bob')).text.includes('carol'));
  });

  test('search adds the status for others and shows no count', async (t) => {
    const server = await start(t, {}, fixture({ partnersByUser: { alice: ['carol'], carol: ['alice'] }, partnerRequestsByUser: { alice: [request('bob')] } }));
    const res = await call(server, 'GET', '/api/users/search?q=cluj', 'alice');
    const byId = Object.fromEntries(res.body.map((u) => [u.id, u]));
    assert.equal(byId.bob.partnerStatus, 'incoming');
    assert.equal(byId.bob.isPartner, false);
    assert.equal(byId.carol.partnerStatus, 'partner');
    assert.equal(byId.carol.isPartner, true);
    assert.equal('partnerStatus' in byId.alice, false, 'not about yourself');
    assert.ok(!res.text.includes('partnerCount'));
    assert.ok(!res.text.includes('@example.test'));
  });
});

describe('a block and partner requests', () => {
  for (const [blocker, blocked] of [['alice', 'bob'], ['bob', 'alice']]) {
    test(`${blocker} blocks ${blocked}: requests in both directions go, and do not come back`, async (t) => {
      const server = await start(t, {}, fixture({
        partnerRequestsByUser: { alice: [request('bob'), request('carol')], bob: [request('alice')] },
      }));
      assert.equal((await call(server, 'POST', `/api/blocks/${blocked}`, blocker)).status, 200);
      assert.deepEqual(readDb(server).partnerRequestsByUser, { alice: [request('carol')] }, 'other requests stay');

      assert.equal((await call(server, 'POST', '/api/drink-partners/requests/bob/accept', 'alice')).status, 404);
      assert.equal((await ask(server, 'alice', 'bob')).status, 404);
      assert.equal((await ask(server, 'bob', 'alice')).status, 404);

      assert.equal((await call(server, 'DELETE', `/api/blocks/${blocked}`, blocker)).status, 204);
      assert.equal(await statusOf(server, 'alice', 'bob'), 'none');
      assert.equal(await statusOf(server, 'bob', 'alice'), 'none');
    });
  }

  test('a failed save puts the requests back', async (t) => {
    const server = await start(t, FAULT_ENV, fixture({ partnerRequestsByUser: { alice: [request('bob')], bob: [request('alice')] } }));
    failSaves(server);
    assert.equal((await call(server, 'POST', '/api/blocks/bob', 'alice')).status, 503);
    allowSaves(server);
    assert.equal(await statusOf(server, 'alice', 'bob'), 'requested');
    await call(server, 'POST', '/api/notifications/read', 'alice');
    assert.deepEqual(readDb(server).partnerRequestsByUser, { alice: [request('bob')], bob: [request('alice')] });
  });
});

describe('persistence', () => {
  test('requests survive a restart, and can be accepted after it', async (t) => {
    const server = await start(t, {}, fixture());
    await ask(server, 'alice', 'bob');
    await server.restart();
    assert.equal(await statusOf(server, 'alice', 'bob'), 'requested');
    assert.equal((await ask(server, 'alice', 'bob')).body.status, 'requested');
    assert.equal((await call(server, 'POST', '/api/drink-partners/requests/alice/accept', 'bob')).status, 200);
    await server.restart();
    assert.equal(await statusOf(server, 'alice', 'bob'), 'partner');
    assert.deepEqual(readDb(server).partnerRequestsByUser, {});
  });

  test('a file from before this key loads and works', async (t) => {
    const server = await start(t, {}, fixture({ partnersByUser: partnered() }));
    assert.equal(await statusOf(server, 'alice', 'bob'), 'partner', 'an existing partnership is kept');
    assert.equal((await ask(server, 'carol', 'alice')).body.status, 'requested');
  });

  for (const value of ['x', [], { alice: 'x' }]) {
    test(`a partnerRequestsByUser of ${JSON.stringify(value)} counts as a corrupt database`, async (t) => {
      const server = await start(t, {}, { users: [person('alice')], partnerRequestsByUser: value });
      // alice's own JWT finds no account: the database started empty.
      assert.equal((await call(server, 'GET', '/api/users/alice', 'alice')).status, 401, 'started empty');
    });
  }
});

describe('the storage limit', () => {
  const limited = { DB_GROWTH_MAX_BYTES: '1' };
  const dbFixture = () => fixture({ partnersByUser: partnered(), partnerRequestsByUser: { alice: [request('carol')], carol: [request('bob')] } });

  test('new requests and accepts get 507, with no change', async (t) => {
    const server = await start(t, limited, { ...dbFixture(), users: [person('alice'), person('bob'), person('carol'), person('dana')] });
    const dbBefore = fs.readFileSync(server.dbFile);
    for (const res of [
      await ask(server, 'dana', 'alice'),
      await ask(server, 'alice', 'carol'),
      await call(server, 'POST', '/api/drink-partners/requests/carol/accept', 'alice'),
    ]) {
      assert.deepEqual([res.status, res.body.code], [507, 'storage_full']);
    }
    assert.deepEqual(fs.readFileSync(server.dbFile), dbBefore);
    assert.deepEqual(await noticesOf(server, 'alice'), []);
    assert.deepEqual(await noticesOf(server, 'carol'), []);
  });

  test('a repeat, a decline, a cancel and a removal stay open', async (t) => {
    const server = await start(t, limited, dbFixture());
    assert.equal((await ask(server, 'carol', 'alice')).body.status, 'requested', 'a repeat');
    assert.equal((await ask(server, 'alice', 'bob')).body.status, 'partner', 'already partners');
    assert.equal((await call(server, 'DELETE', '/api/drink-partners/requests/carol', 'alice')).status, 204);
    assert.equal((await call(server, 'DELETE', '/api/drink-partners/carol', 'bob')).status, 204);
    assert.equal((await call(server, 'DELETE', '/api/drink-partners/bob', 'alice')).status, 204);
    assert.deepEqual(readDb(server).partnerRequestsByUser, {});
    assert.deepEqual(readDb(server).partnersByUser.alice, []);
  });
});

describe('a failed save', () => {
  const pending = () => fixture({ partnerRequestsByUser: { alice: [request('bob')] }, notificationsByUser: {}, nextNotificationId: 5 });

  // A successful save, so the comparison reads what is in memory.
  const memoryAfter = async (server) => {
    await call(server, 'POST', '/api/notifications/read', 'carol');
    const { partnersByUser, partnerRequestsByUser, nextNotificationId, notificationsByUser, limitEventsByUser } = readDb(server);
    return {
      limitEvents: limitEventsByUser,
      partners: partnersByUser,
      requests: partnerRequestsByUser,
      nextNotificationId,
      noticesForAlice: notificationsByUser.alice ?? [],
      noticesForBob: notificationsByUser.bob ?? [],
    };
  };

  const cases = [
    ['a new request', (server) => ask(server, 'carol', 'alice')],
    ['an accept', (server) => call(server, 'POST', '/api/drink-partners/requests/bob/accept', 'alice')],
    ['a crossed request', (server) => ask(server, 'alice', 'bob')],
    ['a decline', (server) => call(server, 'DELETE', '/api/drink-partners/requests/bob', 'alice')],
    ['a cancel', (server) => call(server, 'DELETE', '/api/drink-partners/alice', 'bob')],
  ];
  for (const [label, run] of cases) {
    test(`${label} returns 503 and changes nothing`, async (t) => {
      const server = await start(t, FAULT_ENV, pending());
      const before = await memoryAfter(server);
      failSaves(server);
      assert.equal((await run(server)).status, 503);
      allowSaves(server);
      assert.deepEqual(await memoryAfter(server), before);
      assert.deepEqual(await noticesOf(server, 'bob'), []);
      assert.deepEqual(await noticesOf(server, 'alice'), []);
    });
  }

  test('removing a partner returns 503 and keeps the partnership', async (t) => {
    const server = await start(t, FAULT_ENV, fixture({ partnersByUser: partnered() }));
    failSaves(server);
    assert.equal((await call(server, 'DELETE', '/api/drink-partners/bob', 'alice')).status, 503);
    allowSaves(server);
    assert.equal(await statusOf(server, 'alice', 'bob'), 'partner');
    assert.equal(await statusOf(server, 'bob', 'alice'), 'partner');
  });

  test('with consent off, a link returns 503 and links nobody', async (t) => {
    const server = await start(t, { ...FAULT_ENV, ...FLAG_OFF }, fixture());
    failSaves(server);
    assert.equal((await ask(server, 'alice', 'bob')).status, 503);
    allowSaves(server);
    assert.equal(await statusOf(server, 'alice', 'bob'), 'none');
    assert.deepEqual(await noticesOf(server, 'bob'), []);
  });
});

describe('PARTNER_CONSENT_REQUIRED', () => {
  test('off: POST links both sides at once and clears pending requests', async (t) => {
    const server = await start(t, FLAG_OFF, fixture({
      partnerRequestsByUser: { alice: [request('bob')], carol: [request('alice')] },
    }));
    const direct = await ask(server, 'carol', 'bob');
    assert.deepEqual(direct.body, { status: 'partner', isPartner: true });
    assert.deepEqual((await noticesOf(server, 'bob')).map((n) => [n.type, n.message]), [['partner', 'carol Test added you as a drink partner.']]);

    assert.equal((await ask(server, 'alice', 'bob')).body.status, 'partner', 'an incoming request between the pair');
    assert.equal((await ask(server, 'alice', 'carol')).body.status, 'partner', 'an outgoing request between the pair');
    const db = readDb(server);
    assert.deepEqual(db.partnerRequestsByUser, {});
    assert.deepEqual(db.partnersByUser.alice.sort(), ['bob', 'carol']);
    assert.deepEqual(db.partnersByUser.bob.sort(), ['alice', 'carol']);
    assert.equal((await ask(server, 'alice', 'bob')).body.status, 'partner', 'a repeat does not remove');
    assert.equal((await call(server, 'DELETE', '/api/drink-partners/bob', 'alice')).status, 204);
  });

  test('off: adding, removing and adding again does not repeat an unread notice', async (t) => {
    const server = await start(t, FLAG_OFF, fixture());
    const cycle = async () => {
      await ask(server, 'alice', 'bob');
      await call(server, 'DELETE', '/api/drink-partners/bob', 'alice');
      await ask(server, 'alice', 'bob');
      await call(server, 'DELETE', '/api/drink-partners/bob', 'alice');
    };
    await cycle();
    assert.equal((await noticesOf(server, 'bob')).length, 1);
    await call(server, 'POST', '/api/notifications/read', 'bob');
    await cycle();
    assert.equal((await noticesOf(server, 'bob')).length, 2, 'once read, it is news again');
  });

  test('off: the block, self and missing checks and the growth guard still apply', async (t) => {
    const server = await start(t, { ...FLAG_OFF, DB_GROWTH_MAX_BYTES: '1' }, fixture({ blocksByUser: { alice: ['bob'] } }));
    assert.equal((await ask(server, 'bob', 'alice')).status, 404);
    assert.equal((await ask(server, 'alice', 'alice')).status, 400);
    assert.equal((await ask(server, 'alice', 'nobody')).status, 404);
    assert.equal((await ask(server, 'alice', 'carol')).status, 507);
  });

  for (const value of ['true', 'FALSE', '0', '']) {
    test(`the value "${value}" keeps consent on`, async (t) => {
      const server = await start(t, { PARTNER_CONSENT_REQUIRED: value }, fixture());
      assert.equal((await ask(server, 'alice', 'bob')).body.status, 'requested');
    });
  }
});
