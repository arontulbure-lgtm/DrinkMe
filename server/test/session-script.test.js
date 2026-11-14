// scripts/test-session.mjs (npm run test:ios / test:android): the pure parts of the live watcher.
// The session itself (server, Expo, emulator) is exercised by hand; see docs/DEVICE_TEST_SESSION.md.
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { SERVER_DIR } from './helpers/routes.js';

const session = await import(pathToFileURL(path.join(SERVER_DIR, '..', 'scripts', 'test-session.mjs')).href);

describe('app log entries across sessions (triage of 2026-11-14)', () => {
  const start = Date.parse('2026-11-14T11:33:19.000Z');

  test('entries made before the session started are carried over, not new issues', () => {
    const seen = new Set();
    assert.equal(session.clientEntryOrigin({ clientTs: '2026-11-14T11:31:00.000Z', appSession: 'a', seq: 1 }, start, seen), 'carried-over');
    assert.equal(session.clientEntryOrigin({ clientTs: '2026-11-14T11:33:16.000Z', appSession: 'a', seq: 2 }, start, seen), 'new', 'within the clock allowance');
    assert.equal(session.clientEntryOrigin({ clientTs: '2026-11-14T11:40:00.000Z', appSession: 'a', seq: 3 }, start, seen), 'new');
  });

  test('a resent batch (same appSession and seq) is a duplicate', () => {
    const seen = new Set();
    const entry = { clientTs: '2026-11-14T11:40:00.000Z', appSession: 'a', seq: 9 };
    assert.equal(session.clientEntryOrigin(entry, start, seen), 'new');
    assert.equal(session.clientEntryOrigin({ ...entry }, start, seen), 'duplicate');
    assert.equal(session.clientEntryOrigin({ ...entry, appSession: 'b' }, start, seen), 'new', 'another app session');
  });

  test('entries without seq (older app builds) are never treated as duplicates', () => {
    const seen = new Set();
    const entry = { clientTs: '2026-11-14T11:40:00.000Z', appSession: 'a' };
    assert.equal(session.clientEntryOrigin(entry, start, seen), 'new');
    assert.equal(session.clientEntryOrigin(entry, start, seen), 'new');
  });
});

describe('watcher helpers', () => {
  test('secret-looking .env names, by name only', () => {
    for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'JWT_SECRET', 'GITHUB_TOKEN']) assert.equal(session.isSecretLookingName(name), true, name);
    for (const name of ['EXPO_PUBLIC_FIREBASE_API_KEY', 'NODE_ENV', 'EXPO_PUBLIC_API_URL']) assert.equal(session.isSecretLookingName(name), false, name);
  });

  test('printable keeps one line without terminal controls', () => {
    assert.equal(session.printable('a\nNEW ISSUE\u001b[2J‮x', 200), 'a ⏎ NEW ISSUEx');
  });
});
