// Tests for scripts/backup.js. Temp directories only: the real database is never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBackup, DAILY_RETENTION_DAYS, WEEKLY_RETENTION_DAYS } from '../scripts/backup.js';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 0, 7, 3, 0, 0); // a Wednesday, 03:00 UTC

const tempSetup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drinkme-backup-test-'));
  const dbFile = path.join(root, 'db', 'db.json');
  fs.mkdirSync(path.dirname(dbFile));
  const backupDir = path.join(root, 'backups');
  const writeDb = (data) => fs.writeFileSync(dbFile, JSON.stringify(data));
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { root, dbFile, backupDir, writeDb, cleanup };
};

const listDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const allBackupTexts = (backupDir) => ['daily', 'weekly'].flatMap((sub) => (
  listDir(path.join(backupDir, sub)).map((name) => fs.readFileSync(path.join(backupDir, sub, name), 'utf8'))
));

test('first run writes a daily and a weekly copy that match the database', async (t) => {
  const s = tempSetup();
  t.after(s.cleanup);
  s.writeDb({ users: [{ id: 'u1' }] });
  const result = await runBackup({ dbFile: s.dbFile, backupDir: s.backupDir, now: START });
  assert.equal(result.created.length, 2);
  assert.deepEqual(listDir(path.join(s.backupDir, 'daily')), ['drinkme-2026-01-07.json']);
  assert.deepEqual(listDir(path.join(s.backupDir, 'weekly')), ['drinkme-2026-01-07.json']);
  for (const text of allBackupTexts(s.backupDir)) assert.deepEqual(JSON.parse(text), { users: [{ id: 'u1' }] });
});

test('60 daily runs keep 7 dailies and at most 4 weeks of weeklies', async (t) => {
  const s = tempSetup();
  t.after(s.cleanup);
  s.writeDb({ users: [] });
  for (let day = 0; day < 60; day++) {
    await runBackup({ dbFile: s.dbFile, backupDir: s.backupDir, now: START + day * DAY });
  }
  const last = START + 59 * DAY;
  const dailies = listDir(path.join(s.backupDir, 'daily'));
  const weeklies = listDir(path.join(s.backupDir, 'weekly'));
  assert.equal(dailies.length, DAILY_RETENTION_DAYS);
  assert.ok(weeklies.length >= 4 && weeklies.length <= 5, `weeklies: ${weeklies}`);
  const lastDay = Date.parse(`${new Date(last).toISOString().slice(0, 10)}T00:00:00Z`);
  const ageDays = (name) => (lastDay - Date.parse(`${name.slice(8, 18)}T00:00:00Z`)) / DAY;
  assert.ok(dailies.every((name) => ageDays(name) < DAILY_RETENTION_DAYS));
  assert.ok(weeklies.every((name) => ageDays(name) < WEEKLY_RETENTION_DAYS));
  // Weeklies after the first are Sunday runs.
  for (const name of weeklies.slice(1)) assert.equal(new Date(`${name.slice(8, 18)}T00:00:00Z`).getUTCDay(), 0);
});

test('a deleted account is gone from every backup within 30 days', async (t) => {
  const s = tempSetup();
  t.after(s.cleanup);
  const marker = 'deleted-user-marker-7f3a';
  // The account exists for the first 20 days, which covers several weekly copies.
  let lastDayWithMarker = -1;
  for (let day = 0; day < 60; day++) {
    s.writeDb({ users: day < 20 ? [{ id: marker }] : [] });
    await runBackup({ dbFile: s.dbFile, backupDir: s.backupDir, now: START + day * DAY });
    if (allBackupTexts(s.backupDir).some((text) => text.includes(marker))) lastDayWithMarker = day;
  }
  // Deleted on day 20 (first backup without it); the last copy holding it must be gone by day 20 + 30.
  assert.ok(lastDayWithMarker >= 20, 'the marker should survive in backups for a while');
  assert.ok(lastDayWithMarker < 20 + 30, `marker still in a backup on day ${lastDayWithMarker}`);
});

test('a corrupt database fails without pruning older backups', async (t) => {
  const s = tempSetup();
  t.after(s.cleanup);
  s.writeDb({ users: [] });
  for (let day = 0; day < 10; day++) await runBackup({ dbFile: s.dbFile, backupDir: s.backupDir, now: START + day * DAY });
  const before = [...listDir(path.join(s.backupDir, 'daily')), ...listDir(path.join(s.backupDir, 'weekly'))];
  fs.writeFileSync(s.dbFile, '{"users": [');
  await assert.rejects(runBackup({ dbFile: s.dbFile, backupDir: s.backupDir, now: START + 30 * DAY }));
  const after = [...listDir(path.join(s.backupDir, 'daily')), ...listDir(path.join(s.backupDir, 'weekly'))];
  assert.deepEqual(after, before);
  assert.ok(!listDir(path.join(s.backupDir, 'daily')).some((name) => name.includes('.tmp-')), 'no temp file left');
});

test('a missing database or unknown source fails clearly', async (t) => {
  const s = tempSetup();
  t.after(s.cleanup);
  await assert.rejects(runBackup({ dbFile: s.dbFile, backupDir: s.backupDir, now: START }), /no database file/);
  s.writeDb({});
  await assert.rejects(runBackup({ dbFile: s.dbFile, backupDir: s.backupDir, source: 'postgres', now: START }), /unknown BACKUP_SOURCE/);
});

test('files that only look like backups are left alone', async (t) => {
  const s = tempSetup();
  t.after(s.cleanup);
  s.writeDb({});
  const dailyDir = path.join(s.backupDir, 'daily');
  fs.mkdirSync(dailyDir, { recursive: true });
  fs.writeFileSync(path.join(dailyDir, 'notes.txt'), 'keep');
  fs.writeFileSync(path.join(dailyDir, 'drinkme-2025-02-30.json'), 'invalid date, keep');
  fs.writeFileSync(path.join(dailyDir, 'drinkme-2030-01-01.json'), '{}'); // future date: kept
  await runBackup({ dbFile: s.dbFile, backupDir: s.backupDir, now: START + 40 * DAY });
  const names = listDir(dailyDir);
  for (const kept of ['notes.txt', 'drinkme-2025-02-30.json', 'drinkme-2030-01-01.json']) assert.ok(names.includes(kept), kept);
});
