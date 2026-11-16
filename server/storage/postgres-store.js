// DATA-1 stepping stone: the whole database document as one JSONB value in Postgres.
//
// server.js keeps every record in memory, exactly as in JSON-file mode, and saveDb() hands the serialised
// document to a write-behind queue here. One table row holds the current document; a small history
// table keeps hourly snapshots in place of the file backups. This is NOT the final design: the next step
// is a relational schema (one table per collection), which these helpers make easier because the data
// already lives in the database the app will use.
//
// Plain ESM with no side effects at import. `pg` is loaded only when a store is opened, so JSON-file
// mode never loads it. Nothing here logs a connection string, a password, a host or a record: errors are
// reported by code only (pg error codes such as 28P01, or Node codes such as ECONNREFUSED).

export const DB_DRIVERS = ['json', 'postgres'];
export const STATE_TABLE = 'drinkme_state';
export const HISTORY_TABLE = 'drinkme_state_history';
export const DEFAULT_HISTORY_MAX_ROWS = 30;
export const DEFAULT_HISTORY_MIN_INTERVAL_MS = 60 * 60 * 1000;
// The app promises that a deleted account leaves every backup within 30 days. 28 days of age plus at most
// one day until the daily purge (server.js runs it every 24 hours, and every write prunes too) stays inside.
export const DEFAULT_HISTORY_MAX_AGE_MS = 28 * 24 * 60 * 60 * 1000;
// Write-behind retry waits. The last one repeats until the write succeeds or a newer snapshot replaces it.
export const DEFAULT_RETRY_WAITS_MS = [250, 500, 1000, 2000, 5000, 10000, 30000];
// Arbitrary constants for advisory locks: the schema creation (transaction-scoped), and the one server
// instance per database (session-scoped, held on a dedicated connection while the server runs).
const SCHEMA_LOCK_KEY = 4_163_271_905;
export const INSTANCE_LOCK_KEY = 4_163_271_906;

// sslmode values in DATABASE_URL. pg lets the URL's sslmode override the ssl option, so DATABASE_SSL=require
// cannot be combined with a mode that allows plain text or skips the certificate check.
const SSLMODES_WEAKER_THAN_REQUIRE = ['disable', 'allow', 'prefer', 'no-verify'];
// Modes that encrypt and verify the server certificate (pg 8 treats require like verify-full).
const VERIFYING_SSLMODES = ['verify-full', 'verify-ca', 'require'];

