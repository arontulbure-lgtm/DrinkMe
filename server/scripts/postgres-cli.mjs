// Shared helpers for the Postgres scripts (migrate-to-postgres.mjs, export-from-postgres.mjs) and the
// postgres backup adapter in backup.js. Nothing here prints a connection string, a password or a record.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { openPostgresStore, readDbDriverConfig } from '../storage/postgres-store.js';

export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Same lists as server.js (DB_COUNTER_KEYS, DB_LIST_KEYS, DB_MAP_KEYS). The server checks the shape
// again at load; this copy lets the scripts refuse a document the server would treat as corrupt.
const COUNTER_KEYS = ['nextDrinkId', 'nextNotificationId', 'nextCommentId', 'nextReportId', 'nextAuditId', 'dbSchemaVersion', 'recoveryStartedAt'];
const LIST_KEYS = ['drinks', 'users', 'reports', 'pendingAccountDeletions', 'auditLog'];
const MAP_KEYS = [
  'cheersByUser', 'savedByUser', 'smartBarByUser',
  'partnersByUser', 'notificationsByUser', 'commentsByDrink', 'limitEventsByUser', 'blocksByUser',
  'partnerRequestsByUser',
];
// The schema version server.js writes (DB_SCHEMA_VERSION). Older files are migrated by the server in
// JSON mode first, which also makes the .pre-migration- backup next to the file.
export const MIN_SCHEMA_VERSION = 2;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The name of the first invalid key (never a value), or null. */
export function findDocumentProblem(data) {
  if (!isPlainObject(data)) return 'the root is not a JSON object';
  if (![...COUNTER_KEYS, ...LIST_KEYS, ...MAP_KEYS].some((key) => key in data)) return 'no known DrinkMe keys';
  for (const key of COUNTER_KEYS) {
    if (key in data && typeof data[key] !== 'number') return `invalid ${key}`;
  }
  if ('dbSchemaVersion' in data && !Number.isSafeInteger(data.dbSchemaVersion)) return 'invalid dbSchemaVersion';
  for (const key of LIST_KEYS) {
    if (key in data && !(Array.isArray(data[key]) && data[key].every(isPlainObject))) return `invalid ${key}`;
  }
  for (const key of MAP_KEYS) {
    if (key in data && !(isPlainObject(data[key]) && Object.values(data[key]).every(Array.isArray))) return `invalid ${key}`;
  }
  if (!(data.dbSchemaVersion >= MIN_SCHEMA_VERSION)) {
    return `schema version below ${MIN_SCHEMA_VERSION}: start the server once in JSON mode on this file so it migrates (and backs it up), then run this again`;
  }
  return null;
}

/** Splits argv into positional arguments and the given flags. Unknown flags throw. */
export function parseArgs(argv, { flags = [], options = [] } = {}) {
  const positional = [];
  const flagValues = Object.fromEntries(flags.map((flag) => [flag, false]));
  const optionValues = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flags.includes(arg)) flagValues[arg] = true;
    else if (options.includes(arg)) {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      optionValues[arg] = argv[++i];
    } else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else positional.push(arg);
  }
  return { positional, flags: flagValues, options: optionValues };
}

/** A path given on the command line, relative to where npm was run (INIT_CWD), not to server/. */
export const resolveFromCaller = (file) => path.resolve(process.env.INIT_CWD || process.cwd(), file);

/** DB_FILE as server.js resolves it. */
export const defaultDbFile = () => (
  process.env.DB_FILE?.trim() ? path.resolve(process.env.DB_FILE.trim()) : path.join(SERVER_DIR, 'data', 'db.json')
);

/**
 * Opens the store from DATABASE_URL / DATABASE_SSL, whatever DB_DRIVER says (the migration runs while
 * the server is still in JSON mode). Throws with setting names only.
 */
export async function openStoreFromEnv(env = process.env) {
  const config = readDbDriverConfig({ ...env, DB_DRIVER: 'postgres' });
  if (config.problems.length > 0) throw scriptError(`invalid settings: ${config.problems.join('; ')}`);
  const store = await openPostgresStore({ connectionString: config.databaseUrl, ssl: config.ssl });
  await store.ensureSchema();
  return store;
}

/** Writes text to file atomically (temp file, rename), mode 0600. Refuses to replace a file unless overwrite. */
export async function writeFileAtomically(file, text, { overwrite = false } = {}) {
  if (!overwrite && fs.existsSync(file)) throw scriptError('the output file exists (use --force to replace it)', 'EEXIST');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    const handle = await fs.promises.open(tmpFile, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(tmpFile, file);
  } catch (err) {
    await fs.promises.rm(tmpFile, { force: true });
    throw err;
  }
}

/** An error whose message this code wrote, so it may be printed. */
export const scriptError = (message, code) => Object.assign(new Error(message), { ownMessage: true, ...(code && { code }) });

/** One line for an error: our own message, or a code, never a pg or Node message (it can name the host or user). */
export const describeScriptError = (err) => {
  if (err?.ownMessage) return err.message;
  if (err instanceof SyntaxError) return 'invalid JSON';
  if (typeof err?.code === 'string' && err.code) return err.code;
  return err?.name ?? 'Error';
};
