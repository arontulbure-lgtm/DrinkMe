// Owner decisions of 2026-11-10: report review fields, auto-hide at 3 distinct reporters, suspensions,
// and the 30-day backup rule (21-day retention plus the 7-day recovery hold).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import jwt from 'jsonwebtoken';

import { startServer } from './helpers/harness.js';

const HARNESS_JWT_SECRET = 'test-only-jwt-secret'; // the harness default
const FAULT_PRELOAD = new URL('./helpers/db-fault-preload.js', import.meta.url).href;
const FAULT_ENV = { DB_FAULT: 'save', NODE_OPTIONS: `--import=${FAULT_PRELOAD}` };
const ADMIN_ENV = { ADMIN_USER_IDS: 'admin,second-admin' };
const CONFIRMED_AT = '2026-01-02T03:04:05.000Z';
const OLD = '2026-01-01T00:00:00.000Z';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const IMAGE = `data:image/png;base64,${PNG.toString('base64')}`;

const ago = (hours) => new Date(Date.now() - hours * HOUR_MS).toISOString();
const tokenFor = (uid) => jwt.sign({ uid }, HARNESS_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const readDb = (server) => JSON.parse(fs.readFileSync(server.dbFile, 'utf8'));

const person = (id, extra = {}) => ({
  id, email: `${id}@example.test`, firstName: `Name-${id}`, lastName: 'Test', city: 'Cluj', bio: `Bio of ${id}`,
  nameSetByUser: true, avatar: null, ageConfirmedAt: CONFIRMED_AT, privacyNoticeVersion: 2, ...extra,
});
const post = (id, userId, extra = {}) => ({
  id, userId, name: `Post ${id}`, description: 'Plain', rating: 4, location: 'Cluj', isAlcoholic: false,
  createdAt: OLD, cheersCount: 0, tags: [], imageUrl: IMAGE, ...extra,
});
const commentOf = (id, drinkId, userId) => ({ id, drinkId, userId, content: `Comment ${id}`, createdAt: OLD });
const openReport = (id, reporterId, targetType, targetId, extra = {}) => ({
  id, reporterId, targetType, targetId, reason: 'spam', details: null, status: 'open', createdAt: ago(1), ...extra,
});

const call = async (server, method, route, uid, body) => {
  const res = await fetch(`${server.baseUrl}${route}`, {
    method,
    headers: {
      ...(uid && { Authorization: `Bearer ${tokenFor(uid)}` }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  return { status: res.status, headers: res.headers, text, body: parsed };
};
const idsOf = (res) => res.body.items.map((item) => item.id);
const resolve = (server, id, body, uid = 'admin') => call(server, 'POST', `/api/admin/reports/${id}/resolve`, uid, body);

// owner wrote post 1 (and post 2, never reported). author commented 5 on post 2. viewer is the owner's
// partner, has saved post 1, and stands for everyone else. r1 to r4 are reporters.
const baseFixture = (reports = [], extra = {}) => ({
  dbSchemaVersion: 2,
  users: [
    person('admin'), person('second-admin'), person('viewer'),
    person('owner', { avatar: IMAGE }), person('author'),
    person('r1'), person('r2'), person('r3'), person('r4'),
  ],
  drinks: [post(1, 'owner', { cheersCount: 5 }), post(2, 'owner'), post(3, 'r1')],
  nextDrinkId: 4,
  commentsByDrink: { 2: [commentOf(5, 2, 'author'), commentOf(6, 2, 'r1')] },
  nextCommentId: 7,
  partnersByUser: { owner: ['viewer'], viewer: ['owner'] },
  savedByUser: { viewer: [1] },
  reports,
  nextReportId: reports.length + 1,
  ...extra,
});
const reportsBy = (reporters, targetType, targetId, extra = {}) => reporters.map((reporterId, index) => (
  openReport(index + 1, reporterId, targetType, targetId, extra)
));

const start = async (t, fixture, env = {}) => {
  const server = await startServer({ ...ADMIN_ENV, ...env }, { dbFixture: fixture });
  t.after(() => server.stop());
  return server;
};

// Every surface where post 1 can show for this viewer.
const drinkSurfaces = async (server, uid) => ({
  feed: idsOf(await call(server, 'GET', '/api/drinks', uid)).includes(1),
  search: idsOf(await call(server, 'GET', '/api/drinks?q=Post%201', uid)).includes(1),
  city: idsOf(await call(server, 'GET', '/api/drinks?city=cluj', uid)).includes(1),
  trending: idsOf(await call(server, 'GET', '/api/drinks?sort=trending', uid)).includes(1),
  partners: idsOf(await call(server, 'GET', '/api/drinks/partners', uid)).includes(1),
  profile: idsOf(await call(server, 'GET', '/api/drinks/user/owner', uid)).includes(1),
  detail: (await call(server, 'GET', '/api/drinks/1', uid)).status === 200,
  comments: (await call(server, 'GET', '/api/drinks/1/comments', uid)).status === 200,
  media: (await call(server, 'GET', '/media/drinks/1', uid)).status === 200,
});
const ALL_VISIBLE = { feed: true, search: true, city: true, trending: true, partners: true, profile: true, detail: true, comments: true, media: true };
const NONE_VISIBLE = Object.fromEntries(Object.keys(ALL_VISIBLE).map((key) => [key, false]));

describe('auto-hide threshold', () => {
  test('2 distinct reporters do not hide a post', async (t) => {
    const server = await start(t, baseFixture(reportsBy(['r1', 'r2'], 'drink', 1)));
    assert.deepEqual(await drinkSurfaces(server, 'viewer'), ALL_VISIBLE);
  });

  test('3 open reports from the same reporter do not hide a post', async (t) => {
    const server = await start(t, baseFixture(reportsBy(['r1', 'r1', 'r1'], 'drink', 1)));
    assert.deepEqual(await drinkSurfaces(server, 'viewer'), ALL_VISIBLE);
  });

  test('3 distinct reporters hide a post, and resolved reports do not count', async (t) => {
    const hidden = await start(t, baseFixture(reportsBy(['r1', 'r2', 'r3'], 'drink', 1)));
    assert.deepEqual(await drinkSurfaces(hidden, 'viewer'), NONE_VISIBLE);
    await hidden.stop();

    const resolvedOne = reportsBy(['r1', 'r2', 'r3'], 'drink', 1);
    Object.assign(resolvedOne[2], { status: 'resolved', action: 'dismiss', removed: false, resolvedAt: ago(1) });
    const server = await start(t, baseFixture(resolvedOne));
    assert.deepEqual(await drinkSurfaces(server, 'viewer'), ALL_VISIBLE);
  });

  test('the third distinct report through the API hides the post at once', async (t) => {
    const server = await start(t, baseFixture());
    for (const uid of ['r1', 'r2']) {
      assert.equal((await call(server, 'POST', '/api/reports', uid, { targetType: 'drink', targetId: 1, reason: 'spam' })).status, 201);
    }
    assert.equal((await call(server, 'GET', '/api/drinks/1', 'viewer')).status, 200);
    assert.equal((await call(server, 'POST', '/api/reports', 'r1', { targetType: 'drink', targetId: 1, reason: 'other' })).status, 200, 'a repeat');
    assert.equal((await call(server, 'GET', '/api/drinks/1', 'viewer')).status, 200);
    assert.equal((await call(server, 'POST', '/api/reports', 'r3', { targetType: 'drink', targetId: 1, reason: 'spam' })).status, 201);
    assert.equal((await call(server, 'GET', '/api/drinks/1', 'viewer')).status, 404);
    // Hidden, so a fourth reporter is told it does not exist, like a missing post.
    const missing = await call(server, 'POST', '/api/reports', 'r4', { targetType: 'drink', targetId: 999, reason: 'spam' });
    const hidden = await call(server, 'POST', '/api/reports', 'r4', { targetType: 'drink', targetId: 1, reason: 'spam' });
    assert.equal(hidden.status, 404);
    assert.deepEqual(hidden.body, missing.body);
  });

  test('a blocked reporter and a deleted reporter still count while their report is open', async (t) => {
    const server = await start(t, baseFixture(reportsBy(['r1', 'r2', 'r3'], 'drink', 1)));
    assert.equal((await call(server, 'POST', '/api/blocks/r1', 'owner', { blocked: true })).status, 200);
    assert.equal((await call(server, 'POST', '/api/users/r2/delete-account', 'r2', {})).status, 200);
    assert.equal((await call(server, 'GET', '/api/drinks/1', 'viewer')).status, 404);
    const db = readDb(server);
    assert.equal(db.users.some((u) => u.id === 'r2'), false);
    const anonymous = db.reports.find((r) => r.id === 2);
    assert.match(anonymous.reporterId, /^deleted-[0-9a-f]{16}$/);
    assert.equal(anonymous.reporterDeleted, true);
    assert.equal(anonymous.countsForAutoHide, true, 'r2 counted when the account was deleted');
    assert.ok(!JSON.stringify(db.reports).includes('"r2"'));

    const list = await call(server, 'GET', '/api/admin/reports', 'admin');
    assert.ok(list.body.items.every((item) => item.openReporterCount === 3 && item.autoHideReporterCount === 3 && item.autoHidden === true));
  });
});

describe('who counts towards the auto-hide', () => {
  test('a reporter under 48 hours old, or with the notice pending, does not count; the reports still reach the queue', async (t) => {
    const fixture = baseFixture(reportsBy(['r1', 'r2', 'r3', 'r4'], 'drink', 1));
    fixture.users.find((u) => u.id === 'r3').createdAt = ago(47);
    Object.assign(fixture.users.find((u) => u.id === 'r4'), { createdAt: ago(100), noticePending: true });
    const server = await start(t, fixture);

    assert.equal((await call(server, 'GET', '/api/drinks/1', 'viewer')).status, 200, 'r1 and r2 alone are not enough');
    const list = await call(server, 'GET', '/api/admin/reports', 'admin');
    assert.equal(list.body.total, 4);
    assert.deepEqual(list.body.items.map(({ openReporterCount, autoHideReporterCount, autoHidden }) => ({ openReporterCount, autoHideReporterCount, autoHidden }))[0],
      { openReporterCount: 4, autoHideReporterCount: 2, autoHidden: false });

    // Accepting the notice makes r4 count at once.
    assert.equal((await call(server, 'POST', '/api/users/r4/acknowledgements', 'r4', { type: 'privacy', version: 2 })).status, 200);
    assert.equal((await call(server, 'GET', '/api/drinks/1', 'viewer')).status, 404);
  });

  test('a new reporter starts counting when the account turns 48 hours old, with no other change', async (t) => {
    const fixture = baseFixture(reportsBy(['r1', 'r2', 'r3'], 'drink', 1));
    fixture.users.find((u) => u.id === 'r3').createdAt = new Date(Date.now() - 48 * HOUR_MS + 6000).toISOString();
    const server = await start(t, fixture);
    assert.equal((await call(server, 'GET', '/api/drinks/1', 'viewer')).status, 200);
    const deadline = Date.now() + 15_000;
    let status = 200;
    while (status === 200 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      status = (await call(server, 'GET', '/api/drinks/1', 'viewer')).status;
    }
    assert.equal(status, 404, 'the cached index is rebuilt once r3 is old enough');
  });

  test('a deleted reporter who did not count never starts counting', async (t) => {
    const fixture = baseFixture(reportsBy(['r1', 'r2', 'r3'], 'drink', 1));
    fixture.users.find((u) => u.id === 'r3').createdAt = ago(1);
    const server = await start(t, fixture);
    assert.equal((await call(server, 'POST', '/api/users/r3/delete-account', 'r3', {})).status, 200);
    const anonymous = readDb(server).reports.find((r) => r.id === 3);
    assert.equal(anonymous.reporterDeleted, true);
    assert.equal(anonymous.countsForAutoHide, false);
    assert.equal((await call(server, 'GET', '/api/drinks/1', 'viewer')).status, 200);
    await server.restart();
    assert.equal((await call(server, 'GET', '/api/drinks/1', 'viewer')).status, 200, 'still not after a restart');
  });

  test('a new account gets createdAt at sign-in', async (t) => {
    const server = await start(t, baseFixture());
    const before = Date.now();
    const res = await call(server, 'POST', '/api/auth/mobile', null, { idToken: 'dev-token', uid: 'fresh-user' });
    assert.equal(res.status, 200);
    const stored = readDb(server).users.find((u) => u.id === 'fresh-user').createdAt;
    const created = new Date(stored).getTime();
    assert.ok(Number.isFinite(created) && Math.abs(created - before) < 60_000, `createdAt ${stored}, test start ${new Date(before).toISOString()}`);
    const own = await call(server, 'GET', '/api/users/fresh-user', 'fresh-user');
    assert.equal(own.status, 200);
    assert.equal('createdAt' in own.body, false, 'not sent to clients');
  });
});

describe('who sees hidden content', () => {
  test('a hidden post is missing for others on every surface, with the same 404 as a missing post', async (t) => {
    const server = await start(t, baseFixture(reportsBy(['r1', 'r2', 'r3'], 'drink', 1)));
    const missingDetail = await call(server, 'GET', '/api/drinks/999', 'viewer');
    const missingMedia = await call(server, 'GET', '/media/drinks/999', 'viewer');
    const routes = [
      ['GET', '/api/drinks/1', undefined, missingDetail],
      ['GET', '/api/drinks/1/comments', undefined, missingDetail],
      ['POST', '/api/drinks/1/comments', { content: 'Hi' }, missingDetail],
      ['POST', '/api/drinks/1/like', undefined, missingDetail],
      ['POST', '/api/drinks/1/save', undefined, missingDetail],
      ['GET', '/media/drinks/1', undefined, missingMedia],
    ];
    for (const [method, route, body, missing] of routes) {
      const res = await call(server, method, route, 'viewer', body);
      assert.equal(res.status, 404, `${method} ${route}`);
      assert.deepEqual(res.body, missing.body, `${method} ${route}`);
    }
    assert.equal((await call(server, 'GET', '/media/drinks/1', 'viewer')).headers.get('cache-control'), 'no-store');
    const owned = await call(server, 'GET', '/api/drinks/user/owner', 'viewer');
    assert.deepEqual(idsOf(owned), [2]);
    assert.equal(owned.body.total, 1, 'total counts only what the viewer sees');
    assert.deepEqual(idsOf(await call(server, 'GET', '/api/users/viewer/saved-drinks', 'viewer')), []);
    assert.ok(!idsOf(await call(server, 'GET', '/api/drinks?scope=discover', 'r4')).includes(1));
    assert.ok(!(await call(server, 'GET', '/api/drinks', 'viewer')).text.includes('hiddenPendingReview'));
  });

  test('the owner still sees it everywhere, flagged; the admin sees it too', async (t) => {
    const server = await start(t, baseFixture(reportsBy(['r1', 'r2', 'r3'], 'drink', 1)));
    const ownerView = await drinkSurfaces(server, 'owner');
    assert.deepEqual(ownerView, ALL_VISIBLE);
    const detail = await call(server, 'GET', '/api/drinks/1', 'owner');
    assert.equal(detail.body.hiddenPendingReview, true);
    const feedItem = (await call(server, 'GET', '/api/drinks/partners', 'owner')).body.items.find((d) => d.id === 1);
    assert.equal(feedItem.hiddenPendingReview, true);
    assert.equal((await call(server, 'GET', '/api/drinks/2', 'owner')).body.hiddenPendingReview, undefined, 'only the hidden post');
    assert.equal((await call(server, 'POST', '/api/drinks/1/like', 'owner')).status, 200);

    assert.equal((await call(server, 'GET', '/api/drinks/1', 'admin')).status, 200);
    assert.equal((await call(server, 'GET', '/media/drinks/1', 'admin')).status, 200);
    assert.ok(idsOf(await call(server, 'GET', '/api/drinks', 'admin')).includes(1));
  });

  test('a hidden comment is missing from everyone else\'s list, the post owner\'s too; its author and the admins see it', async (t) => {
    const server = await start(t, baseFixture(reportsBy(['r1', 'r2', 'r3'], 'comment', 5, { drinkId: 2 })));
    const listFor = async (uid) => (await call(server, 'GET', '/api/drinks/2/comments', uid)).body.items;
    assert.deepEqual((await listFor('viewer')).map((c) => c.id), [6]);
    assert.deepEqual((await listFor('owner')).map((c) => c.id), [6], 'the post owner too');
    const authorView = await listFor('author');
    assert.deepEqual(authorView.map((c) => c.id), [6, 5]);
    assert.equal(authorView.find((c) => c.id === 5).hiddenPendingReview, true);
    assert.equal(authorView.find((c) => c.id === 6).hiddenPendingReview, undefined);
    assert.deepEqual((await listFor('admin')).map((c) => c.id), [6, 5]);

    // Anyone but the author and the post owner: the same 404 as a missing comment, not a 403.
    const missing = await call(server, 'DELETE', '/api/drinks/2/comments/999', 'r4');
    const hidden = await call(server, 'DELETE', '/api/drinks/2/comments/5', 'r4');
    assert.equal(hidden.status, 404);
    assert.deepEqual(hidden.body, missing.body);
    assert.equal((await call(server, 'DELETE', '/api/drinks/2/comments/6', 'r4')).status, 403, 'a visible one answers 403');
    assert.equal((await call(server, 'POST', '/api/reports', 'r4', { targetType: 'comment', targetId: 5, reason: 'spam' })).status, 404);
  });

  test('the post owner can still delete a hidden comment on their own post, and so can its author', async (t) => {
    const fixture = baseFixture(reportsBy(['r1', 'r2', 'r3'], 'comment', 5, { drinkId: 2 }));
    fixture.commentsByDrink[2].push(commentOf(7, 2, 'author'));
    fixture.nextCommentId = 8;
    fixture.reports.push(...reportsBy(['r1', 'r2', 'r3'], 'comment', 7, { drinkId: 2 }).map((r, i) => ({ ...r, id: 4 + i })));
    fixture.nextReportId = 7;
    const server = await start(t, fixture);
    assert.equal((await call(server, 'DELETE', '/api/drinks/2/comments/5', 'owner')).status, 204, 'the post owner');
    assert.equal((await call(server, 'DELETE', '/api/drinks/2/comments/7', 'author')).status, 204, 'the author');
    assert.deepEqual(readDb(server).commentsByDrink[2].map((c) => c.id), [6]);
  });

  test('a hidden profile is stripped for others, left out of search, and its avatar is a 404', async (t) => {
    const server = await start(t, baseFixture(reportsBy(['r1', 'r2', 'r3'], 'user', 'owner'), {
      partnerRequestsByUser: { r4: [{ fromId: 'owner', createdAt: ago(1) }] },
    }));
    const stripped = { id: 'owner', lastName: '', city: '', bio: '', avatar: null };

    const profile = await call(server, 'GET', '/api/users/owner', 'viewer');
    assert.equal(profile.status, 200);
    const { partnerStatus, partnerCount, ...publicPart } = profile.body;
    assert.deepEqual(publicPart, stripped);
    assert.equal(partnerStatus, 'partner');
    assert.equal(partnerCount, 1);
    assert.deepEqual((await call(server, 'GET', '/api/users/search?q=Name-owner', 'viewer')).body, []);
    assert.deepEqual((await call(server, 'GET', '/api/drink-partners', 'viewer')).body, [stripped]);
    const card = (await call(server, 'GET', '/api/drinks/1', 'viewer')).body;
    assert.deepEqual(card.user, stripped, 'the posts stay, their author is stripped');
    const avatar = await call(server, 'GET', '/media/avatars/owner', 'viewer');
    const missingAvatar = await call(server, 'GET', '/media/avatars/nobody', 'viewer');
    assert.equal(avatar.status, 404);
    assert.deepEqual(avatar.body, missingAvatar.body);
    assert.equal(avatar.headers.get('cache-control'), 'no-store');
    assert.match(avatar.headers.get('vary') ?? '', /Authorization/i);
    assert.match((await call(server, 'GET', '/media/avatars/owner', 'owner')).headers.get('vary') ?? '', /Authorization/i);
    const partnerList = await call(server, 'GET', '/api/users/viewer/partners', 'viewer');
    assert.deepEqual(partnerList.body, [{ ...stripped, isPartner: true }]);
    const requests = await call(server, 'GET', '/api/drink-partners/requests', 'r4');
    assert.deepEqual(requests.body.incoming.map(({ createdAt, ...user }) => user), [stripped]);

    const own = await call(server, 'GET', '/api/users/owner', 'owner');
    assert.equal(own.body.hiddenPendingReview, true);
    assert.equal(own.body.bio, 'Bio of owner');
    assert.equal((await call(server, 'GET', '/media/avatars/owner', 'owner')).status, 200);

    const adminView = await call(server, 'GET', '/api/users/owner', 'admin');
    assert.equal(adminView.body.firstName, 'Name-owner');
    assert.equal((await call(server, 'GET', '/media/avatars/owner', 'admin')).status, 200);
    assert.equal((await call(server, 'GET', '/api/users/search?q=Name-owner', 'admin')).body.length, 1);
    const listed = (await call(server, 'GET', '/api/admin/reports', 'admin')).body.items[0];
    assert.equal(listed.target.firstName, 'Name-owner', 'the admin reviews the real profile');
  });

  test('dismissing the reports unhides at once; a failed save keeps it hidden', async (t) => {
    const server = await start(t, baseFixture(reportsBy(['r1', 'r2', 'r3'], 'drink', 1)), FAULT_ENV);
    fs.writeFileSync(`${server.dbFile}.fail-saves`, '');
    assert.equal((await resolve(server, 1, { action: 'dismiss' })).status, 503);
    fs.rmSync(`${server.dbFile}.fail-saves`);
    assert.equal((await call(server, 'GET', '/api/drinks/1', 'viewer')).status, 404, 'still hidden after the rollback');

    assert.equal((await resolve(server, 1, { action: 'dismiss' })).status, 200);
    assert.deepEqual(await drinkSurfaces(server, 'viewer'), ALL_VISIBLE);
    assert.equal((await call(server, 'GET', '/api/drinks/1', 'owner')).body.hiddenPendingReview, undefined);
    assert.equal(readDb(server).drinks.some((d) => 'hiddenPendingReview' in d), false, 'nothing is stored');
  });
});

describe('admin report list', () => {
  test('adds ageHours, overdue, openReporterCount, autoHidden and overdueCount, and keeps the old fields', async (t) => {
    const reports = [
      openReport(1, 'r1', 'drink', 1, { createdAt: ago(30) }),
      openReport(2, 'r2', 'drink', 1, { createdAt: ago(2) }),
      openReport(3, 'r3', 'drink', 1, { createdAt: ago(25) }),
      openReport(4, 'r1', 'user', 'author', { createdAt: ago(23) }),
      openReport(5, 'r1', 'drink', 2, { status: 'resolved', action: 'dismiss', removed: false, resolvedAt: ago(1), createdAt: ago(100) }),
    ];
    const server = await start(t, baseFixture(reports));
    const res = await call(server, 'GET', '/api/admin/reports', 'admin');
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 4);
    assert.equal(res.body.overdueCount, 2);
    assert.deepEqual(res.body.items.map(({ id, ageHours, overdue, openReporterCount, autoHidden }) => ({ id, ageHours, overdue, openReporterCount, autoHidden })), [
      { id: 1, ageHours: 30, overdue: true, openReporterCount: 3, autoHidden: true },
      { id: 2, ageHours: 2, overdue: false, openReporterCount: 3, autoHidden: true },
      { id: 3, ageHours: 25, overdue: true, openReporterCount: 3, autoHidden: true },
      { id: 4, ageHours: 23, overdue: false, openReporterCount: 1, autoHidden: false },
    ]);
    const [first] = res.body.items;
    assert.equal(first.reporterId, 'r1');
    assert.equal(first.target.name, 'Post 1');
    assert.equal(first.status, 'open');

    const resolved = await call(server, 'GET', '/api/admin/reports?status=resolved', 'admin');
    assert.equal(resolved.body.items[0].overdue, false, 'a resolved report is never overdue');
    assert.equal(resolved.body.overdueCount, 2, 'always the open queue');
    assert.equal(readDb(server).reports.some((r) => 'ageHours' in r || 'autoHidden' in r), false);
  });
});

describe('suspension', () => {
  const suspend = (server, id, body = {}, uid = 'admin') => call(server, 'POST', `/api/admin/users/${id}/suspend`, uid, body);
  const unsuspend = (server, id, uid = 'admin', body = {}) => call(server, 'POST', `/api/admin/users/${id}/unsuspend`, uid, body);

  test('the first suspension lasts 7 days, a later one is permanent, and the history is minimal', async (t) => {
    const server = await start(t, baseFixture());
    const before = Date.now();
    const first = await suspend(server, 'owner', { reason: '  Spam\u0007 links  ' });
    assert.equal(first.status, 200);
    assert.equal(first.body.suspended, true);
    assert.equal(first.body.suspendedPermanently, false);
    assert.equal(first.body.suspensionCount, 1);
    const untilMs = new Date(first.body.suspendedUntil).getTime();
    // Two processes can read the Windows clock a few milliseconds apart, so the window allows a margin.
    assert.ok(Math.abs(untilMs - (before + 7 * DAY_MS)) < 60_000, `until ${first.body.suspendedUntil}`);

    const own = await call(server, 'GET', '/api/users/owner', 'owner');
    assert.equal(own.body.suspendedUntil, first.body.suspendedUntil);
    assert.equal(own.body.suspendedPermanently, false);
    const other = await call(server, 'GET', '/api/users/owner', 'viewer');
    assert.equal('suspendedUntil' in other.body, false, 'only the owner is told');
    assert.equal('suspendedUntil' in (await call(server, 'GET', '/api/users/viewer', 'viewer')).body, false);

    const [entry] = readDb(server).users.find((u) => u.id === 'owner').suspensions;
    assert.deepEqual(Object.keys(entry).sort(), ['at', 'by', 'permanent', 'reason', 'until']);
    assert.equal(entry.reason, 'Spam links');
    assert.equal(entry.by, 'admin');

    assert.equal((await unsuspend(server, 'owner')).body.suspended, false);
    assert.equal('suspendedUntil' in (await call(server, 'GET', '/api/users/owner', 'owner')).body, false);
    assert.equal((await call(server, 'PUT', '/api/users/owner', 'owner', { bio: 'Back' })).status, 200);

    const second = await suspend(server, 'owner');
    assert.equal(second.body.suspendedPermanently, true);
    assert.equal(second.body.suspendedUntil, null);
    assert.equal(second.body.suspensionCount, 2);
    const blocked = await call(server, 'PUT', '/api/users/owner', 'owner', { bio: 'Again' });
    assert.deepEqual(blocked.body, { error: 'Your account is suspended, so you cannot do this.', code: 'account_suspended', until: null });
    const ownNow = await call(server, 'GET', '/api/users/owner', 'owner');
    assert.equal(ownNow.body.suspendedPermanently, true);
    assert.equal(ownNow.body.suspendedUntil, null);
    const history = readDb(server).users.find((u) => u.id === 'owner').suspensions;
    assert.equal(history.length, 2);
    assert.equal(history[0].endedBy, 'admin');
    assert.equal(typeof history[0].endedAt, 'string');
  });

  test('an admin cannot suspend themselves or another admin; checks the caller and the input', async (t) => {
    const server = await start(t, baseFixture());
    for (const id of ['admin', 'second-admin']) {
      const res = await suspend(server, id);
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'cannot_suspend_admin');
    }
    assert.equal((await suspend(server, 'owner', {}, 'viewer')).status, 403);
    assert.equal((await unsuspend(server, 'owner', 'viewer')).status, 403);
    assert.equal((await suspend(server, 'owner', {}, null)).status, 401);
    assert.equal((await suspend(server, 'nobody')).status, 404);
    assert.equal((await suspend(server, 'owner', { reason: 42 })).status, 400);
    assert.equal((await unsuspend(server, 'nobody')).status, 404);
    assert.equal((await unsuspend(server, 'owner')).body.suspended, false, 'nothing to lift');
    assert.equal(readDb(server).users.some((u) => 'suspensions' in u), false);
  });

  test('every refused action answers 403 account_suspended with the date, and the allowed ones still work', async (t) => {
    const fixture = baseFixture([], {
      partnerRequestsByUser: { owner: [{ fromId: 'r4', createdAt: ago(1) }] },
    });
    const server = await start(t, fixture);
    const { body: { suspendedUntil } } = await suspend(server, 'owner');

    const refused = [
      ['POST', '/api/drinks', { name: 'New', description: 'New', rating: 4, isAlcoholic: false, imageData: IMAGE }],
      ['POST', '/api/drinks/3/comments', { content: 'Hi' }],
      ['POST', '/api/drink-partners/r1', undefined],
      ['POST', '/api/drink-partners/requests/r4/accept', undefined],
      ['PUT', '/api/users/owner', { bio: 'Changed' }],
      ['POST', '/api/users/owner/avatar', { imageData: IMAGE }],
      ['POST', '/api/reports', { targetType: 'drink', targetId: 3, reason: 'spam' }],
    ];
    for (const [method, route, body] of refused) {
      const res = await call(server, method, route, 'owner', body);
      assert.equal(res.status, 403, `${method} ${route}`);
      assert.deepEqual(res.body, {
        error: `Your account is suspended until ${suspendedUntil}, so you cannot do this.`,
        code: 'account_suspended',
        until: suspendedUntil,
      }, `${method} ${route}`);
    }
    const db = readDb(server);
    assert.equal(db.drinks.length, 3);
    assert.equal(db.commentsByDrink[3], undefined);
    assert.equal(db.reports.length, 0);
    assert.equal(db.users.find((u) => u.id === 'owner').bio, 'Bio of owner');

    const allowed = [
      ['GET', '/api/drinks', undefined, 200],
      ['GET', '/api/drinks/3/comments', undefined, 200],
      ['POST', '/api/drinks/3/like', undefined, 200],
      ['POST', '/api/drinks/3/save', undefined, 200],
      ['GET', '/api/users/owner/saved-drinks', undefined, 200],
      ['POST', '/api/blocks/r2', { blocked: true }, 200],
      ['DELETE', '/api/blocks/r2', undefined, 204],
      ['POST', '/api/notifications/read', undefined, 200],
      ['POST', '/api/smart-bar', { name: 'Gin', quantity: '1' }, 201],
      ['DELETE', '/api/drink-partners/requests/r4', undefined, 204],
      ['DELETE', '/api/drink-partners/viewer', undefined, 204],
      ['DELETE', '/api/drinks/2', undefined, 204],
      ['POST', '/api/users/owner/acknowledgements', { type: 'privacy', version: 2 }, 200],
      ['GET', '/media/drinks/3', undefined, 200],
    ];
    for (const [method, route, body, status] of allowed) {
      assert.equal((await call(server, method, route, 'owner', body)).status, status, `${method} ${route}`);
    }
    assert.equal((await call(server, 'POST', '/api/users/owner/delete-account', 'owner', {})).status, 200, 'account deletion stays open');
  });

  test('a suspension ends by its date, with nothing to run', async (t) => {
    const lapsed = { at: ago(8 * 24), until: ago(1), permanent: false, reason: null, by: 'admin' };
    const running = { at: ago(1), until: new Date(Date.now() + DAY_MS).toISOString(), permanent: false, reason: null, by: 'admin' };
    const fixture = baseFixture();
    fixture.users.find((u) => u.id === 'owner').suspensions = [lapsed];
    fixture.users.find((u) => u.id === 'author').suspensions = [running];
    const server = await start(t, fixture);

    assert.equal('suspendedUntil' in (await call(server, 'GET', '/api/users/owner', 'owner')).body, false);
    assert.equal((await call(server, 'POST', '/api/drinks/3/comments', 'owner', { content: 'Hi' })).status, 201);
    assert.equal((await call(server, 'POST', '/api/drinks/3/comments', 'author', { content: 'Hi' })).status, 403);

    // The lapsed one is on record, so the next one is permanent.
    assert.equal((await suspend(server, 'owner')).body.suspendedPermanently, true);
  });

  test('resolve with suspend: true suspends the owner of the content; an admin owner refuses the whole resolve', async (t) => {
    const fixture = baseFixture([
      openReport(1, 'r1', 'comment', 5, { drinkId: 2 }),
      openReport(2, 'r2', 'drink', 4),
      openReport(3, 'r3', 'user', 'author'),
    ], { drinks: [post(1, 'owner'), post(2, 'owner'), post(3, 'r1'), post(4, 'second-admin')], nextDrinkId: 5 });
    const server = await start(t, fixture);

    assert.equal((await resolve(server, 1, { action: 'dismiss', suspend: 'yes' })).status, 400);
    const refused = await resolve(server, 2, { action: 'remove_content', suspend: true });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'cannot_suspend_admin');
    let db = readDb(server);
    assert.equal(db.reports[1].status, 'open', 'nothing resolved');
    assert.ok(db.drinks.some((d) => d.id === 4), 'nothing removed');

    const res = await resolve(server, 1, { action: 'remove_content', suspend: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'resolved');
    assert.equal(res.body.suspension.userId, 'author');
    assert.equal(res.body.suspension.suspendedPermanently, false);
    db = readDb(server);
    const [entry] = db.users.find((u) => u.id === 'author').suspensions;
    assert.equal(entry.reason, 'report 1: spam');
    assert.equal(entry.by, 'admin');
    assert.equal((await call(server, 'POST', '/api/drinks/3/comments', 'author', { content: 'Hi' })).body.code, 'account_suspended');

    // A second report on the same user while the suspension is in force: resolved, but no new suspension.
    const again = await resolve(server, 3, { action: 'dismiss', suspend: true });
    assert.equal(again.status, 200);
    assert.equal(again.body.status, 'resolved');
    assert.equal(again.body.suspension.applied, false);
    assert.equal(again.body.suspension.code, 'already_suspended');
    assert.equal(again.body.suspension.suspendedPermanently, false, 'still the 7-day suspension');
    assert.equal(again.body.suspension.suspendedUntil, res.body.suspension.suspendedUntil);
    assert.equal(again.body.suspension.suspensionCount, 1);
    assert.equal(res.body.suspension.applied, true);
    assert.equal(readDb(server).users.find((u) => u.id === 'author').suspensions.length, 1);
    assert.equal((await resolve(server, 2, { action: 'dismiss' })).status, 200, 'without suspend it resolves');
  });

  test('two reports on one user, both resolved with suspend: true, give one 7-day suspension; permanent: true escalates', async (t) => {
    // One report on the profile, two on a comment by the same user.
    const server = await start(t, baseFixture([
      openReport(1, 'r1', 'user', 'author'),
      openReport(2, 'r2', 'comment', 5, { drinkId: 2 }),
      openReport(3, 'r3', 'comment', 5, { drinkId: 2, reason: 'harassment' }),
    ]));
    const first = await resolve(server, 1, { action: 'dismiss', suspend: true });
    assert.equal(first.body.suspension.applied, true);
    const second = await resolve(server, 2, { action: 'dismiss', suspend: true });
    assert.equal(second.status, 200);
    assert.equal(second.body.suspension.applied, false);
    assert.equal(second.body.suspension.suspendedPermanently, false);
    assert.equal(readDb(server).reports.every((r) => r.status === 'resolved'), true, 'both resolved');
    assert.equal(readDb(server).users.find((u) => u.id === 'author').suspensions.length, 1);

    // An explicit escalation on resolve.
    await server.restart({ dbFixture: { ...readDb(server), reports: [...readDb(server).reports, openReport(4, 'r4', 'user', 'author')], nextReportId: 5 } });
    const escalated = await resolve(server, 4, { action: 'dismiss', suspend: true, permanent: true });
    assert.equal(escalated.body.suspension.applied, true);
    assert.equal(escalated.body.suspension.suspendedPermanently, true);
    assert.equal((await resolve(server, 4, { action: 'dismiss', permanent: 'yes' })).status, 400);
  });

  test('a double tap on suspend changes nothing: 409 already_suspended with the current state', async (t) => {
    const server = await start(t, baseFixture());
    const first = await suspend(server, 'owner');
    const second = await suspend(server, 'owner');
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'already_suspended');
    assert.equal(second.body.suspended, true);
    assert.equal(second.body.suspendedUntil, first.body.suspendedUntil);
    assert.equal(second.body.suspendedPermanently, false);
    assert.equal(second.body.suspensionCount, 1);
    assert.equal(readDb(server).users.find((u) => u.id === 'owner').suspensions.length, 1);

    assert.equal((await suspend(server, 'owner', { permanent: 'yes' })).status, 400);
    const escalated = await suspend(server, 'owner', { permanent: true });
    assert.equal(escalated.status, 200);
    assert.equal(escalated.body.suspendedPermanently, true);
    assert.equal(escalated.body.suspendedUntil, null);
    const again = await suspend(server, 'owner', { permanent: true });
    assert.equal(again.status, 409, 'already permanent');
    assert.equal(again.body.suspendedPermanently, true);
  });

  test('unsuspend with void: true keeps the entry, marked voided, and it does not count towards a permanent repeat', async (t) => {
    const server = await start(t, baseFixture());
    assert.equal((await suspend(server, 'owner')).status, 200);
    assert.equal((await unsuspend(server, 'owner', 'admin', { void: 'yes' })).status, 400);
    const lifted = await unsuspend(server, 'owner', 'admin', { void: true });
    assert.equal(lifted.status, 200);
    assert.equal(lifted.body.suspended, false);
    assert.equal(lifted.body.suspensionCount, 0);
    const [entry] = readDb(server).users.find((u) => u.id === 'owner').suspensions;
    assert.equal(entry.voided, true);
    assert.equal(entry.endedBy, 'admin');

    const next = await suspend(server, 'owner');
    assert.equal(next.body.suspendedPermanently, false, 'the voided one does not count');
    assert.equal(next.body.suspensionCount, 1);
    assert.equal(readDb(server).users.find((u) => u.id === 'owner').suspensions.length, 2);
  });

  test('suspend: true on a report whose content is gone answers 409 suspend_target_gone and changes nothing', async (t) => {
    const server = await start(t, baseFixture([openReport(1, 'r1', 'drink', 999), openReport(2, 'r2', 'comment', 5, { drinkId: 2 })]));
    const res = await resolve(server, 1, { action: 'remove_content', suspend: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'suspend_target_gone');
    assert.equal((await call(server, 'DELETE', '/api/drinks/2/comments/5', 'author')).status, 204);
    assert.equal((await resolve(server, 2, { action: 'dismiss', suspend: true })).body.code, 'suspend_target_gone');
    const db = readDb(server);
    assert.deepEqual(db.reports.map((r) => r.status), ['open', 'open']);
    assert.equal(db.users.some((u) => 'suspensions' in u), false);
  });

  test('a suspended user cannot pass the onboarding name prompt, and sign-in does not set their Google photo', async (t) => {
    const fixture = baseFixture();
    fixture.users.find((u) => u.id === 'owner').avatar = null;
    const server = await start(t, fixture);
    assert.equal((await suspend(server, 'owner')).status, 200);
    const prompt = await call(server, 'PUT', '/api/users/owner', 'owner', { firstName: 'New', nameChosen: true });
    assert.equal(prompt.status, 403);
    assert.equal(prompt.body.code, 'account_suspended');

    const photoURL = 'https://lh3.googleusercontent.com/a/photo';
    for (const uid of ['owner', 'r1']) {
      assert.equal((await call(server, 'POST', '/api/auth/mobile', null, { idToken: 'dev-token', uid, photoURL })).status, 200);
    }
    const users = readDb(server).users;
    assert.equal(users.find((u) => u.id === 'owner').avatar, null, 'suspended: no photo');
    assert.equal(users.find((u) => u.id === 'r1').avatar, photoURL, 'the control user gets it');
  });

  test('a failed save undoes a suspension', async (t) => {
    const server = await start(t, baseFixture([openReport(1, 'r1', 'drink', 1)]), FAULT_ENV);
    fs.writeFileSync(`${server.dbFile}.fail-saves`, '');
    assert.equal((await suspend(server, 'owner')).status, 503);
    assert.equal((await resolve(server, 1, { action: 'dismiss', suspend: true })).status, 503);
    fs.rmSync(`${server.dbFile}.fail-saves`);
    assert.equal('suspendedUntil' in (await call(server, 'GET', '/api/users/owner', 'owner')).body, false);
    assert.equal((await call(server, 'PUT', '/api/users/owner', 'owner', { bio: 'Fine' })).status, 200);
    assert.equal(readDb(server).reports[0].status, 'open');
  });

  test('an admin who deletes their account leaves no id in the history', async (t) => {
    const server = await start(t, baseFixture());
    assert.equal((await suspend(server, 'owner', {}, 'second-admin')).status, 200);
    assert.equal((await call(server, 'POST', '/api/users/second-admin/delete-account', 'second-admin', {})).status, 200);
    const [entry] = readDb(server).users.find((u) => u.id === 'owner').suspensions;
    assert.equal('by' in entry, false);
    assert.equal((await call(server, 'PUT', '/api/users/owner', 'owner', { bio: 'x' })).body.code, 'account_suspended', 'still suspended');
  });
});

describe('backup retention: 21 days plus the 7-day hold stays within 30', () => {
  const placeBackups = (server) => {
    const dir = path.dirname(server.dbFile);
    const name = (days) => `${path.basename(server.dbFile)}.corrupt-${Date.now() - days * DAY_MS}`;
    const recent = name(20);
    const old = name(22);
    for (const file of [recent, old]) fs.writeFileSync(path.join(dir, file), 'backup bytes');
    return { exists: (file) => fs.existsSync(path.join(dir, file)), recent, old };
  };

  test('the default is 21 days', async (t) => {
    const server = await start(t, baseFixture());
    const backups = placeBackups(server);
    await server.restart();
    assert.equal(backups.exists(backups.recent), true);
    assert.equal(backups.exists(backups.old), false);
  });

  test('a longer CORRUPT_BACKUP_RETENTION_DAYS is capped at 21 with a warning', async (t) => {
    const server = await start(t, baseFixture(), { CORRUPT_BACKUP_RETENTION_DAYS: '30' });
    assert.match(server.getOutput(), /CORRUPT_BACKUP_RETENTION_DAYS is above 21 — using 21/);
    const backups = placeBackups(server);
    await server.restart();
    assert.equal(backups.exists(backups.recent), true);
    assert.equal(backups.exists(backups.old), false);
  });

  test('a backup older than 30 days goes even during the recovery hold, across two corrupt starts and on the timer', async (t) => {
    const server = await start(t, baseFixture(), { DB_BACKUP_PURGE_INTERVAL_MS: '200' });
    const dir = path.dirname(server.dbFile);
    const backupName = (days) => `${path.basename(server.dbFile)}.corrupt-${Date.now() - days * DAY_MS}`;
    const place = (days) => {
      const name = backupName(days);
      fs.writeFileSync(path.join(dir, name), 'backup bytes');
      return name;
    };
    const exists = (name) => fs.existsSync(path.join(dir, name));
    const corruptBackups = () => fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));

    const past = place(31);
    const held = place(25); // past the 21-day retention, so only the hold keeps it
    fs.writeFileSync(server.dbFile, '{ first corrupt');
    await server.restart();
    assert.equal(exists(past), false, 'first corrupt start');
    assert.equal(exists(held), true, 'held');
    assert.match(server.getOutput(), /Removed a backup older than the 30-day ceiling, recovery hold or not/);

    const pastAgain = place(35);
    fs.writeFileSync(server.dbFile, '{ second corrupt');
    await server.restart();
    assert.equal(exists(pastAgain), false, 'second corrupt start');
    assert.equal(exists(held), true, 'still held');
    assert.equal(corruptBackups().length, 3, 'the held one and both new corrupt copies');

    // The timer during the hold applies the ceiling too.
    const onTimer = place(40);
    const deadline = Date.now() + 10_000;
    while (exists(onTimer) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(exists(onTimer), false, 'removed by the timer during the hold');
    assert.equal(exists(held), true);
    assert.match(server.getOutput(), /purge held after a recovery start/);
  });
});
