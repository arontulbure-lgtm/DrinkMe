// Copies a DrinkMe JSON database file into Postgres (DATA-1).
//
//   npm run db:migrate-to-postgres -- [file] [--force]
//
// file      the JSON database (default: DB_FILE, else server/data/db.json). A relative path is read
//           from the folder npm was run in.
// --force   replace a Postgres state that already holds data. The replaced state is copied into
//           drinkme_state_history first, so it can be exported again.
//
// Needs DATABASE_URL (and optionally DATABASE_SSL) in the environment or server/.env; DB_DRIVER does not
// matter. Stop the server first, so no write lands in the file after the copy. Prints counts only
// (users, drinks, comments, reports), never personal data, a connection string or a password.
// Exit codes: 0 done, 1 failed, 2 refused (nothing written).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { countDbRecords, toJsonbSafeText } from '../storage/postgres-store.js';
import {
  SERVER_DIR, defaultDbFile, describeScriptError, findDocumentProblem, openStoreFromEnv, parseArgs, resolveFromCaller,
} from './postgres-cli.mjs';

const formatCounts = (counts) => `users=${counts.users} drinks=${counts.drinks} comments=${counts.comments} reports=${counts.reports}`;
const hasRecords = (counts) => Object.values(counts).some((value) => value > 0);

/**
 * @returns {Promise<number>} the exit code
 */
export async function migrateToPostgres(argv, { log = console } = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv, { flags: ['--force'] });
  } catch (err) {
    log.error(`[migrate] ${err.message}. Usage: npm run db:migrate-to-postgres -- [file] [--force]`);
    return 2;
  }
  if (parsed.positional.length > 1) {
    log.error('[migrate] Too many arguments. Usage: npm run db:migrate-to-postgres -- [file] [--force]');
    return 2;
  }
  const force = parsed.flags['--force'];
  const file = parsed.positional[0] ? resolveFromCaller(parsed.positional[0]) : defaultDbFile();

  let data;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
    data = JSON.parse(text);
  } catch (err) {
    log.error(`[migrate] Could not read the JSON database at ${file} (${describeScriptError(err)}). Nothing was written.`);
    return 1;
  }
  const problem = findDocumentProblem(data);
  if (problem) {
    log.error(`[migrate] Refused: ${problem}. Nothing was written.`);
    return 2;
  }
  const counts = countDbRecords(data);

  let store;
  try {
    store = await openStoreFromEnv();
  } catch (err) {
    log.error(`[migrate] Could not open the Postgres database (${describeScriptError(err)}). Nothing was written.`);
    return 1;
  }
  try {
    // The server takes the same lock: a running server would overwrite the migrated state with its own.
    if (!(await store.acquireInstanceLock())) {
      log.error('[migrate] Refused: a DrinkMe server (or another migration) is using this Postgres database. Stop it first. Nothing was written.');
      return 2;
    }
    const existing = await store.load();
    if (existing) {
      const existingCounts = countDbRecords(JSON.parse(existing.text));
      if (hasRecords(existingCounts) && !force) {
        log.error(`[migrate] Refused: Postgres already holds a DrinkMe state (${formatCounts(existingCounts)}). Run again with --force to replace it (the current state is kept in drinkme_state_history first). Nothing was written.`);
        return 2;
      }
      if (hasRecords(existingCounts)) {
        await store.snapshotCurrentToHistory();
        log.log(`[migrate] Copied the existing state (${formatCounts(existingCounts)}) to drinkme_state_history before replacing it.`);
      }
    }

    const { text: safeText, replaced } = toJsonbSafeText(JSON.stringify(data));
    if (replaced > 0) log.warn(`[migrate] Replaced ${replaced} escape(s) Postgres cannot store (NUL or a lone surrogate) with U+FFFD.`);
    await store.write({ text: safeText, schemaVersion: data.dbSchemaVersion });

    const stored = await store.load();
    const storedCounts = stored ? countDbRecords(JSON.parse(stored.text)) : null;
    if (!storedCounts || formatCounts(storedCounts) !== formatCounts(counts)) {
      log.error('[migrate] The state read back from Postgres does not match the file. Check the database before switching DB_DRIVER.');
      return 1;
    }
    log.log(`[migrate] Done: ${formatCounts(counts)} written to Postgres (drinkme_state) and read back.`);
    log.log('[migrate] Next: set DB_DRIVER=postgres (and DATABASE_URL) for the server, then start it. Keep the JSON file as a rollback copy.');
    return 0;
  } catch (err) {
    log.error(`[migrate] Failed (${describeScriptError(err)}). The previous Postgres state is unchanged unless the message above says otherwise.`);
    return 1;
  } finally {
    await store.close().catch(() => {});
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // Values already in the environment win over server/.env.
  dotenv.config({ path: path.join(SERVER_DIR, '.env') });
  process.exitCode = await migrateToPostgres(process.argv.slice(2));
}
