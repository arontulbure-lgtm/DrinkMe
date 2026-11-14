#!/usr/bin/env node
// npm run firebase:auth-check [-- --enable-enumeration-protection]
//
// Reads the Firebase Authentication settings of the server's project through the Identity Toolkit admin
// API (projects/<id>/config), with the service account from server/.env. Prints only the settings
// listed below, never the project's API key or the service-account key. Changes nothing, except that
// --enable-enumeration-protection switches on email enumeration protection
// (emailPrivacyConfig.enableImprovedEmailPrivacy) when it is off.
import { loadServiceAccount } from './official.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://identitytoolkit.googleapis.com/admin/v2';

// The app's own sign-up rules (src/screens/AuthScreen.tsx validatePassword), for the comparison.
export const APP_PASSWORD_RULES = { minLength: 8, uppercase: true, digit: true, special: true, lowercase: false };

/** The lines to print from a project config object. Never includes client.apiKey. */
export function summarizeAuthConfig(config) {
  const email = config?.signIn?.email ?? {};
  const policy = config?.passwordPolicyConfig ?? {};
  const constraints = policy.passwordPolicyVersions?.[0]?.customStrengthOptions ?? {};
  const resetTemplate = config?.notification?.sendEmail?.resetPasswordTemplate ?? {};
  const verifyTemplate = config?.notification?.sendEmail?.verifyEmailTemplate ?? {};
  return [
    `Email/Password sign-in: ${email.enabled ? 'enabled' : 'DISABLED'}${email.passwordRequired === false ? ' (email link only!)' : ''}`,
    `Email enumeration protection: ${config?.emailPrivacyConfig?.enableImprovedEmailPrivacy ? 'on' : 'OFF'}`,
    `Password policy: ${policy.passwordPolicyEnforcementState ?? 'not set'}${Object.keys(constraints).length ? ` ${JSON.stringify(constraints)}` : ''}`,
    `Authorized domains: ${(config?.authorizedDomains ?? []).join(', ') || '(none)'}`,
    `Reset-password email: sender name "${resetTemplate.senderDisplayName ?? ''}", reply-to "${resetTemplate.replyTo ?? ''}", from local part "${resetTemplate.senderLocalPart ?? ''}"`,
    `Verify-email email: sender name "${verifyTemplate.senderDisplayName ?? ''}", reply-to "${verifyTemplate.replyTo ?? ''}"`,
  ];
}

async function accessToken(serviceAccount) {
  const { cert } = await import('firebase-admin/app');
  const token = await cert(serviceAccount).getAccessToken();
  return token.access_token;
}

async function main() {
  const enable = process.argv.includes('--enable-enumeration-protection');
  const serviceAccount = loadServiceAccount(fs.readFileSync(path.join(SERVER_DIR, '.env'), 'utf8'), SERVER_DIR);
  const project = serviceAccount.project_id;
  const headers = { Authorization: `Bearer ${await accessToken(serviceAccount)}`, 'Content-Type': 'application/json' };
  const url = `${API}/projects/${project}/config`;

  const read = async () => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Identity Toolkit config read failed: HTTP ${res.status}`);
    return res.json();
  };

  let config = await read();
  console.log(`Project: ${project}`);
  summarizeAuthConfig(config).forEach((line) => console.log(line));

  if (enable) {
    if (config?.emailPrivacyConfig?.enableImprovedEmailPrivacy) {
      console.log('Enumeration protection was already on. Nothing changed.');
    } else {
      const res = await fetch(`${url}?updateMask=emailPrivacyConfig.enableImprovedEmailPrivacy`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ emailPrivacyConfig: { enableImprovedEmailPrivacy: true } }),
      });
      if (!res.ok) throw new Error(`Enabling enumeration protection failed: HTTP ${res.status}`);
      config = await read();
      console.log(`Enumeration protection now: ${config?.emailPrivacyConfig?.enableImprovedEmailPrivacy ? 'on' : 'still OFF'}`);
    }
  }
  console.log(`App sign-up rules: at least ${APP_PASSWORD_RULES.minLength} characters, an uppercase letter, a digit and a special character.`);
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
