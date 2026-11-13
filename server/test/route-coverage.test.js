// Route-coverage guard: every route registered in server.js must be listed in ROUTE_MANIFEST
// (test/helpers/routes.js) with the test files that exercise it and the gates it must apply.
// Adding a route without adding it there fails this file. route-gates.test.js then checks the gates
// of every listed route against a running server. No server is started here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { ROUTE_MANIFEST, TEST_DIR, parseRoutes, readServerRoutes, staticParts } from './helpers/routes.js';

const GATES = new Set(['public', 'own-before-age', 'adult', 'dev-only']);
// The only routes requireSignedInAdult lets through without a JWT, or before the 18+ confirmation.
// Changing either list needs the owner's OK (drinkme-backend-api, "Rules for every backend change").
const EXPECTED_PUBLIC = ['GET /healthz', 'POST /api/account/delete-unverified', 'POST /api/auth/mobile'];
const EXPECTED_OWN_BEFORE_AGE = [
  'GET /api/users/:id', 'POST /api/users/:id/acknowledgements', 'POST /api/users/:id/delete-account', 'PUT /api/users/:id',
];

const server = readServerRoutes();
const registeredKeys = server.routes.map((route) => route.key);
const readTestFile = (() => {
  const cache = new Map();
  return (file) => {
    if (!cache.has(file)) cache.set(file, fs.readFileSync(path.join(TEST_DIR, file), 'utf8'));
    return cache.get(file);
  };
})();

describe('route coverage guard', () => {
  test('server.js registers every route with a literal path, on the app itself', () => {
    assert.ok(server.routes.length > 0, 'no route found: the parser no longer matches server.js');
    assert.equal(server.registrationCount, server.routes.length,
      'a route is registered with a non-literal path or with app.all/head/options/route; list it by hand and extend readServerRoutes');
    assert.deepEqual(server.unknownMounts, [], 'a path mount other than /api and /media (a sub-router?) is not covered by this guard');
    assert.equal(server.usesExpressRouter, false, 'express.Router is not covered by this guard');
  });

  test('no route is registered twice', () => {
    const duplicates = registeredKeys.filter((key, index) => registeredKeys.indexOf(key) !== index);
    assert.deepEqual(duplicates, []);
  });

  test('every registered route is in ROUTE_MANIFEST', () => {
    const missing = registeredKeys.filter((key) => !Object.hasOwn(ROUTE_MANIFEST, key));
    assert.deepEqual(missing, [], 'add these routes to ROUTE_MANIFEST in test/helpers/routes.js, with their tests');
  });

  test('ROUTE_MANIFEST lists no route that server.js no longer registers', () => {
    const stale = Object.keys(ROUTE_MANIFEST).filter((key) => !registeredKeys.includes(key));
    assert.deepEqual(stale, [], 'remove these entries from ROUTE_MANIFEST');
  });

  test('every entry has a known gate, boolean flags and at least one test file', () => {
    for (const [key, entry] of Object.entries(ROUTE_MANIFEST)) {
      assert.ok(GATES.has(entry.gate), `${key}: gate ${entry.gate}`);
      for (const flag of ['suspended', 'admin']) {
        assert.ok(entry[flag] === undefined || typeof entry[flag] === 'boolean', `${key}: ${flag}`);
      }
      assert.ok(Array.isArray(entry.files) && entry.files.length > 0, `${key}: no test file`);
      assert.ok(!(entry.gate === 'public' && (entry.suspended || entry.admin)), `${key}: a public route cannot check suspension or admin`);
    }
  });

  test('dev-only routes, and only they, live under /__dev/', () => {
    for (const [key, entry] of Object.entries(ROUTE_MANIFEST)) {
      const routePath = key.slice(key.indexOf(' ') + 1);
      assert.equal(entry.gate === 'dev-only', routePath.startsWith('/__dev/'), key);
      if (entry.gate === 'dev-only') assert.ok(!entry.suspended && !entry.admin, `${key}: a dev-only route has no account checks`);
    }
  });

  test('only the agreed routes skip the sign-in or the 18+ gate', () => {
    const withGate = (gate) => Object.keys(ROUTE_MANIFEST).filter((key) => ROUTE_MANIFEST[key].gate === gate).sort();
    assert.deepEqual(withGate('public'), EXPECTED_PUBLIC);
    assert.deepEqual(withGate('own-before-age'), EXPECTED_OWN_BEFORE_AGE);
  });

  test('the parser itself: literal, conditional, commented-out, dynamic and sub-router registrations', () => {
    const parsed = parseRoutes([
      "app.get('/api/a', requireAuth, (req, res) => {});",
      "if (FLAG) {\n  app.post(\n    '/api/b/:id', handler);\n}",
      "// app.get('/api/commented', handler);",
      "/* app.put('/api/block-commented', handler); */",
      "const url = '// not a comment'; app.delete('/api/c', handler);",
    ].join('\n'));
    assert.deepEqual(parsed.routes.map((route) => route.key), ['GET /api/a', 'POST /api/b/:id', 'DELETE /api/c']);
    assert.equal(parsed.registrationCount, 3);

    const dynamic = parseRoutes('app.get(PATH, handler);\napp.all(\'/api/x\', handler);\napp.route(\'/api/y\').get(handler);');
    assert.equal(dynamic.routes.length, 0);
    assert.equal(dynamic.registrationCount, 3, 'a non-literal or app.all/app.route registration is counted, so the first test fails');

    const mounted = parseRoutes("const r = express.Router();\napp.use('/api/v2', r);\napp.use('/api', limiter);");
    assert.deepEqual(mounted.unknownMounts, ['/api/v2']);
    assert.equal(mounted.usesExpressRouter, true);
  });

  test('every listed test file exists and names the route path', () => {
    for (const [key, entry] of Object.entries(ROUTE_MANIFEST)) {
      const routePath = key.slice(key.indexOf(' ') + 1);
      for (const file of entry.files) {
        assert.match(file, /^[\w-]+\.test\.js$/, `${key}: ${file} is not a test file in server/test`);
        assert.ok(fs.existsSync(path.join(TEST_DIR, file)), `${key}: ${file} does not exist`);
        // route-gates.test.js builds every path from the manifest, so it never spells them out.
        if (file === 'route-gates.test.js') continue;
        const text = readTestFile(file);
        for (const part of staticParts(routePath)) {
          assert.ok(text.includes(part), `${key}: ${file} never mentions "${part}"`);
        }
      }
    }
  });
});
