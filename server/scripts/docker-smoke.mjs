#!/usr/bin/env node
// npm run docker:smoke: builds the production image, starts it with a throwaway key and secret (never real
// ones), checks /healthz and /readyz, that /api answers 401 without a session, that the dev-only route is
// absent, and that the container runs as a non-root user, then removes it. Needs Docker.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMAGE = 'drinkme-server-smoke';
const NAME = `drinkme-smoke-${process.pid}`;

const docker = (args, options = {}) => spawnSync('docker', args, { encoding: 'utf8', ...options });
const freePort = () => new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // Holds the event loop open while waiting on the container (fetch alone did not on Windows).
  const keepAlive = setInterval(() => {}, 1000);
  if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) throw new Error('Docker is not running.');
  const build = docker(['build', '-q', '-t', IMAGE, '.'], { cwd: ROOT });
  if (build.status !== 0) throw new Error(`docker build failed:\n${build.stderr}`);
  console.log('✓ image built');

  // Synthetic credentials, generated for this run only.
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const serviceAccount = JSON.stringify({
    type: 'service_account', project_id: 'drinkme-smoke', private_key: privateKey, client_email: 'smoke@drinkme-smoke.example.test',
  });
  const port = await freePort();
  const run = docker([
    'run', '-d', '--name', NAME, '-p', `127.0.0.1:${port}:8080`,
    '-e', `JWT_SECRET=${crypto.randomBytes(48).toString('base64')}`,
    '-e', `FIREBASE_SERVICE_ACCOUNT_KEY=${serviceAccount}`,
    '-e', 'ALLOW_EMPTY_DB=true',
    '-e', 'AI_PROVIDER=off', // production refuses to start without an explicit choice
    IMAGE,
  ]);
  if (run.status !== 0) throw new Error(`docker run failed:\n${run.stderr}`);
  const results = [];
  try {
    let healthy = false;
    for (let i = 0; i < 40 && !healthy; i += 1) {
      try { healthy = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { /* starting */ }
      if (!healthy) await sleep(500);
    }
    results.push(['/healthz answers 200', healthy]);
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`).catch(() => null);
    results.push(['/readyz answers 200 (database loaded, firebase-admin initialised)', ready?.status === 200]);
    const api = await fetch(`http://127.0.0.1:${port}/api/drinks`).catch(() => null);
    results.push(['/api without a session answers 401', api?.status === 401]);
    const dev = await fetch(`http://127.0.0.1:${port}/__dev/client-log`, { method: 'POST' }).catch(() => null);
    results.push(['/__dev/client-log is absent (404)', dev?.status === 404]);
    const user = docker(['exec', NAME, 'id', '-un']).stdout.trim();
    results.push([`runs as a non-root user (${user})`, user !== '' && user !== 'root']);
    const logs = docker(['logs', NAME]);
    results.push(['no FATAL in the start log', !/FATAL/.test(`${logs.stdout}${logs.stderr}`)]);
  } finally {
    docker(['rm', '-f', NAME]);
  }
  clearInterval(keepAlive);
  for (const [label, ok] of results) console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (results.some(([, ok]) => !ok)) process.exitCode = 1;
}

main().catch((err) => {
  docker(['rm', '-f', NAME]);
  console.error(err.message);
  process.exit(1);
});
