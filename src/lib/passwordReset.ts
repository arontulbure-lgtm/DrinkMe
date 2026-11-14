// Pure helpers for the "Forgot password?" flow on AuthScreen. No React or Firebase imports,
// so they can be unit tested later.

export const PASSWORD_RESET_COOLDOWN_MS = 60_000;

// Format check only (one @, a non-empty local part, a dotted domain, no spaces). The sign-up
// domain allowlist does not apply here: an older account may use any provider.
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim();
}

export function isValidEmailFormat(email: string): boolean {
  const value = normalizeEmail(email);
  return value.length <= 254 && EMAIL_FORMAT.test(value);
}

// Whole seconds left, rounded up, never negative. 0 means a new send is allowed.
export function getCooldownRemainingSeconds(cooldownUntil: number, now: number): number {
  if (!Number.isFinite(cooldownUntil) || cooldownUntil <= now) return 0;
  return Math.ceil((cooldownUntil - now) / 1000);
}
