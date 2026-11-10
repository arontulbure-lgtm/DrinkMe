// Test-only: loaded into the server through NODE_OPTIONS=--import. Replaces firebase-admin/auth,
// so an idToken of the form "stub:<JSON claims>" verifies to those claims and anything else fails.
// Marker files next to DB_FILE steer the rest, so a test can change them while the server runs:
//   .stub-delete-user holds fail, not-found or fail-saves; with no file deleteUser succeeds.
//   .stub-user-gone makes getUser report that the user does not exist, or fail if it holds outage.
//   .stub-user-email-verified makes getUser report a confirmed address.
//   .stub-get-user-delay holds a wait in ms for the next getUser call only.
//   .stub-revoked makes verifyIdToken refuse any token when asked to check revocation.
//   .stub-delete-calls receives one line per deleteUser call.
import { register } from 'node:module';

const toDataUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

const STUB_URL = toDataUrl(`
  import fs from 'node:fs';
  const marker = (suffix) => process.env.DB_FILE.trim() + suffix;
  const fail = (code, uid) => Object.assign(new Error('stub failure for ' + uid), { code });
  export const getAuth = () => ({
    verifyIdToken: async (idToken, checkRevoked) => {
      if (!idToken.startsWith('stub:')) throw Object.assign(new Error('bad token'), { code: 'stub/invalid' });
      if (checkRevoked && fs.existsSync(marker('.stub-revoked'))) throw Object.assign(new Error('revoked'), { code: 'auth/id-token-revoked' });
      return JSON.parse(idToken.slice('stub:'.length));
    },
    getUser: async (uid) => {
      if (fs.existsSync(marker('.stub-get-user-delay'))) {
        const wait = Number(fs.readFileSync(marker('.stub-get-user-delay'), 'utf8'));
        fs.rmSync(marker('.stub-get-user-delay'));
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      if (fs.existsSync(marker('.stub-user-gone'))) {
        throw fail(fs.readFileSync(marker('.stub-user-gone'), 'utf8') === 'outage' ? 'auth/internal-error' : 'auth/user-not-found', uid);
      }
      return { uid, emailVerified: fs.existsSync(marker('.stub-user-email-verified')) };
    },
    deleteUser: async (uid) => {
      fs.appendFileSync(marker('.stub-delete-calls'), uid + String.fromCharCode(10));
      const mode = fs.existsSync(marker('.stub-delete-user')) ? fs.readFileSync(marker('.stub-delete-user'), 'utf8') : '';
      if (mode === 'fail') throw fail('auth/internal-error', uid);
      if (mode === 'not-found') throw fail('auth/user-not-found', uid);
      if (mode === 'fail-saves') fs.writeFileSync(marker('.fail-saves'), '');
    },
  });
`);

if (process.env.NODE_ENV !== 'test') throw new Error('firebase-auth stub is test-only');

register(toDataUrl(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'firebase-admin/auth') return { url: ${JSON.stringify(STUB_URL)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`));