/** The URL's sslmode (lowercase), null when absent, or undefined when the URL cannot be parsed. */
export function sslmodeOf(databaseUrl) {
  try {
    const value = new URL(databaseUrl).searchParams.get('sslmode');
    return value === null ? null : value.trim().toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Reads DB_DRIVER, DATABASE_URL and DATABASE_SSL. Never throws. `problems` holds setting names and the
 * rule they break, never their values, so it can go straight to exitOnInvalidProductionConfig.
 * With production: true, Postgres mode also needs a verified TLS connection (DATABASE_SSL=require, or
 * sslmode verify-full / verify-ca / require in the URL), or DATABASE_SSL=disable set on purpose (warned).
 * @param {Record<string, string | undefined>} env
 * @param {{ production?: boolean }} [options]
 * @returns {{ driver: string, databaseUrl: string, ssl: 'require' | 'disable' | null, sslmode: string | null | undefined, problems: string[], warnings: string[] }}
 */
export function readDbDriverConfig(env, { production = false } = {}) {
  const problems = [];
  const warnings = [];
  const rawDriver = (env.DB_DRIVER ?? '').trim();
  const driver = rawDriver === '' ? 'json' : rawDriver;
  if (!DB_DRIVERS.includes(driver)) problems.push('DB_DRIVER (must be json or postgres)');

  const databaseUrl = (env.DATABASE_URL ?? '').trim();
  const rawSsl = (env.DATABASE_SSL ?? '').trim();
  const ssl = rawSsl === '' ? null : rawSsl;
  if (ssl !== null && ssl !== 'require' && ssl !== 'disable') problems.push('DATABASE_SSL (must be require or disable)');

  let sslmode = null;
  if (driver === 'postgres') {
    if (!databaseUrl) problems.push('DATABASE_URL (required when DB_DRIVER=postgres)');
    else if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) problems.push('DATABASE_URL (must start with postgres:// or postgresql://)');
    else {
      sslmode = sslmodeOf(databaseUrl);
      if (sslmode === undefined) problems.push('DATABASE_URL (not a valid URL)');
      else if (ssl === 'require' && SSLMODES_WEAKER_THAN_REQUIRE.includes(sslmode)) {
        problems.push('DATABASE_SSL (require conflicts with a weaker sslmode in DATABASE_URL, which pg would use instead)');
      } else if (production) {
        if (ssl === 'disable') {
          warnings.push('DATABASE_SSL=disable: the Postgres connection is not encrypted. Use this only on a private network.');
        } else if (ssl !== 'require' && !VERIFYING_SSLMODES.includes(sslmode)) {
          problems.push('DATABASE_SSL (production needs require, or sslmode=verify-full in DATABASE_URL; disable only on a private network)');
        }
      }
    }
  } else if (driver === 'json' && databaseUrl) {
    warnings.push('DATABASE_URL is set but DB_DRIVER is not postgres: using the JSON file.');
  }
  return { driver, databaseUrl, ssl, sslmode, problems, warnings };
}

/** The pg `ssl` option for a DATABASE_SSL value. null leaves it to the URL (sslmode=...). */
export function sslOptionFor(ssl) {
  if (ssl === 'require') return { rejectUnauthorized: true };
  if (ssl === 'disable') return false;
  return undefined;
}

/** An error's code for a log line: never its message, which can name the host, user or database. */
export const describePgError = (err) => {
  const code = err?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/i.test(code) ? code : (err?.name ?? 'Error');
};

// JSONB refuses \u0000 and lone UTF-16 surrogates, which JSON.stringify can produce. The regex matches
// an escape only when it is preceded by an even number of backslashes (so typed text such as "\u0000"
// stays as it is). Well-formed JSON.stringify writes valid surrogate pairs as raw characters, so any
// \ud800-\udfff escape in its output is a lone surrogate.
const JSONB_UNSAFE_ESCAPE = /(?<!\\)((?:\\\\)*)\\u(?:0000|[dD][89a-fA-F][0-9a-fA-F]{2})/g;

/**
 * Makes JSON text acceptable to JSONB: replaces \u0000 and lone surrogate escapes with �.
 * @param {string} text JSON text from JSON.stringify
 * @returns {{ text: string, replaced: number }}
 */
export function toJsonbSafeText(text) {
  if (!text.includes('\\u0') && !/\\u[dD][89a-fA-F]/.test(text)) return { text, replaced: 0 };
  let replaced = 0;
  const safe = text.replace(JSONB_UNSAFE_ESCAPE, (_match, backslashes) => {
    replaced += 1;
    return `${backslashes}\\ufffd`;
  });
  return { text: safe, replaced };
}

const defaultSleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms).unref?.();
});

/**
 * Ordered write-behind with coalescing: at most one write in flight; while it runs, newer snapshots
 * replace each other and only the latest is written next. A failed write is retried with backoff
 * (the last wait repeats) until it succeeds or a newer snapshot supersedes it, so nothing is dropped
 * while the process lives. Snapshots are written in the order they were enqueued.
 *
 * Each snapshot gets a sequence number. A written snapshot contains every change of the ones before it,
 * so "snapshot n is stored" means writtenSeq >= n. flush() waits for the snapshots enqueued before it
 * only, so steady traffic cannot keep it waiting.
 *
 * @param {{
 *   write: (snapshot: any) => Promise<void>,
 *   retryWaitsMs?: number[],
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: { warn: (msg: string) => void, error: (msg: string) => void, log?: (msg: string) => void },
 * }} options
 */
