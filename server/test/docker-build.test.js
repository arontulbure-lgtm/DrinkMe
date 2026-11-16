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
// in .dockerignore and `COPY server/storage ./storage` in the Dockerfile, as server/scripts is.
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
