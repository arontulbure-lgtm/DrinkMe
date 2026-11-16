// Scheduled database backup. Run once a day (cron, or the host's scheduled job): `npm run backup`.
//
// Policy (owner decision, 2026-11-10):
//   - daily backups are kept 7 days
//   - weekly backups (the Sunday run, UTC, or the first run of a week with none) are kept 4 weeks
//   - so a deleted account is gone from every backup made here within 30 days of its deletion
//     (28 days of weekly retention plus up to one day until the next run prunes it).
// Retention is counted from the date in the file name, never from file times, so copying a file or a
// wrong file clock cannot extend it. A failed backup never prunes: older copies are kept until a new
// one has been written and checked.
//
// DB-agnostic: everything database-specific sits in an adapter ({ extension, dump(destFile) }):
// json-file copies DB_FILE; postgres exports the DrinkMe state stored in Postgres (DB_DRIVER=postgres)
// as a JSON database file in the format server.js writes, usable as DB_FILE for a rollback. Choose it
// with BACKUP_SOURCE.
//
// Environment:
//   DB_FILE        database file (default: server/data/db.json, the same default as server.js)
//   BACKUP_DIR     where backups go (default: server/backups). Use a different disk or bucket mount
//                  in production, so one failure cannot take both.
//   BACKUP_SOURCE  adapter name: json-file or postgres (default: postgres when DB_DRIVER=postgres,
//                  otherwise json-file)
//   DATABASE_URL, DATABASE_SSL  for the postgres adapter (the same values as the server)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const DAILY_RETENTION_DAYS = 7;
export const WEEKLY_RETENTION_DAYS = 28;
const FILE_PREFIX = 'drinkme-';
const DAILY_NAME = /^drinkme-(\d{4})-(\d{2})-(\d{2})\.[a-z0-9.]+$/;
const WEEKLY_NAME = DAILY_NAME; // weekly files carry the date of the run that made them

// ── Adapters ──────────────────────────────────────────────────────────────────
// dump(destFile) must write a complete, checked copy to destFile or throw.
export const adapters = {
  'json-file': ({ dbFile }) => ({
    extension: '.json',
    async dump(destFile) {
      // server.js saves by writing a temp file and renaming it, so a copy is never half-written.
      await fs.promises.copyFile(dbFile, destFile);
      const text = await fs.promises.readFile(destFile, 'utf8');
      const parsed = JSON.parse(text); // throws on a corrupt or truncated copy
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('database file is not a JSON object');
      }
    },
  }),
  postgres: () => ({
    extension: '.json',
    async dump(destFile) {
      // Imported here, so the json-file adapter never loads pg.
      const { openStoreFromEnv } = await import('./postgres-cli.mjs');
      const store = await openStoreFromEnv();
      try {
        const stored = await store.load();
        if (!stored) throw new Error('Postgres holds no DrinkMe state');
        const data = JSON.parse(stored.text);
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
          throw new Error('the Postgres state is not a JSON object');
        }
        await fs.promises.writeFile(destFile, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        JSON.parse(await fs.promises.readFile(destFile, 'utf8')); // throws on a truncated copy
      } finally {
        await store.close().catch(() => {});
      }
    },
  }),
};

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const dateOfName = (name, pattern) => {
  const match = pattern.exec(name);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) && isoDate(ms) === `${match[1]}-${match[2]}-${match[3]}` ? ms : null;
};

// Regular files only: a symlink or anything else with a backup-like name is left alone.
const listBackups = (dir, pattern) => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((name) => ({ name, file: path.join(dir, name), date: dateOfName(name, pattern) }))
    .filter((item) => item.date !== null && fs.lstatSync(item.file).isFile());
};

const writeChecked = async (adapter, destFile) => {
  const tmpFile = `${destFile}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    await adapter.dump(tmpFile);
    await fs.promises.chmod(tmpFile, 0o600).catch(() => {}); // no effect on Windows
    await fs.promises.rename(tmpFile, destFile);
  } catch (error) {
    await fs.promises.rm(tmpFile, { force: true });
    throw error;
  }
};

/**
 * Makes today's backup, the weekly one when due, then prunes. Returns what it did.
 * `now` is injectable for tests.
 */
export async function runBackup({
  dbFile = process.env.DB_FILE?.trim() ? path.resolve(process.env.DB_FILE.trim()) : path.join(SERVER_DIR, 'data', 'db.json'),
  backupDir = process.env.BACKUP_DIR?.trim() ? path.resolve(process.env.BACKUP_DIR.trim()) : path.join(SERVER_DIR, 'backups'),
  source = process.env.BACKUP_SOURCE?.trim() || (process.env.DB_DRIVER?.trim() === 'postgres' ? 'postgres' : 'json-file'),
  now = Date.now(),
} = {}) {
  const makeAdapter = adapters[source];
  if (!makeAdapter) throw new Error(`unknown BACKUP_SOURCE "${source}" (known: ${Object.keys(adapters).join(', ')})`);
  const adapter = makeAdapter({ dbFile });
  if (source === 'json-file' && !fs.existsSync(dbFile)) throw new Error(`no database file at ${dbFile}`);

  const dailyDir = path.join(backupDir, 'daily');
  const weeklyDir = path.join(backupDir, 'weekly');
  fs.mkdirSync(dailyDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(weeklyDir, { recursive: true, mode: 0o700 });

  const today = Date.UTC(...isoDate(now).split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  const created = [];

  const dailyFile = path.join(dailyDir, `${FILE_PREFIX}${isoDate(today)}${adapter.extension}`);
  await writeChecked(adapter, dailyFile); // a second run on the same day refreshes today's copy
  created.push(dailyFile);

  const weeklies = listBackups(weeklyDir, WEEKLY_NAME);
  const isSunday = new Date(today).getUTCDay() === 0;
  const hasRecentWeekly = weeklies.some((item) => item.date > today - 7 * MS_PER_DAY && item.date <= today);
  if (isSunday || !hasRecentWeekly) {
    const weeklyFile = path.join(weeklyDir, `${FILE_PREFIX}${isoDate(today)}${adapter.extension}`);
    await fs.promises.copyFile(dailyFile, weeklyFile);
    created.push(weeklyFile);
  }

  // Only after a good backup. A file dated in the future is kept (a wrong clock must not delete data).
  const pruned = [];
  const prune = (dir, pattern, days) => {
    for (const item of listBackups(dir, pattern)) {
      if (today - item.date >= days * MS_PER_DAY) {
        fs.rmSync(item.file);
        pruned.push(item.file);
      }
    }
  };
  prune(dailyDir, DAILY_NAME, DAILY_RETENTION_DAYS);
  prune(weeklyDir, WEEKLY_NAME, WEEKLY_RETENTION_DAYS);

  return { created, pruned };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runBackup()
    .then(({ created, pruned }) => {
      console.log(`[backup] OK: wrote ${created.length} file(s), removed ${pruned.length} expired.`);
      for (const file of created) console.log(`[backup]   + ${file}`);
      for (const file of pruned) console.log(`[backup]   - ${file}`);
    })
    .catch((error) => {
      console.error(`[backup] FAILED: ${error.message}. Older backups were kept.`);
      process.exitCode = 1;
    });
}
