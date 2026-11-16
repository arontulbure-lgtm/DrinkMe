// Runs the Postgres tests (DATA-1) against a throwaway Docker container:
//
//   cd server && npm run test:postgres
//
// Starts postgres:16-alpine on a free local port with a random password (never printed), waits until it
// accepts connections, runs test/postgres-store.test.js and test/postgres-integration.test.js with
// TEST_DATABASE_URL set, then removes the container (also on failure or Ctrl+C). Needs Docker running.
// The tests use port 5055 like `npm test`, so do not run both at once.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = 'postgres:16-alpine';
const DATABASE = 'drinkme_test';
const USER = 'drinkme';
const READY_TIMEOUT_MS = 90_000;
const TEST_FILES = ['test/postgres-store.test.js', 'test/postgres-integration.test.js'];

const docker = (args, options = {}) => spawnSync('docker', args, { encoding: 'utf8', ...options });

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.unref();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const canConnect = (port) => new Promise((resolve) => {
  const socket = net.connect({ port, host: '127.0.0.1' });
  socket.setTimeout(1000);
  const done = (ok) => {
    socket.destroy();
    resolve(ok);
  };
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
  socket.once('timeout', () => done(false));
});

async function waitUntilReady(name, port) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // pg_isready inside the container, then a TCP check from here (the port mapping can lag behind).
    const ready = docker(['exec', name, 'pg_isready', '-U', USER, '-d', DATABASE, '-h', '127.0.0.1']);
    if (ready.status === 0 && await canConnect(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function main() {
  const version = docker(['version', '--format', '{{.Server.Version}}']);
  if (version.status !== 0) {
    console.error('[test:postgres] Docker is not available or its daemon is not running. Start Docker Desktop and try again.');
    console.error('[test:postgres] Without Docker, npm test still passes: the Postgres tests are skipped when TEST_DATABASE_URL is not set.');
    return 1;
  }

  const port = await freePort();
  const password = crypto.randomBytes(24).toString('hex');
  const name = `drinkme-pg-test-${crypto.randomBytes(4).toString('hex')}`;
  let removed = false;
  const removeContainer = () => {
    if (removed) return;
    removed = true;
    docker(['rm', '-f', '-v', name]);
    console.log(`[test:postgres] Removed container ${name}.`);
  };
  const onSignal = () => {
    removeContainer();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    console.log(`[test:postgres] Starting ${IMAGE} as ${name} on 127.0.0.1:${port}...`);
    // The password goes in through the environment of the docker CLI (-e NAME without a value), so it
    // never appears in a command line or in this output.
    const run = docker([
      'run', '-d', '--rm', '--name', name,
      '-e', 'POSTGRES_PASSWORD', '-e', `POSTGRES_USER=${USER}`, '-e', `POSTGRES_DB=${DATABASE}`,
      '-p', `127.0.0.1:${port}:5432`, IMAGE,
    ], { env: { ...process.env, POSTGRES_PASSWORD: password } });
    if (run.status !== 0) {
      console.error(`[test:postgres] Could not start the container (docker exit ${run.status}). Is the image reachable (docker pull ${IMAGE})?`);
      return 1;
    }
    if (!(await waitUntilReady(name, port))) {
      console.error(`[test:postgres] Postgres was not ready within ${READY_TIMEOUT_MS / 1000} s.`);
      return 1;
    }
    console.log('[test:postgres] Postgres is ready. Running the Postgres tests...');

    const url = `postgres://${USER}:${password}@127.0.0.1:${port}/${DATABASE}`;
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...TEST_FILES], {
        cwd: SERVER_DIR,
        env: { ...process.env, TEST_DATABASE_URL: url },
        stdio: 'inherit',
      });
      child.once('close', (exitCode) => resolve(exitCode ?? 1));
      child.once('error', () => resolve(1));
    });
    console.log(`[test:postgres] Tests ${code === 0 ? 'passed' : `failed (exit ${code})`}.`);
    return code;
  } finally {
    removeContainer();
  }
}

process.exitCode = await main();
