// Maps Firebase Auth (and native sign-in) errors to translation keys under auth.errors.*.
// Pure on purpose (no React, no Firebase import) so it can be unit tested later.
// Never show error.message to the user: it is English only and can name internal details.

// Wrong password, unknown email and the combined code Firebase uses with email enumeration
// protection all get ONE message, so the screen never tells whether an account exists.
const INVALID_CREDENTIAL_CODES = new Set([
  'auth/invalid-credential',
  'auth/invalid-login-credentials',
  'auth/wrong-password',
  'auth/user-not-found',
]);

// The user closed or cancelled a sign-in flow. Callers show nothing for these.
const CANCELLED_CODES = new Set([
  'auth/popup-closed-by-user',
  'auth/cancelled-popup-request',
  'auth/user-cancelled',
  'auth/redirect-cancelled-by-user',
  'ERR_REQUEST_CANCELED', // expo-apple-authentication
  'ERR_CANCELED',
]);

// Codes that fall back to auth.errors.generic on purpose (not listed below): auth/user-disabled on
// sign-in (a specific message would reveal the account), auth/operation-not-allowed (Console config),
// auth/internal-error and auth/missing-password (the screen checks for an empty password first).
const CODE_TO_KEY: Record<string, string> = {
  'auth/email-already-in-use': 'auth.errors.emailInUse',
  'auth/weak-password': 'auth.errors.weakPassword',
  // The project's password policy (ENFORCE: 8+, uppercase, digit, special) refuses with this code.
  'auth/password-does-not-meet-requirements': 'auth.errors.weakPassword',
  'auth/invalid-email': 'auth.errors.invalidEmail',
  'auth/missing-email': 'auth.errors.invalidEmail',
  'auth/too-many-requests': 'auth.errors.tooManyRequests',
  'auth/network-request-failed': 'auth.errors.network',
  'auth/account-exists-with-different-credential': 'auth.errors.differentCredential',
};

export const AUTH_ERROR_GENERIC_KEY = 'auth.errors.generic';
export const AUTH_ERROR_CANCELLED_KEY = 'auth.errors.cancelled';

export function getAuthErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : null;
}

export function isAuthCancellation(error: unknown): boolean {
  const code = getAuthErrorCode(error);
  return code !== null && CANCELLED_CODES.has(code);
}

export function getAuthErrorKey(error: unknown): string {
  const code = getAuthErrorCode(error);
  if (code === null) return AUTH_ERROR_GENERIC_KEY;
  if (INVALID_CREDENTIAL_CODES.has(code)) return 'auth.errors.invalidCredentials';
  if (CANCELLED_CODES.has(code)) return AUTH_ERROR_CANCELLED_KEY;
  return CODE_TO_KEY[code] ?? AUTH_ERROR_GENERIC_KEY;
}

// Google / Apple sign-in: never "Email or password is incorrect", which makes no sense there.
export function getSocialAuthErrorKey(error: unknown, provider: 'google' | 'apple'): string {
  const key = getAuthErrorKey(error);
  if (key !== 'auth.errors.invalidCredentials') return key;
  return provider === 'google' ? 'auth.errors.google' : AUTH_ERROR_GENERIC_KEY;
}

// Password reset: null means "show the neutral confirmation". auth/user-not-found and
// auth/user-disabled count as success, so the answer is the same whether the account exists,
// is disabled, or does not exist. The other keys reveal nothing about the account.
export function getPasswordResetErrorKey(error: unknown): string | null {
  const code = getAuthErrorCode(error);
  if (code === 'auth/user-not-found' || code === 'auth/user-disabled') return null;
  if (code === 'auth/invalid-email' || code === 'auth/missing-email') return 'auth.errors.invalidEmail';
  if (code === 'auth/too-many-requests') return 'auth.errors.tooManyRequests';
  if (code === 'auth/network-request-failed') return 'auth.errors.network';
  return 'auth.forgot.failed';
}