export function createWriteBehindQueue({ write, retryWaitsMs = DEFAULT_RETRY_WAITS_MS, sleep = defaultSleep, log = console }) {
  let latest;          // the newest snapshot not yet handed to write()
  let latestSeq = 0;
  let hasLatest = false;
  let running = false; // a pump is active (a write in flight or a retry wait)
  let enqueuedSeq = 0;
  let writtenSeq = 0;
  let writtenCount = 0;
  let failedAttempts = 0;
  let waiters = [];    // [{ seq, resolve }]
  let wakeRetry = null; // ends a retry wait early (flush, or a newer snapshot after a failure)

  const isIdle = () => !running && !hasLatest;
  const notifyWritten = () => {
    const ready = waiters.filter((waiter) => waiter.seq <= writtenSeq);
    waiters = waiters.filter((waiter) => waiter.seq > writtenSeq);
    for (const waiter of ready) waiter.resolve(true);
  };

  const interruptibleSleep = (ms) => new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      wakeRetry = null;
      resolve();
    };
    wakeRetry = finish;
    sleep(ms).then(finish, finish);
  });

  async function pump() {
    running = true;
    let snapshot;
    let snapshotSeq = 0;
    let failures = 0;
    try {
      while (hasLatest || failures > 0) {
        if (hasLatest) {
          // A newer snapshot always wins over one that is still failing: it contains every change.
          snapshot = latest;
          snapshotSeq = latestSeq;
          latest = undefined;
          hasLatest = false;
        }
        try {
          await write(snapshot);
          writtenCount += 1;
          writtenSeq = Math.max(writtenSeq, snapshotSeq);
          if (failures > 0) log.warn(`[db] Postgres write succeeded after ${failures} failed attempt(s).`);
          failures = 0;
          snapshot = undefined;
          notifyWritten();
        } catch (err) {
          failures += 1;
          failedAttempts += 1;
          const wait = retryWaitsMs[Math.min(failures - 1, retryWaitsMs.length - 1)];
          // One line on the first failure, then every 10th, so an outage cannot flood the log.
          if (failures === 1 || failures % 10 === 0) {
            log.error(`[db] Postgres write failed (${describePgError(err)}), attempt ${failures}; retrying in ${wait} ms. Changes stay in memory until a write succeeds.`);
          }
          await interruptibleSleep(wait);
        }
      }
    } finally {
      running = false;
      notifyWritten();
    }
  }

  return {
    /** Queues a snapshot and returns its sequence number. Never throws and never waits. */
    enqueue(snapshot) {
      enqueuedSeq += 1;
      latest = snapshot;
      latestSeq = enqueuedSeq;
      hasLatest = true;
      if (!running) {
        pump().catch((err) => log.error(`[db] Postgres write queue stopped (${describePgError(err)}).`));
      }
      return enqueuedSeq;
    },
    /**
     * Resolves true once every snapshot enqueued so far is written, or false after timeoutMs. A pending
     * retry wait is cut short, so a flush tries the write at once.
     */
    flush(timeoutMs = 10_000) {
      const seq = enqueuedSeq;
      if (writtenSeq >= seq) return Promise.resolve(true);
      wakeRetry?.();
      return new Promise((resolve) => {
        // Not unref'd: a shutdown flush must keep the process alive until it ends, even with nothing
        // else left (retry waits are unref'd).
        const timer = setTimeout(() => {
          waiters = waiters.filter((item) => item !== waiter);
          resolve(false);
        }, timeoutMs);
        const waiter = {
          seq,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
        };
        waiters.push(waiter);
      });
    },
    isIdle,
    stats: () => ({ enqueued: enqueuedSeq, written: writtenCount, failedAttempts, pending: !isIdle() }),
  };
}

