// POST /__dev/client-log: the development-only sink for the app's log bridge (server/dev-log-bridge.js,
// src/lib/devLogBridge.ts). It exists only with NODE_ENV=development, writes redacted JSON lines to
// <DEV_SESSION_DIR>/client.jsonl, and is absent (404, nothing written) without DEV_SESSION_DIR and in test
// and production mode. Only JSON with the app's header and no Origin is accepted.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { cleanApiPath, redactText, sanitizeClientLogEntry } from '../dev-log-bridge.js';
import { startServer } from './helpers/harness.js';

const ROUTE = '/__dev/client-log';
const TIMEOUT = 60_000;

// Synthetic values only; nothing here is a real credential.
const JWT = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from('{"uid":"abc"}').toString('base64url')}.c2lnbmF0dXJlLXZhbHVlLXg`;
const GOOGLE_KEY = `AIza${'Sy0aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0u'}`;
const OPAQUE = 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7d';
const EMAIL = 'tester.one+beta@example.test';

const makeTempDir = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return dir;
};

const APP_HEADERS = { 'Content-Type': 'application/json', 'X-DrinkMe-Dev-Log': '1' };

const postBatch = async (baseUrl, body, { raw = false, headers = APP_HEADERS } = {}) => {
  const res = await fetch(`${baseUrl}${ROUTE}`, {
    method: 'POST',
    headers,
    body: raw ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, text: await res.text() };
};

const readLines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

describe('redaction and entry cleaning (unit)', () => {
  test('emails, JWTs, bearer tokens, key=value secrets, Google keys, opaque tokens and query strings are redacted', () => {
    const input = [
      `user ${EMAIL} failed`,
      `token ${JWT}`,
      'Authorization: Bearer abc.def-123',
      'password=hunter2 apiKey: "k-1"',
      `maps ${GOOGLE_KEY}`,
      `blob ${OPAQUE}`,
      'GET https://maps.example.test/place?input=bar&key=secret#x',
    ].join('\n');
    const out = redactText(input);
    for (const secret of [EMAIL, JWT, 'abc.def-123', 'hunter2', 'k-1', GOOGLE_KEY, OPAQUE, 'input=bar', 'secret']) {
      assert.ok(!out.includes(secret), `still contains ${secret}: ${out}`);
    }
    assert.match(out, /\[email\]/);
    assert.match(out, /\[jwt\]/);
    assert.match(out, /Bearer \[token\]/);
    assert.match(out, /password=\[redacted\]/);
    assert.match(out, /\[google-key\]/);
    assert.match(out, /blob \[token\]/);
    assert.match(out, /https:\/\/maps\.example\.test\/place\?\[query\]/);
  });

  test('compound secret names, URL-encoded emails, controls and direction overrides', () => {
    const out = redactText('{"newPassword":"pw1","authToken":"t1","clientSecret":"s1","private_key":"k1"} jane%40example.test');
    for (const secret of ['pw1', 't1', 's1', 'k1', 'jane%40example.test']) assert.ok(!out.includes(secret), out);
    assert.equal(redactText('"code":"age_required" status code: 500'), '"code":"age_required" status code: 500');
    assert.match(redactText('code=4/0AbCdEfGhIjKlMnOpQr'), /code=\[redacted\]/);
    const entry = sanitizeClientLogEntry({ kind: 'note', message: 'a\u009b2Jb\u202ec\u2066d' });
    assert.equal(entry.message, 'a2Jbcd');
  });

  test('stack traces, file paths and short ids stay readable', () => {
    const stack = 'TypeError: x is undefined\n    at HomeScreen (http://192.168.0.10:8081/index.bundle?platform=ios&dev=true&minify=false:1234:56)\n    at src/screens/ProfileScreen.tsx:88:12';
    const out = redactText(stack);
    assert.match(out, /index\.bundle\?platform=ios&dev=true&minify=false:1234:56/);
    assert.match(out, /src\/screens\/ProfileScreen\.tsx:88:12/);
    assert.match(out, /TypeError: x is undefined/);
    assert.equal(redactText('uid Xy12abCD34efGH56ijKL78mnOP90'), 'uid Xy12abCD34efGH56ijKL78mnOP90');
  });

  test('API paths lose their query string and long id segments', () => {
    assert.equal(cleanApiPath('/api/users/Xy12abCD34efGH56ijKL78mnOP90/partners?x=1'), '/api/users/:id/partners');
    assert.equal(cleanApiPath('/api/drinks/12/comments'), '/api/drinks/12/comments');
    assert.equal(cleanApiPath('https://evil.test/x'), undefined);
  });

  test('only listed fields and kinds are kept; bodies and headers never are', () => {
    const entry = sanitizeClientLogEntry({
      kind: 'api', method: 'POST', path: '/api/drinks?q=a', status: 500, code: 'x', durationMs: 120,
      body: { password: 'p' }, headers: { Authorization: 'Bearer t' }, screen: 'Home', extra: 'no',
    });
    assert.deepEqual(Object.keys(entry).filter((key) => entry[key] !== undefined).sort(),
      ['code', 'durationMs', 'kind', 'method', 'path', 'screen', 'status']);
    assert.equal(sanitizeClientLogEntry({ kind: 'shell', message: 'x' }), null);
    assert.equal(sanitizeClientLogEntry({ kind: 'console' }), null, 'no message');
    assert.equal(sanitizeClientLogEntry({ kind: 'api', method: 'TRACE', path: '/api/x' }), null);
    assert.equal(sanitizeClientLogEntry({ kind: 'nav' }), null, 'no screen');
    assert.equal(sanitizeClientLogEntry([]), null);
    const long = sanitizeClientLogEntry({ kind: 'note', message: 'a'.repeat(5000) });
    assert.ok(long.message.length < 2100 && long.message.endsWith('…[cut]'));
    const control = sanitizeClientLogEntry({ kind: 'note', message: 'a\u001b[31mred\u0007' });
    assert.equal(control.message, 'a[31mred');
  });
});

describe('POST /__dev/client-log with NODE_ENV=development', () => {
  test('appends redacted JSON lines to DEV_SESSION_DIR/client.jsonl, without a sign-in', { timeout: TIMEOUT }, async (t) => {
    const sessionDir = makeTempDir(t, 'drinkme-devlog-');
    const server = await startServer({ NODE_ENV: 'development', DEV_SESSION_DIR: sessionDir });
    t.after(() => server.stop());
    const file = path.join(sessionDir, 'client.jsonl');

    assert.match(server.getOutput(), /\[dev-log\] Development only/);

    const ok = await postBatch(server.baseUrl, {
      entries: [
        { kind: 'console', level: 'error', message: `Login failed for ${EMAIL} with ${JWT}`, screen: 'Auth', trail: ['Auth'], clientTs: '2026-11-13T10:00:00.000Z', appSession: 's1', platform: 'ios' },
        { kind: 'api', method: 'GET', path: '/api/users/Xy12abCD34efGH56ijKL78mnOP90?token=abc', status: 500, durationMs: 42, screen: 'Profile', body: 'secret body' },
        { kind: 'note', message: `Button looks cut off, key=${OPAQUE}`, screen: 'Home' },
        { kind: 'nav', screen: 'Explore' },
        { kind: 'unknown', message: 'dropped' },
      ],
    });
    assert.equal(ok.status, 204, ok.text);

    const lines = readLines(file);
    assert.equal(lines.length, 4);
    const text = fs.readFileSync(file, 'utf8');
    for (const secret of [EMAIL, JWT, OPAQUE, 'token=abc', 'secret body', 'Xy12abCD34efGH56ijKL78mnOP90']) {
      assert.ok(!text.includes(secret), `client.jsonl still contains ${secret}`);
    }
    assert.equal(lines[0].kind, 'console');
    assert.equal(lines[0].screen, 'Auth');
    assert.match(lines[0].message, /\[email\].*\[jwt\]/);
    assert.ok(!Number.isNaN(Date.parse(lines[0].ts)));
    assert.deepEqual(
      { method: lines[1].method, path: lines[1].path, status: lines[1].status, durationMs: lines[1].durationMs },
      { method: 'GET', path: '/api/users/:id', status: 500, durationMs: 42 },
    );
    assert.equal(lines[2].kind, 'note');
    assert.equal(lines[3].screen, 'Explore');

    // What a browser or a stray client can send is refused before anything is parsed into the log.
    const note = { entries: [{ kind: 'note', message: 'from a web page' }] };
    const form = await postBatch(server.baseUrl, 'entries[0][kind]=note&entries[0][message]=x', {
      raw: true, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(form.status, 415);
    assert.equal((await postBatch(server.baseUrl, note, { headers: { 'Content-Type': 'application/json' } })).status, 403);
    assert.equal((await postBatch(server.baseUrl, note, { headers: { ...APP_HEADERS, Origin: 'https://evil.example.test' } })).status, 403);

    // Refused batches write nothing.
    for (const body of [{}, { entries: [] }, { entries: 'x' }, { entries: Array(51).fill({ kind: 'note', message: 'x' }) }]) {
      assert.equal((await postBatch(server.baseUrl, body)).status, 400);
    }
    assert.equal((await postBatch(server.baseUrl, '{not json', { raw: true })).status, 400);
    const big = await postBatch(server.baseUrl, { entries: [{ kind: 'note', message: 'x'.repeat(150 * 1024) }] });
    assert.equal(big.status, 413);
    assert.equal(readLines(file).length, 4);

    // Only POST exists, and nothing else under /__dev/.
    assert.equal((await fetch(`${server.baseUrl}${ROUTE}`)).status, 404);
    assert.equal((await fetch(`${server.baseUrl}/__dev/other`, { method: 'POST' })).status, 404);
    // The sink logs no request line for its own batches.
    assert.doesNotMatch(server.getOutput(), /POST \/__dev\/client-log/);

    // The media diagnostic: whether a token came and from which client, never the token itself.
    const junkToken = 'not-a-real-token-1234567890';
    const media = (headers) => fetch(`${server.baseUrl}/media/drinks/1`, { headers });
    assert.equal((await media({ 'User-Agent': 'okhttp/4.12.0' })).status, 401);
    assert.equal((await media({ Authorization: `Bearer ${junkToken}`, 'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 15)' })).status, 401);
    const output = server.getOutput();
    assert.match(output, /\[dev-media\] GET \/media\/drinks\/1 auth=absent client=android-okhttp/);
    assert.match(output, /\[dev-media\] GET \/media\/drinks\/1 auth=refused client=android/);
    assert.ok(!output.includes(junkToken), 'the token is never logged');
  });
});

describe('POST /__dev/client-log is absent outside development', () => {
  test('development without DEV_SESSION_DIR (a server started by hand): 404', { timeout: TIMEOUT }, async (t) => {
    const server = await startServer({ NODE_ENV: 'development' });
    t.after(() => server.stop());
    const res = await postBatch(server.baseUrl, { entries: [{ kind: 'note', message: 'x' }] });
    assert.equal(res.status, 404);
    assert.doesNotMatch(server.getOutput(), /\[dev-log\]/);
  });

  test('test mode: 404 and no client.jsonl', { timeout: TIMEOUT }, async (t) => {
    const sessionDir = makeTempDir(t, 'drinkme-devlog-');
    const server = await startServer({ DEV_SESSION_DIR: sessionDir }); // the harness sets NODE_ENV=test
    t.after(() => server.stop());
    const res = await postBatch(server.baseUrl, { entries: [{ kind: 'note', message: 'x' }] });
    assert.equal(res.status, 404);
    assert.deepEqual(fs.readdirSync(sessionDir), []);
    await fetch(`${server.baseUrl}/media/drinks/1`);
    assert.doesNotMatch(server.getOutput(), /\[dev-log\]|\[dev-media\]/);
  });

  test('production mode: 404 and no client.jsonl', { timeout: TIMEOUT }, async (t) => {
    const sessionDir = makeTempDir(t, 'drinkme-devlog-');
    // Synthetic credentials that exist only in memory for this run, as in production-guard.test.js.
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const server = await startServer({
      NODE_ENV: 'production',
      JWT_SECRET: 'abcdefghijklmnopqrstuvwxyz012345',
      FIREBASE_SERVICE_ACCOUNT_KEY: JSON.stringify({
        type: 'service_account',
        project_id: 'drinkme-devlog-test',
        private_key: privateKey,
        client_email: 'devlog-test@drinkme-devlog-test.example.test',
      }),
      ALLOW_EMPTY_DB: 'true',
      DEV_SESSION_DIR: sessionDir,
    });
    t.after(() => server.stop());
    const res = await postBatch(server.baseUrl, { entries: [{ kind: 'note', message: 'x' }] });
    assert.equal(res.status, 404);
    assert.deepEqual(fs.readdirSync(sessionDir), []);
    assert.doesNotMatch(server.getOutput(), /\[dev-log\]/);
  });
});
