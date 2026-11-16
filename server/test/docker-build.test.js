// The Docker image (root Dockerfile + .dockerignore allowlist) must contain every module server.js imports
// statically, or production crashes at start with "module not found". dev-log-bridge.js is the deliberate
// exception: development-only, imported dynamically, and kept out of the image so it can never load there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { SERVER_DIR } from './helpers/routes.js';

const ROOT = path.resolve(SERVER_DIR, '..');
const serverSource = fs.readFileSync(path.join(SERVER_DIR, 'server.js'), 'utf8');
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');

const staticLocalImports = [...serverSource.matchAll(/^import\s[^;]*?from\s+'\.\/([\w./-]+)'/gm)].map((m) => m[1]);

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A module in a subfolder (./storage/x.js) may instead be covered by its whole top folder: `!server/storage/`
// in .dockerignore and `COPY server/storage ./storage` in the Dockerfile.
test('every local module server.js imports statically is in the image', () => {
  assert.ok(staticLocalImports.length > 0);
  for (const file of staticLocalImports) {
    const folder = file.includes('/') ? file.split('/')[0] : null;
    const inIgnore = new RegExp(`^!server/${escapeRegExp(file)}$`, 'm').test(dockerignore)
      || (folder !== null && new RegExp(`^!server/${escapeRegExp(folder)}/?$`, 'm').test(dockerignore));
    const inCopy = new RegExp(`COPY[^\n]*server/${escapeRegExp(file)}`).test(dockerfile)
      || (folder !== null && new RegExp(`^COPY server/${escapeRegExp(folder)}/? \\./${escapeRegExp(folder)}/?$`, 'm').test(dockerfile));
    assert.ok(inIgnore, `${file} missing from .dockerignore`);
    assert.ok(inCopy, `${file} missing from the Dockerfile COPY`);
  }
});

test('the storage module is imported statically, so the check above covers it', () => {
  assert.ok(staticLocalImports.includes('storage/postgres-store.js'));
});

// Only the scripts production needs are in the image; owner and developer tools (which write tokens and
// passwords, or edit .env files) are not.
const SHIPPED_SCRIPTS = ['backup.js', 'postgres-cli.mjs', 'migrate-to-postgres.mjs', 'export-from-postgres.mjs'];
const DEV_ONLY_SCRIPTS = [
  'testapi.mjs', 'testusers.mjs', 'firebase-configure.mjs', 'official.mjs', 'env-remove.mjs', 'test-postgres.mjs', 'docker-smoke.mjs',
];

test('the image holds the production scripts only, never the whole scripts folder', () => {
  assert.doesNotMatch(dockerignore, /^!server\/scripts\/?$/m, 'the whole scripts folder must not be allowlisted');
  assert.doesNotMatch(dockerfile, /COPY server\/scripts\/? /, 'the whole scripts folder must not be copied');
  const copyLine = dockerfile.split(/\r?\n/).find((line) => line.startsWith('COPY server/scripts/')) ?? '';
  for (const script of SHIPPED_SCRIPTS) {
    assert.match(dockerignore, new RegExp(`^!server/scripts/${escapeRegExp(script)}$`, 'm'), `${script} missing from .dockerignore`);
    assert.ok(copyLine.includes(`server/scripts/${script}`), `${script} missing from the Dockerfile COPY`);
  }
  for (const script of DEV_ONLY_SCRIPTS) {
    assert.ok(!dockerignore.includes(`scripts/${script}`), `${script} must not be in .dockerignore's allowlist`);
    assert.ok(!dockerfile.includes(`scripts/${script}`), `${script} must not be copied into the image`);
  }
});

test('every local module the shipped scripts import is in the image too', () => {
  for (const script of SHIPPED_SCRIPTS) {
    const source = fs.readFileSync(path.join(SERVER_DIR, 'scripts', script), 'utf8');
    const imports = [...source.matchAll(/(?:from\s+|import\()'(\.{1,2}\/[\w./-]+)'/g)].map((m) => m[1]);
    for (const specifier of imports) {
      const relative = path.posix.normalize(`scripts/${specifier}`);
      const folder = relative.split('/')[0];
      const shipped = SHIPPED_SCRIPTS.some((name) => relative === `scripts/${name}`)
        || (folder !== 'scripts' && new RegExp(`^!server/${escapeRegExp(folder)}/?$`, 'm').test(dockerignore));
      assert.ok(shipped, `${script} imports ${specifier}, which is not in the image`);
    }
  }
});

test('the development-only log bridge stays out of the image and is imported dynamically only', () => {
  assert.doesNotMatch(dockerignore, /dev-log-bridge/);
  assert.doesNotMatch(dockerfile, /dev-log-bridge/);
  assert.ok(!staticLocalImports.includes('dev-log-bridge.js'));
});

test('the image runs as a non-root user in production mode with a health endpoint', () => {
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^ENV NODE_ENV=production$/m);
  assert.match(serverSource, /app\.get\('\/healthz'/);
});
