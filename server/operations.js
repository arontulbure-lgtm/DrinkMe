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
// Same names as the AI track (server/ai/provider.js on auto/ai-2026-11-16): local | openai | off.
export const AI_PROVIDERS = ['local', 'openai', 'off'];

/**
 * Reads AI_PROVIDER and the legacy AI_ENABLED.
 * - AI_PROVIDER unset: the legacy AI_ENABLED=true means 'openai', anything else 'off' (as before).
 *   Production refuses to start: the choice must be explicit there.
 * - AI_PROVIDER set: it wins over AI_ENABLED. An unknown value is 'off' (warned); production refuses it.
 * - 'local' needs the ai-service integration from the AI track, which this build does not have: AI stays
 *   off (warned), and production refuses it until that merge.
 * @returns {{ provider: 'local' | 'openai' | 'off', explicit: boolean, aiEnabled: boolean, problems: string[], warnings: string[] }}
 *   aiEnabled: the OpenAI routes may run (still only with OPENAI_API_KEY).
 */
export const readAiProviderConfig = (env, { production }) => {
  const raw = (env.AI_PROVIDER ?? '').trim().toLowerCase();
  const legacyEnabled = env.AI_ENABLED === 'true';
  const problems = [];
  const warnings = [];
  let provider;

  if (raw === '') {
    provider = legacyEnabled ? 'openai' : 'off';
    if (production) problems.push('AI_PROVIDER (set it explicitly: off, local or openai; off until the AI service is deployed)');
  } else if (AI_PROVIDERS.includes(raw)) {
    provider = raw;
    if (legacyEnabled && provider !== 'openai') {
      warnings.push('AI_ENABLED=true is ignored because AI_PROVIDER is set.');
    }
  } else {
    provider = 'off';
    if (production) problems.push('AI_PROVIDER (off, local or openai)');
    else warnings.push('AI_PROVIDER must be local, openai or off - AI stays off.');
  }

  if (provider === 'local') {
    if (production) problems.push('AI_PROVIDER (local needs the AI service integration, which this build does not include; use off)');
    else warnings.push('AI_PROVIDER=local needs the AI service integration, which this build does not include - AI stays off.');
  }

  // The privacy policy (§5a) says photos and ingredients never go to an outside AI company, so production
  // runs OpenAI only after an explicit acknowledgement that the notice and subprocessor list were updated.
  if (provider === 'openai' && production && env.AI_OPENAI_PRODUCTION_ACK !== 'true') {
    problems.push('AI_PROVIDER (openai in production needs AI_OPENAI_PRODUCTION_ACK=true after the privacy policy names OpenAI; use off)');
  }

  return { provider, explicit: raw !== '', aiEnabled: provider === 'openai', problems, warnings };
};
