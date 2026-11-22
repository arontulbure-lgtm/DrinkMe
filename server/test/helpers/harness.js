import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER_FILE = path.join(SERVER_DIR, 'server.js');

/** The real database. Tests may stat it, but must never read or write it. */
export const REAL_DATA_DIR = path.join(SERVER_DIR, 'data');
export const REAL_DB_FILE  = path.join(REAL_DATA_DIR, 'db.json');

// Overridable so two worktrees can run the suite at the same time (e.g. DRINKME_TEST_PORT=5056).
const TEST_PORT          = /^\d{2,5}$/.test(process.env.DRINKME_TEST_PORT ?? '') ? process.env.DRINKME_TEST_PORT : '5055';
const INHERITED_ENV_KEYS = ['PATH', 'SystemRoot', 'TEMP', 'TMP'];
const START_TIMEOUT_MS   = 30_000;
const POLL_INTERVAL_MS   = 100;
const OUTPUT_TAIL_CHARS  = 4_000;
const LISTENING_MESSAGE  = 'API running at';

const isInside = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false; // different drive on Windows
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
};

/** Resolves symlinks/junctions on the part of the path that already exists. */
const realpathOfExisting = (target) => {
  let existing = target;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return target;
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), path.relative(existing, target));
};

/**
 * Allows only a DB_FILE inside os.tmpdir() or the harness temp dir, and always
 * refuses server/data/. An empty or whitespace-only value is refused too,
 * because the server would fall back to server/data/db.json.
 */
const assertSafeDbFile = (dbFileEnv, cwd) => {
  if (typeof dbFileEnv !== 'string' || !dbFileEnv.trim()) {
    throw new Error('Refusing to start the server without a non-empty DB_FILE');
  }
  const resolved = path.resolve(cwd, dbFileEnv.trim()); // the server trims too
  const realResolved = realpathOfExisting(resolved);
  if (
    isInside(REAL_DATA_DIR, resolved) ||
    isInside(realpathOfExisting(REAL_DATA_DIR), realResolved)
  ) {
    throw new Error(`Refusing to use a DB_FILE inside server/data/: ${resolved}`);
  }
  const allowedDirs = [os.tmpdir(), cwd].map(realpathOfExisting);
  if (!allowedDirs.some((dir) => isInside(dir, realResolved))) {
    throw new Error(`Refusing to use a DB_FILE outside the temp directory: ${resolved}`);
  }
  return resolved;
};

const healthzAnswers = async (port) => {
  try {
    await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) });
    return true;
  } catch {
    return false;
  }
};

