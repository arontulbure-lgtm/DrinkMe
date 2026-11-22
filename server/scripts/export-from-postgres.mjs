// Writes the DrinkMe state stored in Postgres to a JSON database file (DATA-1): a backup, or a
// rollback to JSON mode (point DB_FILE at the file in its own folder, set DB_DRIVER=json).
//
//   npm run db:export-from-postgres -- <out-file> [--force] [--history <id>]
//   npm run db:export-from-postgres -- --list-history
//
// <out-file>      where to write (relative paths are from the folder npm was run in). Never replaced
//                 unless --force. Written atomically with mode 0600, in the same format as server.js.
// --history <id>  export a snapshot from drinkme_state_history instead of the current state.
// --list-history  print the history snapshots (id, date, counts), no data.
//
// Needs DATABASE_URL (and optionally DATABASE_SSL) in the environment or server/.env. Prints counts only.
// Exit codes: 0 done, 1 failed, 2 refused (nothing written).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { countDbRecords } from '../storage/postgres-store.js';
import {
  SERVER_DIR, describeScriptError, openStoreFromEnv, parseArgs, resolveFromCaller, writeFileAtomically,
} from './postgres-cli.mjs';

const USAGE = 'Usage: npm run db:export-from-postgres -- <out-file> [--force] [--history <id>] | --list-history';
const formatCounts = (counts) => `users=${counts.users} drinks=${counts.drinks} comments=${counts.comments} reports=${counts.reports}`;

/**
 * @returns {Promise<number>} the exit code
 */
export async function exportFromPostgres(argv, { log = console } = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv, { flags: ['--force', '--list-history'], options: ['--history'] });
  } catch (err) {
    log.error(`[export] ${err.message}. ${USAGE}`);
    return 2;
  }
  const listHistory = parsed.flags['--list-history'];
  const historyArg = parsed.options['--history'];
  if (historyArg !== undefined && !/^[1-9]\d{0,15}$/.test(historyArg)) {
    log.error(`[export] --history needs a snapshot id (a whole number). ${USAGE}`);
    return 2;
  }
  if (listHistory ? parsed.positional.length > 0 : parsed.positional.length !== 1) {
    log.error(`[export] ${USAGE}`);
    return 2;
  }

  let store;
  try {
    store = await openStoreFromEnv();
  } catch (err) {
    log.error(`[export] Could not open the Postgres database (${describeScriptError(err)}).`);
    return 1;
  }
  try {
    if (listHistory) {
      const rows = await store.listHistory();
      if (rows.length === 0) log.log('[export] drinkme_state_history is empty.');
      for (const row of rows) {
        const counts = countDbRecords(JSON.parse(await store.loadHistory(row.id)));
        log.log(`[export] #${row.id} ${new Date(row.createdAt).toISOString()} ${formatCounts(counts)}`);
      }
      return 0;
    }

    const text = historyArg === undefined ? (await store.load())?.text ?? null : await store.loadHistory(Number(historyArg));
    if (text === null) {
      log.error(historyArg === undefined
        ? '[export] Postgres holds no DrinkMe state (drinkme_state is empty). Nothing was written.'
        : `[export] No history snapshot #${historyArg}. Nothing was written.`);
      return 2;
    }
    const data = JSON.parse(text);
    const outFile = resolveFromCaller(parsed.positional[0]);
    try {
      // The same format saveDb writes in JSON mode, so the file can be used as DB_FILE.
      await writeFileAtomically(outFile, JSON.stringify(data, null, 2), { overwrite: parsed.flags['--force'] });
    } catch (err) {
      log.error(`[export] Could not write ${outFile} (${describeScriptError(err)}). Nothing was written.`);
      return err?.code === 'EEXIST' ? 2 : 1;
    }
    log.log(`[export] Done: ${formatCounts(countDbRecords(data))} written to ${outFile}.`);
    return 0;
  } catch (err) {
    log.error(`[export] Failed (${describeScriptError(err)}).`);
    return 1;
  } finally {
    await store.close().catch(() => {});
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // Values already in the environment win over server/.env.
  dotenv.config({ path: path.join(SERVER_DIR, '.env') });
  process.exitCode = await exportFromPostgres(process.argv.slice(2));
}
