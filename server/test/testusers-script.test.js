// server/scripts/testusers.mjs: which accounts it may delete, and the password shape. Creating and deleting
// real Firebase users is run by hand (npm run testusers:create / testusers:delete).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isDeletableTestEmail, randomPassword, TEST_EMAILS, TEST_USERS_FILE } from '../scripts/testusers.mjs';

test('only test addresses can ever be deleted, never the official account', () => {
  for (const email of [...TEST_EMAILS, 'test9@drinkme.test', 'drinkmesocialapp+e2e1@gmail.com', 'drinkmesocialapp+e2e-20261114@gmail.com']) {
    assert.equal(isDeletableTestEmail(email), true, email);
  }
  for (const email of ['drinkmesocialapp@gmail.com', 'drinkmesocialapp+other@gmail.com', 'someone@drinkme.test', 'test1@drinkme.test.evil.com', 'xtest1@drinkme.test', undefined, '']) {
    assert.equal(isDeletableTestEmail(email), false, String(email));
  }
});

test('passwords meet the app and Firebase policy and are random', () => {
  const a = randomPassword();
  const b = randomPassword();
  assert.notEqual(a, b);
  for (const password of [a, b]) {
    assert.ok(password.length >= 8);
    assert.match(password, /[A-Z]/);
    assert.match(password, /[0-9]/);
    assert.match(password, /[.-]/);
    // Typed with adb input text: no shell-special characters.
    assert.doesNotMatch(password, /[\s&;()<>|*'"`\\$!#%]/);
  }
});

test('the password file is under logs/ (git-ignored)', () => {
  assert.match(TEST_USERS_FILE.replace(/\\/g, '/'), /\/logs\/testusers\.local\.json$/);
});