/**
 * Opens a pool and returns the store. Throws (with the pg error code) when pg cannot be loaded; the
 * connection itself is made by the first query (ensureSchema).
 *
 * @param {{
 *   connectionString: string,
 *   ssl?: 'require' | 'disable' | null,
 *   historyMaxRows?: number,
 *   historyMinIntervalMs?: number,
 *   historyMaxAgeMs?: number,
 *   poolFactory?: (config: object) => any,
 *   log?: { warn: (msg: string) => void, error: (msg: string) => void },
 * }} options poolFactory is for tests (a fake pg.Pool).
 */
export async function openPostgresStore({
  connectionString,
  ssl = null,
  historyMaxRows = DEFAULT_HISTORY_MAX_ROWS,
  historyMinIntervalMs = DEFAULT_HISTORY_MIN_INTERVAL_MS,
  historyMaxAgeMs = DEFAULT_HISTORY_MAX_AGE_MS,
  poolFactory,
  log = console,
}) {
  let makePool = poolFactory;
  if (!makePool) {
    const { default: pg } = await import('pg');
    makePool = (config) => new pg.Pool(config);
  }
  const pool = makePool({
    connectionString,
    ...(sslOptionFor(ssl) !== undefined && { ssl: sslOptionFor(ssl) }),
    max: 4, // one is the instance lock while the server runs
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    application_name: 'drinkme-server',
  });
  // An idle client that loses its connection emits 'error' on the pool; without a listener Node exits.
  pool.on?.('error', (err) => log.warn(`[db] Postgres connection error (${describePgError(err)}); it reconnects on the next write.`));

  const withTransaction = async (work) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // the connection is gone; the server rolled back already
      }
      throw err;
    } finally {
      client.release();
    }
  };

  let lockClient = null;

  const store = {
    /**
     * Takes the session advisory lock that allows one DrinkMe server (or migration) per database, on a
     * connection of its own kept for the life of the process. Resolves false when another holds it.
     * If that connection drops, Postgres releases the lock; this is logged.
     */
    async acquireInstanceLock() {
      const client = await pool.connect();
      let locked = false;
      try {
        const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [INSTANCE_LOCK_KEY]);
        locked = rows[0]?.locked === true;
      } finally {
        if (!locked) client.release();
      }
      if (locked) {
        lockClient = client;
        client.on?.('error', (err) => log.error(`[db] Lost the Postgres connection holding the instance lock (${describePgError(err)}). Another server could now start on this database.`));
      }
      return locked;
    },

    /** Creates the two tables if missing. Idempotent and safe to run from two processes at once. */
    async ensureSchema() {
      await withTransaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_KEY]);
        await client.query(`CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
          id smallint PRIMARY KEY CHECK (id = 1),
          data jsonb NOT NULL,
          schema_version integer,
          updated_at timestamptz NOT NULL DEFAULT now()
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
          id bigserial PRIMARY KEY,
          data jsonb NOT NULL,
          schema_version integer,
          created_at timestamptz NOT NULL DEFAULT now()
        )`);
        await client.query(`CREATE INDEX IF NOT EXISTS ${HISTORY_TABLE}_created_at_idx ON ${HISTORY_TABLE} (created_at)`);
      });
    },

    /**
     * The stored document as JSON text, or null when there is no state row.
     * @returns {Promise<{ text: string, schemaVersion: number | null, updatedAt: Date } | null>}
     */
    async load() {
      const { rows } = await pool.query(`SELECT data::text AS data, schema_version, updated_at FROM ${STATE_TABLE} WHERE id = 1`);
      if (rows.length === 0) return null;
      return { text: rows[0].data, schemaVersion: rows[0].schema_version ?? null, updatedAt: rows[0].updated_at };
    },

    /**
     * Replaces the document, then adds a history snapshot when the newest one is older than
     * historyMinIntervalMs, and prunes history to historyMaxRows rows and historyMaxAgeMs. One transaction.
     * keepAllHistory skips the row limit (the age ceiling still applies): server.js sets it while a
     * recovery hold may be on, so snapshots from before a lost start are not pushed out.
     * @param {{ text: string, schemaVersion: number | null, keepAllHistory?: boolean }} snapshot JSON text (see toJsonbSafeText)
     */
    async write({ text, schemaVersion, keepAllHistory = false }) {
      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO ${STATE_TABLE} (id, data, schema_version, updated_at) VALUES (1, $1::jsonb, $2, now())
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, schema_version = EXCLUDED.schema_version, updated_at = now()`,
          [text, schemaVersion],
        );
        await client.query(
          `INSERT INTO ${HISTORY_TABLE} (data, schema_version)
           SELECT data, schema_version FROM ${STATE_TABLE}
           WHERE id = 1 AND NOT EXISTS (
             SELECT 1 FROM ${HISTORY_TABLE} WHERE created_at > now() - ($1::double precision * interval '1 millisecond')
           )`,
          [historyMinIntervalMs],
        );
        await store.pruneHistory({ client, byCount: !keepAllHistory });
      });
    },

    /**
     * Deletes history older than historyMaxAgeMs and, unless byCount is false, beyond historyMaxRows
     * (newest kept). Returns the number of rows deleted.
     */
    async pruneHistory({ client = pool, byCount = true } = {}) {
      const { rowCount } = await client.query(
        `DELETE FROM ${HISTORY_TABLE}
         WHERE created_at < now() - ($1::double precision * interval '1 millisecond')
            OR ($3::boolean AND id NOT IN (SELECT id FROM ${HISTORY_TABLE} ORDER BY id DESC LIMIT $2))`,
        [historyMaxAgeMs, historyMaxRows, byCount],
      );
      return rowCount ?? 0;
    },

    /** Copies the current state row into history now (used by the migration script before --force). */
    async snapshotCurrentToHistory() {
      const { rowCount } = await pool.query(
        `INSERT INTO ${HISTORY_TABLE} (data, schema_version) SELECT data, schema_version FROM ${STATE_TABLE} WHERE id = 1`,
      );
      return rowCount ?? 0;
    },

    /** History rows, newest first, without their data: [{ id, createdAt, schemaVersion }]. */
    async listHistory() {
      const { rows } = await pool.query(`SELECT id, created_at, schema_version FROM ${HISTORY_TABLE} ORDER BY id DESC`);
      return rows.map((row) => ({ id: Number(row.id), createdAt: row.created_at, schemaVersion: row.schema_version ?? null }));
    },

    /** One history snapshot's JSON text, or null. */
    async loadHistory(id) {
      const { rows } = await pool.query(`SELECT data::text AS data FROM ${HISTORY_TABLE} WHERE id = $1`, [id]);
      return rows.length === 0 ? null : rows[0].data;
    },

    async close() {
      if (lockClient) {
        try {
          await lockClient.query('SELECT pg_advisory_unlock($1)', [INSTANCE_LOCK_KEY]);
        } catch {
          // the lock ends with the connection anyway
        }
        lockClient.release();
        lockClient = null;
      }
      await pool.end();
    },
  };
  return store;
}

/**
 * Counts for the scripts' summaries: numbers only, never personal data.
 * @param {any} data a parsed database document
 */
export function countDbRecords(data) {
  const lengthOf = (value) => (Array.isArray(value) ? value.length : 0);
  let comments = 0;
  if (data && typeof data.commentsByDrink === 'object' && data.commentsByDrink !== null) {
    for (const list of Object.values(data.commentsByDrink)) comments += lengthOf(list);
  }
  return {
    users: lengthOf(data?.users),
    drinks: lengthOf(data?.drinks),
    comments,
    reports: lengthOf(data?.reports),
  };
}