const applyFixture = (dbFile, dbFixture) => {
  if (dbFixture === undefined) return;
  if (dbFixture === null) {
    fs.rmSync(dbFile, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  fs.writeFileSync(dbFile, JSON.stringify(dbFixture, null, 2), 'utf8');
};

/**
 * Starts server.js on a temporary DB_FILE, with a child env built from scratch.
 *
 * @param {Record<string, string>} [env] Overrides for the child env.
 * @param {{ dbFixture?: object }} [options] dbFixture is written to DB_FILE before the spawn.
 * @returns {Promise<{
 *   baseUrl: string,
 *   dbFile: string,
 *   getOutput: () => string,
 *   restart:(options?: { dbFixture?: object | null }) => Promise<void>,
 *   stop: () => Promise<void>,
 * }>} restart keeps the same DB_FILE. Its dbFixture replaces the file; null removes it.
 */
export async function startServer(env = {}, { dbFixture } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drinkme-test-'));
  const removeTempDir = () => {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };

  let child = null;
  let exited = Promise.resolve();
  let hasExited = true;
  let exitCode = null;
  let output = '';
  let stderrTail = '';

  const killOnExit = () => child?.kill();

  const stopChild = async () => {
    if (!hasExited) child.kill();
    await exited;
  };

  try {
    const inherited = Object.fromEntries(
      INHERITED_ENV_KEYS
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]])
    );
    const childEnv = {
      ...inherited,
      PORT: TEST_PORT,
      HOST: '127.0.0.1',
      JWT_SECRET: 'test-only-jwt-secret',
      FIREBASE_SERVICE_ACCOUNT_KEY: '',
      NODE_ENV: 'test',
      ALLOW_INSECURE_DEV_AUTH: 'true',
      DB_FILE: path.join(tempDir, 'db.json'),
      ...env,
    };
    const dbFile  = assertSafeDbFile(childEnv.DB_FILE, tempDir);
    const baseUrl = `http://127.0.0.1:${childEnv.PORT}`;

    const spawnAndWait = async () => {
      if (await healthzAnswers(childEnv.PORT)) {
        throw new Error(`Port ${childEnv.PORT} already answers /healthz; refusing to start`);
      }

      output = '';
      stderrTail = '';
      exitCode = null;
      hasExited = false;
      child = spawn(process.execPath, [SERVER_FILE], {
        cwd: tempDir, // no .env here, so dotenv loads nothing
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let isListening = false;
      const keepTail = (chunk) => {
        output = (output + chunk).slice(-OUTPUT_TAIL_CHARS);
      };
      let stdoutTail = '';
      child.stdout.on('data', (chunk) => {
        stdoutTail = (stdoutTail + chunk).slice(-OUTPUT_TAIL_CHARS);
        isListening = isListening || stdoutTail.includes(LISTENING_MESSAGE);
      });
      child.stdout.on('data', keepTail);
      child.stderr.on('data', keepTail);
      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-OUTPUT_TAIL_CHARS);
      });
      exited = new Promise((resolve) => {
        const onDone = (code = null) => {
          exitCode = code;
          hasExited = true;
          resolve();
        };
        // 'close', not 'exit': the last output has been received by then.
        child.once('close', onDone);
        child.once('error', () => onDone());
      });

      const deadline = Date.now() + START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (hasExited) {
          throw Object.assign(new Error(`Server exited during startup:\n${output}`), {
            exitCode,
            stderr: stderrTail,
            output,
          });
        }
        // Only trust /healthz once our child has reported listening, so a foreign
        // server that took the port after the pre-check is never mistaken for it.
        if (isListening && await healthzAnswers(childEnv.PORT)) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      throw new Error(`Server did not answer /healthz in time:\n${output}`);
    };

    process.once('exit', killOnExit);
    applyFixture(dbFile, dbFixture);
    await spawnAndWait();

    let stopped = false;
    return {
      baseUrl,
      dbFile,
      getOutput: () => output,
      async restart({ dbFixture: nextFixture } = {}) {
        await stopChild();
        applyFixture(dbFile, nextFixture);
        await spawnAndWait();
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        await stopChild();
        process.removeListener('exit', killOnExit);
        removeTempDir();
      },
    };
  } catch (err) {
    await stopChild();
    process.removeListener('exit', killOnExit);
    try {
      removeTempDir();
    } catch (cleanupErr) {
      console.warn('[harness] Could not remove temp dir:', cleanupErr.message);
    }
    throw err; // always the original startup error
  }
}

/**
 * Asserts that the server exits non-zero during startup and never opens its port.
 * Stops a server that wrongly started, so a regression fails instead of hanging the run.
 *
 * @param {Record<string, string>} [env] Overrides for the child env.
 * @param {{ dbFixture?: object }} [options] Passed to startServer.
 * @returns {Promise<{ stderr: string, output: string }>} output holds stdout and stderr together.
 */
export async function assertRefusesToStart(env = {}, options = {}) {
  let wronglyStarted = null;
  try {
    wronglyStarted = await startServer(env, options);
  } catch (err) {
    assert.match(err.message, /Server exited during startup/);
    assert.ok(Number.isInteger(err.exitCode) && err.exitCode !== 0, `exit code was ${err.exitCode}`);
    assert.ok(!err.output.includes(LISTENING_MESSAGE), 'the server must not report listening');
    assert.equal(await healthzAnswers(env.PORT ?? TEST_PORT), false, 'the port must stay closed');
    return { stderr: err.stderr, output: err.output };
  }
  await wronglyStarted.stop();
  assert.fail('the server must refuse to start');
}
