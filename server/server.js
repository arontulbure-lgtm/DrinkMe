import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import multer from 'multer';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import jwt from 'jsonwebtoken';
import validator from 'validator';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// Fails closed: an unset or mistyped NODE_ENV gets every production guard.
const isProduction = !['development', 'test'].includes(process.env.NODE_ENV);
const allowInsecureDevAuth = !isProduction && process.env.ALLOW_INSECURE_DEV_AUTH === 'true';
// Exactly 'true', read once at start: any other value leaves sign-in and existing JWTs as they are.
const REQUIRE_VERIFIED_EMAIL = process.env.REQUIRE_VERIFIED_EMAIL === 'true';

const JWT_SECRET_MIN_LENGTH = 32;
const JWT_SECRET_MIN_DISTINCT_CHARS = 16;
// SHA-256 of the default secret that older versions hardcoded. That value is public in the git history.
const OLD_DEFAULT_JWT_SECRET_SHA256 = 'bb9331f912210f0e7bf4852bbbbedd40856b8fa6678042a95e75f358dd763659';
const JWT_ALGORITHM = 'HS256';
const hasJwtSecret = Boolean(process.env.JWT_SECRET?.trim());

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
// In production a missing secret stops the server below, so the random value is only ever used outside it.
const JWT_SECRET = hasJwtSecret ? process.env.JWT_SECRET : crypto.randomBytes(64).toString('base64');

const verifyApiToken = (token) => jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
// ev marks a JWT issued for a confirmed address. Older JWTs have none, so they stop working when REQUIRE_VERIFIED_EMAIL goes on.
// sg is the user's session generation (user.sessionGen). It is left out at 0, so JWTs from before it
// existed stay valid until a sign-in raises the generation, which logs out every earlier JWT.
const signApiToken = (uid, emailVerified = false, sessionGen = 0) => jwt.sign(
  { uid, ...(emailVerified && { ev: true }), ...(sessionGen > 0 && { sg: sessionGen }) },
  JWT_SECRET,
  { algorithm: JWT_ALGORITHM, expiresIn: '30d' }
);

if (!hasJwtSecret && !isProduction) {
  console.warn('[auth] JWT_SECRET not set — using a random secret for this process. Tokens stop working on restart.');
}

// Prints setting names only, never their values.
function exitOnInvalidProductionConfig(problems) {
  console.error(`[startup] FATAL: refusing to start in production. Fix: ${problems.join('; ')}.`);
  process.exit(1);
}

// ── Firebase Admin SDK ────────────────────────────────────────────────────────
// AUTH-1: Verify Firebase ID tokens server-side.
// Set FIREBASE_SERVICE_ACCOUNT_KEY in server/.env (JSON string or file path)
// to enable full verification. Production refuses to start without it. In development and
// test, /api/auth/mobile returns 503 without it, unless ALLOW_INSECURE_DEV_AUTH=true enables
// a fallback that trusts the client uid. That fallback is insecure and development-only.
import { initializeApp as adminInitializeApp, getApps as adminGetApps, cert } from 'firebase-admin/app';
import { getAuth as adminGetAuth } from 'firebase-admin/auth';

let firebaseAuth = null;

{
  const keyEnv = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  let serviceAccount = null;

  if (keyEnv) {
    try {
      serviceAccount = keyEnv.trimStart().startsWith('{')
        ? JSON.parse(keyEnv)
        : JSON.parse(fs.readFileSync(keyEnv, 'utf8'));
    } catch (e) {
      // A JSON parse error message can quote the key, so only the error type is logged.
      console.warn('[firebase-admin] Could not parse FIREBASE_SERVICE_ACCOUNT_KEY:', e.code ?? e.name);
    }
  }

  if (serviceAccount) {
    try {
      if (!adminGetApps().length) {
        adminInitializeApp({ credential: cert(serviceAccount) });
      }
      firebaseAuth = adminGetAuth();
      console.log('[firebase-admin] ✅ Initialized — ID tokens will be fully verified server-side.');
    } catch (e) {
      if (!isProduction) throw e;
      console.warn('[firebase-admin] Could not initialize from FIREBASE_SERVICE_ACCOUNT_KEY:', e.code ?? e.name);
    }
  } else if (allowInsecureDevAuth) {
    console.warn('[firebase-admin] ⚠️  No service account key — ALLOW_INSECURE_DEV_AUTH=true, so sign-in trusts the client uid. This is insecure and development-only.');
  } else if (!isProduction) {
    console.warn('[firebase-admin] ⚠️  No service account key — sign-in returns 503. Set FIREBASE_SERVICE_ACCOUNT_KEY, or ALLOW_INSECURE_DEV_AUTH=true for an insecure, development-only fallback that trusts the client uid.');
  }
}

const trimmedJwtSecret = process.env.JWT_SECRET?.trim() ?? '';

// The old default is public, so it is refused in every environment. Prints the setting name only.
if (crypto.createHash('sha256').update(trimmedJwtSecret).digest('hex') === OLD_DEFAULT_JWT_SECRET_SHA256) {
  console.error('[startup] FATAL: refusing to start. Fix: JWT_SECRET is the old default; generate a new value.');
  process.exit(1);
}

if (isProduction) {
  const missingConfig = [];
  if (
    trimmedJwtSecret.length < JWT_SECRET_MIN_LENGTH ||
    new Set(trimmedJwtSecret).size < JWT_SECRET_MIN_DISTINCT_CHARS
  ) {
    missingConfig.push(
      `JWT_SECRET (at least ${JWT_SECRET_MIN_LENGTH} characters, ${JWT_SECRET_MIN_DISTINCT_CHARS} distinct, and not the old default)`
    );
  }
  if (!firebaseAuth) {
    missingConfig.push('FIREBASE_SERVICE_ACCOUNT_KEY (a valid service account)');
  }
  if (missingConfig.length) exitOnInvalidProductionConfig(missingConfig);
  if (!REQUIRE_VERIFIED_EMAIL) {
    console.warn('[auth] REQUIRE_VERIFIED_EMAIL is off: accounts with an unconfirmed email can use the API.');
  }
}

/**
 * Verify a Firebase ID token using Firebase Admin SDK.
 * Returns the claims used here on success, null on failure. checkRevoked also asks Firebase
 * whether the session was revoked or the user is gone, which takes a network call.
 */
async function verifyFirebaseToken(idToken, { checkRevoked = false } = {}) {
  if (!firebaseAuth) return null;
  try {
    const decoded = await firebaseAuth.verifyIdToken(idToken, checkRevoked);
    return { uid: decoded.uid, email: decoded.email, emailVerified: decoded.email_verified === true, name: decoded.name, picture: decoded.picture, issuedAtSeconds: decoded.iat, authTimeSeconds: decoded.auth_time, signInProvider: decoded.firebase?.sign_in_provider };
  } catch (e) {
    // The message can hold attacker-controlled text, so only the error type is logged.
    console.warn('[firebase-admin] verifyIdToken failed:', e.code ?? e.name);
    return null;
  }
}

// ── Persistence ───────────────────────────────────────────────────────────────
// DB_FILE env overrides the database location (used by the test harness).
const DB_FILE  = process.env.DB_FILE?.trim()
  ? path.resolve(process.env.DB_FILE.trim())
  : path.join(__dirname, 'data', 'db.json');
const DATA_DIR = path.dirname(DB_FILE);

// A wrong path must not silently become an empty database. A first deploy sets ALLOW_EMPTY_DB=true once.
if (isProduction) {
  const dbFileEnv = process.env.DB_FILE;
  if (dbFileEnv !== undefined && !path.isAbsolute(dbFileEnv.trim())) {
    exitOnInvalidProductionConfig(['DB_FILE (must be an absolute path)']);
  }
  if (!fs.existsSync(DB_FILE)) {
    if (process.env.ALLOW_EMPTY_DB !== 'true') {
      exitOnInvalidProductionConfig(['DB_FILE (no database file at this path; set ALLOW_EMPTY_DB=true only for a first deploy)']);
    }
    console.warn('[db] ALLOW_EMPTY_DB=true and no database file — starting empty. Remove the flag after this deploy.');
  } else if (process.env.ALLOW_EMPTY_DB === 'true') {
    console.warn('[db] ALLOW_EMPTY_DB=true but the database file exists. Remove the flag: it lets a corrupt database start empty.');
  }
}

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

const app = express();

// The error handler shows a message to the client only for errors made here. The flag is not
// named `expose` because http-errors sets that on errors from libraries.
const createAppError = (status, message, code) => (
  Object.assign(new Error(message), { status, isAppError: true, ...(code && { code }) })
);

// Caps on decoded image bytes.
const AVATAR_MAX_BYTES     = 2 * 1024 * 1024;
const POST_IMAGE_MAX_BYTES = 7 * 1024 * 1024;
// Plus one: busboy reports the limit when a file reaches it, which would refuse a file of exactly the cap.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: AVATAR_MAX_BYTES + 1,
    fieldSize: Math.ceil(AVATAR_MAX_BYTES * 4 / 3) + 4,
    files: 1,
    fields: 1,
  },
});
// Plus one for the same reason as above. A scan is one file and nothing else.
const aiImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: POST_IMAGE_MAX_BYTES + 1,
    files: 1,
    fields: 0,
  },
});

// Parser errors that are not MulterErrors (no boundary, truncated body) come from bad client input.
const parseUpload = (middleware) => (req, res, next) => {
  middleware(req, res, (err) => {
    if (!err || err instanceof multer.MulterError) return next(err);
    res.status(400).json({ error: 'Invalid upload' });
  });
};

// Number of reverse proxies in front of this server. Keep it 0 when clients connect directly:
// trusting a hop that does not exist lets a client pick its own IP through X-Forwarded-For.
const parseTrustProxyHops = (rawValue) => {
  const value = (rawValue ?? '').trim();
  if (!value) return 0;
  if (/^\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  console.warn('[config] TRUST_PROXY_HOPS must be a non-negative integer — using 0.');
  return 0;
};
app.set('trust proxy', parseTrustProxyHops(process.env.TRUST_PROXY_HOPS));

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOptions = isProduction
  ? {
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(createAppError(403, 'Not allowed by CORS'), false);
      },
      credentials: true,
    }
  : { origin: true, credentials: true };

app.use(cors(corsOptions));
app.use(helmet());
// Replaces the built-in token, so both formats log the path only: query strings carry search terms.
// The account deletion path is masked too, so deleting an account does not write its uid to the log.
morgan.token('url', (req) => (
  (req.originalUrl || req.url).split('?')[0].replace(/^(\/api\/users\/)[^/]+(\/delete-account\/?)$/i, '$1:id$2')
));
app.use(morgan(isProduction ? 'combined' : 'dev'));

// ── Media ─────────────────────────────────────────────────────────────────────
// Images leave the JSON responses and come from here. Mounted before the body parsers, which a GET
// for an image never needs, and outside /api, so one screen of images cannot use up the API limit.
// The handlers read state defined further down, all of it set before the server starts listening.
const MEDIA_CACHE_CONTROL = 'private, max-age=86400';
const mediaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/media', mediaLimiter);
// Signed in and 18+ confirmed; see requireSignedInAdult.
app.use('/media', requireSignedInAdult);

// A stored value that is not a usable image is a 404, like one that does not exist.
const sendStoredImage = (req, res, cacheKey, storedValue, cacheControl = MEDIA_CACHE_CONTROL) => {
  const { image, wasCached } = getDecodedImage(cacheKey, storedValue);
  // Only for the tests, which cannot otherwise see whether an image was decoded again.
  if (process.env.NODE_ENV === 'test') res.set('X-Media-Cache', wasCached ? 'hit' : 'miss');
  if (!image) return res.status(404).json({ error: 'Not found' });
  // Replaces helmet's same-origin value. Helmet's X-Content-Type-Options: nosniff stays.
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.set('Cache-Control', cacheControl);
  res.set('Content-Type', image.mime);
  // Set here, so res.send does not hash the bytes on every request.
  res.set('ETag', image.etag);
  if (req.fresh) return res.status(304).end();
  return res.send(image.bytes); // for HEAD, res.send sets the length and writes no body
};

app.get('/media/drinks/:id', (req, res) => {
  const drinkId = parsePositiveInteger(req.params.id);
  const found = drinks.find((d) => d.id === drinkId);
  const viewerId = getUserId(req);
  // An admin must be able to see what they review: a poster who blocks them cannot hide an image. This route only.
  // requireSignedInAdult runs first, so the admin has confirmed 18+ by now and only a block can be bypassed.
  const isReviewAccess = Boolean(found) && ADMIN_USER_IDS.has(viewerId) && !canViewDrink(found, viewerId);
  // A block answers exactly like a post that does not exist, and neither answer may be reused after an unblock.
  const drink = found && (isReviewAccess || !isBlockedBetween(found.userId, viewerId)) ? found : undefined;
  // The answer depends on who asks, so a cache must not reuse it for another viewer.
  res.vary('Authorization');
  if (!drink) res.set('Cache-Control', 'no-store');
  // Before any decoding and before the 304 answer, so neither a cached image nor an ETag gets past it.
  if (drink && !isReviewAccess && !canViewDrink(drink, viewerId)) {
    res.set('Cache-Control', 'no-store');
    return respondAgeRequired(res);
  }
  sendStoredImage(req, res, `drink:${drinkId}`, drink?.imageUrl, isReviewAccess ? 'no-store' : MEDIA_CACHE_CONTROL);
});

// The v query parameter only makes a new avatar a new URL for image caches. A provider photo is not
// a data URL, so it gets a 404 and is never fetched through this server.
app.get('/media/avatars/:userId', (req, res) => {
  const owner = isLiveAccount(req.params.userId) ? userIndex.get(req.params.userId) : undefined;
  const avatar = owner && !owner.noticePending ? owner.avatar : undefined;
  sendStoredImage(req, res, `avatar:${req.params.userId}`, avatar);
});

// Global: 100 req / 15 min / IP
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

// SEC-B: per-user rate limit for mutation endpoints (30 actions / min / user)
const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use userId from JWT if available, else fall back to IP
    try {
      const auth = req.headers.authorization;
      if (auth?.startsWith('Bearer ')) {
        const decoded = verifyApiToken(auth.slice(7));
        return `user:${decoded.uid}`;
      }
    } catch {}
    return req.ip;
  },
  skip: (req) => req.method === 'GET', // only rate-limit writes
});
app.use('/api', mutationLimiter);
// Before the body parsers, so a refused request is never parsed. See requireSignedInAdult.
app.use('/api', requireSignedInAdult);

const DEFAULT_BODY_LIMIT = '100kb';
const POST_BODY_LIMIT    = '10mb';
const AVATAR_BODY_LIMIT  = '3mb';
const defaultJsonParser       = express.json({ limit: DEFAULT_BODY_LIMIT });
const defaultUrlencodedParser = express.urlencoded({ extended: true, limit: DEFAULT_BODY_LIMIT });
// Parsed in the route after auth, so only the account owner can make the server hold a large body.
const postBodyParser   = express.json({ limit: POST_BODY_LIMIT });
const avatarBodyParser = express.json({ limit: AVATAR_BODY_LIMIT });
const isImageUploadRoute = (req) => (
  req.method === 'POST' && (req.path === '/api/drinks' || /^\/api\/users\/[^/]+\/avatar$/.test(req.path))
);
app.use((req, res, next) => (isImageUploadRoute(req) ? next() : defaultJsonParser(req, res, next)));
app.use((req, res, next) => (isImageUploadRoute(req) ? next() : defaultUrlencodedParser(req, res, next)));

// ── Input sanitization helper (SEC-A) ─────────────────────────────────────────
const sanitizeText = (value, maxLength = 500) => {
  if (typeof value !== 'string') return '';
  // Control characters are removed first, keeping newlines, so a control-only value ends up empty.
  // Tabs become spaces so pasted words stay apart. A lone surrogate takes 6 characters in the saved
  // JSON, so toWellFormed runs first on the input. After that a trailing high surrogate can only be
  // an emoji split by the slice, so that half is dropped rather than stored as U+FFFD.
  // Output is not HTML-escaped: React Native <Text> does not parse HTML, so entities would show
  // literally. A future web client must encode this text on output.
  // C1 controls and bidi overrides go too. Other format characters stay: ZWJ is part of many emoji.
  const cleaned = validator.stripLow(value.replace(/\t/g, ' '), true)
    .replace(/[\u0080-\u009F‪-‮⁦-⁩]/g, '')
    .toWellFormed()
    .trim();
  return cleaned.slice(0, maxLength).replace(/[\uD800-\uDBFF]$/, '').toWellFormed();
};
const sanitizeOptional = (value, maxLength = 500) => {
  if (!value || typeof value !== 'string') return null;
  return sanitizeText(value, maxLength);
};

const PHOTO_URL_MAX_LENGTH = 2048;
// Exact hosts: other googleusercontent.com subdomains can be chosen by a caller and could log viewers' IPs.
const PHOTO_URL_HOST_PATTERN = /^lh[3-6]\.googleusercontent\.com$/;
// Returns the URL only if it is an https Google profile photo URL, otherwise undefined.
const sanitizePhotoURL = (value) => {
  if (typeof value !== 'string' || value.length > PHOTO_URL_MAX_LENGTH) return undefined;
  if (!validator.isURL(value, { protocols: ['https'], require_protocol: true })) return undefined;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' || !PHOTO_URL_HOST_PATTERN.test(parsed.hostname) || parsed.port || parsed.username || parsed.password) {
    return undefined;
  }
  return value;
};

// AI stays off unless AI_ENABLED is exactly 'true'. A key on its own does not turn it on.
const AI_ENABLED = process.env.AI_ENABLED === 'true';
const AI_REQUEST_TIMEOUT_MS = 30_000;
const AI_MAX_RETRIES = 1; // timeouts are retried too, so one request can wait twice the timeout

if (AI_ENABLED && !process.env.OPENAI_API_KEY) {
  console.warn('AI_ENABLED=true but OPENAI_API_KEY is not set. AI endpoints will respond with 503.');
}

const openai = AI_ENABLED && process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: AI_REQUEST_TIMEOUT_MS, maxRetries: AI_MAX_RETRIES })
  : null;

// ── Default seed data — EMPTY (no dummy users for production) ─────────────────
const DEFAULT_USERS = [];
const DEFAULT_DRINKS = [];

// ── Mutable state (populated from file or seed on startup) ────────────────────
let drinks           = [];
let nextDrinkId      = 1;
let nextNotificationId = 1;
let nextCommentId    = 1;
let nextReportId     = 1;
// 2: text is stored plain. A file with a lower or missing value holds HTML-escaped text.
const DB_SCHEMA_VERSION = 2;
let dbSchemaVersion  = DB_SCHEMA_VERSION;

const userIndex         = new Map();
const avatarHashByUser  = new Map(); // not persisted: rebuilt from the stored avatars at load
const cheersByUser      = new Map();
const savedByUser       = new Map();
const smartBarByUser    = new Map();
const partnersByUser    = new Map();
const notificationsByUser = new Map();
const commentsByDrink   = new Map();
const limitEventsByUser = new Map();
const blocksByUser      = new Map();
// Target id to [{ fromId, createdAt }]. deleteUserDataCascade erases a user both ways.
const partnerRequestsByUser = new Map();
const reports           = [];
// [{ uid }]: accounts whose deletion was accepted and has not finished. No JWT or sign-in works for a uid here.
// [{ uid, until }]: a finished deletion, kept for ACCOUNT_TOMBSTONE_MS and then pruned. See isTokenFromBeforeDeletion.
const pendingAccountDeletions = [];

const stories = [];

// ── Persistence helpers ───────────────────────────────────────────────────────
const DB_RENAME_RETRIES       = 3;
const DB_RENAME_RETRY_WAIT_MS = 50;
const DB_RENAME_RETRY_CODES   = new Set(['EPERM', 'EBUSY', 'EACCES']);
const DB_READ_RETRIES         = 3;
const DB_READ_RETRY_CODES     = new Set([...DB_RENAME_RETRY_CODES, 'EMFILE']);

const DB_COUNTER_KEYS = ['nextDrinkId', 'nextNotificationId', 'nextCommentId', 'nextReportId', 'dbSchemaVersion', 'recoveryStartedAt'];
const DB_LIST_KEYS    = ['drinks', 'users', 'reports', 'pendingAccountDeletions'];
const DB_MAP_KEYS     = [
  'cheersByUser', 'savedByUser', 'smartBarByUser',
  'partnersByUser', 'notificationsByUser', 'commentsByDrink', 'limitEventsByUser', 'blocksByUser',
  'partnerRequestsByUser',
];

// Size in bytes of the last good save, or of the file at load. Read by the growth guard.
let lastSavedDbBytes = 0;
// Backup retention reads these. True only for a file that was read and kept, never for an empty start.
let isDbLoaded = false;
let didBackUpDbOnLoad = false;
// When a corrupt or missing file made this database start empty. Saved only while set. Holds the backup purge.
let recoveryStartedAt;

const waitBeforeDbRetry = () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DB_RENAME_RETRY_WAIT_MS);
};

// Windows can refuse a rename briefly while another process (antivirus, indexer) holds the target.
function renameDbFileWithRetry(tmpFile) {
  for (let retriesLeft = DB_RENAME_RETRIES; ; retriesLeft--) {
    try {
      fs.renameSync(tmpFile, DB_FILE);
      return;
    } catch (err) {
      if (retriesLeft === 0 || !DB_RENAME_RETRY_CODES.has(err.code)) throw err;
      waitBeforeDbRetry();
    }
  }
}

