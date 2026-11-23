// Operations helpers for server.js: the readiness answer behind GET /readyz, the request log format
// (LOG_FORMAT) and the AI provider setting (AI_PROVIDER). Pure functions, so they can be tested without
// starting a server. Messages name settings only, never their values.

// ── Readiness (/readyz) ──────────────────────────────────────────────────────────
// Reason codes are fixed strings: a probe learns which part is not ready, never a value or a detail.
export const READINESS_REASONS = Object.freeze({
  DB_NOT_LOADED: 'db_not_loaded',
  AUTH_NOT_INITIALIZED: 'auth_not_initialized',
  SHUTTING_DOWN: 'shutting_down',
});

/**
 * @param {{ dbLoaded: boolean, firebaseRequired: boolean, firebaseReady: boolean, shuttingDown?: boolean }} state
 * @returns {string | null} null when ready, otherwise one of READINESS_REASONS.
 */
export const readinessReason = ({ dbLoaded, firebaseRequired, firebaseReady, shuttingDown = false }) => {
  if (shuttingDown) return READINESS_REASONS.SHUTTING_DOWN;
  if (!dbLoaded) return READINESS_REASONS.DB_NOT_LOADED;
  if (firebaseRequired && !firebaseReady) return READINESS_REASONS.AUTH_NOT_INITIALIZED;
  return null;
};

// ── Request log format (LOG_FORMAT) ────────────────────────────────────────────
export const LOG_FORMATS = ['text', 'json'];

/**
 * LOG_FORMAT: unset or 'text' keeps the text format, 'json' writes one JSON object per request.
 * Case and surrounding spaces are ignored. Anything else is reported as invalid and falls back to text.
 * @returns {{ format: 'text' | 'json', valid: boolean }}
 */
export const parseLogFormat = (rawValue) => {
  const value = (rawValue ?? '').trim().toLowerCase();
  if (value === '') return { format: 'text', valid: true };
  if (LOG_FORMATS.includes(value)) return { format: value, valid: true };
  return { format: 'text', valid: false };
};

const toFiniteNumber = (value) => {
  if (value === undefined || value === null || value === '' || value === '-') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * One request log line as JSON: {ts, method, path, status, ms, size}. The same fields as the text
 * production format and nothing more (no IP address, user agent, referrer or query string; the path is
 * the already masked one). JSON.stringify escapes control characters, so a crafted path cannot forge a
 * second log line.
 */
export const formatJsonRequestLog = ({ ts, method, path, status, ms, size }) => JSON.stringify({
  ts,
  method,
  path,
  status: toFiniteNumber(status),
  ms: toFiniteNumber(ms),
  size: toFiniteNumber(size),
});

// ── AI provider (AI_PROVIDER) ──────────────────────────────────────────────────
// Which provider runs is decided by server/ai/provider.js (resolveAiProviderName: local or off, with its own
// warnings; the OpenAI provider was removed, decision D-24). This only adds the production startup rule.
export const AI_PROVIDER_CHOICES = ['local', 'off'];

/**
 * Production must state AI_PROVIDER explicitly as local or off; unset, the removed "openai" or any other
 * value stops the start (the value itself is never printed). Outside production nothing is required.
 * The extra checks for local (token, service URL) live next to the provider in server.js.
 * @returns {{ provider: 'local' | 'off', explicit: boolean, problems: string[] }}
 */
export const readAiProviderConfig = (env, { production }) => {
  const raw = (env.AI_PROVIDER ?? '').trim().toLowerCase();
  const problems = [];
  if (production && raw === '') {
    problems.push('AI_PROVIDER (set it explicitly: off, or local with the AI service)');
  } else if (production && !AI_PROVIDER_CHOICES.includes(raw)) {
    problems.push('AI_PROVIDER (off or local; the OpenAI provider was removed)');
  }
  return { provider: raw === 'local' ? 'local' : 'off', explicit: raw !== '', problems };
};
