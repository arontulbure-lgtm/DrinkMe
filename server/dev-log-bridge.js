// Development-only sink for the app's log bridge (src/lib/devLogBridge.ts), used during device test sessions.
// server.js imports this file only when NODE_ENV is exactly 'development' and DEV_SESSION_DIR is set
// (scripts/test-session.mjs sets it), and only then registers POST /__dev/client-log. A server started by
// hand, and test and production mode, never load the module and the route does not exist.
// The route takes only JSON with the X-DrinkMe-Dev-Log header and no Origin (the app's fetch sends none),
// so a web page cannot post to it. A device on the same Wi-Fi still can: entries are untrusted text.
//
// Each accepted entry becomes one JSON line in <session dir>/client.jsonl. Only listed fields are kept,
// every string is cut to a fixed length and redacted again here (the app redacts first): email
// addresses, JWTs, bearer tokens, key=value secrets, Google API keys, long opaque tokens and URL query
// strings. Request and response bodies are never accepted.
import fs from 'node:fs';
import path from 'node:path';

export const CLIENT_LOG_FILE_NAME = 'client.jsonl';
// One batch from the app holds at most 15 entries; the cap leaves room for a slow network.
export const MAX_ENTRIES_PER_BATCH = 50;
// A session file stops growing past this size. One line in the server log says so.
export const MAX_CLIENT_LOG_BYTES = 20 * 1024 * 1024;