// Atomic write: a crash or failed rename leaves the previous DB_FILE intact.
function saveDb() {
  const tmpFile = `${DB_FILE}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try {
    const data = {
      drinks,
      nextDrinkId,
      nextNotificationId,
      nextCommentId,
      nextReportId,
      dbSchemaVersion,
      users: Array.from(userIndex.values()),
      reports,
      cheersByUser: Object.fromEntries(
        Array.from(cheersByUser.entries()).map(([k, v]) => [k, Array.from(v)])
      ),
      savedByUser: Object.fromEntries(
        Array.from(savedByUser.entries()).map(([k, v]) => [k, Array.from(v)])
      ),
      smartBarByUser: Object.fromEntries(smartBarByUser.entries()),
      partnersByUser: Object.fromEntries(
        Array.from(partnersByUser.entries()).map(([k, v]) => [k, Array.from(v)])
      ),
      notificationsByUser: Object.fromEntries(notificationsByUser.entries()),
      commentsByDrink: Object.fromEntries(
        Array.from(commentsByDrink.entries()).map(([k, v]) => [String(k), v])
      ),
      limitEventsByUser: Object.fromEntries(limitEventsByUser.entries()),
      blocksByUser: Object.fromEntries(
        Array.from(blocksByUser.entries()).map(([k, v]) => [k, Array.from(v)])
      ),
      partnerRequestsByUser: Object.fromEntries(partnerRequestsByUser.entries()),
      pendingAccountDeletions,
      ...(recoveryStartedAt !== undefined && { recoveryStartedAt }),
    };
    const serialized = JSON.stringify(data, null, 2);
    const bytes = Buffer.from(serialized, 'utf8');
    const fd = fs.openSync(tmpFile, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameDbFileWithRetry(tmpFile);
    lastSavedDbBytes = bytes.length;
    return true;
  } catch (err) {
    console.error('[db] Failed to save, keeping the previous database:', err.message);
    try {
      fs.rmSync(tmpFile, { force: true });
    } catch (cleanupErr) {
      console.error(`[db] Could not remove temp file ${tmpFile}:`, cleanupErr.message);
    }
    return false;
  }
}

// For routes that mutate: false means the 503 was already sent. Creates roll back at their call
// sites. Toggles and profile edits are deliberately not rolled back. Neither is a new user at
// sign-in: no token was issued and a retry reuses the record, but until then it is visible to other
// users, and the next successful save writes it to disk.
const saveDbOrRespond = (res) => {
  if (saveDb()) return true;
  res.status(503).json({ error: 'Could not save your changes. Please try again.' });
  return false;
};

// A raw SyntaxError message can quote file content, so it never reaches the logs.
const describeDbError = (err) => (err instanceof SyntaxError ? 'invalid JSON' : (err.code ?? err.name));

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Starting empty after these failures could let the next mutation overwrite a good database.
function exitOnDbLoadFailure(action, reason) {
  console.error(`[db] FATAL: could not ${action} ${DB_FILE} (${reason}). Refusing to start so the database file is not overwritten.`);
  process.exit(1);
}

function readDbFileWithRetry() {
  for (let retriesLeft = DB_READ_RETRIES; ; retriesLeft--) {
    try {
      return fs.readFileSync(DB_FILE);
    } catch (err) {
      if (retriesLeft === 0 || !DB_READ_RETRY_CODES.has(err.code)) {
        exitOnDbLoadFailure('read', describeDbError(err));
      }
      waitBeforeDbRetry();
    }
  }
}

/**
 * Returns the name of the first invalid key, or null. A missing key is allowed,
 * so files written before a key existed keep loading. Only key names are
 * returned, because map entries are keyed by user id.
 */
function findDbShapeProblem(data) {
  if (!isPlainObject(data)) return 'root';
  // In production, a file with no known key is probably not this database (a mistaken DB_FILE).
  if (isProduction && ![...DB_COUNTER_KEYS, ...DB_LIST_KEYS, ...DB_MAP_KEYS].some((key) => key in data)) {
    return 'no known keys';
  }
  for (const key of DB_COUNTER_KEYS) {
    if (key in data && typeof data[key] !== 'number') return key;
  }
  // No version ever wrote a fraction or an unsafe integer, so its meaning cannot be guessed.
  if ('dbSchemaVersion' in data && !Number.isSafeInteger(data.dbSchemaVersion)) return 'dbSchemaVersion';
  for (const key of DB_LIST_KEYS) {
    if (key in data && !(Array.isArray(data[key]) && data[key].every(isPlainObject))) return key;
  }
  for (const key of DB_MAP_KEYS) {
    if (key in data && !(isPlainObject(data[key]) && Object.values(data[key]).every(Array.isArray))) return key;
  }
  return null;
}

const listDbSiblings = (prefix) =>
  fs.readdirSync(DATA_DIR).filter((name) => name.startsWith(prefix));

// Returns the newest backup with this marker in its name and its hash, or null.
function newestDbBackup(marker) {
  const prefix = `${path.basename(DB_FILE)}${marker}`;
  const timestampOf = (name) => Number(name.slice(prefix.length));
  const [newest] = listDbSiblings(prefix)
    .filter((name) => /^\d+$/.test(name.slice(prefix.length)))
    .sort((a, b) => timestampOf(b) - timestampOf(a));
  if (!newest) return null;
  const file = path.join(DATA_DIR, newest);
  return { file, hash: sha256(fs.readFileSync(file)) };
}

// 'wx' never overwrites an existing backup. Only a file this call created, and could not verify, is removed.
function writeDbBackup(backupFile, rawBytes) {
  const fd = fs.openSync(backupFile, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, rawBytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (sha256(fs.readFileSync(backupFile)) !== sha256(rawBytes)) {
      throw Object.assign(new Error('Backup content mismatch'), { code: 'EBACKUPMISMATCH' });
    }
  } catch (err) {
    try {
      fs.rmSync(backupFile, { force: true });
    } catch (cleanupErr) {
      console.warn(`[db] Could not remove incomplete backup ${backupFile}:`, describeDbError(cleanupErr));
    }
    throw err;
  }
}

// In production an unusable database stops the server, unless ALLOW_EMPTY_DB=true accepts an empty start.
function exitIfEmptyStartNotAllowed(reason, backupNote) {
  if (isProduction && process.env.ALLOW_EMPTY_DB !== 'true') {
    exitOnDbLoadFailure('load', `${reason}; ${backupNote}; ALLOW_EMPTY_DB is not set`);
  }
}

// Only for a file that was read but holds no usable data. Backups expire after the retention period:
// see purgeExpiredDbBackups, which never runs on a start like this one.
function preserveCorruptDb(rawBytes, reason) {
  recoveryStartedAt = Date.now();
  let existingHash = null;
  try {
    existingHash = newestDbBackup('.corrupt-')?.hash ?? null;
  } catch (err) {
    console.warn('[db] Could not check existing backups, making a new one:', describeDbError(err));
  }
  if (existingHash === sha256(rawBytes)) {
    exitIfEmptyStartNotAllowed(reason, 'an identical backup already exists');
    console.error(`[db] Failed to load ${DB_FILE} (${reason}), an identical backup already exists, starting empty.`);
    return;
  }

  const backupFile = `${DB_FILE}.corrupt-${Date.now()}`;
  try {
    writeDbBackup(backupFile, rawBytes);
  } catch (err) {
    exitOnDbLoadFailure(`back up (${reason}) to ${backupFile}`, describeDbError(err));
  }
  exitIfEmptyStartNotAllowed(reason, `saved a copy to ${backupFile}`);
  console.error(`[db] Failed to load ${DB_FILE} (${reason}), saved a copy to ${backupFile}, starting empty.`);
}

// Leftovers from a crash mid-write. Failing to remove one is harmless, so it never stops startup.
function removeStaleDbTempFiles() {
  try {
    const prefix = `${path.basename(DB_FILE)}.tmp-`;
    for (const name of listDbSiblings(prefix)) {
      // Exactly what saveDb writes, so no other file with a similar name goes.
      if (!/^\d+-[0-9a-f]{16}$/.test(name.slice(prefix.length))) continue;
      try {
        fs.rmSync(path.join(DATA_DIR, name), { force: true });
      } catch (err) {
        console.warn('[db] Could not remove a stale temp file:', describeDbError(err));
      }
    }
  } catch (err) {
    console.warn('[db] Could not remove stale temp files:', describeDbError(err));
  }
}

// A bare & or a proper prefix of an entity validator.escape emits: what the old length limit left
// behind when it cut one. Anything else, such as the raw text R&D, is not a cut.
const LEGACY_CUT_ENTITY = /&(?:a(?:mp?)?|lt?|gt?|q(?:u(?:ot?)?)?|#(?:x(?:2[7F]?|5C?)?|96?)?)?$/;
// Smart Bar text was stored raw before it was sanitized, so "Rum &" can be real. A cut can only
// happen at the old cap, so only a value of exactly that length is stripped there.
const LEGACY_SMART_BAR_CAPS = { name: 120, quantity: 60, unit: 60 };

const decodeLegacyText = (value) => validator.unescape(value.replace(LEGACY_CUT_ENTITY, ''));

// Anything that is not a string, or a record that is not an object, is left as found.
const decodeLegacyFields = (record, fields) => {
  if (!isPlainObject(record)) return;
  for (const field of fields) {
    if (typeof record[field] === 'string') record[field] = decodeLegacyText(record[field]);
  }
};

function decodeLegacyDbText() {
  for (const user of userIndex.values()) {
    const wasMasked = typeof user.firstName === 'string' && isEmailDerivedName(user);
    decodeLegacyFields(user, ['firstName', 'lastName', 'city', 'bio']);
    // A name the old limit cut no longer equals the prefix once decoded, which would make it public.
    if (wasMasked && !isEmailDerivedName(user)) user.firstName = sanitizeText(user.email.split('@')[0], 120);
  }
  for (const drink of drinks) decodeLegacyFields(drink, ['name', 'description', 'location']);
  for (const list of commentsByDrink.values()) {
    for (const comment of list) decodeLegacyFields(comment, ['content']);
  }
  for (const list of smartBarByUser.values()) {
    for (const item of list) {
      if (!isPlainObject(item)) continue;
      for (const [field, cap] of Object.entries(LEGACY_SMART_BAR_CAPS)) {
        if (typeof item[field] !== 'string') continue;
        item[field] = item[field].length === cap ? decodeLegacyText(item[field]) : validator.unescape(item[field]);
      }
    }
  }
  for (const list of notificationsByUser.values()) {
    for (const notification of list) decodeLegacyFields(notification, ['message']);
  }
}

// Runs once, on a file that loaded. The marker and the decoded text are saved together, so a failed
// save or a crash leaves the old file to migrate again on the next start.
function migrateLegacyDbText(rawBytes) {
  didBackUpDbOnLoad = true;
  // Repeated failed saves would otherwise leave one copy per start. A failed check makes a new backup.
  let existingBackup = null;
  try {
    existingBackup = newestDbBackup('.pre-migration-');
  } catch (err) {
    console.warn('[db] Could not check existing backups, making a new one:', describeDbError(err));
  }
  let backupFile;
  if (existingBackup?.hash === sha256(rawBytes)) {
    backupFile = existingBackup.file;
  } else {
    backupFile = `${DB_FILE}.pre-migration-${Date.now()}`;
    try {
      writeDbBackup(backupFile, rawBytes);
    } catch (err) {
      exitOnDbLoadFailure(`back up (schema migration) to ${backupFile}`, describeDbError(err));
    }
  }
  try {
    decodeLegacyDbText();
  } catch (err) {
    exitOnDbLoadFailure('migrate', describeDbError(err));
  }
  if (saveDb()) {
    console.log(`[db] Migrated to schema version ${DB_SCHEMA_VERSION} (plain text). Previous file saved to ${backupFile}`);
  } else {
    console.error(`[db] Could not save the schema migration. It runs again on the next start. Previous file saved to ${backupFile}`);
  }
}

function loadDb() {
  let dbStats;
  try {
    dbStats = fs.statSync(DB_FILE, { throwIfNoEntry: false });
  } catch (err) {
    exitOnDbLoadFailure('stat', describeDbError(err));
  }
  if (dbStats === undefined) {
    console.log(`[db] No saved state found at ${DB_FILE} — starting with empty database.`);
    recoveryStartedAt = Date.now();
    saveDb();
    return;
  }

  const rawBytes = readDbFileWithRetry();

  let data;
  try {
    data = JSON.parse(rawBytes.toString('utf8'));
  } catch (err) {
    if (err instanceof SyntaxError) {
      preserveCorruptDb(rawBytes, describeDbError(err));
      return;
    }
    exitOnDbLoadFailure('decode', describeDbError(err)); // e.g. larger than the maximum string length
  }

  const shapeProblem = findDbShapeProblem(data);
  if (shapeProblem) {
    preserveCorruptDb(rawBytes, `invalid shape: ${shapeProblem}`);
    return;
  }
  // Set only for a file that is kept: the paths above exit, or start empty and must not stay blocked.
  lastSavedDbBytes = rawBytes.length;

  try {
    // Restore counters
    if (typeof data.nextDrinkId      === 'number') nextDrinkId      = data.nextDrinkId;
    if (typeof data.nextNotificationId === 'number') nextNotificationId = data.nextNotificationId;
    if (typeof data.nextCommentId    === 'number') nextCommentId    = data.nextCommentId;
    if (typeof data.nextReportId     === 'number') nextReportId     = data.nextReportId;

    // Restore drinks (a loop, because spreading a large array throws RangeError)
    if (data.drinks) {
      for (const drink of data.drinks) drinks.push(drink);
    }

    // Restore users
    if (data.users) {
      for (const u of data.users) {
        userIndex.set(u.id, u);
        rememberAvatarHash(u);
      }
    }
    // Restore Sets: cheersByUser
    if (data.cheersByUser) {
      for (const [k, v] of Object.entries(data.cheersByUser)) {
        cheersByUser.set(k, new Set(v));
      }
    }

    // Restore Sets: savedByUser
    if (data.savedByUser) {
      for (const [k, v] of Object.entries(data.savedByUser)) {
        savedByUser.set(k, new Set(v));
      }
    }

    // Restore smartBarByUser
    if (data.smartBarByUser) {
      for (const [k, v] of Object.entries(data.smartBarByUser)) {
        smartBarByUser.set(k, v);
      }
    }

    // Restore Sets: partnersByUser
    if (data.partnersByUser) {
      for (const [k, v] of Object.entries(data.partnersByUser)) {
        partnersByUser.set(k, new Set(v));
      }
      // Logged-out requests used to save an entry under the key "null"; drop it on the next save.
      partnersByUser.delete('null');
    }

    // Restore notificationsByUser
    if (data.notificationsByUser) {
      for (const [k, v] of Object.entries(data.notificationsByUser)) {
        notificationsByUser.set(k, v);
      }
    }

    // Restore commentsByDrink (keys are strings in JSON, need number)
    if (data.commentsByDrink) {
      const drinkIds = new Set(drinks.map((drink) => drink.id));
      for (const [k, v] of Object.entries(data.commentsByDrink)) {
        const drinkId = Number(k);
        // Logged-out reads used to save empty lists for ids with no drink, such as NaN.
        if (v.length === 0 && !drinkIds.has(drinkId)) continue;
        if (!Number.isFinite(drinkId)) {
          // Unreachable by any route, but comments are never dropped: keep them under the original key.
          console.warn(`[db] Keeping ${v.length} comment(s) saved under a non-numeric drink id.`);
          commentsByDrink.set(k, v);
          continue;
        }
        commentsByDrink.set(drinkId, v);
      }
    }

    // A counter behind the stored records would reuse an id, so it moves ahead of them.
    for (const drink of drinks) {
      if (Number.isSafeInteger(drink.id) && drink.id >= nextDrinkId) nextDrinkId = drink.id + 1;
    }
    for (const comments of commentsByDrink.values()) {
      for (const comment of comments) {
        if (Number.isSafeInteger(comment?.id) && comment.id >= nextCommentId) nextCommentId = comment.id + 1;
      }
    }

    // Restore limitEventsByUser. Only a file from before this key is seeded, once: a key with no
    // entries means nothing happened in the window, and seeding it would bring back deleted content.
    if (data.limitEventsByUser) {
      for (const [k, v] of Object.entries(data.limitEventsByUser)) {
        limitEventsByUser.set(k, v);
        pruneLimitEvents(k);
      }
    } else {
      seedLimitEvents();
    }

    // Restore reports. The counter stays ahead of them even if its key is missing.
    if (data.reports) {
      for (const report of data.reports) {
        reports.push(report);
        if (report.id >= nextReportId) nextReportId = report.id + 1;
      }
      pruneResolvedReporters();
    }

    // Restore Sets: blocksByUser
    if (data.blocksByUser) {
      for (const [k, v] of Object.entries(data.blocksByUser)) {
        blocksByUser.set(k, new Set(v));
      }
    }

    // Restore partnerRequestsByUser. A malformed or expired entry, or one for a user who no longer exists, is left out.
    if (data.partnerRequestsByUser) {
      for (const [k, v] of Object.entries(data.partnerRequestsByUser)) {
        const kept = v.filter((request) => (
          isPlainObject(request) && !isPartnerRequestExpired(request) && userIndex.has(request.fromId)
        ));
        if (kept.length > 0 && userIndex.has(k)) partnerRequestsByUser.set(k, kept);
      }
    }

    // Restore pendingAccountDeletions. Finished before the server starts listening: see resumePendingAccountDeletions.
    if (data.pendingAccountDeletions) {
      for (const { uid, until } of data.pendingAccountDeletions) {
        if (typeof uid === 'string' && uid && !pendingAccountDeletions.some((entry) => entry.uid === uid)) {
          // An unusable until counts as unfinished, the safe side. One too far ahead cannot outlast the retention.
          pendingAccountDeletions.push(Number.isFinite(until) ? { uid, until: Math.min(until, Date.now() + ACCOUNT_TOMBSTONE_MS) } : { uid });
        }
      }
    }

    // A value ahead of the clock would hold the purge for longer than it should.
    if (typeof data.recoveryStartedAt === 'number') recoveryStartedAt = Math.min(data.recoveryStartedAt, Date.now());
  } catch (err) {
    exitOnDbLoadFailure('restore', describeDbError(err));
  }

  if (!(data.dbSchemaVersion >= DB_SCHEMA_VERSION)) {
    migrateLegacyDbText(rawBytes);
  } else {
    dbSchemaVersion = data.dbSchemaVersion; // a newer version is kept as found
  }

  // Empty, so backups may be all that is left. Saved now, so the 7-day hold counts from here across restarts.
  if (userIndex.size === 0 && recoveryStartedAt === undefined) {
    recoveryStartedAt = Date.now();
    saveDb();
  }

  console.log(
    `[db] Loaded — ${drinks.length} drinks, ${userIndex.size} users.`
  );
  isDbLoaded = true;
  removeStaleDbTempFiles();
}

// ── Collection helpers ────────────────────────────────────────────────────────
const ensurePartnerSet = (userId) => {
  if (!partnersByUser.has(userId)) {
    partnersByUser.set(userId, new Set());
  }
  return partnersByUser.get(userId);
};

const ensureNotifications = (userId) => {
  if (!notificationsByUser.has(userId)) {
    notificationsByUser.set(userId, []);
  }
  return notificationsByUser.get(userId);
};

const NOTIFICATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const cleanupNotifications = (userId) => {
  const list = ensureNotifications(userId);
  const now = Date.now();
  const filtered = list.filter(
    (item) => now - new Date(item.createdAt).getTime() <= NOTIFICATION_MAX_AGE_MS
  );
  if (filtered.length !== list.length) {
    notificationsByUser.set(userId, filtered);
  }
  return filtered;
};

const NOTIFICATIONS_MAX_PER_USER = 200;

// drinkId is for notifications whose text names a post: see toVisibleNotification.
// actorId is who caused it, stored so a later block can hide it on read.
const pushNotification = (targetUserId, actorId, type, message, drinkId) => {
  if (!userIndex.has(targetUserId) || isDbGrowthBlocked() || isBlockedBetween(targetUserId, actorId)) return;
  const list = ensureNotifications(targetUserId);
  list.unshift({
    id: nextNotificationId++,
    type,
    message,
    actorId,
    ...(drinkId !== undefined && { drinkId }),
    read: false,
    createdAt: new Date().toISOString(),
  });
  if (list.length > NOTIFICATIONS_MAX_PER_USER) list.length = NOTIFICATIONS_MAX_PER_USER;
  notificationsByUser.set(targetUserId, list);
};

const ensureSmartBar = (userId) => {
  if (!smartBarByUser.has(userId)) {
    smartBarByUser.set(userId, []);
  }
  return smartBarByUser.get(userId);
};

const ensureComments = (drinkId) => {
  if (!commentsByDrink.has(drinkId)) {
    commentsByDrink.set(drinkId, []);
  }
  return commentsByDrink.get(drinkId);
};

// The raw and sanitized forms of the email prefix are compared, plus the legacy forms.
const matchesEmailPrefix = (firstName, localPart) => {
  const name = firstName.toLowerCase();
  // The last form is a name saved HTML-escaped, with its control characters, by older versions.
  return name === localPart.toLowerCase()
    || name === sanitizeText(localPart, 120).toLowerCase()
    || name === validator.escape(localPart).slice(0, 120).toLowerCase();
};

// Older accounts have a firstName built from their email prefix.
// nameSetByUser: the owner or the sign-in provider chose this name, so it is public even when it equals the prefix.
const isEmailDerivedName = (user) => {
  if (user.nameSetByUser || !user.firstName || typeof user.email !== 'string') return false;
  return matchesEmailPrefix(user.firstName, user.email.split('@')[0]);
};

const isOlderIdToken = (user, tokenIat) => Number.isFinite(tokenIat) && Number.isFinite(user.lastIdTokenIat) && tokenIat < user.lastIdTokenIat;

// A user with no usable name gets an empty one: the email must never become a public name.
// providerName comes from the verified token, so it is trusted even when it equals the email prefix.
// displayName comes from the request body, so a value equal to the prefix is refused. Anything with an @ is refused from both.
// A name is only set here, on creation: later sign-ins never refill it, so a cleared name stays cleared.
// emailFromToken: the address comes from a verified Firebase token, so it replaces any stored value.
// The token is verified, but the address itself may be unconfirmed; emailVerified records that.
// emailVerified is undefined outside Firebase mode. An unverified sign-in reaches this only with REQUIRE_VERIFIED_EMAIL off.
// tokenIat: a token older than the last one accepted cannot change the email or emailVerified.
const registerUserIfNeeded = ({ id, email, emailFromToken = false, emailVerified, tokenIat, providerName, displayName, photoURL }) => {
  if (!id) return;
  const normalizedEmail = email || `${id}@drinkme.app`;
  if (!userIndex.has(id)) {
    const name = (providerName || displayName || '').trim();
    const firstWord = name.split(/\s+/)[0];
    const emailPrefix = normalizedEmail.split('@')[0];
    const isPrefixName = matchesEmailPrefix(name, emailPrefix) || matchesEmailPrefix(firstWord, emailPrefix);
    const isUsableName = !name.includes('@') && (Boolean(providerName) || !isPrefixName);
    const nameParts = (isUsableName ? name : '').split(/\s+/);
    userIndex.set(id, {
      id,
      email: normalizedEmail,
      firstName: nameParts[0],
      lastName:  nameParts.slice(1).join(' '),
      city: '',
      bio:  '',
      avatar: photoURL || null,
      ...(emailVerified !== undefined && { emailVerified }),
      ...(Number.isFinite(tokenIat) && { lastIdTokenIat: tokenIat }),
      ...(nameParts[0] && { nameSetByUser: true }),
      // Cleared by the privacy acknowledgement. Accounts from before the notice never get it.
      noticePending: true,
    });
  } else {
    const existing = userIndex.get(id);
    // Never replace an existing avatar: the client sends the Google photo on every app launch.
    if (photoURL && !existing.avatar && !existing.avatarClearedByAdmin) existing.avatar = photoURL;
    if (!isOlderIdToken(existing, tokenIat)) {
      if (emailFromToken && email && existing.email !== email) {
        // Compared against the old address, so a changed email cannot unmask the old prefix.
        if (isEmailDerivedName(existing)) existing.firstName = '';
        existing.email = email;
      }
      if (emailVerified !== undefined) existing.emailVerified = emailVerified;
      if (Number.isFinite(tokenIat)) existing.lastIdTokenIat = tokenIat;
    }
    if (!existing.email) existing.email  = normalizedEmail;
  }
  ensurePartnerSet(id);
  ensureSmartBar(id);
};

// ── Image validation ──────────────────────────────────────────────────────────
const POST_IMAGE_RULES = {
  allowedTypes: new Set(['jpeg', 'png', 'webp', 'heic']),
  maxBytes: POST_IMAGE_MAX_BYTES,
  typeError: 'Invalid image format. Use JPEG, PNG, WebP or HEIC.',
};
const AVATAR_IMAGE_RULES = {
  allowedTypes: new Set(['jpeg', 'png', 'webp']),
  maxBytes: AVATAR_MAX_BYTES,
  typeError: 'Invalid image format. Use JPEG, PNG or WebP.',
};

// No HEIC: the OpenAI image input accepts PNG, JPEG, WebP and non-animated GIF only.
const AI_IMAGE_RULES = {
  allowedTypes: new Set(['jpeg', 'png', 'webp']),
  maxBytes: POST_IMAGE_MAX_BYTES,
  typeError: 'Invalid image format. Use JPEG, PNG or WebP.',
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);
const FTYP_MIN_BOX_BYTES = 16; // size, 'ftyp', major brand, minor version
const DATA_URL_IMAGE_PREFIX = /^data:image\/[a-z0-9.+-]+;base64,/;
// expo-image-picker sends unwrapped base64 on iOS and Android, so whitespace is never valid here.
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

// Checks the signature only, so a valid signature followed by other content still passes.
const detectImageType = (bytes) => {
  const tagAt = (offset) => bytes.toString('latin1', offset, offset + 4);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'png';
  if (tagAt(0) === 'RIFF' && tagAt(8) === 'WEBP') return 'webp';
  if (tagAt(4) === 'ftyp' && HEIC_BRANDS.has(tagAt(8))) {
    const boxBytes = bytes.readUInt32BE(0);
    if (boxBytes >= FTYP_MIN_BOX_BYTES && boxBytes <= bytes.length) return 'heic';
  }
  return null;
};

/**
 * Returns { dataUrl } with the type taken from the bytes, or { status, error }.
 * The type the client declared (MIME, prefix or filename) is never used.
 */
const validateImageBytes = (bytes, { allowedTypes, maxBytes, typeError }) => {
  if (bytes.length > maxBytes) return { status: 413, error: 'Image too large' };
  const type = detectImageType(bytes);
  if (!allowedTypes.has(type)) return { status: 400, error: typeError };
  return { dataUrl: toDataUrl(bytes, `image/${type}`) };
};

// imageData is raw base64 (expo-image-picker) or a data:image/...;base64, URL.
const validateImage = (imageData, rules) => {
  if (typeof imageData !== 'string') return { status: 400, error: rules.typeError };
  const base64 = imageData.replace(DATA_URL_IMAGE_PREFIX, '');
  if (base64.length % 4 !== 0 || !BASE64_PATTERN.test(base64)) {
    return { status: 400, error: rules.typeError };
  }
  return validateImageBytes(Buffer.from(base64, 'base64'), rules);
};

// ── Image storage limits ──────────────────────────────────────────────────────
const DEFAULT_IMAGE_STORAGE_MAX_BYTES = 200 * 1024 * 1024;
const USER_IMAGE_QUOTA_MAX_BYTES = 100 * 1024 * 1024;
const IMAGE_STORAGE_WARNING_RATIO = 0.8;
const POST_LIMIT_WINDOW_MS       = 24 * 60 * 60 * 1000;
const POST_LIMIT_MAX_COUNT       = 20;
const POST_LIMIT_MAX_IMAGE_BYTES = 50 * 1024 * 1024;

// Overrides exist only so tests can use a small value. Invalid values are ignored.
const parseTestOnlyLimit = (rawValue, defaultValue) => {
  const value = Number(rawValue);
  const isValid = process.env.NODE_ENV === 'test' && /^\d+$/.test(rawValue ?? '') && Number.isSafeInteger(value) && value > 0;
  return isValid ? value : defaultValue;
};
const IMAGE_STORAGE_MAX_BYTES = parseTestOnlyLimit(process.env.IMAGE_STORAGE_MAX_BYTES, DEFAULT_IMAGE_STORAGE_MAX_BYTES);

// Loading decodes the file into one string, which fails above about 536.87 million UTF-8 bytes (512 MiB) even
// when it holds far fewer characters. Stopping growth below that, in bytes, keeps the server able
// to restart, and keeps saves working for the routes that stay open.
const DEFAULT_DB_GROWTH_MAX_BYTES = 450_000_000;
const DB_GROWTH_MAX_BYTES = parseTestOnlyLimit(process.env.DB_GROWTH_MAX_BYTES, DEFAULT_DB_GROWTH_MAX_BYTES);
const isDbGrowthBlocked = () => lastSavedDbBytes > DB_GROWTH_MAX_BYTES;
const respondDbGrowthBlocked = (res) => res.status(507).json({
  error: 'Storage is full. Please try again later.',
  code: 'storage_full',
});

// Provider photo URLs are not stored images, so they do not count.
const storedImageBytes = (value) => (typeof value === 'string' && value.startsWith('data:') ? value.length : 0);

let imageStorageWarningLogged = false; // once per process, so a full disk does not flood the logs

// replacedImage is freed by the same change, so it does not count against the new total.
const wouldExceedImageStorage = (newImage, replacedImage = null) => {
  let total = newImage.length - storedImageBytes(replacedImage);
  for (const drink of drinks) total += storedImageBytes(drink.imageUrl);
  for (const user of userIndex.values()) total += storedImageBytes(user.avatar);
  if (!imageStorageWarningLogged && total > IMAGE_STORAGE_MAX_BYTES * IMAGE_STORAGE_WARNING_RATIO) {
    imageStorageWarningLogged = true;
    console.warn(`[storage] Stored images passed ${IMAGE_STORAGE_WARNING_RATIO * 100}% of the limit.`);
  }
  return total > IMAGE_STORAGE_MAX_BYTES;
};

// Lifetime total for one user. replacedImage is that user's current avatar, which is credited.
const wouldExceedUserImageQuota = (userId, newImage, replacedImage = null) => {
  let total = newImage.length - storedImageBytes(replacedImage) + storedImageBytes(userIndex.get(userId)?.avatar);
  for (const drink of drinks) {
    if (drink.userId === userId) total += storedImageBytes(drink.imageUrl);
  }
  return total > USER_IMAGE_QUOTA_MAX_BYTES;
};
const respondUserImageQuota = (res) => res.status(507).json({
  error: 'You have reached your photo storage limit.',
  code: 'user_image_quota',
});

const COMMENT_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const COMMENT_LIMIT_MAX_COUNT = 200;
const PARTNER_REQUEST_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const PARTNER_REQUEST_LIMIT_MAX_COUNT = 100;

// One entry per post, comment or partner request created: { kind, at, imageBytes? }. The daily limits read only these,
// never the content, so deleting a post gives none of them back. The lifetime quota and global storage
// above stay derived from stored images, which a deletion does free.
const LIMIT_EVENT_MAX_AGE_MS = Math.max(POST_LIMIT_WINDOW_MS, COMMENT_LIMIT_WINDOW_MS, PARTNER_REQUEST_LIMIT_WINDOW_MS);

// Anything unusable, including an entry that is not an object, gives NaN: never counted, and pruned.
const limitEventTime = (event) => new Date(event?.at).getTime();

const limitEventsWithin = (userId, kind, windowMs) => {
  const windowStart = Date.now() - windowMs;
  return (limitEventsByUser.get(userId) ?? []).filter((event) => event?.kind === kind && limitEventTime(event) > windowStart);
};

// Only removes: a user left with nothing loses the key, and a user with no key does not gain one.
const pruneLimitEvents = (userId) => {
  const events = limitEventsByUser.get(userId);
  if (!events) return;
  const windowStart = Date.now() - LIMIT_EVENT_MAX_AGE_MS;
  const kept = events.filter((event) => limitEventTime(event) > windowStart);
  if (kept.length > 0) limitEventsByUser.set(userId, kept);
  else limitEventsByUser.delete(userId);
};

const recordLimitEvent = (userId, event) => {
  pruneLimitEvents(userId);
  const events = limitEventsByUser.get(userId) ?? [];
  events.push(event);
  limitEventsByUser.set(userId, events);
  return event;
};

// For the rollback of a create whose save failed.
const removeLimitEvent = (userId, event) => {
  const remaining = (limitEventsByUser.get(userId) ?? []).filter((item) => item !== event);
  if (remaining.length > 0) limitEventsByUser.set(userId, remaining);
  else limitEventsByUser.delete(userId);
};

// A file from before limitEventsByUser: what happened inside the window is rebuilt from the content.
// Saved with the next write. Until then nothing can have been deleted, so a restart rebuilds the same.
const seedLimitEvents = () => {
  const addIfRecent = (userId, event) => {
    if (typeof userId !== 'string' || !(limitEventTime(event) > Date.now() - LIMIT_EVENT_MAX_AGE_MS)) return;
    recordLimitEvent(userId, event);
  };
  for (const drink of drinks) {
    addIfRecent(drink.userId, {
      kind: 'post',
      at: drink.createdAt,
      imageBytes: typeof drink.imageUrl === 'string' ? drink.imageUrl.length : 0,
    });
  }
  for (const comments of commentsByDrink.values()) {
    for (const comment of comments) {
      if (isPlainObject(comment)) addIfRecent(comment.userId, { kind: 'comment', at: comment.createdAt });
    }
  }
};

const hasReachedCommentLimit = (userId) => (
  limitEventsWithin(userId, 'comment', COMMENT_LIMIT_WINDOW_MS).length >= COMMENT_LIMIT_MAX_COUNT
);

const wouldExceedPostLimit = (userId, newImage) => {
  const events = limitEventsWithin(userId, 'post', POST_LIMIT_WINDOW_MS);
  let imageBytes = newImage.length;
  for (const event of events) {
    if (Number.isFinite(event.imageBytes) && event.imageBytes > 0) imageBytes += event.imageBytes;
  }
  return events.length + 1 > POST_LIMIT_MAX_COUNT || imageBytes > POST_LIMIT_MAX_IMAGE_BYTES;
};

const respondImageStorageFull = (res) => res.status(507).json({
  error: 'Image storage is full. Please try again later.',
  code: 'image_storage_full',
});

// ── Image delivery ────────────────────────────────────────────────────────────
// The stored record always keeps the data URL, which the limits above and saveDb read. These helpers
// only build what a response shows, so a /media URL can never reach the database.
// image/jpg: older versions stored that prefix as sent. The bytes still decide the type served.
const MEDIA_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic']);
const STORED_IMAGE_PREFIX = /^data:([a-z0-9.+/-]+);base64,/;
const AVATAR_HASH_LENGTH = 12;

// Older versions stored the declared type, so the type sent to clients comes from the bytes too.
const decodeStoredImage = (value) => {
  if (typeof value !== 'string') return null;
  const prefix = STORED_IMAGE_PREFIX.exec(value);
  if (!prefix || !MEDIA_MIME_TYPES.has(prefix[1])) return null;
  const base64 = value.slice(prefix[0].length);
  if (base64.length % 4 !== 0 || !BASE64_PATTERN.test(base64)) return null;
  const bytes = Buffer.from(base64, 'base64');
  const mime = `image/${detectImageType(bytes)}`;
  return MEDIA_MIME_TYPES.has(mime) ? { bytes, mime } : null;
};

// Decoding a 7 MB image takes long enough that a burst of requests would stall the server, so the
// decoded bytes and their ETag are kept. Least recently used goes first; a Map keeps insertion order.
const DEFAULT_MEDIA_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const MEDIA_CACHE_MAX_BYTES = parseTestOnlyLimit(process.env.MEDIA_CACHE_MAX_BYTES, DEFAULT_MEDIA_CACHE_MAX_BYTES);
const MEDIA_CACHE_UNUSABLE_ENTRY_BYTES = 1024; // a value that fails to decode is remembered too
const MEDIA_ETAG_HASH_LENGTH = 32;
const mediaCache = new Map();
let mediaCacheBytes = 0;

const dropFromMediaCache = (key, entry) => {
  mediaCache.delete(key);
  mediaCacheBytes -= entry.bytes;
};

// An entry counts only for the exact stored value it came from, so a replaced image is never served.
const getDecodedImage = (key, storedValue) => {
  if (typeof storedValue !== 'string') return { image: null, wasCached: false };
  const cached = mediaCache.get(key);
  if (cached) {
    dropFromMediaCache(key, cached);
    if (cached.storedValue === storedValue) {
      mediaCache.set(key, cached);
      mediaCacheBytes += cached.bytes;
      return { image: cached.image, wasCached: true };
    }
  }
  const decoded = decodeStoredImage(storedValue);
  const image = decoded && { ...decoded, etag: `"${sha256(decoded.bytes).slice(0, MEDIA_ETAG_HASH_LENGTH)}"` };
  const bytes = image ? image.bytes.length : MEDIA_CACHE_UNUSABLE_ENTRY_BYTES;
  if (bytes <= MEDIA_CACHE_MAX_BYTES) {
    mediaCache.set(key, { storedValue, image, bytes });
    mediaCacheBytes += bytes;
    for (const [oldestKey, oldest] of mediaCache) {
      if (mediaCacheBytes <= MEDIA_CACHE_MAX_BYTES) break;
      dropFromMediaCache(oldestKey, oldest);
    }
  }
  return { image, wasCached: false };
};

// A stored image of a type /media never serves, such as an old SVG avatar, shows as no image.
const isServableImage = (value) => (
  typeof value === 'string' && MEDIA_MIME_TYPES.has(STORED_IMAGE_PREFIX.exec(value)?.[1])
);

// An entry counts only for the exact avatar it was made from, so a rollback or a provider photo
// cannot leave a stale hash behind: the next read recomputes it. Same string, so === is immediate.
const rememberAvatarHash = (user) => {
  if (!isServableImage(user.avatar)) {
    avatarHashByUser.delete(user.id);
    return undefined;
  }
  const hash = sha256(user.avatar).slice(0, AVATAR_HASH_LENGTH);
  avatarHashByUser.set(user.id, { avatar: user.avatar, hash });
  return hash;
};

const getAvatarHash = (user) => {
  const known = avatarHashByUser.get(user.id);
  return known?.avatar === user.avatar ? known.hash : rememberAvatarHash(user);
};

// Checked on output too: an older database can hold a photo URL on any https host.
const toAvatarUrl = (user) => (
  isServableImage(user.avatar)
    ? `/media/avatars/${encodeURIComponent(user.id)}?v=${getAvatarHash(user)}`
    : sanitizePhotoURL(user.avatar) ?? null
);

const toDrinkImageUrl = (drink) => (isServableImage(drink.imageUrl) ? `/media/drinks/${drink.id}` : null);

// ── Bounded lists ─────────────────────────────────────────────────────────────
const PAGE_DEFAULT_LIMIT = 20;
const PAGE_MAX_LIMIT = 50;
const TRENDING_MAX_ITEMS = 20;
const SEARCH_TEXT_MAX_LENGTH = 100;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d{0,15}$/;

// Digits only: Number() alone would accept 1e3, 0x10 and 1.0, and a repeated query key is an array.
const parsePositiveInteger = (value) => (
  typeof value === 'string' && POSITIVE_INTEGER_PATTERN.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : null
);

// Returns { limit, before }, or null if either value is invalid.
const parsePageParams = (query) => {
  const limit = query.limit === undefined ? PAGE_DEFAULT_LIMIT : parsePositiveInteger(query.limit);
  const before = query.before === undefined ? undefined : parsePositiveInteger(query.before);
  if (limit === null || limit > PAGE_MAX_LIMIT || before === null) return null;
  return { limit, before };
};

const respondInvalidPage = (res) => res.status(400).json({ error: 'Invalid limit or before' });

// Newest id first, and `before` is exclusive, so a new record cannot shift later pages.
const paginateById = (records, { limit, before }) => {
  const matching = before === undefined ? [...records] : records.filter((record) => record.id < before);
  matching.sort((a, b) => b.id - a.id);
  const items = matching.slice(0, limit);
  return { items, nextCursor: matching.length > limit ? items[items.length - 1].id : null };
};

// Lowercased for a plain substring match, never a pattern. Returns null for a non-string such as
// a repeated query key, and '' when absent.
const parseSearchText = (value) => {
  if (value === undefined) return '';
  if (typeof value !== 'string') return null;
  return value.trim().slice(0, SEARCH_TEXT_MAX_LENGTH).toLowerCase();
};

const textIncludes = (value, lowercasedText) => typeof value === 'string' && value.toLowerCase().includes(lowercasedText);

// ── Blocks ────────────────────────────────────────────────────────────────────
// A block works in both directions. Every read needs a signed-in, confirmed viewer (requireSignedInAdult).
const hasBlocked = (blockerId, targetId) => blocksByUser.get(blockerId)?.has(targetId) === true;
const isBlockedBetween = (firstId, secondId) => (
  Boolean(firstId && secondId) && (hasBlocked(firstId, secondId) || hasBlocked(secondId, firstId))
);

// ── Partner requests ──────────────────────────────────────────────────────────
// Read once at start. Off only for exactly 'false': POST then links both sides at once. The partner
// list stays restricted either way.
const PARTNER_CONSENT_REQUIRED = process.env.PARTNER_CONSENT_REQUIRED !== 'false';
const PARTNER_REQUESTS_MAX_OUTGOING = 50;
const PARTNER_REQUEST_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

// An emergency rollback: with consent off anyone can add themselves, which opens the private list to them.
if (!PARTNER_CONSENT_REQUIRED && isProduction) {
  console.warn('[partners] PARTNER_CONSENT_REQUIRED=false is an emergency rollback: anyone can add themselves as a partner and read a private partner list.');
}

// An unusable date gives NaN, which counts as expired.
const isPartnerRequestExpired = ({ createdAt }) => !(Date.now() - new Date(createdAt).getTime() < PARTNER_REQUEST_MAX_AGE_MS);

// What is pending for a target. Expired entries leave memory here, and the file with the next save.
const getPendingPartnerRequests = (targetId) => {
  const list = partnerRequestsByUser.get(targetId);
  if (!list) return [];
  const pending = list.filter((request) => !isPartnerRequestExpired(request));
  if (pending.length === list.length) return list;
  if (pending.length > 0) partnerRequestsByUser.set(targetId, pending);
  else partnerRequestsByUser.delete(targetId);
  return pending;
};

const hasPartnerRequest = (fromId, targetId) => (
  getPendingPartnerRequests(targetId).some((request) => request.fromId === fromId)
);

// Lists and partner Sets are replaced, never changed in place, so a failed save can put the old ones back.
const removePartnerRequest = (fromId, targetId) => {
  const remaining = getPendingPartnerRequests(targetId).filter((request) => request.fromId !== fromId);
  if (remaining.length > 0) partnerRequestsByUser.set(targetId, remaining);
  else partnerRequestsByUser.delete(targetId);
};

const addPartnerLink = (userId, otherId) => {
  partnersByUser.set(userId, new Set(partnersByUser.get(userId)).add(otherId));
};
const removePartnerLink = (userId, otherId) => {
  partnersByUser.set(userId, new Set(Array.from(partnersByUser.get(userId) ?? []).filter((id) => id !== otherId)));
};

const clearPartnerRequestsBetween = (firstId, secondId) => {
  removePartnerRequest(firstId, secondId);
  removePartnerRequest(secondId, firstId);
};

const linkPartners = (firstId, secondId) => {
  addPartnerLink(firstId, secondId);
  addPartnerLink(secondId, firstId);
  clearPartnerRequestsBetween(firstId, secondId);
};

const unlinkPartners = (firstId, secondId) => {
  removePartnerLink(firstId, secondId);
  removePartnerLink(secondId, firstId);
  clearPartnerRequestsBetween(firstId, secondId);
};

// Returns a function that puts back the pair's partners, requests and notifications, for a save that fails.
const snapshotPartnerPair = (firstId, secondId) => {
  const previous = [firstId, secondId].map((id) => ({
    id,
    partners: partnersByUser.get(id),
    requests: partnerRequestsByUser.get(id),
    notifications: notificationsByUser.has(id) ? [...notificationsByUser.get(id)] : undefined,
  }));
  const previousNotificationId = nextNotificationId;
  return () => {
    const restore = (map, id, value) => (value === undefined ? map.delete(id) : map.set(id, value));
    for (const { id, partners, requests, notifications } of previous) {
      restore(partnersByUser, id, partners);
      restore(partnerRequestsByUser, id, requests);
      restore(notificationsByUser, id, notifications);
    }
    nextNotificationId = previousNotificationId;
  };
};

// How the viewer stands with another user. Only ever about the viewer, so nothing shows a third party's requests.
const getPartnerStatus = (viewerId, otherId) => {
  if (partnersByUser.get(viewerId)?.has(otherId)) return 'partner';
  if (hasPartnerRequest(viewerId, otherId)) return 'requested';
  if (hasPartnerRequest(otherId, viewerId)) return 'incoming';
  return 'none';
};

// Requests with a user who no longer exists, or across a block, are never shown or counted.
const isLivePartnerRequest = (firstId, secondId) => (
  isLiveAccount(firstId) && isLiveAccount(secondId) && !isBlockedBetween(firstId, secondId)
);

const getIncomingPartnerRequests = (userId) => getPendingPartnerRequests(userId)
  .filter(({ fromId }) => isLivePartnerRequest(fromId, userId))
  .map(({ fromId, createdAt }) => ({ otherId: fromId, createdAt }));

const getOutgoingPartnerRequests = (userId) => {
  const outgoing = [];
  for (const targetId of Array.from(partnerRequestsByUser.keys())) {
    const request = getPendingPartnerRequests(targetId).find(({ fromId }) => fromId === userId);
    if (request && isLivePartnerRequest(userId, targetId)) outgoing.push({ otherId: targetId, createdAt: request.createdAt });
  }
  return outgoing;
};

const isListedPartner = (ownerId, viewerId) => partnersByUser.get(ownerId)?.has(viewerId) === true;

// The partners of ownerId that viewerId may see, which is also what partnerCount counts.
const getVisiblePartnerIds = (ownerId, viewerId) => Array.from(partnersByUser.get(ownerId) ?? [])
  .filter((id) => isLiveAccount(id) && !isBlockedBetween(viewerId, id));

// An ID token lives up to an hour, so this is as long as one issued before the deletion can come back.
// Retention: only the uid, for 1 hour after the deletion finished, and gone within one retry interval after that.
const ACCOUNT_TOMBSTONE_MS = parseTestOnlyLimit(process.env.ACCOUNT_TOMBSTONE_MS, 60 * 60 * 1000);

// ── Report retention ──────────────────────────────────────────────────────────
const RESOLVED_REPORTER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// A resolved report keeps who filed it for this long, and its details not at all. Runs at load and on
// resolve; what load drops reaches the file with the next save.
const pruneResolvedReporters = () => {
  const cutoff = Date.now() - RESOLVED_REPORTER_RETENTION_MS;
  for (const report of reports) {
    if (report.status === 'resolved' && 'reporterId' in report && new Date(report.resolvedAt).getTime() <= cutoff) {
      delete report.reporterId;
    }
  }
};

// ── Load persisted state on startup ──────────────────────────────────────────
loadDb();

// ── Auth helpers ──────────────────────────────────────────────────────────────
// False once a deletion was accepted, even if a failed cascade left the record in place.
const isLiveAccount = (uid) => userIndex.has(uid) && !isAccountDeletionPending(uid);

// Firebase mode only: dev mode has nothing that could ever confirm an address.
const isEmailVerificationMissing = (uid, payload) => (
  REQUIRE_VERIFIED_EMAIL && Boolean(firebaseAuth) && (payload.ev !== true || userIndex.get(uid)?.emailVerified === false)
);

// A JWT from an earlier session generation was logged out by a later verified sign-in (see the sign-in route).
const getSessionGen = (user) => (Number.isSafeInteger(user?.sessionGen) && user.sessionGen > 0 ? user.sessionGen : 0);
const isCurrentSessionGen = (uid, payload) => (payload.sg ?? 0) === getSessionGen(userIndex.get(uid));

/**
 * Extrage userId din JWT-ul Bearer. Returnează null dacă tokenul lipsește sau e invalid.
 * Nu mai există fallback la user_demo — fiecare request neautentificat primește null.
 */
const getUserId = (req) => {
  const header = req.headers.authorization || '';
  const match  = header.match(/Bearer\s+(.+)/i);
  if (!match) return null;
  try {
    const payload = verifyApiToken(match[1]);
    // A token can outlive its user (lost database, deleted account). Signing in again recreates the user.
    return payload.uid && isLiveAccount(payload.uid) && isCurrentSessionGen(payload.uid, payload) && !isEmailVerificationMissing(payload.uid, payload) ? payload.uid : null;
  } catch {
    return null;
  }
};

/**
 * Middleware: blochează request-ul cu 401 dacă tokenul lipsește sau e invalid.
 * Stochează userId în req.userId pentru rutele downstream.
 */
const requireAuth = (req, res, next) => {
  // Already checked by requireSignedInAdult for every /api route, in the same request.
  const userId = req.userId ?? getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Authentication required' });
  req.userId = userId;
  next();
};

// ── Age gate ──────────────────────────────────────────────────────────────────
// A self-declaration. Only the time of the answer is stored, never a birth date.
const isAgeConfirmed = (userId) => {
  const confirmedAt = userId ? userIndex.get(userId)?.ageConfirmedAt : undefined;
  return typeof confirmedAt === 'string' && confirmedAt !== '';
};

// A post with no flag counts as alcoholic. Applies to the owner too, and a logged-out viewer is unconfirmed.
// requireSignedInAdult already refuses unconfirmed and logged-out viewers on every route; this stays as
// defence in depth, and for blocks, which still matter per post.
const isAlcoholicDrink = (drink) => drink.isAlcoholic !== false;
const canViewDrink = (drink, viewerId) => (
  !isBlockedBetween(drink.userId, viewerId) && (!isAlcoholicDrink(drink) || isAgeConfirmed(viewerId))
);

const respondAgeRequired = (res) => res.status(403).json({
  error: 'Confirm your age to see this post.',
  code: 'age_required',
});

// ── Sign-in and age gate for every route ─────────────────────────────────────
// Owner decision: nothing is readable without signing in, and a signed-in user who has not confirmed
// they are 18+ can only do what the first-run flow needs (AgeGate, privacy notice, name prompt) and
// leave. Mounted on /api and /media before every route and body parser, as a function declaration so
// the /media mount near the top can use it. Paths are matched without case and with an optional
// trailing slash, like Express matches the routes. The rules only ever let a request through, so a
// path spelled in a way they miss gets the full gate, never less.
const SIGNED_OUT_ROUTES = [
  ['POST', /^\/api\/auth\/mobile\/?$/i],
  // Takes a fresh Firebase ID token instead of a JWT, and exists only with REQUIRE_VERIFIED_EMAIL on.
  ['POST', /^\/api\/account\/delete-unverified\/?$/i],
];
// Each names the caller's own account. The routes check ownership again.
const UNCONFIRMED_OWN_ACCOUNT_ROUTES = [
  ['GET', /^\/api\/users\/([^/]+)\/?$/i], // own profile: session start and refresh
  ['PUT', /^\/api\/users\/([^/]+)\/?$/i], // name prompt (Onboarding)
  ['POST', /^\/api\/users\/([^/]+)\/acknowledgements\/?$/i], // age confirmation and privacy notice
  ['POST', /^\/api\/users\/([^/]+)\/delete-account\/?$/i],
];

const routeMethod = (req) => (req.method === 'HEAD' ? 'GET' : req.method);
const matchesRoute = (req, [method, pattern]) => routeMethod(req) === method && pattern.exec(req.baseUrl + req.path);

const namesOwnAccount = (match, userId) => {
  try {
    // /api/users/search is its own route, registered first, so it never names an account here.
    const id = decodeURIComponent(match[1]);
    return id === userId && id.toLowerCase() !== 'search';
  } catch {
    return false;
  }
};

function requireSignedInAdult(req, res, next) {
  if (SIGNED_OUT_ROUTES.some((route) => matchesRoute(req, route))) return next();
  const userId = getUserId(req);
  // The answer depends on who asks, so no cache may keep a refusal or reuse it for someone else.
  const refuse = () => res.vary('Authorization').set('Cache-Control', 'no-store');
  if (!userId) return refuse().status(401).json({ error: 'Authentication required' });
  if (!isAgeConfirmed(userId)) {
    const isOwnAccountRoute = UNCONFIRMED_OWN_ACCOUNT_ROUTES.some((route) => {
      const match = matchesRoute(req, route);
      return Boolean(match) && namesOwnAccount(match, userId);
    });
    if (!isOwnAccountRoute) return respondAgeRequired(refuse());
  }
  req.userId = userId;
  next();
}

// For a post canViewDrink refused. A block comes first and reads exactly like a post that does not
// exist, so the answer says nothing about the post's flag or the viewer's age.
const respondDrinkHidden = (res, drink, viewerId) => (
  isBlockedBetween(drink.userId, viewerId)
    ? res.status(404).json({ error: 'Drink not found' })
    : respondAgeRequired(res)
);

// Notifications whose text can name a post, and what an unconfirmed reader gets instead.
const NOTIFICATION_TEXT_WITHOUT_POST_NAME = {
  cheer: 'Someone cheered your post.',
  comment: 'Someone commented on your post.',
};

// Older notifications hold no drinkId, and a deleted post cannot be checked: both count as alcoholic.
// The stored text is kept, so it shows in full once the reader confirms. drinkId and actorId stay internal.
const toVisibleNotification = ({ drinkId, actorId, ...notification }, viewerId) => {
  const textWithoutPostName = NOTIFICATION_TEXT_WITHOUT_POST_NAME[notification.type];
  // Defence in depth: requireSignedInAdult already refuses unconfirmed readers of /api/notifications.
  if (!textWithoutPostName || isAgeConfirmed(viewerId)) return notification;
  const drink = drinks.find((d) => d.id === drinkId);
  return drink && canViewDrink(drink, viewerId) ? notification : { ...notification, message: textWithoutPostName };
};

// What other users may see. An allowlist, so a new field on the user record stays private by default.
// ageConfirmed must stay owner-only (toOwnerUser): the client takes its presence as proof that a JWT is the owner's.
const toPublicUser = (user) => {
  if (!user) return undefined;
  // Hidden until the owner has read what becomes public, so a user who leaves at the notice was never public.
  if (user.noticePending) return { id: user.id, lastName: '', city: '', bio: '', avatar: null };
  const { id, firstName, lastName, city, bio } = user;
  return { id, ...(!isEmailDerivedName(user) && { firstName }), lastName, city, bio, avatar: toAvatarUrl(user) };
};

// Same number as PRIVACY_NOTICE_VERSION in src/screens/OnboardingScreen.tsx. Raise both when the notice
// text changes in substance. The notice describes the read rules in this file, so it must change with them.
// Rollout: deploy the server first, then release the client. Any version from 1 up to this one is accepted
// and the highest is stored, so older builds still answering their own notice are never stranded.
// Its partner sentence is untrue with PARTNER_CONSENT_REQUIRED=false, an emergency rollback only: anyone
// can then add themselves and read the list.
// Version 2: nothing is visible without signing in (requireSignedInAdult).
const PRIVACY_NOTICE_VERSION = 2;

const getPrivacyNoticeVersion = (user) => (Number.isInteger(user.privacyNoticeVersion) ? user.privacyNoticeVersion : null);

// What the owner gets back. An allowlist too, so internal fields such as nameSetByUser stay private.
// needsName looks at the record, not the public view, which hides every name while the notice is pending.
// A masked name still comes back in firstName, to the owner only.
const toOwnerUser = (user) => {
  const { id, email, emailVerified, firstName, lastName, city, bio } = user;
  return {
    id,
    email,
    emailVerified,
    firstName,
    lastName,
    city,
    bio,
    avatar: toAvatarUrl(user),
    ageConfirmed: isAgeConfirmed(id),
    needsName: !firstName || isEmailDerivedName(user),
    privacyNoticeVersion: getPrivacyNoticeVersion(user),
  };
};

const getPublicName = (publicUser) => `${publicUser.firstName ?? ''} ${publicUser.lastName ?? ''}`.trim();

const getDisplayName = (userId) => {
  const publicUser = toPublicUser(userIndex.get(userId));
  return (publicUser && getPublicName(publicUser)) || 'Someone';
};

const decorateDrink = (drink, currentUserId) => {
  const user       = userIndex.get(drink.userId);
  const likedSet   = currentUserId ? (cheersByUser.get(currentUserId) || new Set()) : new Set();
  const savedSet   = currentUserId ? (savedByUser.get(currentUserId)  || new Set()) : new Set();
  const partnerSet = currentUserId ? ensurePartnerSet(currentUserId)               : new Set();
  return {
    ...drink,
    imageUrl: toDrinkImageUrl(drink),
    user: toPublicUser(user),
    isLiked:   likedSet.has(drink.id),
    isSaved:   savedSet.has(drink.id),
    isPartner: currentUserId
      ? (partnerSet.has(drink.userId) || drink.userId === currentUserId)
      : false,
  };
};

const decorateComment = (comment) => ({
  ...comment,
  user: toPublicUser(userIndex.get(comment.userId)),
});

const toDataUrl = (buffer, mime = 'image/jpeg') => {
  const base64 = buffer.toString('base64');
  return `data:${mime};base64,${base64}`;
};

// Removes a post and everything that hangs off it, and returns a function that puts it all back, for
// a save that fails. No response handling and no save, so account deletion and moderation can reuse it.
// Notifications are plain text and stay until they expire. Limit events stay on purpose.
// A caller removing several posts must run their restore functions in reverse order.
const deleteDrinkCascade = (drinkId) => {
  const index = drinks.findIndex((d) => d.id === drinkId);
  if (index === -1) return null;
  const [drink] = drinks.splice(index, 1);
  const comments = commentsByDrink.get(drinkId);
  commentsByDrink.delete(drinkId);

  // The earlier Sets are kept whole, so a restored one also keeps its order in the saved file.
  const removeFromSets = (setsByUser) => {
    const previous = new Map();
    for (const [userId, set] of setsByUser) {
      if (!set.has(drinkId)) continue;
      previous.set(userId, set);
      const remaining = new Set(set);
      remaining.delete(drinkId);
      setsByUser.set(userId, remaining);
    }
    return previous;
  };
  const previousCheers = removeFromSets(cheersByUser);
  const previousSaved = removeFromSets(savedByUser);

  // Frees the memory now. After a restore the next request only decodes the image again.
  const cacheKey = `drink:${drinkId}`;
  const cached = mediaCache.get(cacheKey);
  if (cached) dropFromMediaCache(cacheKey, cached);

  return () => {
    drinks.splice(index, 0, drink);
    if (comments) commentsByDrink.set(drinkId, comments);
    for (const [userId, set] of previousCheers) cheersByUser.set(userId, set);
    for (const [userId, set] of previousSaved) savedByUser.set(userId, set);
  };
};

// Like deleteDrinkCascade: no response handling and no save, and it returns the undo. Limit events stay on purpose.
const deleteCommentFromDrink = (drinkId, commentId) => {
  const comments = commentsByDrink.get(drinkId);
  const index = comments ? comments.findIndex((comment) => comment?.id === commentId) : -1;
  if (index === -1) return null;
  const [comment] = comments.splice(index, 1);
  return () => comments.splice(index, 0, comment);
};

// Same contract. Back to the state of a user with no name: nothing left to mask, and sign-in does not
// refill a name. The flag stops sign-in bringing back a provider photo; the user can still upload one.
const clearUserProfile = (userId) => {
  const user = userIndex.get(userId);
  if (!user) return null;
  const { firstName, lastName, bio, avatar, nameSetByUser, avatarClearedByAdmin } = user;
  Object.assign(user, { firstName: '', lastName: '', bio: '', avatar: null, avatarClearedByAdmin: true });
  delete user.nameSetByUser;
  rememberAvatarHash(user);
  const cacheKey = `avatar:${userId}`;
  const cached = mediaCache.get(cacheKey);
  if (cached) dropFromMediaCache(cacheKey, cached);
  return () => {
    Object.assign(user, { firstName, lastName, bio, avatar });
    if (nameSetByUser !== undefined) user.nameSetByUser = nameSetByUser;
    if (avatarClearedByAdmin === undefined) delete user.avatarClearedByAdmin;
    rememberAvatarHash(user);
  };
};

// ── Account deletion ──────────────────────────────────────────────────────────
// Durable through pendingAccountDeletions, so a crash at any step finishes at the next start:
// 1. the entry is saved, 2. the data goes, 3. the Firebase user goes, 4. the entry goes.
// Nothing here logs a uid, a name or an email.
const ACCOUNT_DELETION_TOKEN_MAX_AGE_MS = 5 * 60 * 1000;
const ACCOUNT_DELETION_TOKEN_MAX_SKEW_MS = 60 * 1000;
const ACCOUNT_DELETION_RETRY_INTERVAL_MS = parseTestOnlyLimit(process.env.ACCOUNT_DELETION_RETRY_INTERVAL_MS, 15 * 60 * 1000);
// How a notification from before actorId continues after the name. Anchors the match, so deleting
// Ana leaves "Ana Pop commented on" alone.
const LEGACY_NOTIFICATION_VERBS = ['commented on ', 'cheered your ', 'accepted your ', 'added you ', 'sent you '];
// Their cascade threw, so the entry must stay. finishAccountDeletion and the next start run it again.
const incompleteAccountCascades = new Set();
const accountDeletionsInFlight = new Map();

const isAccountDeletionPending = (uid) => pendingAccountDeletions.some((entry) => entry.uid === uid && entry.until === undefined);

const removeAccountDeletionEntries = (uid) => {
  for (let index = pendingAccountDeletions.length - 1; index >= 0; index--) {
    if (pendingAccountDeletions[index].uid === uid) pendingAccountDeletions.splice(index, 1);
  }
};

// True for a token issued before a deletion that finished in the last hour. A missing iat counts as before.
const isTokenFromBeforeDeletion = (uid, issuedAtSeconds) => {
  const entry = pendingAccountDeletions.find((item) => item.uid === uid && item.until !== undefined);
  if (!entry || entry.until <= Date.now()) return false;
  // The same clock margin the delete route accepts, so its token is never counted as newer than the deletion.
  return !(issuedAtSeconds * 1000 > entry.until - ACCOUNT_TOMBSTONE_MS + ACCOUNT_DELETION_TOKEN_MAX_SKEW_MS);
};

const isRecentTokenTime = (seconds) => {
  const ageMs = Date.now() - seconds * 1000;
  return ageMs <= ACCOUNT_DELETION_TOKEN_MAX_AGE_MS && ageMs >= -ACCOUNT_DELETION_TOKEN_MAX_SKEW_MS;
};

// A refreshed token gets a new iat without any new sign-in, so a password account must also show a
// recent auth_time. Google and Apple cannot be asked to sign in again from here: see the client.
const isFreshDeletionToken = ({ issuedAtSeconds, authTimeSeconds, signInProvider }) => (
  isRecentTokenTime(issuedAtSeconds)
  && typeof signInProvider === 'string'
  && (signInProvider !== 'password' || isRecentTokenTime(authTimeSeconds))
);

// How notifications from before actorId can begin. "Someone" is the fallback for anyone, so it names nobody.
const toLegacyNotificationPrefixes = (user) => {
  const fullName = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
  return [...new Set([getDisplayName(user.id), fullName])]
    .filter((name) => name && name !== 'Someone')
    .flatMap((name) => LEGACY_NOTIFICATION_VERBS.map((verb) => `${name} ${verb}`));
};

// An entry with an actorId is matched on that alone, so another user with the same name keeps theirs.
const isNotificationAboutUser = (notification, uid, legacyPrefixes, ownDrinkIds) => {
  if (!isPlainObject(notification)) return false;
  if (notification.actorId === uid || ownDrinkIds.has(notification.drinkId)) return true;
  return (notification.actorId === undefined || notification.actorId === null)
    && typeof notification.message === 'string'
    && legacyPrefixes.some((prefix) => notification.message.startsWith(prefix));
};

// Removes everything that holds or names this user. No response handling and no save. Repeating it is
// safe, and the restore functions of deleteDrinkCascade are dropped on purpose: the pending entry makes
// the deletion go forward, never back. Other users' limit events hold no id, so they stay and still count.
const deleteUserDataCascade = (uid) => {
  const user = userIndex.get(uid);
  const ownDrinkIds = new Set(drinks.filter((drink) => drink.userId === uid).map((drink) => drink.id));
  // drinkId:id, the pair a report names.
  const ownCommentKeys = new Set();
  for (const [drinkId, comments] of commentsByDrink) {
    for (const comment of comments) {
      if (comment?.userId === uid) ownCommentKeys.add(`${drinkId}:${comment.id}`);
    }
  }

  // Reports and notifications first: finding them needs the posts, comments and name removed below.
  for (let index = reports.length - 1; index >= 0; index--) {
    const report = reports[index];
    const isAboutUser = report.reporterId === uid
      || (report.targetType === 'user' && report.targetId === uid)
      || (report.targetType === 'drink' && ownDrinkIds.has(report.targetId))
      || (report.targetType === 'comment' && (ownCommentKeys.has(`${report.drinkId}:${report.targetId}`) || ownDrinkIds.has(report.drinkId)));
    if (isAboutUser) reports.splice(index, 1);
    else if (report.resolvedBy === uid) delete report.resolvedBy;
  }
  const legacyPrefixes = user ? toLegacyNotificationPrefixes(user) : [];
  for (const [ownerId, list] of notificationsByUser) {
    const kept = list.filter((item) => !isNotificationAboutUser(item, uid, legacyPrefixes, ownDrinkIds));
    if (kept.length !== list.length) notificationsByUser.set(ownerId, kept);
  }

  for (const [drinkId, comments] of commentsByDrink) {
    if (comments.some((comment) => comment?.userId === uid)) {
      commentsByDrink.set(drinkId, comments.filter((comment) => comment?.userId !== uid));
    }
  }
  // Also takes other users' comments, cheers and saves on these posts.
  for (const drinkId of ownDrinkIds) deleteDrinkCascade(drinkId);

  // After their own posts, so only the posts that remain have a count to correct. The Set goes first,
  // so a repeat after a failure cannot lower a count twice.
  const cheered = cheersByUser.get(uid) ?? [];
  cheersByUser.delete(uid);
  const drinksById = new Map(drinks.map((drink) => [drink.id, drink]));
  for (const drinkId of cheered) {
    const drink = drinksById.get(drinkId);
    if (drink) drink.cheersCount = Math.max(0, (drink.cheersCount || 0) - 1);
  }
  savedByUser.delete(uid);
  smartBarByUser.delete(uid);
  notificationsByUser.delete(uid);
  limitEventsByUser.delete(uid);

  partnersByUser.delete(uid);
  for (const [otherId, partners] of partnersByUser) {
    if (partners.has(uid)) removePartnerLink(otherId, uid);
  }
  partnerRequestsByUser.delete(uid);
  for (const [targetId, requests] of partnerRequestsByUser) {
    const kept = requests.filter((request) => request?.fromId !== uid);
    if (kept.length === 0) partnerRequestsByUser.delete(targetId);
    else if (kept.length !== requests.length) partnerRequestsByUser.set(targetId, kept);
  }
  blocksByUser.delete(uid);
  for (const [blockerId, blocked] of blocksByUser) {
    if (!blocked.has(uid)) continue;
    const kept = new Set(blocked);
    kept.delete(uid);
    if (kept.size > 0) blocksByUser.set(blockerId, kept);
    else blocksByUser.delete(blockerId);
  }

  avatarHashByUser.delete(uid);
  const avatarCacheKey = `avatar:${uid}`;
  const cachedAvatar = mediaCache.get(avatarCacheKey);
  if (cachedAvatar) dropFromMediaCache(avatarCacheKey, cachedAvatar);

  // Last: while the record exists, a cascade that threw can be retried with the same JWT.
  userIndex.delete(uid);
};

const runAccountCascade = (uid) => {
  try {
    deleteUserDataCascade(uid);
    incompleteAccountCascades.delete(uid);
    return true;
  } catch (err) {
    incompleteAccountCascades.add(uid);
    console.error('[account] Could not finish a data deletion. It is retried:', describeDbError(err));
    return false;
  }
};

// Resolves to whether the Firebase user is gone. The message can quote the uid, so only the type is logged.
const deleteFirebaseUser = async (uid) => {
  try {
    await firebaseAuth.deleteUser(uid);
    return true;
  } catch (err) {
    if (err.code === 'auth/user-not-found') return true;
    console.warn('[firebase-admin] deleteUser failed. It is retried at the next start or sign-in:', err.code ?? err.name);
    return false;
  }
};

// Finished: the pending entry becomes a tombstone. Without Firebase nothing can use a tombstone.
const settleAccountDeletion = (uid) => {
  removeAccountDeletionEntries(uid);
  if (firebaseAuth) pendingAccountDeletions.push({ uid, until: Date.now() + ACCOUNT_TOMBSTONE_MS });
  if (saveDb()) return;
  // A failed save leaves the pending entry in the file, so it must stay in memory too.
  removeAccountDeletionEntries(uid);
  pendingAccountDeletions.push({ uid });
};

// Resolves to whether a Firebase user was removed, never rejects, and runs once per uid at a time.
// An unfinished cascade is run again first. Without Firebase (insecure dev mode only) no Firebase user
// can be removed, so the answer stays false. Only the route may then clear the entry: one found at a
// start or a sign-in could come from a production database, whose Firebase user still has to go.
const finishAccountDeletion = (uid, { clearWithoutFirebase = false } = {}) => {
  const running = accountDeletionsInFlight.get(uid);
  if (running) return running;
  const run = (async () => {
    if (incompleteAccountCascades.has(uid) && runAccountCascade(uid)) saveDb();
    const firebaseDeleted = firebaseAuth ? await deleteFirebaseUser(uid) : false;
    if ((firebaseDeleted || (!firebaseAuth && clearWithoutFirebase)) && !incompleteAccountCascades.has(uid)) settleAccountDeletion(uid);
    return firebaseDeleted;
  })().finally(() => accountDeletionsInFlight.delete(uid));
  accountDeletionsInFlight.set(uid, run);
  return run;
};

const pruneAccountTombstones = () => {
  const now = Date.now();
  let didPrune = false;
  for (let index = pendingAccountDeletions.length - 1; index >= 0; index--) {
    const { until } = pendingAccountDeletions[index];
    if (until !== undefined && until <= now) {
      pendingAccountDeletions.splice(index, 1);
      didPrune = true;
    }
  }
  return didPrune;
};

// Before the server listens, so no request ever sees the data of an account being deleted. The
// Firebase calls continue after that, and a failure only leaves the entry for the next attempt.
const resumePendingAccountDeletions = () => {
  const didPrune = pruneAccountTombstones();
  const uids = pendingAccountDeletions.filter((entry) => entry.until === undefined).map((entry) => entry.uid);
  if (uids.length === 0) {
    if (didPrune) saveDb();
    return;
  }
  console.log(`[account] Resuming ${uids.length} pending account deletion(s).`);
  for (const uid of uids) runAccountCascade(uid);
  saveDb();
  for (const uid of uids) void finishAccountDeletion(uid);
};

// For a Firebase failure or an unfinished cascade when nobody restarts the server or signs in. No save
// unless something changed.
const retryAccountDeletions = () => {
  if (pruneAccountTombstones()) saveDb();
  for (const { uid, until } of [...pendingAccountDeletions]) {
    if (until === undefined) void finishAccountDeletion(uid);
  }
};

// The tombstone covers tokens issued before a deletion. This also covers a tombstone lost with a
// restored file. Any other failure lets sign-in go on: a Firebase outage or permission problem must not
// stop every new sign-up.
const isFirebaseUserGone = async (uid) => {
  try {
    await firebaseAuth.getUser(uid);
    return false;
  } catch (err) {
    if (err.code === 'auth/user-not-found') return true;
    console.warn('[firebase-admin] getUser failed:', err.code ?? err.name);
    return false;
  }
};

const respondAccountDeleted = (res) => res.status(410).json({
  error: 'This account has been deleted.',
  code: 'account_deleted',
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

const DEV_AUTH_UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
let hasWarnedAboutAuthTimeSkew = false;

app.post('/api/auth/mobile', async (req, res) => {
  const { idToken, uid: clientUid, email: clientEmail, displayName, photoURL: clientPhotoURL } = req.body || {};

  if (typeof idToken !== 'string' || !idToken) return res.status(400).json({ error: 'Missing or invalid idToken' });

  let verifiedUid = null;
  let email;
  let emailVerified;
  let providerName;
  let photoURL;
  let issuedAtSeconds;
  let authTimeSeconds;
  let signInProvider;

  // AUTH-1: Verify Firebase ID token server-side using Firebase Admin SDK
  if (firebaseAuth) {
    const verified = await verifyFirebaseToken(idToken);
    if (!verified) {
      return res.status(401).json({ error: 'Invalid Firebase ID token' });
    }
    verifiedUid = verified.uid;
    issuedAtSeconds = verified.issuedAtSeconds;
    authTimeSeconds = verified.authTimeSeconds;
    signInProvider = verified.signInProvider;
    email = verified.email;
    emailVerified = verified.emailVerified;
    providerName = typeof verified.name === 'string' ? sanitizeOptional(verified.name, 120) : undefined;
    // From the verified token only: a request body could name any URL for viewers' devices to load.
    photoURL = verified.picture;
    // Reject if client-provided uid doesn't match the verified token
    if (clientUid && clientUid !== verifiedUid) {
      return res.status(401).json({ error: 'UID mismatch' });
    }
  } else {
    // Production already refuses to start without Firebase, so this is its defense in depth.
    if (!allowInsecureDevAuth) return res.status(503).json({ error: 'Authentication unavailable' });
    // Fallback (no service account): trust the client-provided uid
    // ⚠️ This is insecure and development-only — it requires ALLOW_INSECURE_DEV_AUTH=true
    if (!clientUid) return res.status(400).json({ error: 'Missing uid' });
    if (typeof clientUid !== 'string' || !DEV_AUTH_UID_PATTERN.test(clientUid)) {
      return res.status(400).json({ error: 'Invalid uid' });
    }
    verifiedUid = clientUid;
    photoURL = clientPhotoURL;
    if (typeof clientEmail === 'string' && validator.isEmail(clientEmail, { blacklisted_chars: '<>&"' })) {
      email = clientEmail;
    }
  }

  // After verification, so only the account's owner can learn this or cause a retry. Creates no user.
  if (isAccountDeletionPending(verifiedUid)) {
    void finishAccountDeletion(verifiedUid);
    return respondAccountDeleted(res);
  }

  if (firebaseAuth && isTokenFromBeforeDeletion(verifiedUid, issuedAtSeconds)) return respondAccountDeleted(res);

  if (!userIndex.has(verifiedUid) && isDbGrowthBlocked()) return respondDbGrowthBlocked(res);
  if (firebaseAuth && !userIndex.has(verifiedUid) && await isFirebaseUserGone(verifiedUid)) return respondAccountDeleted(res);
  // After the deletion checks, so a deleted account still gets 410. A failure here, including a Firebase
  // outage, refuses the sign-in.
  if (REQUIRE_VERIFIED_EMAIL && firebaseAuth && !(await verifyFirebaseToken(idToken, { checkRevoked: true }))) {
    return res.status(401).json({ error: 'Invalid Firebase ID token' });
  }
  // A deletion can have been accepted, or even finished, during that wait.
  if (isAccountDeletionPending(verifiedUid) || (firebaseAuth && isTokenFromBeforeDeletion(verifiedUid, issuedAtSeconds))) return respondAccountDeleted(res);

  const existingUser = userIndex.get(verifiedUid);
  const isStaleToken = Boolean(existingUser) && isOlderIdToken(existingUser, issuedAtSeconds);
  const isPasswordToken = signInProvider === 'password';
  // Strong: a confirmed address, and either a provider that confirmed it (Google, Apple) or a password
  // typed in the last few minutes. A refreshed password token keeps its old auth_time, so an attacker's
  // kept session never counts, even after the owner's relink marks the address confirmed.
  // The federated case is decided from the token's own claims, before the staleness rule below: the
  // attacker can refresh more often than the owner signs in, which would otherwise make the owner's Google
  // token count as older and lose. Only the owner can hold a Google token for this uid. A password token
  // still has to be the newest one, so an older one cannot undo a later loss of verification.
  const isStrongFederatedSignIn = Boolean(firebaseAuth) && emailVerified === true
    && typeof signInProvider === 'string' && !isPasswordToken;
  const isStrongVerifiedSignIn = isStrongFederatedSignIn || (
    Boolean(firebaseAuth) && !isStaleToken && emailVerified === true && isPasswordToken && isRecentTokenTime(authTimeSeconds)
  );
  // An older token can only lose: a kept unverified one must not profit from a later verification, and
  // a kept verified one must not undo a later loss of it. A federated token keeps its verified claim.
  if (isStaleToken && !isStrongFederatedSignIn) emailVerified = emailVerified === true && existingUser.emailVerified === true;

  // ── Email takeover guard, with or without REQUIRE_VERIFIED_EMAIL ──
  // Someone can register another person's address with a password before its owner, unconfirmed, and get
  // a JWT for that uid. When the owner later signs in with Google, Firebase keeps the uid and drops the
  // password. Accounts are matched by uid only, never by email, so the defence is the session generation:
  // a strong verified sign-in raises it and logs out every earlier JWT, and the auth floor then refuses
  // the password session that was kept. Written from the documented Firebase claims (see the flag notes).
  // The floor comes first, before the flag-on branch below can write anything: a replayed password token
  // from before the owner's sign-in must not change the stored state or log the owner out.
  if (
    firebaseAuth && isPasswordToken && Number.isFinite(existingUser?.verifiedAuthFloor)
    && !(authTimeSeconds >= existingUser.verifiedAuthFloor)
  ) {
    return res.status(403).json({ error: 'Please sign in again.', code: 'sign_in_again' });
  }
  // Once the owner has signed in through a provider that confirms the address, an unverified token
  // (the attacker's kept password session, refreshed) cannot lower the stored verified state.
  const keepsVerifiedState = Boolean(existingUser?.federatedVerifiedAt) && emailVerified !== true;

  let establishesAuthFloor = false;
  // After every deletion check, so a deleted account is told that and is never asked to verify.
  if (REQUIRE_VERIFIED_EMAIL && firebaseAuth) {
    if (!emailVerified) {
      // An unknown uid leaves nothing behind. A known one loses access now, even if this save fails.
      if (existingUser && !isStaleToken && !keepsVerifiedState && existingUser.emailVerified !== false) {
        existingUser.emailVerified = false;
        if (Number.isFinite(issuedAtSeconds)) existingUser.lastIdTokenIat = issuedAtSeconds;
        saveDb();
      }
      return res.status(403).json({ error: 'Please confirm your email address.', code: 'email_not_verified' });
    }
    // A wrong clock on either side would refuse every password sign-in here, so it should be visible.
    if (signInProvider === 'password' && authTimeSeconds * 1000 - Date.now() > ACCOUNT_DELETION_TOKEN_MAX_SKEW_MS && !hasWarnedAboutAuthTimeSkew) {
      hasWarnedAboutAuthTimeSkew = true;
      console.warn('[auth] A token auth_time is ahead of this server clock by more than the allowed margin. Check the server clock.');
    }
    // Until this account's first verified sign-in, a refreshed password token could be one an attacker
    // kept from before the owner took the address back through Google, because refreshing does not change
    // auth_time. Signing in again gives a new auth_time, so this is asked at most once. That sign-in sets
    // the floor, and a password token from before the floor stays refused. The owner's own tokens keep
    // their auth_time on refresh, so they stay at or above it. Written from the documented claims: real
    // Firebase behaviour for this case could not be tested on this run.
    const hasAuthFloor = Number.isFinite(existingUser?.verifiedAuthFloor);
    establishesAuthFloor = existingUser?.emailVerified !== true || !hasAuthFloor;
    const isBelowFloor = isPasswordToken && hasAuthFloor && !(authTimeSeconds >= existingUser.verifiedAuthFloor);
    const isNotFreshEnough = establishesAuthFloor && (typeof signInProvider !== 'string' || (isPasswordToken && !isRecentTokenTime(authTimeSeconds)));
    if (isBelowFloor || isNotFreshEnough) {
      return res.status(403).json({ error: 'Please sign in again.', code: 'sign_in_again' });
    }
  }

  // ── Email takeover guard, with or without REQUIRE_VERIFIED_EMAIL (continued) ──
  // With the flag off, a confirmed but not strong token cannot be told apart from the attacker's refreshed
  // one, so it gets a JWT without ev and the stored state stays unconfirmed. The flag-on path above
  // refuses this case with sign_in_again instead.
  if (!REQUIRE_VERIFIED_EMAIL && firebaseAuth && emailVerified === true && !isStrongVerifiedSignIn && existingUser?.emailVerified !== true) {
    emailVerified = false;
  }
  // The second rule covers the race where the attacker's refreshed token, already confirmed after the
  // relink, reached the server first and stored emailVerified: the owner's first federated sign-in still
  // starts a new generation. Costs one extra sign-in on other devices for an existing Google user.
  const bumpsSessionGen = Boolean(existingUser) && isStrongVerifiedSignIn
    && (existingUser.emailVerified !== true || (isStrongFederatedSignIn && !existingUser.federatedVerifiedAt));
  // A new account needs no new generation, but a federated or fresh password one still sets the floor,
  // so a password session kept from before the owner's relink cannot sign in afterwards.
  const setsTakeoverFloor = bumpsSessionGen || (!existingUser && isStrongVerifiedSignIn);

  registerUserIfNeeded({
    id: verifiedUid,
    email,
    emailFromToken: Boolean(firebaseAuth),
    emailVerified: keepsVerifiedState ? undefined : emailVerified,
    tokenIat: issuedAtSeconds,
    providerName,
    displayName: typeof displayName === 'string' ? sanitizeOptional(displayName, 120) : undefined,
    photoURL: sanitizePhotoURL(photoURL),
  });
  const user = userIndex.get(verifiedUid);
  if (establishesAuthFloor || setsTakeoverFloor) {
    // A federated floor is one second past that token's iat, so a password session whose auth_time falls
    // in the same second as the owner's sign-in is still refused. The owner's own password sign-ins come later.
    const floor = isPasswordToken ? authTimeSeconds : issuedAtSeconds + 1;
    if (Number.isFinite(floor)) user.verifiedAuthFloor = Math.max(floor, user.verifiedAuthFloor ?? floor);
  }
  // A stale strong token does not update the stored state in registerUserIfNeeded, so it is set here.
  if (bumpsSessionGen) {
    user.sessionGen = getSessionGen(user) + 1;
    user.emailVerified = true;
  }
  if (isStrongFederatedSignIn && !user.federatedVerifiedAt) user.federatedVerifiedAt = new Date().toISOString();
  // Not rolled back when the save fails, like the rest of sign-in: earlier JWTs stay logged out in
  // memory, and a retry finds the work done and issues a JWT at the new generation.
  if (!saveDbOrRespond(res)) return;

  const token = signApiToken(verifiedUid, emailVerified === true, getSessionGen(user));
  res.json({ token });
});

const USER_SEARCH_MAX_RESULTS = 50;
const USER_SEARCH_MIN_QUERY_LENGTH = 2;

// Per-user limit, so one account cannot page through the user list with short queries.
const searchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId, // always set: this runs after requireAuth
});

app.get('/api/users/search', requireAuth, searchLimiter, (req, res) => {
  const partnerSet    = ensurePartnerSet(req.userId);
  const normalized    = (req.query.q ?? '').toString().trim().replace(/^@+/, '').toLowerCase();
  if (normalized.length < USER_SEARCH_MIN_QUERY_LENGTH) return res.json([]);
  const allUsers      = Array.from(userIndex.values())
    .filter((user) => isLiveAccount(user.id) && !user.noticePending && !isBlockedBetween(req.userId, user.id))
    .map(toPublicUser);
  // Only public fields are searched: matching on email would let anyone test for an address.
  const filtered = allUsers
    .filter((c) => (
      getPublicName(c).toLowerCase().includes(normalized) ||
      (c.city || '').toLowerCase().includes(normalized)
    ))
    .slice(0, USER_SEARCH_MAX_RESULTS);
  res.json(filtered.map((c) => ({
    ...c,
    isPartner: partnerSet.has(c.id),
    ...(c.id !== req.userId && { partnerStatus: getPartnerStatus(req.userId, c.id) }),
  })));
});

app.get('/api/users/:id', (req, res) => {
  const user = userIndex.get(req.params.id);
  const viewerId = getUserId(req);
  if (!user || !isLiveAccount(req.params.id) || isBlockedBetween(viewerId, req.params.id)) return res.status(404).json({ error: 'User not found' });
  if (viewerId === user.id) return res.json({ ...toOwnerUser(user), partnerCount: getVisiblePartnerIds(user.id, viewerId).length });
  // No logged-out branch: requireSignedInAdult answers 401 before this route.
  res.json({
    ...toPublicUser(user),
    partnerStatus: getPartnerStatus(viewerId, user.id),
    ...(isListedPartner(user.id, viewerId) && { partnerCount: getVisiblePartnerIds(user.id, viewerId).length }),
  });
});

// The owner and that user's partners only, whether or not consent is required.
app.get('/api/users/:id/partners', requireAuth, (req, res) => {
  const requesterId = req.userId;
  const targetId    = req.params.id;
  if (!isLiveAccount(targetId) || isBlockedBetween(requesterId, targetId)) return res.status(404).json({ error: 'User not found' });
  if (requesterId !== targetId && !isListedPartner(targetId, requesterId)) {
    return res.status(403).json({ error: 'Only this user\'s drink partners can see this list.', code: 'partner_list_private' });
  }
  const requesterPartners = ensurePartnerSet(requesterId);
  res.json(getVisiblePartnerIds(targetId, requesterId)
    .map((id) => ({ ...toPublicUser(userIndex.get(id)), isPartner: requesterPartners.has(id) })));
});

app.put('/api/users/:id', requireAuth, (req, res) => {
  // SEC-4: verifică că userul autentificat este proprietarul contului
  if (req.userId !== req.params.id) {
    return res.status(403).json({ error: 'Forbidden: cannot edit another user\'s profile' });
  }
  const user = userIndex.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { firstName, lastName, city, bio, nameChosen } = req.body || {};
  const previousProfile = {
    firstName: user.firstName, lastName: user.lastName, city: user.city, bio: user.bio, nameSetByUser: user.nameSetByUser,
  };
  // SEC-A: sanitize profile fields
  if (typeof firstName === 'string') {
    const nextFirstName = sanitizeText(firstName, 120);
    const storedFirstName = typeof user.firstName === 'string' ? user.firstName : '';
    // The client resends the stored value on every save, which is not a change. A form opened before
    // the schema migration resends the old escaped form, possibly cut, which is not one either.
    const resentFirstName = firstName.trim();
    const escapedFirstName = validator.escape(storedFirstName);
    // Sent only by the name prompt, whose field starts empty. So a masked user who types exactly the
    // masked name has chosen it, and without this the prompt would never close for them.
    const isTypedName = nameChosen === true && nextFirstName !== '';
    // A form opened before a rename, or before the name was cleared, can still hold the masked prefix.
    // Saving it would publish the email prefix, so only the name prompt can choose that name.
    const isPrefixFromForm = nameChosen !== true && typeof user.email === 'string'
      && matchesEmailPrefix(nextFirstName, user.email.split('@')[0]);
    if (isTypedName || (
      !isPrefixFromForm &&
      resentFirstName !== storedFirstName &&
      resentFirstName !== escapedFirstName &&
      resentFirstName !== escapedFirstName.slice(0, 120) &&
      nextFirstName !== storedFirstName
    )) {
      user.firstName = nextFirstName;
      if (nextFirstName !== '') user.nameSetByUser = true;
      else delete user.nameSetByUser;
    }
  }
  if (typeof lastName  === 'string') user.lastName  = sanitizeText(lastName, 120);
  if (typeof city      === 'string') user.city      = sanitizeText(city, 120);
  if (typeof bio       === 'string') user.bio       = sanitizeText(bio, 500);
  if (!saveDbOrRespond(res)) {
    for (const [key, value] of Object.entries(previousProfile)) {
      if (value === undefined) delete user[key];
      else user[key] = value;
    }
    return;
  }
  res.json(toOwnerUser(user));
});

// No growth check: the answer is small, and it must stay possible once storage is full.
app.post('/api/users/:id/acknowledgements', requireAuth, (req, res) => {
  if (req.userId !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  const user = userIndex.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { type, confirmed, version } = req.body || {};
  if (type === 'privacy') {
    if (!Number.isInteger(version) || version < 1 || version > PRIVACY_NOTICE_VERSION) {
      return res.status(400).json({ error: 'Invalid acknowledgement' });
    }
    // The highest stays. A repeat or a lower version keeps the first time and writes nothing, unless it
    // still has to end the hidden state.
    const storedVersion = getPrivacyNoticeVersion(user) ?? 0;
    if (version <= storedVersion && !user.noticePending) return res.json(toOwnerUser(user));
    const { privacyNoticeVersion: previousVersion, privacyNoticeAt: previousAt, noticePending: previousPending } = user;
    if (version > storedVersion) {
      user.privacyNoticeVersion = version;
      user.privacyNoticeAt = new Date().toISOString();
    }
    delete user.noticePending;
    if (!saveDbOrRespond(res)) {
      if (previousVersion === undefined) delete user.privacyNoticeVersion;
      else user.privacyNoticeVersion = previousVersion;
      if (previousAt === undefined) delete user.privacyNoticeAt;
      else user.privacyNoticeAt = previousAt;
      if (previousPending !== undefined) user.noticePending = previousPending;
      return;
    }
    return res.json(toOwnerUser(user));
  }
  if (type !== 'age' || confirmed !== true) return res.status(400).json({ error: 'Invalid acknowledgement' });
  // A repeat keeps the first time and writes nothing.
  if (isAgeConfirmed(user.id)) return res.json(toOwnerUser(user));
  const previousConfirmedAt = user.ageConfirmedAt;
  user.ageConfirmedAt = new Date().toISOString();
  if (!saveDbOrRespond(res)) {
    if (previousConfirmedAt === undefined) delete user.ageConfirmedAt;
    else user.ageConfirmedAt = previousConfirmedAt;
    return;
  }
  res.json(toOwnerUser(user));
});

// Runs before multer, so a non-owner gets 403 without the server buffering their upload.
const requireAvatarOwner = (req, res, next) => {
  if (req.userId !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  next();
};

app.post('/api/users/:id/avatar', requireAuth, requireAvatarOwner, avatarBodyParser, parseUpload(avatarUpload.single('avatar')), (req, res) => {
  // The account can have been deleted while the body arrived, after requireAuth.
  if (!isLiveAccount(req.userId)) return res.status(401).json({ error: 'Authentication required' });
  const user = userIndex.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  let avatarData = null;
  if (req.file?.buffer) {
    avatarData = validateImageBytes(req.file.buffer, AVATAR_IMAGE_RULES);
  } else if (typeof req.body?.imageData === 'string') {
    avatarData = validateImage(req.body.imageData, AVATAR_IMAGE_RULES);
  }
  if (!avatarData) return res.status(400).json({ error: 'Missing or invalid avatar payload' });
  if (avatarData.error) return res.status(avatarData.status).json({ error: avatarData.error });
  if (wouldExceedUserImageQuota(user.id, avatarData.dataUrl, user.avatar)) return respondUserImageQuota(res);
  // A replacement that is no larger does not grow the database, so it stays allowed.
  if (avatarData.dataUrl.length > storedImageBytes(user.avatar) && isDbGrowthBlocked()) return respondDbGrowthBlocked(res);
  if (wouldExceedImageStorage(avatarData.dataUrl, user.avatar)) return respondImageStorageFull(res);
  const previousAvatar = user.avatar;
  user.avatar = avatarData.dataUrl;
  if (!saveDbOrRespond(res)) {
    user.avatar = previousAvatar;
    rememberAvatarHash(user);
    return;
  }
  rememberAvatarHash(user);
  res.json(toOwnerUser(user));
});

// Runs before the limiter, so another user's requests cannot use up the owner's attempts.
const requireAccountOwner = (req, res, next) => {
  if (req.userId !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  next();
};

const accountDeletionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId, // always set: this runs after requireAuth
});

// Answers the request itself. Writes the pending entry first, so a crash after that is resumed at the next start.
const deleteAccountDurably = async (uid, res) => {
  // A tombstone from an earlier account with this uid is replaced, and comes back if this save fails.
  const previousEntries = [...pendingAccountDeletions];
  removeAccountDeletionEntries(uid);
  pendingAccountDeletions.push({ uid });
  if (!saveDbOrRespond(res)) {
    pendingAccountDeletions.splice(0, pendingAccountDeletions.length, ...previousEntries);
    return;
  }

  // From here the entry is on disk. A failed save below is logged by saveDb, and the next start repeats the cascade.
  runAccountCascade(uid);
  saveDb();
  const firebaseDeleted = await finishAccountDeletion(uid, { clearWithoutFirebase: true });
  if (incompleteAccountCascades.has(uid)) {
    return res.status(500).json({ error: 'Could not delete your account. Please try again.', code: 'account_deletion_incomplete' });
  }
  res.json({ deleted: true, firebaseDeleted });
};

// POST because some proxies strip the body of a DELETE. No growth check: it must work once storage is
// full. With Firebase, the JWT alone is not enough, so a stolen one cannot delete an account: the request
// also needs a recent ID token for this uid, and a session Firebase has not revoked. In insecure dev mode
// nothing can verify a token, so the JWT and the ownership check are all that is checked. A repeat gets
// 401 like any other route once the entry exists: finishAccountDeletion does the retrying.
app.post('/api/users/:id/delete-account', requireAuth, requireAccountOwner, accountDeletionLimiter, async (req, res, next) => {
  try {
    const uid = req.userId;
    if (firebaseAuth) {
      const { idToken } = req.body || {};
      const verified = typeof idToken === 'string' && idToken ? await verifyFirebaseToken(idToken, { checkRevoked: true }) : null;
      if (!verified || !isFreshDeletionToken(verified)) {
        return res.status(401).json({ error: 'Please sign in again to delete your account.', code: 'reauth_required' });
      }
      if (verified.uid !== uid) return res.status(403).json({ error: 'Forbidden' });
    } else if (!allowInsecureDevAuth) {
      return res.status(503).json({ error: 'Authentication unavailable' });
    }
    // A parallel request can have finished during the wait above.
    if (!isLiveAccount(uid)) return res.status(401).json({ error: 'Authentication required' });

    await deleteAccountDurably(uid, res);
  } catch (err) { next(err); }
});

// An unverified user has no JWT, so the route above cannot serve them. This one skips only that gate and
// takes the same proof: a recent, unrevoked ID token, with a recent sign-in for a password account. Not
// registered with the flag off. A verified user has a session and uses the route above.
if (REQUIRE_VERIFIED_EMAIL && firebaseAuth) {
  const verifyUnverifiedDeletionToken = async (req, res, next) => {
    try {
      const { idToken } = req.body || {};
      const verified = typeof idToken === 'string' && idToken ? await verifyFirebaseToken(idToken, { checkRevoked: true }) : null;
      if (!verified) return res.status(401).json({ error: 'Please sign in again to delete your account.', code: 'reauth_required' });
      req.userId = verified.uid;
      req.verifiedDeletionToken = verified;
      next();
    } catch (err) { next(err); }
  };

  app.post('/api/account/delete-unverified', verifyUnverifiedDeletionToken, accountDeletionLimiter, async (req, res, next) => {
    try {
      const uid = req.userId;
      if (!isFreshDeletionToken(req.verifiedDeletionToken)) {
        return res.status(401).json({ error: 'Please sign in again to delete your account.', code: 'reauth_required' });
      }
      if (req.verifiedDeletionToken.emailVerified) {
        return res.status(403).json({ error: 'This email is confirmed.', code: 'email_already_verified' });
      }
      if (isAccountDeletionPending(uid)) {
        void finishAccountDeletion(uid);
        return respondAccountDeleted(res);
      }
      const respondAlreadyVerified = () => res.status(403).json({ error: 'This email is confirmed.', code: 'email_already_verified' });
      const user = userIndex.get(uid);
      if (user) {
        // A kept token claiming "unverified" must not delete a verified owner. An address that really
        // became unverified signs in first, which stores false.
        if (isOlderIdToken(user, req.verifiedDeletionToken.issuedAtSeconds) || user.emailVerified === true) return respondAlreadyVerified();
        return await deleteAccountDurably(uid, res);
      }
      // No record to compare with, so Firebase answers. A failed lookup deletes nothing.
      let firebaseUser;
      try {
        firebaseUser = await firebaseAuth.getUser(uid);
      } catch (err) {
        console.warn('[firebase-admin] getUser failed:', err.code ?? err.name);
        return res.status(503).json({ error: 'Could not delete your account. Please try again.' });
      }
      // A sign-in or deletion can have happened during that wait.
      if (firebaseUser.emailVerified === true || userIndex.has(uid) || isAccountDeletionPending(uid)) return respondAlreadyVerified();
      // Never signed in successfully, so the Firebase user is all there is.
      if (await deleteFirebaseUser(uid)) return res.json({ deleted: true, firebaseDeleted: true });
      res.status(500).json({ error: 'Could not delete your account. Please try again.', code: 'account_deletion_incomplete' });
    } catch (err) { next(err); }
  });
}

app.get('/api/drink-partners', requireAuth, (req, res) => {
  const partnerSet = Array.from(ensurePartnerSet(req.userId));
  res.json(partnerSet
    .filter((id) => isLiveAccount(id) && !isBlockedBetween(req.userId, id))
    .map((id) => toPublicUser(userIndex.get(id)))
    .filter(Boolean));
});

const respondPartnerStatus = (res, status) => res.json({ status, isPartner: status === 'partner' });

// Repeating an action must not flood the other user's list, which keeps only the newest entries.
// An expired entry no longer shows, so it does not count as already told.
const pushNotificationUnlessUnread = (targetUserId, actorId, type, message) => {
  const now = Date.now();
  const isAlreadyNotified = (notificationsByUser.get(targetUserId) ?? []).some((item) => (
    item.type === type && item.actorId === actorId && !item.read
    && now - new Date(item.createdAt).getTime() <= NOTIFICATION_MAX_AGE_MS
  ));
  if (!isAlreadyNotified) pushNotification(targetUserId, actorId, type, message);
};

// Links the pair and tells the other side, or leaves everything as it was when the save fails.
const linkPartnersOrRespond = (res, userId, otherId, notify) => {
  const restore = snapshotPartnerPair(userId, otherId);
  linkPartners(userId, otherId);
  notify();
  if (!saveDbOrRespond(res)) return restore();
  respondPartnerStatus(res, 'partner');
};

const acceptPartnerRequestOrRespond = (res, userId, fromId) => (
  linkPartnersOrRespond(res, userId, fromId, () => (
    pushNotification(fromId, userId, 'partner', `${getDisplayName(userId)} accepted your drink partner request.`)
  ))
);

const toPartnerRequestUsers = (requests) => requests
  .map(({ otherId, createdAt }) => ({ ...toPublicUser(userIndex.get(otherId)), createdAt }))
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

app.get('/api/drink-partners/requests', requireAuth, (req, res) => {
  res.json({
    incoming: toPartnerRequestUsers(getIncomingPartnerRequests(req.userId)),
    outgoing: toPartnerRequestUsers(getOutgoingPartnerRequests(req.userId)),
  });
});

app.post('/api/drink-partners/requests/:fromId/accept', requireAuth, (req, res) => {
  const userId = req.userId;
  const fromId = req.params.fromId;
  if (!isLivePartnerRequest(fromId, userId)) return res.status(404).json({ error: 'Request not found' });
  const status = getPartnerStatus(userId, fromId);
  if (status === 'partner') return respondPartnerStatus(res, status);
  if (status !== 'incoming') return res.status(404).json({ error: 'Request not found' });
  if (isDbGrowthBlocked()) return respondDbGrowthBlocked(res);
  acceptPartnerRequestOrRespond(res, userId, fromId);
});

// A decline tells nobody, and the other user may ask again. Stays open at the storage limit: it only removes.
app.delete('/api/drink-partners/requests/:fromId', requireAuth, (req, res) => {
  const userId = req.userId;
  const fromId = req.params.fromId;
  if (!hasPartnerRequest(fromId, userId)) return res.status(204).end();
  const previousRequests = partnerRequestsByUser.get(userId);
  removePartnerRequest(fromId, userId);
  if (!saveDbOrRespond(res)) {
    partnerRequestsByUser.set(userId, previousRequests);
    return;
  }
  res.status(204).end();
});

// Not a toggle: a partner is removed through DELETE below, so a repeat never undoes anything.
app.post('/api/drink-partners/:targetId', requireAuth, (req, res) => {
  const userId   = req.userId;
  const targetId = req.params.targetId;
  if (!isLiveAccount(targetId)) return res.status(404).json({ error: 'User not found' });
  if (targetId === userId)      return res.status(400).json({ error: 'Cannot add yourself' });
  if (isBlockedBetween(userId, targetId)) return res.status(404).json({ error: 'User not found' });

  const status = getPartnerStatus(userId, targetId);
  if (status === 'partner') return respondPartnerStatus(res, status);
  if (status === 'requested' && PARTNER_CONSENT_REQUIRED) return respondPartnerStatus(res, status);
  if (isDbGrowthBlocked()) return respondDbGrowthBlocked(res);
  if (!PARTNER_CONSENT_REQUIRED) {
    return linkPartnersOrRespond(res, userId, targetId, () => (
      pushNotificationUnlessUnread(targetId, userId, 'partner', `${getDisplayName(userId)} added you as a drink partner.`)
    ));
  }
  if (status === 'incoming') return acceptPartnerRequestOrRespond(res, userId, targetId);
  if (getOutgoingPartnerRequests(userId).length >= PARTNER_REQUESTS_MAX_OUTGOING) {
    return res.status(429).json({ error: 'You have too many pending partner requests.', code: 'partner_request_limit' });
  }
  // Counts creations, so cancelling and asking someone else does not get around the cap above.
  if (limitEventsWithin(userId, 'partner_request', PARTNER_REQUEST_LIMIT_WINDOW_MS).length >= PARTNER_REQUEST_LIMIT_MAX_COUNT) {
    return res.status(429).json({ error: 'You have sent too many partner requests today.', code: 'partner_request_limit' });
  }

  const restore = snapshotPartnerPair(userId, targetId);
  const createdAt = new Date().toISOString();
  partnerRequestsByUser.set(targetId, [...getPendingPartnerRequests(targetId), { fromId: userId, createdAt }]);
  const limitEvent = recordLimitEvent(userId, { kind: 'partner_request', at: createdAt });
  pushNotificationUnlessUnread(targetId, userId, 'partner_request', `${getDisplayName(userId)} sent you a drink partner request.`);
  if (!saveDbOrRespond(res)) {
    restore();
    removeLimitEvent(userId, limitEvent);
    return;
  }
  respondPartnerStatus(res, 'requested');
});

// ?expect= names what the caller's button showed, so a stale button changes nothing.
const PARTNER_DELETE_EXPECTED_STATUS = new Map([['request', 'requested'], ['partner', 'partner']]);

// Removes a partner or cancels the caller's own request. Stays open at the storage limit: it only removes.
app.delete('/api/drink-partners/:targetId', requireAuth, (req, res) => {
  const userId   = req.userId;
  const targetId = req.params.targetId;
  const { expect } = req.query;
  if (expect !== undefined && !PARTNER_DELETE_EXPECTED_STATUS.has(expect)) return res.status(400).json({ error: 'Invalid expect value' });
  if (!isLiveAccount(targetId)) return res.status(404).json({ error: 'User not found' });
  if (targetId === userId)      return res.status(400).json({ error: 'Cannot remove yourself' });
  if (isBlockedBetween(userId, targetId)) return res.status(404).json({ error: 'User not found' });

  const status = getPartnerStatus(userId, targetId);
  if (expect !== undefined && PARTNER_DELETE_EXPECTED_STATUS.get(expect) !== status) {
    return res.status(409).json({ error: 'The partner state has changed.', code: 'partner_state_changed', status, isPartner: status === 'partner' });
  }
  if (status !== 'partner' && status !== 'requested') return res.status(204).end();
  const restore = snapshotPartnerPair(userId, targetId);
  if (status === 'partner') unlinkPartners(userId, targetId);
  else removePartnerRequest(userId, targetId);
  if (!saveDbOrRespond(res)) return restore();
  res.status(204).end();
});

app.get('/api/friends/count', requireAuth, (req, res) => {
  res.json(getVisiblePartnerIds(req.userId, req.userId).length);
});

app.get('/api/stories', (req, res) => {
  res.json(stories.map((story) => ({ ...story, user: toPublicUser(userIndex.get(story.userId)) })));
});

app.get('/api/drinks', (req, res) => {
  const currentUserId = getUserId(req);
  const page = parsePageParams(req.query);
  if (!page) return respondInvalidPage(res);
  const cityQuery = parseSearchText(req.query.city);
  const searchQuery = parseSearchText(req.query.q);
  const { alcoholic, scope, sort } = req.query;
  const isTrending = sort === 'trending';
  const hasValidFilters = cityQuery !== null && searchQuery !== null
    && (alcoholic === undefined || alcoholic === 'false')
    && (scope === undefined || scope === 'discover')
    && (sort === undefined || isTrending)
    && !(isTrending && page.before !== undefined);
  if (!hasValidFilters) return res.status(400).json({ error: 'Invalid filter' });
  if (scope === 'discover' && !currentUserId) return res.status(401).json({ error: 'Authentication required' });

  // First, so the search, the ranking and the paging below only ever see what this viewer may see.
  let list = drinks.filter((d) => canViewDrink(d, currentUserId));
  if (cityQuery) {
    list = list.filter((d) => textIncludes(d.location, cityQuery));
  }
  if (searchQuery) {
    list = list.filter((d) => (
      textIncludes(d.name, searchQuery) || textIncludes(d.description, searchQuery) || textIncludes(d.location, searchQuery)
    ));
  }
  if (alcoholic === 'false') {
    list = list.filter((d) => d.isAlcoholic === false);
  }
  if (scope === 'discover') {
    const partnerSet = ensurePartnerSet(currentUserId);
    list = list.filter((d) => d.userId !== currentUserId && !partnerSet.has(d.userId));
  }
  if (isTrending) {
    const items = [...list]
      .sort((a, b) => (b.cheersCount || 0) - (a.cheersCount || 0) || b.id - a.id)
      .slice(0, Math.min(page.limit, TRENDING_MAX_ITEMS));
    return res.json({ items: items.map((d) => decorateDrink(d, currentUserId)), nextCursor: null });
  }
  const { items, nextCursor } = paginateById(list, page);
  res.json({ items: items.map((d) => decorateDrink(d, currentUserId)), nextCursor });
});

app.get('/api/drinks/partners', requireAuth, (req, res) => {
  const page = parsePageParams(req.query);
  if (!page) return respondInvalidPage(res);
  const currentUserId = req.userId;
  const partnerSet    = ensurePartnerSet(currentUserId);
  const list = drinks.filter((d) => (partnerSet.has(d.userId) || d.userId === currentUserId) && canViewDrink(d, currentUserId));
  const { items, nextCursor } = paginateById(list, page);
  res.json({ items: items.map((d) => decorateDrink(d, currentUserId)), nextCursor });
});

app.get('/api/drinks/:id', (req, res) => {
  const currentUserId = getUserId(req);
  const drinkId = parsePositiveInteger(req.params.id);
  const drink = drinks.find((d) => d.id === drinkId);
  if (!drink) return res.status(404).json({ error: 'Drink not found' });
  if (!canViewDrink(drink, currentUserId)) return respondDrinkHidden(res, drink, currentUserId);
  res.json(decorateDrink(drink, currentUserId));
});

app.get('/api/drinks/:id/comments', (req, res) => {
  const page = parsePageParams(req.query);
  if (!page) return respondInvalidPage(res);
  const drinkId = parsePositiveInteger(req.params.id);
  const drink = drinks.find((d) => d.id === drinkId);
  if (!drink) return res.status(404).json({ error: 'Drink not found' });
  const viewerId = getUserId(req);
  if (!canViewDrink(drink, viewerId)) return respondDrinkHidden(res, drink, viewerId);
  // Before paging. The author of a comment can be blocked when the post's owner is not.
  const visibleComments = (commentsByDrink.get(drinkId) ?? []).filter((comment) => !isBlockedBetween(comment?.userId, viewerId));
  const { items, nextCursor } = paginateById(visibleComments, page);
  res.json({ items: items.map(decorateComment), nextCursor });
});

app.post('/api/drinks/:id/comments', requireAuth, (req, res) => {
  const currentUserId = req.userId;
  const drinkId = parsePositiveInteger(req.params.id);
  const { content } = req.body || {};
  if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: 'Missing comment content' });
  if (content.length > 500) return res.status(400).json({ error: 'Comment too long' });
  const drink = drinks.find((d) => d.id === drinkId);
  if (!drink) return res.status(404).json({ error: 'Drink not found' });
  if (!canViewDrink(drink, currentUserId)) return respondDrinkHidden(res, drink, currentUserId);

  const safeContent = sanitizeText(content, 500);
  if (!safeContent) return res.status(400).json({ error: 'Comment cannot be empty' });
  if (hasReachedCommentLimit(currentUserId)) {
    return res.status(429).json({
      error: 'Daily comment limit reached. Please try again tomorrow.',
      code: 'daily_comment_limit',
    });
  }
  if (isDbGrowthBlocked()) return respondDbGrowthBlocked(res);

  const comment = {
    id: nextCommentId++,
    drinkId,
    userId: currentUserId,
    content: safeContent,
    createdAt: new Date().toISOString(),
  };
  ensureComments(drinkId).push(comment);
  const limitEvent = recordLimitEvent(currentUserId, { kind: 'comment', at: comment.createdAt });
  const firstNewNotificationId = nextNotificationId;
  // A copy, because the per-user cap can drop the oldest notification from the live list.
  const previousNotifications = notificationsByUser.get(drink.userId)?.slice();
  if (drink.userId !== currentUserId) {
    pushNotification(drink.userId, currentUserId, 'comment', `${getDisplayName(currentUserId)} commented on ${drink.name}.`, drink.id);
  }
  if (!saveDbOrRespond(res)) {
    ensureComments(drinkId).pop();
    removeLimitEvent(currentUserId, limitEvent);
    nextCommentId = comment.id;
    if (nextNotificationId !== firstNewNotificationId) {
      notificationsByUser.set(drink.userId, previousNotifications ?? []);
      nextNotificationId = firstNewNotificationId;
    }
    return;
  }
  res.status(201).json(decorateComment(comment));
});

// No growth check, like deleting a post. A comment's author and the post's owner can always remove
// it, even on a post they can no longer see. Limit events stay, so this cannot reset the daily limit.
app.delete('/api/drinks/:id/comments/:commentId', requireAuth, (req, res) => {
  const currentUserId = req.userId;
  const drinkId = parsePositiveInteger(req.params.id);
  const commentId = parsePositiveInteger(req.params.commentId);
  const drink = drinks.find((d) => d.id === drinkId);
  if (!drink) return res.status(404).json({ error: 'Drink not found' });
  const comment = (commentsByDrink.get(drinkId) ?? []).find((item) => item?.id === commentId);
  const canRemove = drink.userId === currentUserId || comment?.userId === currentUserId;
  if (!canRemove && !canViewDrink(drink, currentUserId)) return respondDrinkHidden(res, drink, currentUserId);
  if (!comment || (!canRemove && isBlockedBetween(comment.userId, currentUserId))) {
    return res.status(404).json({ error: 'Comment not found' });
  }
  if (!canRemove) return res.status(403).json({ error: 'Forbidden' });
  const restoreComment = deleteCommentFromDrink(drinkId, commentId);
  if (!saveDbOrRespond(res)) {
    restoreComment();
    return;
  }
  res.status(204).end();
});

app.get('/api/drinks/user/:userId', (req, res) => {
  const page = parsePageParams(req.query);
  if (!page) return respondInvalidPage(res);
  const currentUserId = getUserId(req);
  const list = drinks.filter((d) => d.userId === req.params.userId && canViewDrink(d, currentUserId));
  const { items, nextCursor } = paginateById(list, page);
  res.json({ items: items.map((d) => decorateDrink(d, currentUserId)), nextCursor, total: list.length });
});

app.post('/api/drinks', requireAuth, postBodyParser, (req, res) => {
  // The account can have been deleted while the body arrived, after requireAuth.
  if (!isLiveAccount(req.userId)) return res.status(401).json({ error: 'Authentication required' });
  const currentUserId = req.userId;
  const { name, description, rating, location, isAlcoholic, imageData } = req.body || {};
  // Before any validation, so the image of a post that would be refused is never processed.
  // Defence in depth: requireSignedInAdult already refuses an unconfirmed user before this route.
  if (isAlcoholic !== false && !isAgeConfirmed(currentUserId)) return respondAgeRequired(res);
  if (!name || !description || !imageData) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const normalizedRating = Number(rating);
  if (Number.isNaN(normalizedRating) || normalizedRating < 0 || normalizedRating > 5) {
    return res.status(400).json({ error: 'Rating must be between 0 and 5' });
  }
  // SEC-10: validate the image from its bytes
  const normalizedImage = validateImage(imageData, POST_IMAGE_RULES);
  if (normalizedImage.error) {
    return res.status(normalizedImage.status).json({ error: normalizedImage.error });
  }

  // SEC-A: sanitize text inputs
  const safeName        = sanitizeText(name, 120);
  const safeDescription = sanitizeText(description, 1000);
  const safeLocation    = sanitizeOptional(location, 180);
  if (!safeName || !safeDescription) {
    return res.status(400).json({ error: 'Name and description cannot be empty' });
  }

  if (wouldExceedPostLimit(currentUserId, normalizedImage.dataUrl)) {
    return res.status(429).json({ error: 'Daily post limit reached. Please try again tomorrow.', code: 'daily_post_limit' });
  }
  if (wouldExceedUserImageQuota(currentUserId, normalizedImage.dataUrl)) return respondUserImageQuota(res);
  if (isDbGrowthBlocked()) return respondDbGrowthBlocked(res);
  if (wouldExceedImageStorage(normalizedImage.dataUrl)) return respondImageStorageFull(res);

  const newDrink = {
    id: nextDrinkId++,
    userId: currentUserId,
    name: safeName,
    description: safeDescription,
    rating: normalizedRating,
    location: safeLocation,
    isAlcoholic: isAlcoholic !== false,
    createdAt: new Date().toISOString(),
    cheersCount: 0,
    tags: [],
    imageUrl: normalizedImage.dataUrl,
    isPartner: true,
  };
  drinks.unshift(newDrink);
  const limitEvent = recordLimitEvent(currentUserId, {
    kind: 'post',
    at: newDrink.createdAt,
    imageBytes: newDrink.imageUrl.length,
  });
  if (!saveDbOrRespond(res)) {
    drinks.shift();
    removeLimitEvent(currentUserId, limitEvent);
    nextDrinkId = newDrink.id;
    return;
  }
  res.status(201).json(decorateDrink(newDrink, currentUserId));
});

// No growth check: a deletion is how storage gets freed once it is full.
app.delete('/api/drinks/:id', requireAuth, (req, res) => {
  const drinkId = parsePositiveInteger(req.params.id);
  const drink = drinks.find((d) => d.id === drinkId);
  if (!drink) return res.status(404).json({ error: 'Drink not found' });
  if (drink.userId !== req.userId) {
    return isBlockedBetween(drink.userId, req.userId)
      ? res.status(404).json({ error: 'Drink not found' })
      : res.status(403).json({ error: 'Forbidden' });
  }
  const restoreDrink = deleteDrinkCascade(drinkId);
  if (!saveDbOrRespond(res)) {
    restoreDrink();
    return;
  }
  res.status(204).end();
});

app.post('/api/drinks/:id/like', requireAuth, (req, res) => {
  const currentUserId = req.userId;
  const drinkId = parsePositiveInteger(req.params.id);
  const drink = drinks.find((d) => d.id === drinkId);
  if (!drink) return res.status(404).json({ error: 'Drink not found' });
  if (!canViewDrink(drink, currentUserId)) return respondDrinkHidden(res, drink, currentUserId);

  const likedSet = cheersByUser.get(currentUserId) || new Set();
  if (likedSet.has(drink.id)) {
    likedSet.delete(drink.id);
    drink.cheersCount = Math.max(0, (drink.cheersCount || 0) - 1);
  } else {
    if (isDbGrowthBlocked()) return respondDbGrowthBlocked(res);
    likedSet.add(drink.id);
    drink.cheersCount = (drink.cheersCount || 0) + 1;
    if (drink.userId !== currentUserId) {
      pushNotification(drink.userId, currentUserId, 'cheer', `${getDisplayName(currentUserId)} cheered your drink ${drink.name}.`, drink.id);
    }
  }
  cheersByUser.set(currentUserId, likedSet);
  if (!saveDbOrRespond(res)) return;
  res.json({ cheered: likedSet.has(drink.id), cheersCount: drink.cheersCount });
});

app.post('/api/drinks/:id/save', requireAuth, (req, res) => {
  const currentUserId = req.userId;
  const drinkId = parsePositiveInteger(req.params.id);
  const drink = drinks.find((d) => d.id === drinkId);
  if (!drink) return res.status(404).json({ error: 'Drink not found' });
  if (!canViewDrink(drink, currentUserId)) return respondDrinkHidden(res, drink, currentUserId);

  const savedSet = savedByUser.get(currentUserId) || new Set();
  if (savedSet.has(drink.id)) {
    savedSet.delete(drink.id);
  } else {
    if (isDbGrowthBlocked()) return respondDbGrowthBlocked(res);
    savedSet.add(drink.id);
  }
  savedByUser.set(currentUserId, savedSet);
  if (!saveDbOrRespond(res)) return;
  res.json({ saved: savedSet.has(drink.id) });
});

app.get('/api/users/:userId/saved-drinks', requireAuth, (req, res) => {
  // A saved list is private: only its owner may read it.
  if (req.userId !== req.params.userId) return res.status(403).json({ error: 'Forbidden' });
  const page = parsePageParams(req.query);
  if (!page) return respondInvalidPage(res);
  const currentUserId = req.userId;
  const savedSet = savedByUser.get(req.params.userId) || new Set();
  const { items, nextCursor } = paginateById(drinks.filter((d) => savedSet.has(d.id) && canViewDrink(d, currentUserId)), page);
  res.json({ items: items.map((d) => decorateDrink(d, currentUserId)), nextCursor });
});

app.get('/api/notifications', requireAuth, (req, res) => {
  // Hidden, not removed: an unblock brings them back. Older ones hold no actorId and stay until they expire.
  const list        = cleanupNotifications(req.userId).filter((n) => !isBlockedBetween(req.userId, n.actorId));
  const unreadCount = list.filter((n) => !n.read).length;
  res.json({ notifications: list.map((n) => toVisibleNotification(n, req.userId)), unreadCount });
});

app.post('/api/notifications/read', requireAuth, (req, res) => {
  const list = cleanupNotifications(req.userId);
  list.forEach((n) => { n.read = true; });
  notificationsByUser.set(req.userId, list);
  if (!saveDbOrRespond(res)) return;
  res.json({ success: true });
});

const SMART_BAR_NAME_MAX_LENGTH     = 120;
const SMART_BAR_QUANTITY_MAX_LENGTH = 60;
const SMART_BAR_UNIT_MAX_LENGTH     = 60;
const SMART_BAR_MAX_ITEMS           = 500;

app.get('/api/smart-bar', requireAuth, (req, res) => {
  res.json(ensureSmartBar(req.userId));
});

app.post('/api/smart-bar', requireAuth, (req, res) => {
  const userId    = req.userId;
  const bar       = ensureSmartBar(userId);
  const { name, quantity, unit } = req.body || {};
  const hasValidTypes =
    typeof name === 'string' &&
    (typeof quantity === 'string' || typeof quantity === 'number') &&
    (unit === undefined || typeof unit === 'string');
  if (!hasValidTypes) return res.status(400).json({ error: 'Invalid name, quantity or unit' });
  const cleanName     = sanitizeText(name, SMART_BAR_NAME_MAX_LENGTH);
  const cleanQuantity = sanitizeText(String(quantity), SMART_BAR_QUANTITY_MAX_LENGTH);
  const cleanUnit     = unit === undefined ? 'bottle' : sanitizeText(unit, SMART_BAR_UNIT_MAX_LENGTH);
  if (!cleanName || !cleanQuantity || !cleanUnit) {
    return res.status(400).json({ error: 'Invalid name, quantity or unit' });
  }
  // Checked before the id spread below, so a list over the cap never reaches it.
  if (bar.length >= SMART_BAR_MAX_ITEMS) {
    return res.status(429).json({ error: 'Your Smart Bar is full. Remove an item to add a new one.', code: 'smart_bar_limit' });
  }
  if (isDbGrowthBlocked()) return respondDbGrowthBlocked(res);
  const newItem = {
    id: Math.max(0, ...bar.map((i) => i.id)) + 1,
    name:     cleanName,
    quantity: cleanQuantity,
    unit:     cleanUnit,
  };
  bar.push(newItem);
  if (!saveDbOrRespond(res)) {
    bar.pop();
    return;
  }
  res.status(201).json(newItem);
});

app.delete('/api/smart-bar/:itemId', requireAuth, (req, res) => {
  const userId = req.userId;
  const bar    = ensureSmartBar(userId);
  const index  = bar.findIndex((i) => i.id === Number(req.params.itemId));
  if (index === -1) return res.status(404).json({ error: 'Item not found' });
  bar.splice(index, 1);
  if (!saveDbOrRespond(res)) return;
  res.status(204).end();
});

// ── Blocking ──────────────────────────────────────────────────────────────────
const BLOCKS_MAX_PER_USER = 200;

// Only the caller's own blocks. Who blocked the caller is never shown.
app.get('/api/blocks', requireAuth, (req, res) => {
  const blocked = Array.from(blocksByUser.get(req.userId) ?? []);
  res.json(blocked.map((id) => {
    const user = isLiveAccount(id) ? toPublicUser(userIndex.get(id)) : undefined;
    if (!user || !hasBlocked(id, req.userId)) return user;
    // They blocked the caller too, so only what the caller needs to recognize the entry.
    return { id: user.id, firstName: user.firstName, lastName: user.lastName };
  }).filter(Boolean));
});

app.post('/api/blocks/:targetId', requireAuth, (req, res) => {
  const userId   = req.userId;
  const targetId = req.params.targetId;
  if (targetId === userId)      return res.status(400).json({ error: 'Cannot block yourself' });
  if (!isLiveAccount(targetId)) return res.status(404).json({ error: 'User not found' });
  if (hasBlocked(userId, targetId)) return res.json({ blocked: true });
  const previousBlocks = blocksByUser.get(userId);
  if ((previousBlocks?.size ?? 0) >= BLOCKS_MAX_PER_USER) {
    return res.status(429).json({ error: 'You have blocked too many users.', code: 'block_limit' });
  }
  // No growth check: a user can always protect themselves, and the cap above bounds what this adds.

  // The earlier Sets are kept whole, so a restored one also keeps its order in the saved file.
  const previousUserPartners   = ensurePartnerSet(userId);
  const previousTargetPartners = ensurePartnerSet(targetId);
  const withoutId = (set, id) => new Set(Array.from(set).filter((item) => item !== id));
  const previousUserRequests   = partnerRequestsByUser.get(userId);
  const previousTargetRequests = partnerRequestsByUser.get(targetId);
  blocksByUser.set(userId, new Set(previousBlocks).add(targetId));
  partnersByUser.set(userId, withoutId(previousUserPartners, targetId));
  partnersByUser.set(targetId, withoutId(previousTargetPartners, userId));
  clearPartnerRequestsBetween(userId, targetId);
  if (!saveDbOrRespond(res)) {
    if (previousBlocks) blocksByUser.set(userId, previousBlocks);
    else blocksByUser.delete(userId);
    partnersByUser.set(userId, previousUserPartners);
    partnersByUser.set(targetId, previousTargetPartners);
    if (previousUserRequests) partnerRequestsByUser.set(userId, previousUserRequests);
    if (previousTargetRequests) partnerRequestsByUser.set(targetId, previousTargetRequests);
    return;
  }
  res.json({ blocked: true });
});

// Stays open at the storage limit, because it only removes. The partnership and any request do not come back.
app.delete('/api/blocks/:targetId', requireAuth, (req, res) => {
  const userId   = req.userId;
  const targetId = req.params.targetId;
  const previousBlocks = blocksByUser.get(userId);
  if (!previousBlocks?.has(targetId)) return res.status(204).end();
  const remaining = new Set(previousBlocks);
  remaining.delete(targetId);
  if (remaining.size > 0) blocksByUser.set(userId, remaining);
  else blocksByUser.delete(userId);
  if (!saveDbOrRespond(res)) {
    blocksByUser.set(userId, previousBlocks);
    return;
  }
  res.status(204).end();
});

// ── Reports and moderation ────────────────────────────────────────────────────
const REPORT_TARGET_TYPES = new Set(['drink', 'comment', 'user']);
const REPORT_REASONS = new Set(['spam', 'harassment', 'underage', 'dangerous_drinking', 'mislabeled_alcohol', 'other']);
const REPORT_DETAILS_MAX_LENGTH = 300;
const REPORT_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const REPORT_LIMIT_MAX_COUNT = 20;
const ADMIN_REPORTS_MAX_ITEMS = 100;

// Read once at start. Empty means nobody, so every admin route answers 403.
const ADMIN_USER_IDS = new Set(
  (process.env.ADMIN_USER_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean)
);

// Counts only: these ids stay out of the logs. A new admin who has not signed in yet counts as unknown.
const unknownAdminCount = Array.from(ADMIN_USER_IDS).filter((id) => !userIndex.has(id)).length;
if (ADMIN_USER_IDS.size === 0 && isProduction) {
  console.warn('[moderation] ADMIN_USER_IDS is empty: nobody can review reports.');
} else if (unknownAdminCount > 0) {
  console.warn(`[moderation] ADMIN_USER_IDS: ${unknownAdminCount} of ${ADMIN_USER_IDS.size} match no known user.`);
}

// Runs after requireAuth, so logged out stays 401.
const requireAdmin = (req, res, next) => {
  if (!ADMIN_USER_IDS.has(req.userId)) return res.status(403).json({ error: 'Forbidden' });
  next();
};

// Post and comment ids can come as a number or as digits. Returns null for anything else.
const parseReportTargetId = (targetType, targetId) => {
  if (targetType === 'user') return typeof targetId === 'string' && targetId ? targetId : null;
  return parsePositiveInteger(typeof targetId === 'number' ? String(targetId) : targetId);
};

const findComment = (commentId) => {
  for (const [drinkId, comments] of commentsByDrink) {
    const comment = comments.find((item) => item?.id === commentId);
    if (comment) return { comment, drinkId };
  }
  return null;
};

// Who owns the target, if this viewer may see it. Null covers missing, hidden by age and blocked alike.
const findVisibleTargetOwner = (targetType, targetId, viewerId) => {
  if (targetType === 'user') {
    return isLiveAccount(targetId) && !isBlockedBetween(targetId, viewerId) ? targetId : null;
  }
  if (targetType === 'drink') {
    const drink = drinks.find((d) => d.id === targetId);
    return drink && !isAccountDeletionPending(drink.userId) && canViewDrink(drink, viewerId) ? drink.userId : null;
  }
  const found = findComment(targetId);
  const drink = found && drinks.find((d) => d.id === found.drinkId);
  return drink && !isAccountDeletionPending(found.comment.userId) && canViewDrink(drink, viewerId) && !isBlockedBetween(found.comment.userId, viewerId)
    ? found.comment.userId
    : null;
};

// The answer holds only the id: reporter and details are for admins.
app.post('/api/reports', requireAuth, (req, res) => {
  const reporterId = req.userId;
  const { targetType, reason, details } = req.body || {};
  if (!REPORT_TARGET_TYPES.has(targetType) || !REPORT_REASONS.has(reason)) {
    return res.status(400).json({ error: 'Invalid report' });
  }
  if (details !== undefined && details !== null && typeof details !== 'string') {
    return res.status(400).json({ error: 'Invalid report' });
  }
  const targetId = parseReportTargetId(targetType, req.body.targetId);
  if (targetId === null) return res.status(400).json({ error: 'Invalid report' });

  const ownerId = findVisibleTargetOwner(targetType, targetId, reporterId);
  if (!ownerId) return res.status(404).json({ error: 'Not found' });
  if (ownerId === reporterId) return res.status(400).json({ error: 'Cannot report your own content' });

  // findVisibleTargetOwner found the comment, so this is set for a comment target.
  const commentDrinkId = targetType === 'comment' ? findComment(targetId).drinkId : undefined;
  // Open reports only, so repeat behaviour can be reported after a resolution.
  const existing = reports.find((r) => (
    r.status === 'open' && r.reporterId === reporterId && r.targetType === targetType && r.targetId === targetId && r.drinkId === commentDrinkId
  ));
  if (existing) return res.json({ id: existing.id });

  const windowStart = Date.now() - REPORT_LIMIT_WINDOW_MS;
  const recentCount = reports.filter((r) => r.reporterId === reporterId && new Date(r.createdAt).getTime() > windowStart).length;
  if (recentCount >= REPORT_LIMIT_MAX_COUNT) {
    return res.status(429).json({ error: 'Daily report limit reached. Please try again tomorrow.', code: 'daily_report_limit' });
  }
  if (isDbGrowthBlocked()) return respondDbGrowthBlocked(res);

  const report = {
    id: nextReportId++,
    reporterId,
    targetType,
    targetId,
    ...(commentDrinkId !== undefined && { drinkId: commentDrinkId }),
    reason,
    details: sanitizeOptional(details, REPORT_DETAILS_MAX_LENGTH) || null,
    status: 'open',
    createdAt: new Date().toISOString(),
  };
  reports.push(report);
  if (!saveDbOrRespond(res)) {
    reports.pop();
    nextReportId = report.id;
    return;
  }
  res.status(201).json({ id: report.id });
});

// Public fields only, so the target user's email never reaches a report. Null once the target is gone.
const toAdminReportTarget = ({ targetType, targetId, drinkId }) => {
  if (targetType === 'user') return toPublicUser(userIndex.get(targetId)) ?? null;
  if (targetType === 'drink') {
    const drink = drinks.find((d) => d.id === targetId);
    if (!drink) return null;
    const { id, userId, name, description, location, isAlcoholic, createdAt } = drink;
    return { id, userId, name, description, location, isAlcoholic, createdAt, imageUrl: toDrinkImageUrl(drink), user: toPublicUser(userIndex.get(userId)) };
  }
  const comment = (commentsByDrink.get(drinkId) ?? []).find((item) => item?.id === targetId);
  if (!comment) return null;
  const { id, userId, content, createdAt } = comment;
  return { id, drinkId, userId, content, createdAt, user: toPublicUser(userIndex.get(userId)) };
};
const toAdminReport = (report) => ({ ...report, target: toAdminReportTarget(report) });

// Oldest first and with no paging, so working through the queue reaches every report.
app.get('/api/admin/reports', requireAuth, requireAdmin, (req, res) => {
  const { status = 'open' } = req.query;
  if (status !== 'open' && status !== 'resolved') return res.status(400).json({ error: 'Invalid status' });
  const matching = reports.filter((r) => r.status === status);
  res.json({ items: matching.slice(0, ADMIN_REPORTS_MAX_ITEMS).map(toAdminReport), total: matching.length });
});

// Returns the undo, or null when the target is already gone.
const removeReportTarget = ({ targetType, targetId, drinkId }) => {
  if (targetType === 'drink') return deleteDrinkCascade(targetId);
  if (targetType === 'user') return clearUserProfile(targetId);
  return deleteCommentFromDrink(drinkId, targetId);
};

// Either action resolves every open report on the same target. No growth check: this frees storage.
app.post('/api/admin/reports/:id/resolve', requireAuth, requireAdmin, (req, res) => {
  const reportId = parsePositiveInteger(req.params.id);
  const report = reports.find((r) => r.id === reportId);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  const { action } = req.body || {};
  if (!['dismiss', 'remove_content', 'clear_profile'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  if (action === 'remove_content' && report.targetType === 'user') {
    return res.status(400).json({ error: 'A user cannot be removed this way' });
  }
  if (action === 'clear_profile' && report.targetType !== 'user') {
    return res.status(400).json({ error: 'Only a user profile can be cleared' });
  }
  if (report.status !== 'open') return res.status(409).json({ error: 'Report already resolved' });

  const undoRemoval = action === 'dismiss' ? null : removeReportTarget(report);
  const removed = Boolean(undoRemoval); // false for a target that was already gone
  const resolvedAt = new Date().toISOString();
  const resolved = reports.filter((r) => (
    r.status === 'open' && r.targetType === report.targetType && r.targetId === report.targetId && r.drinkId === report.drinkId
  ));
  const previousDetails = resolved.map((item) => item.details);
  for (const item of resolved) Object.assign(item, { status: 'resolved', action, removed, details: null, resolvedAt, resolvedBy: req.userId });
  pruneResolvedReporters();
  if (!saveDbOrRespond(res)) {
    undoRemoval?.();
    resolved.forEach((item, index) => {
      item.status = 'open';
      item.details = previousDetails[index];
      delete item.action;
      delete item.removed;
      delete item.resolvedAt;
      delete item.resolvedBy;
    });
    return;
  }
  res.json(toAdminReport(report));
});

// ── AI endpoints (off unless AI_ENABLED=true; the client flags are separate) ───
const AI_MODEL = 'gpt-4o-mini';
const AI_RECIPES_MAX_OUTPUT_TOKENS = 3000;
const AI_DETECT_MAX_OUTPUT_TOKENS = 100;
const AI_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const AI_RATE_LIMIT_MAX = 20;

const AI_INGREDIENTS_MAX_COUNT = 50;
const AI_INGREDIENT_MAX_LENGTH = 120;
const AI_PRODUCT_NAME_MAX_LENGTH = 120;

const AI_OUTPUT_MAX_RECIPES = 5;
const AI_OUTPUT_MAX_RECIPE_INGREDIENTS = 20;
const AI_OUTPUT_MAX_TITLE_LENGTH = 120;
const AI_OUTPUT_MAX_INGREDIENT_NAME_LENGTH = 120;
const AI_OUTPUT_MAX_GARNISH_LENGTH = 120;
const AI_OUTPUT_MAX_INSTRUCTIONS_LENGTH = 2000;
const AI_OUTPUT_MAX_PRODUCT_NAME_LENGTH = 120;
const AI_OUTPUT_MAX_AMOUNT_OZ = 17;
const AI_OUTPUT_MAX_AMOUNT_ML = 500;
const ML_PER_OZ = 29.5735;
const AI_ALLOWED_DIFFICULTIES = ['easy', 'medium', 'hard', 'mocktail'];

// Fixed rules go in the instructions parameter, apart from the text that comes from the user.
const AI_NON_ALCOHOLIC_RULE = 'Every recipe must have difficulty "mocktail" and contain zero alcohol: no spirits, no liqueurs, no wine or beer, and no alcoholic bitters.';
const AI_RECIPE_OUTPUT_RULES = `- Each recipe is one standard serving; no challenges, intoxication goals, or claims about performance or social success.
- List ingredient quantities in both ounces and milliliters.
- Respond strictly as JSON matching this schema:
{
  "recipes": [
    {
      "title": "string",
      "difficulty": "easy|medium|hard|mocktail",
      "ingredients": [
        { "name": "string", "amount_oz": number, "amount_ml": number }
      ],
      "garnish": "string | null",
      "instructions": "string"
    }
  ]
}`;
const AI_SMART_BAR_INSTRUCTIONS = `You are a professional mixologist. Create 5 unique cocktail/drink recipes using ONLY the available ingredients in the user message (plus standard mixers like juice, soda, sugar, bitters, ice).

Rules:
- Create 5 recipes total: 1 easy, 2 medium, 1 hard, 1 mocktail (no alcohol).
- Only use ingredients from the provided list plus common pantry items (lime juice, lemon juice, simple syrup, soda water, tonic water, ice, salt, sugar, bitters, mint, etc.).
${AI_RECIPE_OUTPUT_RULES}`;
const AI_SMART_BAR_NON_ALCOHOLIC_INSTRUCTIONS = `You are a professional mixologist. Create 5 unique mocktail recipes using ONLY the non-alcoholic ingredients in the user message (plus standard mixers like juice, soda, sugar, ice). Leave out any alcoholic ingredient on the list.

Rules:
- ${AI_NON_ALCOHOLIC_RULE}
- Only use ingredients from the provided list plus common pantry items (lime juice, lemon juice, simple syrup, soda water, tonic water, ice, salt, sugar, mint, etc.).
${AI_RECIPE_OUTPUT_RULES}`;
const AI_PRODUCT_RECIPE_INSTRUCTIONS = `You are a professional mixologist. Using the product named in the user message, craft 5 unique recipes.
- Create 5 recipes total: 1 easy, 2 medium and 1 hard alcoholic cocktail, and 1 mocktail (no alcohol).
${AI_RECIPE_OUTPUT_RULES}`;
const AI_PRODUCT_NON_ALCOHOLIC_INSTRUCTIONS = `You are a professional mixologist. Using the product named in the user message, craft 5 unique mocktail recipes.
- ${AI_NON_ALCOHOLIC_RULE}
- If the product contains alcohol, do not use it; suggest alcohol-free recipes in a similar style.
${AI_RECIPE_OUTPUT_RULES}`;
const AI_DETECT_INSTRUCTIONS = 'You are a product recognition expert. From the image provided, extract the product name as specifically as possible (brand + product if possible), and determine whether it is alcoholic or non-alcoholic. Return strictly JSON with keys: productName (string), isAlcoholic (boolean).';

// Runs before multer and the limiter, so a disabled route neither reads an upload nor uses up the limit.
const requireAiEnabled = (req, res, next) => {
  if (!openai) return res.status(503).json({ error: 'AI features are unavailable', code: 'ai_disabled' });
  next();
};

// One budget for all three routes, because each request costs money.
const aiLimiter = rateLimit({
  windowMs: AI_RATE_LIMIT_WINDOW_MS,
  max: AI_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId, // always set: this runs after requireAuth
  message: { error: 'Too many AI requests. Try again later.', code: 'ai_rate_limit' },
});

// Not sanitizeText: a prompt also needs format characters, quotes and repeated spaces removed.
// This limits how far input can leave its place in the prompt, but it cannot stop prompt injection:
// the text still reaches the model, so the output caps below are what bound the result.
const cleanPromptInput = (value) => (
  value
    .toWellFormed()
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
);

// Returns the cleaned list, or null if any item is invalid. Items are joined with commas in the prompt.
const parseIngredients = (value) => {
  if (!Array.isArray(value) || value.length === 0 || value.length > AI_INGREDIENTS_MAX_COUNT) return null;
  const ingredients = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    // Unescaped first: a client holding text from before the schema migration can still send entities.
    const cleaned = cleanPromptInput(validator.unescape(item).replace(/[,;]/g, ' '));
    if (!cleaned || cleaned.length > AI_INGREDIENT_MAX_LENGTH) return null;
    ingredients.push(cleaned);
  }
  return ingredients;
};

const parseProductName = (value) => {
  if (typeof value !== 'string') return null;
  const cleaned = cleanPromptInput(validator.unescape(value));
  return cleaned && cleaned.length <= AI_PRODUCT_NAME_MAX_LENGTH ? cleaned : null;
};

// Upstream values can only reach the log if they look like a short identifier.
const toLogToken = (value) => (typeof value === 'string' && /^[\w.-]{1,64}$/.test(value) ? value : undefined);

// Upstream messages can quote a masked API key, so only the type, code and status are logged or kept.
const createAiResponse = async (instructions, content, maxOutputTokens) => {
  try {
    return await openai.responses.create({
      model: AI_MODEL,
      instructions,
      input: [{ role: 'user', content }],
      text: { format: { type: 'json_object' } },
      max_output_tokens: maxOutputTokens,
      store: false,
    });
  } catch (err) {
    const status = Number.isInteger(err?.status) ? err.status : undefined;
    console.warn('[ai] Upstream request failed:', toLogToken(err?.type) ?? toLogToken(err?.constructor?.name), toLogToken(err?.code), status);
    throw createAppError(502, 'AI request failed', 'ai_upstream_error');
  }
};

// Returns the parsed value, or null. A parse error message can quote AI output, so only its type is logged.
const parseAiJson = (rawText) => {
  let parsed = (typeof rawText === 'string' ? rawText : '').trim();
  if (parsed.startsWith('```')) parsed = parsed.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  if (!parsed.startsWith('{')) { const m = parsed.match(/\{[\s\S]*\}/); if (m) parsed = m[0]; }
  try {
    return JSON.parse(parsed);
  } catch (e) {
    console.warn('[ai] Could not parse AI output:', e.name);
    return null;
  }
};

// Not sanitizeText: this text is not stored, so it only needs a cap. Saving it later goes through
// the sanitized routes.
const capAiText = (value, maxLength) => (
  typeof value === 'string'
    ? validator.stripLow(value, true).trim().slice(0, maxLength).toWellFormed().trim()
    : ''
);

const toAiAmount = (value, maxAmount) => {
  // Leading number only, so "1/2 oz" gives 1 and cannot join its digits into 12.
  const amount = typeof value === 'string' ? parseFloat(value) : value;
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? Math.min(amount, maxAmount) : 0;
};

const normalizeAiIngredient = (ingredient) => {
  const name = capAiText(ingredient?.name, AI_OUTPUT_MAX_INGREDIENT_NAME_LENGTH);
  if (!name) return null;
  const amountOz = toAiAmount(ingredient.amount_oz, AI_OUTPUT_MAX_AMOUNT_OZ);
  const amountMl = toAiAmount(ingredient.amount_ml, AI_OUTPUT_MAX_AMOUNT_ML)
    || Math.min(Math.round(amountOz * ML_PER_OZ), AI_OUTPUT_MAX_AMOUNT_ML);
  return { name, amount_oz: amountOz, amount_ml: amountMl };
};

const normalizeAiRecipe = (recipe) => {
  const difficulty = typeof recipe?.difficulty === 'string' ? recipe.difficulty.toLowerCase() : '';
  return {
    title: capAiText(recipe?.title, AI_OUTPUT_MAX_TITLE_LENGTH),
    difficulty: AI_ALLOWED_DIFFICULTIES.includes(difficulty) ? difficulty : 'medium',
    ingredients: (Array.isArray(recipe?.ingredients) ? recipe.ingredients : [])
      .map(normalizeAiIngredient)
      .filter(Boolean)
      .slice(0, AI_OUTPUT_MAX_RECIPE_INGREDIENTS),
    garnish: capAiText(recipe?.garnish, AI_OUTPUT_MAX_GARNISH_LENGTH) || null,
    instructions: capAiText(recipe?.instructions, AI_OUTPUT_MAX_INSTRUCTIONS_LENGTH),
  };
};

// The model can call anything a mocktail, so the text of a mocktail-only answer is checked too. This is a
// safety net with known limits: a drink it does not list gets through, and "non-alcoholic beer" is dropped.
// All of these are matched after toAlcoholCheckText, so they are written without diacritics.
const AI_ALCOHOL_WORDS = [
  'whisky', 'whiskey', 'whiskies', 'whiskeys', 'bourbon', 'scotch', 'vodka', 'vodkas', 'gin', 'gins', 'rum', 'rums',
  'tequila', 'tequilas', 'mezcal', 'brandy', 'brandies', 'cognac', 'armagnac', 'liqueur', 'liqueurs', 'liquor', 'liquors',
  'spirit', 'spirits', 'wine', 'wines', 'beer', 'beers', 'lager', 'lagers', 'stout', 'porter', 'ipa', 'pale ale', 'brown ale',
  'cider', 'ciders', 'hard seltzer', 'champagne', 'prosecco', 'cava', 'sake', 'soju', 'mead', 'vermouth', 'bitters', 'amaro',
  'campari', 'aperol', 'absinthe', 'sambuca', 'ouzo', 'grappa', 'pastis', 'kahlua', 'baileys', 'cointreau', 'triple sec',
  'curacao', 'schnapps', 'sherry', 'madeira', 'marsala', 'jagermeister', 'limoncello', 'amaretto', 'pisco', 'cachaca',
  'alcohol', 'alcoholic', 'alcoholice',
  'tuica', 'tuici', 'palinca', 'palinci', 'horinca', 'rachiu', 'rachiuri', 'rakia', 'vin', 'vinuri', 'bere', 'beri',
  'lichior', 'lichioruri', 'coniac', 'coniacuri', 'votca', 'vodca', 'rom', 'sampanie', 'spumant', 'cidru', 'vermut',
  'visinata', 'afinata', 'tarie', 'tarii', 'alcool', 'alcoolic', 'alcoolica', 'alcoolice',
];
const toAlcoholWordPattern = (word) => word.replace(/ /g, '[\\s-]+');
const AI_ALCOHOL_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${AI_ALCOHOL_WORDS.map(toAlcoholWordPattern).join('|')})(?![\\p{L}\\p{N}])`,
  'u'
);
// Removed before the check, because they name no alcoholic drink. "nonalcoholic" needs no entry: it is one word.
const AI_ALCOHOL_FREE_PHRASES = /(?<![\p{L}\p{N}])(?:(?:non|no|zero|without|fara)[\s-]+(?:alcoholic|alcohol|alcoolica|alcoolice|alcoolic|alcool)|(?:alcohol|alcool)[\s-]*free|ginger[\s-]+beer|root[\s-]+beer|bere[\s-]+de[\s-]+ghimbir|(?:wine|beer)[\s-]*glass(?:es)?|pahar(?:e)?[\s-]+de[\s-]+(?:vin|bere)|(?:wine|cider)[\s-]+vinegar|otet[\s-]+de[\s-]+vin)(?![\p{L}\p{N}])/gu;

// Removes accents and invisible format characters, so neither can hide a word.
const toAlcoholCheckText = (value) => value.normalize('NFKD').replace(/[\p{M}\p{Cf}]/gu, '').toLowerCase();

const mentionsAlcohol = ({ title, ingredients, garnish, instructions }) => AI_ALCOHOL_PATTERN.test(
  toAlcoholCheckText([title, ...ingredients.map((ingredient) => ingredient.name), garnish ?? '', instructions].join('\n'))
    .replace(AI_ALCOHOL_FREE_PHRASES, ' ')
);

// inputText also names JSON, because the json_object format may check the input messages for that word.
const generateAiRecipes = async (instructions, inputText, { mocktailsOnly }) => {
  const response = await createAiResponse(instructions, [{ type: 'input_text', text: inputText }], AI_RECIPES_MAX_OUTPUT_TOKENS);
  const data = parseAiJson(response.output_text);
  if (!Array.isArray(data?.recipes)) throw createAppError(502, 'Invalid AI output', 'ai_invalid_output');
  const recipes = data.recipes
    .map(normalizeAiRecipe)
    .filter((r) => r.title && r.instructions && r.ingredients.length > 0)
    .filter((r) => !mocktailsOnly || (r.difficulty === 'mocktail' && !mentionsAlcohol(r)))
    .slice(0, AI_OUTPUT_MAX_RECIPES);
  if (recipes.length === 0) throw createAppError(502, 'Invalid AI output', 'ai_invalid_output');
  return recipes;
};

app.post('/api/smart-bar/generate-recipes', requireAuth, requireAiEnabled, aiLimiter, async (req, res, next) => {
  try {
    const ingredients = parseIngredients(req.body?.ingredients);
    if (!ingredients) return res.status(400).json({ error: 'Invalid ingredients' });
    const nonAlcoholicOnly = req.body?.nonAlcoholicOnly;
    if (nonAlcoholicOnly !== undefined && typeof nonAlcoholicOnly !== 'boolean') {
      return res.status(400).json({ error: 'Invalid nonAlcoholicOnly' });
    }
    // An unconfirmed user gets mocktails whatever the client asked for, with no error.
    // The unconfirmed case is defence in depth: requireSignedInAdult refuses it before this route.
    const mocktailsOnly = nonAlcoholicOnly === true || !isAgeConfirmed(req.userId);
    const instructions = mocktailsOnly ? AI_SMART_BAR_NON_ALCOHOLIC_INSTRUCTIONS : AI_SMART_BAR_INSTRUCTIONS;
    const inputText = `Available ingredients: ${ingredients.join(', ')}. Respond in JSON.`;
    res.json(await generateAiRecipes(instructions, inputText, { mocktailsOnly }));
  } catch (err) { next(err); }
});

const handleDetectProduct = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Missing image file' });
    const image = validateImageBytes(req.file.buffer, AI_IMAGE_RULES);
    if (image.error) return res.status(image.status).json({ error: image.error });
    const response = await createAiResponse(
      AI_DETECT_INSTRUCTIONS,
      [{ type: 'input_text', text: 'Identify the product in this image. Respond in JSON.' }, { type: 'input_image', image_url: image.dataUrl, detail: 'low' }],
      AI_DETECT_MAX_OUTPUT_TOKENS,
    );
    const data = parseAiJson(response.output_text);
    const productName = capAiText(data?.productName, AI_OUTPUT_MAX_PRODUCT_NAME_LENGTH);
    if (!productName) return res.json({ error: 'Product not recognized, please try again.' });
    // An unknown value counts as alcoholic, the safer side for a drinks app.
    res.json({ productName, isAlcoholic: data.isAlcoholic !== false });
  } catch (error) { next(error); }
};
app.post('/api/detect-product', requireAuth, requireAiEnabled, aiLimiter, parseUpload(aiImageUpload.single('image')), handleDetectProduct);

app.post('/api/generate-recipes', requireAuth, requireAiEnabled, aiLimiter, async (req, res, next) => {
  try {
    const { isAlcoholic } = req.body || {};
    const productName = parseProductName(req.body?.productName);
    if (!productName) return res.status(400).json({ error: 'Invalid productName' });
    if (isAlcoholic !== undefined && typeof isAlcoholic !== 'boolean') {
      return res.status(400).json({ error: 'Invalid isAlcoholic' });
    }
    // An unconfirmed user gets mocktails whatever the client asked for, with no error.
    // The unconfirmed case is defence in depth: requireSignedInAdult refuses it before this route.
    const mocktailsOnly = isAlcoholic === false || !isAgeConfirmed(req.userId);
    const instructions = mocktailsOnly ? AI_PRODUCT_NON_ALCOHOLIC_INSTRUCTIONS : AI_PRODUCT_RECIPE_INSTRUCTIONS;
    const inputText = `Product: "${productName}". Respond in JSON.`;
    res.json({ recipes: await generateAiRecipes(instructions, inputText, { mocktailsOnly }) });
  } catch (error) { next(error); }
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Image too large' });
    return res.status(400).json({ error: 'Invalid upload' });
  }
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
  if (err.isAppError) return res.status(status).json({ error: err.message, ...(err.code && { code: err.code }) });
  // Messages from libraries can quote input or upstream text, so they never reach the client.
  if (status >= 500) console.error(err);
  return res.status(status).json({ error: status >= 500 ? 'Internal server error' : 'Request could not be processed' });
});

// ── Backup retention ──────────────────────────────────────────────────────────
// Corrupt and pre-migration backups hold personal data, including of deleted accounts, and cannot be
// edited person by person. The app tells users they are gone within 40 days: these 30, plus up to 7 for
// the recovery hold below, and a little for a purge that waits for a healthy start.
const DEFAULT_DB_BACKUP_RETENTION_DAYS = 30;
const DB_BACKUP_RETENTION_MAX_DAYS = 36_500; // keeps the dates below valid
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DB_BACKUP_PURGE_INTERVAL_MS = parseTestOnlyLimit(process.env.DB_BACKUP_PURGE_INTERVAL_MS, MS_PER_DAY);
const DB_BACKUP_PURGE_MIN_WAIT_MS = 1000;
const DB_BACKUP_MARKERS = ['.corrupt-', '.pre-migration-'];
// Exactly what Date.now() writes in a backup's name, so a name with other digits is not a backup of ours.
const DB_BACKUP_TIMESTAMP_PATTERN = /^[1-9]\d{12}$/;

const parseBackupRetentionDays = (rawValue) => {
  const value = (rawValue ?? '').trim();
  if (!value) return DEFAULT_DB_BACKUP_RETENTION_DAYS;
  if (/^[1-9]\d*$/.test(value) && Number(value) <= DB_BACKUP_RETENTION_MAX_DAYS) return Number(value);
  console.warn(`[config] CORRUPT_BACKUP_RETENTION_DAYS must be a whole number from 1 to ${DB_BACKUP_RETENTION_MAX_DAYS} — using ${DEFAULT_DB_BACKUP_RETENTION_DAYS}.`);
  return DEFAULT_DB_BACKUP_RETENTION_DAYS;
};
const DB_BACKUP_RETENTION_DAYS = parseBackupRetentionDays(process.env.CORRUPT_BACKUP_RETENTION_DAYS);
if (DB_BACKUP_RETENTION_DAYS > DEFAULT_DB_BACKUP_RETENTION_DAYS) {
  console.warn(`[config] CORRUPT_BACKUP_RETENTION_DAYS is above ${DEFAULT_DB_BACKUP_RETENTION_DAYS}, but the app tells users backups are removed within 40 days, which assumes ${DEFAULT_DB_BACKUP_RETENTION_DAYS}.`);
}

// Held after a start that lost its data, however many restarts follow: an empty database with old
// backups beside it is what recovery looks like, and those backups may be the only copy. It also starts
// when the last user leaves. It always ends: the saved time stays while there are no users, so a
// restart cannot start it again and the 30-day promise still holds after the last account is deleted.
const DB_RECOVERY_PURGE_HOLD_MS = parseTestOnlyLimit(process.env.DB_RECOVERY_PURGE_HOLD_MS, 7 * MS_PER_DAY);

const isDbBackupPurgeHeld = () => {
  if (recoveryStartedAt === undefined) {
    if (userIndex.size > 0) return false;
    recoveryStartedAt = Date.now();
    saveDb();
  }
  const releaseAt = recoveryStartedAt + DB_RECOVERY_PURGE_HOLD_MS;
  if (Date.now() < releaseAt) {
    console.warn(`[db] Backup purge held after a recovery start, until ${new Date(releaseAt).toISOString()}.`);
    return true;
  }
  if (userIndex.size > 0) recoveryStartedAt = undefined;
  console.log('[db] Backup purge hold after a recovery start has ended.');
  return false;
};

// Only regular files directly in the database's directory whose whole name is a backup name. lstat
// does not follow a link, so a symlink or junction is left alone, as is anything else with such a name.
const listDbBackups = () => {
  const dbName = path.basename(DB_FILE);
  const backups = [];
  for (const name of fs.readdirSync(DATA_DIR)) {
    const marker = DB_BACKUP_MARKERS.find((item) => name.startsWith(`${dbName}${item}`));
    if (!marker) continue;
    const timestamp = name.slice(dbName.length + marker.length);
    if (!DB_BACKUP_TIMESTAMP_PATTERN.test(timestamp)) continue;
    const file = path.join(DATA_DIR, name);
    if (!fs.lstatSync(file).isFile()) continue;
    backups.push({ file, timestamp: Number(timestamp), expiresAt: Number(timestamp) + DB_BACKUP_RETENTION_DAYS * MS_PER_DAY });
  }
  return backups;
};

const describeBackupsLeft = (backups) => {
  if (backups.length === 0) return '0 backups remain';
  const lastExpiry = new Date(Math.max(...backups.map((backup) => backup.expiresAt))).toISOString();
  return `${backups.length} backup(s) remain, the last expiring ${lastExpiry}`;
};

// The age comes from the name, so a copied file or a changed clock on the file does not extend it, and
// a timestamp in the future is simply kept. Never throws, whatever fails is logged and retried later.
// Returns when the next backup expires, or Infinity.
function purgeExpiredDbBackups() {
  let nextExpiry = Infinity;
  try {
    if (isDbBackupPurgeHeld()) return recoveryStartedAt + DB_RECOVERY_PURGE_HOLD_MS;
    let backups = listDbBackups();
    const now = Date.now();
    const aheadCount = backups.filter((backup) => backup.timestamp > now).length;
    if (aheadCount > 0) console.warn(`[db] ${aheadCount} backup(s) have a timestamp ahead of the current time, and are kept until they expire from it.`);
    for (const backup of backups) {
      if (backup.expiresAt > now) {
        nextExpiry = Math.min(nextExpiry, backup.expiresAt);
        continue;
      }
      try {
        fs.unlinkSync(backup.file);
        backups = backups.filter((item) => item !== backup);
        console.log(`[db] Removed an expired backup, ${describeBackupsLeft(backups)}.`);
      } catch (err) {
        console.warn('[db] Could not remove an expired backup:', describeDbError(err));
      }
    }
  } catch (err) {
    console.warn('[db] Could not check backups for expiry:', describeDbError(err));
  }
  return nextExpiry;
}

// Every 24 hours, or sooner when a backup expires sooner, so none outlives the period by up to a day.
// unref: this timer alone never keeps the process alive.
function scheduleDbBackupPurge(nextExpiry) {
  const wait = Math.max(DB_BACKUP_PURGE_MIN_WAIT_MS, Math.min(DB_BACKUP_PURGE_INTERVAL_MS, nextExpiry - Date.now()));
  setTimeout(() => scheduleDbBackupPurge(purgeExpiredDbBackups()), wait).unref();
}

// Not at a start that lost its data: an operator may need those backups to recover, so the first look
// comes when the hold ends. A start that just migrated waits for the timer.
if (isDbLoaded) scheduleDbBackupPurge(didBackUpDbOnLoad ? Infinity : purgeExpiredDbBackups());
else scheduleDbBackupPurge(recoveryStartedAt + DB_RECOVERY_PURGE_HOLD_MS);

resumePendingAccountDeletions();
setInterval(retryAccountDeletions, ACCOUNT_DELETION_RETRY_INTERVAL_MS).unref();

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`API running at http://${HOST}:${PORT}`);
});
