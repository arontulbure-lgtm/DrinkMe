// server/scripts/official.mjs (npm run official:check / official:set): pure functions on fixture texts and
// temp files. The real .env files are never read here. official:find needs Firebase and is checked by hand.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { checkProjects, envValue, loadServiceAccount, setOfficialUid } from '../scripts/official.mjs';

const UID = 'AbC123def456GHI789jkl012MNo3';
const SECRET = 'super-secret-value-123';

describe('official:set (setOfficialUid)', () => {
  test('adds the line when missing, keeping every other byte (CRLF file without a final newline)', () => {
    const text = `NODE_ENV=development\r\nJWT_SECRET=${SECRET}\r\nADMIN_USER_IDS=admin1`;
    const result = setOfficialUid(text, UID);
    assert.equal(result.ok, true);
    assert.equal(result.text, `${text}\r\nOFFICIAL_USER_IDS=${UID}\r\n`);
  });

  test('adds the line to an LF file that ends with a newline', () => {
    const text = 'A=1\nB=2\n';
    assert.equal(setOfficialUid(text, UID).text, `A=1\nB=2\nOFFICIAL_USER_IDS=${UID}\n`);
  });

  test('replaces an existing line in place and touches nothing else', () => {
    const text = `# comment\r\nOFFICIAL_USER_IDS=old-uid\r\nJWT_SECRET=${SECRET}\r\n`;
    const result = setOfficialUid(text, UID);
    assert.equal(result.text, `# comment\r\nOFFICIAL_USER_IDS=${UID}\r\nJWT_SECRET=${SECRET}\r\n`);
    assert.equal(result.changed, true);
    assert.equal(setOfficialUid(result.text, UID).changed, false, 'the same uid again changes nothing');
  });

  test('refuses a uid that is also an admin, without echoing the admin list', () => {
    const result = setOfficialUid(`ADMIN_USER_IDS=someone, ${UID}\n`, UID);
    assert.equal(result.ok, false);
    assert.match(result.reason, /ADMIN_USER_IDS/);
    assert.ok(!result.reason.includes('someone') && !result.reason.includes(UID));
  });

  test('refuses an invalid uid and a file with two OFFICIAL_USER_IDS lines', () => {
    assert.equal(setOfficialUid('A=1\n', 'bad uid!').ok, false);
    assert.equal(setOfficialUid('A=1\n', '').ok, false);
    assert.equal(setOfficialUid('OFFICIAL_USER_IDS=a\nOFFICIAL_USER_IDS=b\n', UID).ok, false);
  });

  test('a commented-out line is not mistaken for the setting', () => {
    const result = setOfficialUid('# OFFICIAL_USER_IDS=old\n', UID);
    assert.equal(result.text, `# OFFICIAL_USER_IDS=old\nOFFICIAL_USER_IDS=${UID}\n`);
  });
});

describe('official:check (checkProjects)', () => {
  const withServiceAccount = (t, projectId) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drinkme-official-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'sa.json'), JSON.stringify({ project_id: projectId, private_key: SECRET }));
    return dir;
  };

  test('MATCH when both project ids agree; nothing secret in the output', (t) => {
    const dir = withServiceAccount(t, 'drinkmeapp-a8fea');
    const result = checkProjects({
      rootEnvText: 'EXPO_PUBLIC_FIREBASE_PROJECT_ID=drinkmeapp-a8fea\nEXPO_PUBLIC_FIREBASE_API_KEY=AIzaKEY\n',
      serverEnvText: `FIREBASE_SERVICE_ACCOUNT_KEY=./sa.json\nJWT_SECRET=${SECRET}\n`,
      serverDir: dir,
    });
    assert.equal(result.ok, true);
    const output = result.lines.join('\n');
    assert.match(output, /MATCH/);
    assert.doesNotMatch(output, /MISMATCH/);
    assert.ok(!output.includes(SECRET) && !output.includes('AIzaKEY'));
  });

  test('MISMATCH names both projects', (t) => {
    const dir = withServiceAccount(t, 'drinkme-b2269');
    const result = checkProjects({
      rootEnvText: 'EXPO_PUBLIC_FIREBASE_PROJECT_ID="drinkmeapp-a8fea"\n',
      serverEnvText: 'FIREBASE_SERVICE_ACCOUNT_KEY=./sa.json\n',
      serverDir: dir,
    });
    assert.equal(result.ok, false);
    const output = result.lines.join('\n');
    assert.match(output, /drinkmeapp-a8fea/);
    assert.match(output, /drinkme-b2269/);
    assert.match(output, /MISMATCH/);
  });

  test('an unreadable key reports the error type only', (t) => {
    const dir = withServiceAccount(t, 'x');
    assert.throws(() => loadServiceAccount(`FIREBASE_SERVICE_ACCOUNT_KEY={"private_key":"${SECRET}"`, dir), (err) => {
      assert.ok(!err.message.includes(SECRET));
      return true;
    });
    assert.throws(() => loadServiceAccount('A=1\n', dir), /not set/);
  });

  test('envValue reads quoted values, inline comments and a BOM', () => {
    assert.equal(envValue('﻿X="a b" # c\n', 'X'), 'a b');
    assert.equal(envValue('X=val # comment\n', 'X'), 'val');
    assert.equal(envValue('export X=1\n', 'X'), '1');
    assert.equal(envValue('Y=1\n', 'X'), undefined);
  });
});
