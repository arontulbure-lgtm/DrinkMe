// server/scripts/firebase-configure.mjs and env-file.mjs: pure functions plus one end-to-end run of the
// script against a temporary copy of the repository layout. The real .env files are never touched: the
// script resolves its files from its own location, so the run uses a copy of the script in a temp tree.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { setEnvLines } from '../scripts/env-file.mjs';
import { parseWebConfig, readServiceAccountProject, serviceAccountSetting } from '../scripts/firebase-configure.mjs';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const SECRET = 'PRIVATE-KEY-CANARY-9f8e7d';
const WEB = {
  apiKey: 'AIzaWebKeyCanary123', authDomain: 'drinkmeapp-a8fea.firebaseapp.com', projectId: 'drinkmeapp-a8fea',
  storageBucket: 'drinkmeapp-a8fea.firebasestorage.app', messagingSenderId: '123456789', appId: '1:123456789:web:abc',
  measurementId: 'G-IGNORED',
};
const account = (projectId) => JSON.stringify({
  type: 'service_account', project_id: projectId, private_key: SECRET, client_email: `x@${projectId}.iam.gserviceaccount.com`,
});

describe('env-file setEnvLines', () => {
  test('replaces in place, appends missing names, keeps other bytes and CRLF', () => {
    const text = `# keep\r\nEXPO_PUBLIC_FIREBASE_API_KEY=old\r\nOTHER=${SECRET}\r\nLAST=1`;
    const result = setEnvLines(text, { EXPO_PUBLIC_FIREBASE_API_KEY: 'new', EXPO_PUBLIC_FIREBASE_APP_ID: '1:2:web:3' });
    assert.equal(result.text, `# keep\r\nEXPO_PUBLIC_FIREBASE_API_KEY=new\r\nOTHER=${SECRET}\r\nLAST=1\r\nEXPO_PUBLIC_FIREBASE_APP_ID=1:2:web:3\r\n`);
    assert.deepEqual(result.changed, ['EXPO_PUBLIC_FIREBASE_API_KEY', 'EXPO_PUBLIC_FIREBASE_APP_ID']);
    assert.deepEqual(setEnvLines(result.text, { EXPO_PUBLIC_FIREBASE_API_KEY: 'new' }).changed, []);
  });

  test('refuses duplicate names and unsafe values', () => {
    assert.equal(setEnvLines('A=1\nA=2\n', { A: '3' }).ok, false);
    assert.equal(setEnvLines('', { A: 'has space' }).ok, false);
    assert.equal(setEnvLines('', { A: 'quote"d' }).ok, false);
  });
});

describe('firebase-configure parsing', () => {
  test('reads JSON and the console snippet; ignores measurementId', () => {
    const fromJson = parseWebConfig(JSON.stringify(WEB));
    assert.equal(fromJson.projectId, 'drinkmeapp-a8fea');
    assert.equal(fromJson.measurementId, undefined);
    const snippet = `const firebaseConfig = {\n  apiKey: "${WEB.apiKey}",\n  authDomain: "${WEB.authDomain}",\n  projectId: "${WEB.projectId}",\n  storageBucket: "${WEB.storageBucket}",\n  messagingSenderId: "${WEB.messagingSenderId}",\n  appId: "${WEB.appId}",\n  measurementId: "G-X"\n};`;
    assert.deepEqual(parseWebConfig(snippet), fromJson);
    assert.throws(() => parseWebConfig('{"apiKey":"x"}'), /missing/);
  });

  test('checks the service-account shape and never echoes the key', () => {
    assert.equal(readServiceAccountProject(account('drinkmeapp-a8fea')), 'drinkmeapp-a8fea');
    assert.throws(() => readServiceAccountProject('{"type":"user"}'), (err) => !err.message.includes(SECRET));
    assert.throws(() => readServiceAccountProject(`not json ${SECRET}`), (err) => !err.message.includes(SECRET));
  });

  test('service-account path: relative to server/ inside the repo, absolute outside', () => {
    const serverDir = path.join(os.tmpdir(), 'repo', 'server');
    assert.equal(serviceAccountSetting(path.join(serverDir, 'serviceAccount-new.json'), serverDir), './serviceAccount-new.json');
    assert.equal(serviceAccountSetting(path.join(serverDir, '..', 'keys', 'sa.json'), serverDir), '../keys/sa.json');
    const outside = path.join(os.tmpdir(), 'elsewhere', 'sa.json');
    assert.equal(serviceAccountSetting(outside, serverDir), outside.split(path.sep).join('/'));
  });
});