const KINDS = new Set(['console', 'error', 'rejection', 'boundary', 'api', 'nav', 'note']);
const LEVELS = new Set(['error', 'warn', 'info']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const PLATFORMS = new Set(['ios', 'android', 'web', 'windows', 'macos']);

const TEXT_LIMITS = { message: 2000, stack: 6000, componentStack: 4000, screen: 80, code: 80, path: 200, appSession: 40 };
const MAX_TRAIL_SCREENS = 10;

// Order matters: whole JWTs and bearer headers go before the generic token rule cuts them up.
const REDACTIONS = [
  [/eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, '[jwt]'],
  [/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [token]'],
  [/\bAIza[\w-]{30,}/g, '[google-key]'],
  [/[\w.!#$%&'*+/=?^`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[email]'],
  [/[\w.+-]+%40[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gi, '[email]'],
  // URL query strings can hold search terms, API keys and OAuth codes. Metro bundle URLs in stack
  // traces keep theirs (platform and dev flags only), so the line and column after it stay readable.
  [/(\bhttps?:\/\/[^\s?#"']+)\?[^\s#"']*/gi, (match, base) => (/\.(bundle|map)$/i.test(base) ? match : `${base}?[query]`)],
  // Also compounds such as newPassword, authToken, clientSecret, private_key.
  [/([\w-]*(?:token|password|passwd|secret|api_?key|apikey|private_?key|authorization|code_verifier)["']?\s*[:=]\s*["']?)(?!Bearer\b|\[)[^\s"'&,;}\]]+/gi, '$1[redacted]'],
  // A bare code or key only when the value is long: "code":"age_required" and status codes stay readable.
  [/(\b(?:code|key)\b["']?\s*[:=]\s*["']?)(?!\[)[^\s"'&,;}\]]{16,}/gi, '$1[redacted]'],
];

// A long run of token characters with a digit and both letter cases, and at most two slashes (a file
// path has more), reads as a token or key. Firebase uids (28 characters) stay readable.
const OPAQUE_RUN = /[A-Za-z0-9_+/=-]{32,}/g;
const looksLikeToken = (run) => (
  /\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run) && (run.match(/\//g)?.length ?? 0) <= 2
);

export function redactText(value) {
  if (typeof value !== 'string' || value === '') return '';
  let out = value;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out.replace(OPAQUE_RUN, (run) => (looksLikeToken(run) ? '[token]' : run));
}

// Control characters other than newline and tab (C0, DEL, C1) and direction overrides are removed, so a
// log line cannot rewrite the terminal or display differently from what it contains.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

const cleanText = (value, limit) => {
  if (typeof value !== 'string') return undefined;
  const text = redactText(value.replace(CONTROL_CHARACTERS, ''));
  if (!text) return undefined;
  return text.length > limit ? `${text.slice(0, limit)}…[cut]` : text;
};

// Any path segment of 20 or more id characters becomes :id, so user ids do not need to be logged.
// The query string is dropped whole.
export function cleanApiPath(value) {
  if (typeof value !== 'string') return undefined;
  const withoutQuery = value.split(/[?#]/)[0];
  if (!withoutQuery.startsWith('/')) return undefined;
  const masked = withoutQuery.split('/').map((segment) => (/^[\w-]{20,}$/.test(segment) ? ':id' : segment)).join('/');
  return cleanText(masked, TEXT_LIMITS.path);
}

const cleanInteger = (value, min, max) => (
  Number.isInteger(value) && value >= min && value <= max ? value : undefined
);

const cleanTimestamp = (value) => {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
};

/** One entry from the app, reduced to the known fields. Returns null for an entry that is not usable. */
export function sanitizeClientLogEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !KINDS.has(raw.kind)) return null;
  const entry = {
    kind: raw.kind,
    level: LEVELS.has(raw.level) ? raw.level : undefined,
    clientTs: cleanTimestamp(raw.clientTs),
    appSession: cleanText(raw.appSession, TEXT_LIMITS.appSession),
    seq: cleanInteger(raw.seq, 1, 1_000_000_000),
    platform: PLATFORMS.has(raw.platform) ? raw.platform : undefined,
    screen: cleanText(raw.screen, TEXT_LIMITS.screen),
    trail: Array.isArray(raw.trail)
      ? raw.trail.slice(-MAX_TRAIL_SCREENS).map((item) => cleanText(item, TEXT_LIMITS.screen)).filter(Boolean)
      : undefined,
    message: cleanText(raw.message, TEXT_LIMITS.message),
    stack: cleanText(raw.stack, TEXT_LIMITS.stack),
    componentStack: cleanText(raw.componentStack, TEXT_LIMITS.componentStack),
    fatal: typeof raw.fatal === 'boolean' ? raw.fatal : undefined,
  };
  if (raw.kind === 'api') {
    entry.method = METHODS.has(raw.method) ? raw.method : undefined;
    entry.path = cleanApiPath(raw.path);
    // 0 means the request got no answer (offline, timeout, refused connection).
    entry.status = cleanInteger(raw.status, 0, 599);
    entry.code = cleanText(raw.code, TEXT_LIMITS.code);
    entry.durationMs = cleanInteger(raw.durationMs, 0, 10 * 60 * 1000);
    if (!entry.method || !entry.path) return null;
  } else if (raw.kind !== 'nav' && !entry.message) {
    return null;
  }
  if (raw.kind === 'nav' && !entry.screen) return null;
  if (entry.trail?.length === 0) entry.trail = undefined;
  return entry;
}

/** The kind of HTTP client from its User-Agent, for the dev media diagnostic: never the string itself. */
export function clientKind(userAgent) {
  const ua = String(userAgent ?? '');
  if (/okhttp/i.test(ua)) return 'android-okhttp';
  if (/Dalvik|Android/i.test(ua)) return 'android';
  if (/CFNetwork|Darwin/i.test(ua)) return 'ios-cfnetwork';
  if (/Expo|ReactNative/i.test(ua)) return 'expo';
  if (/Mozilla/i.test(ua)) return 'browser';
  if (/node|undici/i.test(ua)) return 'node';
  return ua ? 'other' : 'none';
}

export const DEV_LOG_HEADER = 'x-drinkme-dev-log';

/**
 * Refuses what a browser can send: a form post (not JSON), a request without the app's header (a custom
 * header needs a CORS preflight), or any request with an Origin (the app's fetch sends none).
 * @returns {{ status: number, error: string } | null} null when the request may be appended.
 */
export function refuseUntrustedRequest(req) {
  if (!req.is('application/json')) return { status: 415, error: 'JSON only' };
  if (req.get(DEV_LOG_HEADER) !== '1') return { status: 403, error: 'Missing dev log header' };
  if (req.get('origin') !== undefined) return { status: 403, error: 'Browser requests are not accepted' };
  return null;
}

/**
 * Appends the app's batches to <dir>/client.jsonl.
 * @param {string} dir The session folder. Created if missing.
 */
export function createClientLogSink(dir) {
  const file = path.join(path.resolve(dir), CLIENT_LOG_FILE_NAME);
  let isFull = false;

  return {
    file,
    /** @returns {{ ok: true, written: number } | { ok: false }} */
    append(body) {
      const rawEntries = body?.entries;
      if (!Array.isArray(rawEntries) || rawEntries.length === 0 || rawEntries.length > MAX_ENTRIES_PER_BATCH) {
        return { ok: false };
      }
      const receivedAt = new Date().toISOString();
      const lines = rawEntries
        .map(sanitizeClientLogEntry)
        .filter(Boolean)
        .map((entry) => JSON.stringify({ ts: receivedAt, ...entry }))
        .join('\n');
      if (!lines) return { ok: true, written: 0 };
      if (isFull) return { ok: true, written: 0 };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
      if (size + Buffer.byteLength(lines) + 1 > MAX_CLIENT_LOG_BYTES) {
        isFull = true;
        console.warn(`[dev-log] ${CLIENT_LOG_FILE_NAME} reached ${MAX_CLIENT_LOG_BYTES} bytes; later app logs are dropped.`);
        return { ok: true, written: 0 };
      }
      fs.appendFileSync(file, `${lines}\n`);
      return { ok: true, written: lines.split('\n').length };
    },
  };
}
