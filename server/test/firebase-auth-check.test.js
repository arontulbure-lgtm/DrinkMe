// server/scripts/firebase-auth-check.mjs (npm run firebase:auth-check): the printed summary. The live call
// to the Identity Toolkit API is run by hand; see docs/DEVICE_TEST_SESSION.md, section F.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { APP_PASSWORD_RULES, summarizeAuthConfig } from '../scripts/firebase-auth-check.mjs';

test('summary shows the settings and never the project API key', () => {
  const lines = summarizeAuthConfig({
    client: { apiKey: 'AIzaCANARYkey1234567890abcdefghijklmn' },
    signIn: { email: { enabled: true, passwordRequired: true } },
    emailPrivacyConfig: { enableImprovedEmailPrivacy: true },
    passwordPolicyConfig: {
      passwordPolicyEnforcementState: 'ENFORCE',
      passwordPolicyVersions: [{ customStrengthOptions: { minPasswordLength: 8, containsUppercaseCharacter: true } }],
    },
    authorizedDomains: ['localhost', 'drinkmeapp-a8fea.firebaseapp.com'],
    notification: { sendEmail: { resetPasswordTemplate: { senderDisplayName: 'DrinkMe', replyTo: 'r@example.test' } } },
  }).join('\n');
  assert.doesNotMatch(lines, /AIza/);
  assert.match(lines, /Email\/Password sign-in: enabled/);
  assert.match(lines, /Email enumeration protection: on/);
  assert.match(lines, /ENFORCE .*minPasswordLength":8/);
  assert.match(lines, /sender name "DrinkMe", reply-to "r@example.test"/);
});

test('missing settings are reported as off, not as an error', () => {
  const lines = summarizeAuthConfig({}).join('\n');
  assert.match(lines, /Email\/Password sign-in: DISABLED/);
  assert.match(lines, /enumeration protection: OFF/);
  assert.match(lines, /Password policy: not set/);
});

test('the app rules the summary compares against match AuthScreen validatePassword', () => {
  assert.deepEqual(APP_PASSWORD_RULES, { minLength: 8, uppercase: true, digit: true, special: true, lowercase: false });
});