describe('npm run firebase:configure, end to end on a temp copy', () => {
  const makeTree = (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drinkme-fbcfg-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'server', 'scripts'), { recursive: true });
    for (const name of ['firebase-configure.mjs', 'env-file.mjs', 'official.mjs']) {
      fs.copyFileSync(path.join(SCRIPTS_DIR, name), path.join(root, 'server', 'scripts', name));
    }
    fs.writeFileSync(path.join(root, '.env'), `EXPO_PUBLIC_FIREBASE_PROJECT_ID=drinkme-b2269\r\nANTHROPIC_API_KEY=${SECRET}\r\n`);
    fs.writeFileSync(path.join(root, 'server', '.env'), `NODE_ENV=development\nJWT_SECRET=${SECRET}\nFIREBASE_SERVICE_ACCOUNT_KEY=./serviceAccount.json\n`);
    // Outside any git repository, so the git-ignore check does not apply to these files.
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'drinkme-fbdl-'));
    t.after(() => fs.rmSync(downloads, { recursive: true, force: true }));
    return { root, downloads };
  };
  const run = (root, args) => spawnSync(process.execPath, [path.join(root, 'server', 'scripts', 'firebase-configure.mjs'), ...args], { cwd: root, encoding: 'utf8' });

  test('sets the six lines and the key path, prints MATCH and no secret', (t) => {
    const { root, downloads } = makeTree(t);
    const web = path.join(downloads, 'firebase-web-config.json');
    const sa = path.join(downloads, 'sa.json');
    fs.writeFileSync(web, JSON.stringify(WEB));
    fs.writeFileSync(sa, account('drinkmeapp-a8fea'));
    const result = run(root, [web, sa]);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /drinkmeapp-a8fea/);
    assert.match(output, /\nMATCH\n/);
    for (const secret of [SECRET, WEB.apiKey, WEB.appId]) assert.ok(!output.includes(secret), `printed ${secret}`);

    const rootEnv = fs.readFileSync(path.join(root, '.env'), 'utf8');
    assert.match(rootEnv, /^EXPO_PUBLIC_FIREBASE_PROJECT_ID=drinkmeapp-a8fea\r$/m);
    assert.match(rootEnv, new RegExp(`^ANTHROPIC_API_KEY=${SECRET}\\r$`, 'm'), 'other lines untouched');
    assert.match(rootEnv, /^EXPO_PUBLIC_FIREBASE_APP_ID=1:123456789:web:abc\r$/m);
    assert.doesNotMatch(rootEnv, /G-IGNORED/);
    const serverEnv = fs.readFileSync(path.join(root, 'server', '.env'), 'utf8');
    assert.equal(serverEnv, `NODE_ENV=development\nJWT_SECRET=${SECRET}\nFIREBASE_SERVICE_ACCOUNT_KEY=${sa.split(path.sep).join('/')}\n`);
    assert.ok(fs.readdirSync(root).some((name) => name.startsWith('.env.before-firebase-')), 'a copy of the old file is kept');
  });

  test('MISMATCH between the two files changes nothing', (t) => {
    const { root, downloads } = makeTree(t);
    const web = path.join(downloads, 'web.json');
    const sa = path.join(downloads, 'sa.json');
    fs.writeFileSync(web, JSON.stringify(WEB));
    fs.writeFileSync(sa, account('drinkme-b2269'));
    const before = fs.readFileSync(path.join(root, '.env'), 'utf8');
    const result = run(root, [web, sa]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /MISMATCH/);
    assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), before);
  });
});

describe('env:remove (removeEnvLine and the command)', () => {
  test('removes every line for the name, keeps the rest byte for byte', async () => {
    const { removeEnvLine } = await import('../scripts/env-file.mjs');
    const text = `A=1\r\nANTHROPIC_API_KEY=${SECRET}\r\n# ANTHROPIC_API_KEY=commented\r\nB=2\r\nANTHROPIC_API_KEY=again`;
    const result = removeEnvLine(text, 'ANTHROPIC_API_KEY');
    assert.equal(result.removed, 2);
    assert.equal(result.text, 'A=1\r\n# ANTHROPIC_API_KEY=commented\r\nB=2\r\n');
    assert.equal(removeEnvLine('A=1\n', 'X').removed, 0);
  });

  test('the command prints no value and refuses non-.env files', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drinkme-envrm-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, `KEEP=1\nANTHROPIC_API_KEY=${SECRET}\n`);
    const run = (args) => spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'env-remove.mjs'), ...args], { encoding: 'utf8' });
    const result = run(['ANTHROPIC_API_KEY', file]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(SECRET));
    assert.equal(fs.readFileSync(file, 'utf8'), 'KEEP=1\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'X=1\n');
    assert.equal(run(['X', path.join(dir, 'notes.txt')]).status, 1);
  });
});
