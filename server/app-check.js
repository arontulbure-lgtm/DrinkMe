// Firebase App Check for the API (SEC-I, plan in docs/APP_CHECK_PLAN.md).
//
// APP_CHECK_MODE:
//   off      (default) the header is not looked at
//   monitor  every /api request is checked and counted, nothing is refused; a summary is logged
//   enforce  a request without a valid X-Firebase-AppCheck token gets 401 { code: 'app_check_failed' }
// Any other value is treated as off with a loud warning at start, and production refuses to start with it
// (a typo must not silently switch the protection off).
//
// The app can only obtain real tokens from a native attestation provider (Play Integrity / App Attest), which
// needs a development or store build: until then, run in monitor mode at most.
export const APP_CHECK_HEADER = 'x-firebase-appcheck';
export const APP_CHECK_MODES = ['off', 'monitor', 'enforce'];

/** @returns {{ mode: 'off' | 'monitor' | 'enforce', valid: boolean }} */
export function parseAppCheckMode(rawValue) {
  const value = (rawValue ?? '').trim().toLowerCase();
  if (!value) return { mode: 'off', valid: true };
  if (APP_CHECK_MODES.includes(value)) return { mode: value, valid: true };
  return { mode: 'off', valid: false };
}

/**
 * Express middleware for /api.
 * @param {{ mode: string, verify: (token: string) => Promise<unknown>, onResult?: (result: 'valid' | 'missing' | 'invalid') => void }} options
 */
export function createAppCheckMiddleware({ mode, verify, onResult = () => {} }) {
  return async (req, res, next) => {
    if (mode === 'off') return next();
    const token = req.get(APP_CHECK_HEADER);
    let result = 'missing';
    if (token) {
      try {
        await verify(token);
        result = 'valid';
      } catch {
        result = 'invalid';
      }
    }
    onResult(result);
    if (result === 'valid' || mode === 'monitor') return next();
    res.set('Cache-Control', 'no-store');
    return res.status(401).json({ error: 'App verification failed', code: 'app_check_failed' });
  };
}

/** Counts per result, logged as one line when something changed (monitor mode). */
export function createAppCheckStats() {
  const counts = { valid: 0, missing: 0, invalid: 0 };
  let logged = '';
  return {
    counts,
    record(result) { counts[result] += 1; },
    summary() {
      const line = `[app-check] since start: ${counts.valid} valid, ${counts.missing} missing, ${counts.invalid} invalid`;
      if (line === logged) return null;
      logged = line;
      return line;
    },
  };
}
