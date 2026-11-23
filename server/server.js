import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import multer from 'multer';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import validator from 'validator';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLocalProvider } from './ai/localProvider.js';
import { createBarcodeLookup, isValidEan } from './ai/openFoodFacts.js';
import { createPhotoStore } from './ai/photoStore.js';
import { AiProviderError, resolveAiProviderName } from './ai/provider.js';
import { generateRecipeBatch, recipeId as recipeIdFor } from './ai/recipeEngine.js';
import { checkRecipe, knownItemFor } from './ai/recipeSafety.js';
import { normalizeRecipe, validateScanResult } from './ai/schemas.js';
import { SCAN_CATEGORIES } from './ai/taxonomy.js';

dotenv.config();

// Fails closed: an unset or mistyped NODE_ENV gets every production guard.
const isProduction = !['development', 'test'].includes(process.env.NODE_ENV);
const allowInsecureDevAuth = !isProduction && process.env.ALLOW_INSECURE_DEV_AUTH === 'true';
// Device test sessions only (npm run test:ios): POST /__dev/client-log exists only when NODE_ENV is
// exactly 'development' and DEV_SESSION_DIR is set (the session script sets it). A server started by
// hand, and test and production mode, never load the module. See dev-log-bridge.js.
const devSessionDir = process.env.DEV_SESSION_DIR?.trim() ?? '';
const isDevLogBridgeEnabled = process.env.NODE_ENV === 'development' && devSessionDir !== '';
const devLogBridge = isDevLogBridgeEnabled ? await import('./dev-log-bridge.js') : null;
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
import { getAppCheck as adminGetAppCheck } from 'firebase-admin/app-check';
import { createAppCheckMiddleware, createAppCheckStats, parseAppCheckMode } from './app-check.js';
import { formatJsonRequestLog, parseLogFormat, readAiProviderConfig, readinessReason } from './operations.js';
import {
  DEFAULT_HISTORY_MAX_AGE_MS, createWriteBehindQueue, describePgError, openPostgresStore, readDbDriverConfig, toJsonbSafeText,
} from './storage/postgres-store.js';

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

// AI_PROVIDER (local | off): production needs it set explicitly. Which provider runs is decided below
// (resolveAiProviderName); this only feeds the startup guard. See operations.js and server/README.md.
const aiProviderConfig = readAiProviderConfig(process.env, { production: isProduction });

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
  if (!parseAppCheckMode(process.env.APP_CHECK_MODE).valid) {
    missingConfig.push('APP_CHECK_MODE (off, monitor or enforce)');
  }
  missingConfig.push(...aiProviderConfig.problems);
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

// DATA-1: DB_DRIVER=json (default) keeps the database in DB_FILE. DB_DRIVER=postgres keeps the same
// document as JSONB in Postgres (DATABASE_URL), written behind by storage/postgres-store.js; DB_FILE's
// directory then only receives the rare .corrupt-/.pre-migration- copies. See server/README.md,
// "Database: JSON or Postgres". Setting names only in these messages, never values.
const dbDriverConfig = readDbDriverConfig(process.env, { production: isProduction });
if (dbDriverConfig.problems.length > 0) {
  if (isProduction) exitOnInvalidProductionConfig(dbDriverConfig.problems);
  console.error(`[db] FATAL: invalid database settings. Fix: ${dbDriverConfig.problems.join('; ')}.`);
  process.exit(1);
}
for (const warning of dbDriverConfig.warnings) console.warn(`[db] ${warning}`);
const isPostgresDb = dbDriverConfig.driver === 'postgres';
// What load messages name: the file path in JSON mode (unchanged), the table in Postgres mode.
const DB_SOURCE_LABEL = isPostgresDb ? 'the Postgres state (drinkme_state)' : DB_FILE;

// A wrong path must not silently become an empty database. A first deploy sets ALLOW_EMPTY_DB=true once.
if (isProduction) {
  const dbFileEnv = process.env.DB_FILE;
  if (dbFileEnv !== undefined && !path.isAbsolute(dbFileEnv.trim())) {
    exitOnInvalidProductionConfig(['DB_FILE (must be an absolute path)']);
  }
  // Postgres mode checks for its state row below, once connected.
  if (!isPostgresDb && !fs.existsSync(DB_FILE)) {
    if (process.env.ALLOW_EMPTY_DB !== 'true') {
      exitOnInvalidProductionConfig(['DB_FILE (no database file at this path; set ALLOW_EMPTY_DB=true only for a first deploy)']);
    }
    console.warn('[db] ALLOW_EMPTY_DB=true and no database file — starting empty. Remove the flag after this deploy.');
  } else if (!isPostgresDb && process.env.ALLOW_EMPTY_DB === 'true') {
    console.warn('[db] ALLOW_EMPTY_DB=true but the database file exists. Remove the flag: it lets a corrupt database start empty.');
  }
}

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

// Postgres mode: connect, create the tables if missing and read the stored document before anything
// else runs (the server listens only after loadDb). loadDb() then takes the same validation and
// migration path as a file that was read.
let postgresStore = null;
let postgresWriteQueue = null;
let preloadedDbText; // Postgres mode: the stored JSON text, or null when there is no state row yet
if (isPostgresDb) {
  let hasInstanceLock = false;
  try {
    postgresStore = await openPostgresStore({ connectionString: dbDriverConfig.databaseUrl, ssl: dbDriverConfig.ssl });
    // One server per database: two would overwrite each other's whole document.
    hasInstanceLock = await postgresStore.acquireInstanceLock();
    if (hasInstanceLock) {
      await postgresStore.ensureSchema();
      preloadedDbText = (await postgresStore.load())?.text ?? null;
    }
  } catch (err) {
    console.error(`[db] FATAL: could not open the Postgres database (${describePgError(err)}). Refusing to start.`);
    process.exit(1);
  }
  if (!hasInstanceLock) {
    console.error('[db] FATAL: another DrinkMe server (or a migration) is using this Postgres database. DB_DRIVER=postgres allows one server per database. Refusing to start.');
    process.exit(1);
  }
  if (isProduction) {
    if (preloadedDbText === null) {
      if (process.env.ALLOW_EMPTY_DB !== 'true') {
        exitOnInvalidProductionConfig(['DATABASE_URL (no DrinkMe state in this database; run npm run db:migrate-to-postgres, or set ALLOW_EMPTY_DB=true only for a first deploy)']);
      }
      console.warn('[db] ALLOW_EMPTY_DB=true and no Postgres state — starting empty. Remove the flag after this deploy.');
    } else if (process.env.ALLOW_EMPTY_DB === 'true') {
      console.warn('[db] ALLOW_EMPTY_DB=true but a Postgres state exists. Remove the flag: it lets a corrupt database start empty.');
    }
  }
  postgresWriteQueue = createWriteBehindQueue({ write: (snapshot) => postgresStore.write(snapshot) });
  console.log('[db] Using Postgres (write-behind). A crash can lose the last moments of changes; see server/README.md.');
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
// The app's dev log batches (development only) would fill the console with one line every few seconds.
// Production (legal T-05, GDPR minimisation): time, method, path, status, size and duration only; no IP
// address, user agent or referrer, which morgan's 'combined' format would keep for every request.
const PRODUCTION_LOG_FORMAT = ':date[iso] :method :url :status :res[content-length] - :response-time ms';
// LOG_FORMAT=json (any environment): the same fields as one JSON object per line, {ts, method, path,
// status, ms, size}, for hosts that index JSON logs. Unset or 'text' keeps the formats above.
const logFormat = parseLogFormat(process.env.LOG_FORMAT);
if (!logFormat.valid) console.warn('[config] LOG_FORMAT must be text or json - using text.');
const JSON_REQUEST_LOG_FORMAT = (tokens, req, res) => formatJsonRequestLog({
  ts: new Date().toISOString(),
  method: tokens.method(req, res),
  path: tokens.url(req, res),
  status: tokens.status(req, res),
  ms: tokens['response-time'](req, res),
  size: tokens.res(req, res, 'content-length'),
});
const requestLogFormat = logFormat.format === 'json' ? JSON_REQUEST_LOG_FORMAT : (isProduction ? PRODUCTION_LOG_FORMAT : 'dev');
app.use(morgan(requestLogFormat, { skip: (req) => Boolean(devLogBridge) && req.path === '/__dev/client-log' }));

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
// Device test sessions only (see devLogBridge): whether a media request carries a usable token, and
// from which client. Never the token, never the user. Diagnoses images that load on one platform only.
if (devLogBridge) {
  app.use('/media', (req, res, next) => {
    const header = req.headers.authorization;
    const auth = !header ? 'absent' : !/^Bearer\s+\S+$/i.test(header) ? 'malformed' : getUserId(req) ? 'accepted' : 'refused';
    console.log(`[dev-media] ${req.method} ${devLogBridge.cleanApiPath(req.baseUrl + req.path)} auth=${auth} client=${devLogBridge.clientKind(req.get('user-agent'))}`);
    next();
  });
}
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
  // A block, or a hide after reports, answers exactly like a post that does not exist, and neither
  // answer may be reused after an unblock or a resolution.
  const drink = found && (isReviewAccess || (!isBlockedBetween(found.userId, viewerId) && !isDrinkHiddenFrom(found, viewerId))) ? found : undefined;
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
// A profile hidden after reports has no avatar for others, the same 404 as none at all.
app.get('/media/avatars/:userId', (req, res) => {
  const owner = isLiveAccount(req.params.userId) ? userIndex.get(req.params.userId) : undefined;
  const avatar = owner && !owner.noticePending && !isUserHiddenFrom(owner.id, req.userId) ? owner.avatar : undefined;
  // The answer can depend on who asks while a profile is hidden.
  res.vary('Authorization');
  if (avatar === undefined) res.set('Cache-Control', 'no-store');
  sendStoredImage(req, res, `avatar:${req.params.userId}`, avatar);
});

// Rate-limit key: the user id from a valid API token, else the client IP (signed-out calls such as sign-in).
const rateLimitKey = (req) => {
  try {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const decoded = verifyApiToken(auth.slice(7));
      return `user:${decoded.uid}`;
    }
  } catch {}
  return req.ip;
};

// Ceiling per IP: 1000 req / 15 min. Many users share one IP (bar Wi-Fi, mobile carrier CGNAT), so the
// per-IP limit is high and the real per-person limit is the one below.
const apiIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
});
// Global: 100 req / 15 min per user (signed in) or per IP (signed out).
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
});
app.use('/api', apiIpLimiter, apiLimiter);

// SEC-B: per-user rate limit for mutation endpoints (30 actions / min / user)
const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  skip: (req) => req.method === 'GET', // only rate-limit writes
});
app.use('/api', mutationLimiter);
// App Check (SEC-I, docs/APP_CHECK_PLAN.md): APP_CHECK_MODE off (default), monitor or enforce. After the
// limiters, so a flood of bad tokens is rate-limited first; before the sign-in gate, so an app without a
// valid token learns nothing else. Tokens are verified with Firebase (cached keys, no call per request).
// Test mode only: APP_CHECK_TEST_TOKEN is accepted as the one valid token, since tests cannot get real ones.
{
  const appCheck = parseAppCheckMode(process.env.APP_CHECK_MODE);
  if (!appCheck.valid) console.warn('[app-check] APP_CHECK_MODE is not off, monitor or enforce: App Check is OFF.');
  const testToken = process.env.NODE_ENV === 'test' ? process.env.APP_CHECK_TEST_TOKEN : undefined;
  if (appCheck.mode !== 'off') {
    if (!firebaseAuth && !testToken) {
      console.warn(`[app-check] APP_CHECK_MODE=${appCheck.mode} needs FIREBASE_SERVICE_ACCOUNT_KEY: every token counts as invalid.`);
    }
    const stats = createAppCheckStats();
    const verify = testToken
      ? async (token) => { if (token !== testToken) throw new Error('invalid'); }
      : async (token) => {
        if (!firebaseAuth) throw new Error('no firebase admin');
        return adminGetAppCheck().verifyToken(token);
      };
    app.use('/api', createAppCheckMiddleware({ mode: appCheck.mode, verify, onResult: (result) => stats.record(result) }));
    if (appCheck.mode === 'monitor') {
      setInterval(() => {
        const line = stats.summary();
        if (line) console.log(line);
      }, process.env.NODE_ENV === 'test' ? 500 : 15 * 60 * 1000).unref();
    }
    console.log(`[app-check] ${appCheck.mode} mode for /api.`);
  }
}
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
  req.method === 'POST' && (req.path === '/api/drinks' || req.path === '/api/ai/scan' || /^\/api\/users\/[^/]+\/avatar$/.test(req.path))
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

// AI provider (server/ai/provider.js): AI starts only with AI_PROVIDER=local set explicitly (decision D-24,
// 2026-11-22: never an outside AI company). Anything else, including the old AI_ENABLED switch, means off.
const AI_PROVIDER_NAME = resolveAiProviderName(process.env);

// The provider behind the /api/ai/* routes. null when AI is off.
const parsePositiveMs = (raw, fallback) => (/^\d{3,6}$/.test(raw ?? '') ? Number(raw) : fallback);
const aiProvider = (() => {
  if (AI_PROVIDER_NAME === 'local') {
    // Production: the link to the ai-service carries photos, so it needs a strong token and must be loopback or https.
    if (isProduction) {
      const token = process.env.AI_SERVICE_TOKEN ?? '';
      let url;
      try { url = new URL(process.env.AI_SERVICE_URL || 'http://127.0.0.1:8088'); } catch { url = null; }
      const isLoopback = url && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      // AI_SERVICE_PRIVATE_HOSTS: exact host names on a private network the operator controls (e.g. the
      // docker-compose service name "ai-service" on one host). Plain http is accepted only for those.
      const privateHosts = (process.env.AI_SERVICE_PRIVATE_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
      const isPrivateHost = url && url.protocol === 'http:' && privateHosts.includes(url.hostname.toLowerCase());
      if (token.length < 32 || !url || !(isLoopback || isPrivateHost || url.protocol === 'https:')) {
        console.error('[ai] FATAL: AI_PROVIDER=local in production needs AI_SERVICE_TOKEN (32+ characters) and an AI_SERVICE_URL that is loopback, https, or a host listed in AI_SERVICE_PRIVATE_HOSTS (use a private network or WireGuard otherwise). Refusing to start.');
        process.exit(1);
      }
    }
    return createLocalProvider({
      url: process.env.AI_SERVICE_URL,
      token: process.env.AI_SERVICE_TOKEN || undefined,
      timeoutMs: parsePositiveMs(process.env.AI_SERVICE_TIMEOUT_MS, 60_000),
    });
  }
  return null;
})();
console.log(`[ai] Provider: ${aiProvider ? AI_PROVIDER_NAME : 'off'}`);

// Scan photos are kept only for users who opted in (see server/ai/photoStore.js).
const AI_PHOTO_RETENTION_DAYS = /^\d{1,3}$/.test(process.env.AI_PHOTO_RETENTION_DAYS ?? '') ? Number(process.env.AI_PHOTO_RETENTION_DAYS) : 90;
const aiPhotoStore = createPhotoStore({
  dir: process.env.AI_PHOTO_DIR?.trim() || path.join(DATA_DIR, 'ai-scans'),
  retentionDays: AI_PHOTO_RETENTION_DAYS,
});
// OFF_API_URL is for tests only (a local stub); production always uses Open Food Facts.
const lookupBarcode = createBarcodeLookup(!isProduction && process.env.OFF_API_URL ? { baseUrl: process.env.OFF_API_URL } : {});

// ── Default seed data — EMPTY (no dummy users for production) ─────────────────
const DEFAULT_USERS = [];
const DEFAULT_DRINKS = [];

// ── Mutable state (populated from file or seed on startup) ────────────────────
let drinks           = [];
let nextDrinkId      = 1;
let nextNotificationId = 1;
let nextCommentId    = 1;
let nextReportId     = 1;
let nextAuditId      = 1;
// 2: text is stored plain. A file with a lower or missing value holds HTML-escaped text.
const DB_SCHEMA_VERSION = 2;
let dbSchemaVersion  = DB_SCHEMA_VERSION;

const userIndex         = new Map();
const avatarHashByUser  = new Map(); // not persisted: rebuilt from the stored avatars at load
const cheersByUser      = new Map();
const savedByUser       = new Map();
const smartBarByUser    = new Map();
// userId → [saved AI recipe] (newest first). See the AI section.
const savedRecipesByUser = new Map();
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
// Security and moderation actions, oldest first. Only through the helpers in the Audit log section.
const auditLog = [];

const stories = [];

// ── Persistence helpers ───────────────────────────────────────────────────────
// Waits between tries, doubling: 6 tries in all, about 0.8 s of blocking at most. Used for the rename
// in saveDb and for the read at load.
const DB_RETRY_WAITS_MS       = [25, 50, 100, 200, 400];
const DB_RENAME_RETRY_CODES   = new Set(['EPERM', 'EBUSY', 'EACCES']);
const DB_READ_RETRY_CODES     = new Set([...DB_RENAME_RETRY_CODES, 'EMFILE']);

const DB_COUNTER_KEYS = ['nextDrinkId', 'nextNotificationId', 'nextCommentId', 'nextReportId', 'nextAuditId', 'dbSchemaVersion', 'recoveryStartedAt'];
const DB_LIST_KEYS    = ['drinks', 'users', 'reports', 'pendingAccountDeletions', 'auditLog'];
const DB_MAP_KEYS     = [
  'cheersByUser', 'savedByUser', 'smartBarByUser', 'savedRecipesByUser',
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

const waitBeforeDbRetry = (waitMs) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
};

/**
 * Runs operation, retrying the error codes in retryCodes with the waits of DB_RETRY_WAITS_MS. Logs one
 * line when any retry was needed: the action, the count and the codes, never a path or message.
 */
function runDbFileOperationWithRetry(action, retryCodes, operation) {
  const codes = [];
  const logRetries = (outcome) => {
    if (codes.length === 0) return;
    console.warn(`[db] ${action} needed ${codes.length} ${codes.length === 1 ? 'retry' : 'retries'} (${[...new Set(codes)].join(', ')}), ${outcome}.`);
  };
  for (let attempt = 0; ; attempt++) {
    try {
      const result = operation();
      logRetries('then succeeded');
      return result;
    } catch (err) {
      if (attempt >= DB_RETRY_WAITS_MS.length || !retryCodes.has(err.code)) {
        logRetries(`then failed (${err.code ?? err.name})`);
        throw err;
      }
      codes.push(err.code);
      waitBeforeDbRetry(DB_RETRY_WAITS_MS[attempt]);
    }
  }
}

// Windows can refuse a rename briefly while another process (antivirus, indexer) holds the target.
function renameDbFileWithRetry(tmpFile) {
  runDbFileOperationWithRetry('Save', DB_RENAME_RETRY_CODES, () => fs.renameSync(tmpFile, DB_FILE));
}

// The whole database as one plain object, the shape of DB_FILE and of the Postgres JSONB document.
function buildDbDocument() {
  return {
    drinks,
    nextDrinkId,
    nextNotificationId,
    nextCommentId,
    nextReportId,
    nextAuditId,
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
    savedRecipesByUser: Object.fromEntries(savedRecipesByUser.entries()),
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
    auditLog,
    ...(recoveryStartedAt !== undefined && { recoveryStartedAt }),
  };
}

// Postgres mode. The document is serialised now, so the snapshot is consistent, and written behind:
// true means queued, not stored. A failed write is retried in the background until it succeeds or a
// newer snapshot replaces it (storage/postgres-store.js), so routes cannot answer 503 for it and a crash
// can lose the changes not yet written. False only when serialising fails (routes then answer 503).
function queuePostgresSave() {
  try {
    const { text, replaced } = toJsonbSafeText(JSON.stringify(buildDbDocument()));
    if (replaced > 0) console.warn(`[db] Replaced ${replaced} escape(s) Postgres cannot store (NUL or a lone surrogate) with U+FFFD.`);
    lastSavedDbBytes = Buffer.byteLength(text, 'utf8');
    // While a recovery hold may be on, history keeps every hourly snapshot (30-day ceiling only), so
    // snapshots from before a lost start are not pushed out by the row limit.
    postgresWriteQueue.enqueue({ text, schemaVersion: dbSchemaVersion, keepAllHistory: recoveryStartedAt !== undefined });
    return true;
  } catch (err) {
    console.error(`[db] Failed to serialise the database for Postgres, nothing queued (${err.code ?? err.name}).`);
    return false;
  }
}

// Atomic write: a crash or failed rename leaves the previous DB_FILE intact.
function saveDb() {
  if (isPostgresDb) return queuePostgresSave();
  const tmpFile = `${DB_FILE}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try {
    const data = buildDbDocument();
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
    // The code only: Node's message names the temp and database paths.
    console.error(`[db] Failed to save, keeping the previous database (${err.code ?? err.name}).`);
    try {
      fs.rmSync(tmpFile, { force: true });
    } catch (cleanupErr) {
      console.error(`[db] Could not remove temp file ${tmpFile}:`, cleanupErr.message);
    }
    return false;
  }
}

// For routes that mutate: false means the 503 was already sent. Most changes roll back at their
// call sites, cheer and save included. These do not: marking notifications read, deleting a Smart
// Bar item, and a new user at sign-in (no token was issued and a retry reuses the record, but until
// then it is visible to other users, and the next successful save writes it to disk).
const respondSaveFailed = (res) => res.status(503).json({ error: 'Could not save your changes. Please try again.' });
const saveDbOrRespond = (res) => {
  if (saveDb()) return true;
  respondSaveFailed(res);
  return false;
};

// ── Durable saves (Postgres write-behind) ──
// A few changes must be stored before the server acts on them or answers: the pending account deletion
// (before any data or the Firebase user goes), session generation bumps (logging out stolen JWTs) and
// admin suspensions. JSON mode: saveDb already wrote the file, so these behave exactly as before.
// Postgres mode: they also wait until the queued snapshot is in Postgres, at most this long.
const DURABLE_SAVE_TIMEOUT_MS = 10_000;

/** Postgres mode: resolves whether every change made so far is stored. JSON mode: true. */
const waitForDbWritten = () => (isPostgresDb ? postgresWriteQueue.flush(DURABLE_SAVE_TIMEOUT_MS) : Promise.resolve(true));

/** saveDb, then (Postgres mode) wait until it is stored. Resolves false when either fails. */
async function saveDbDurable() {
  if (!saveDb()) return false;
  return waitForDbWritten();
}

/** saveDbOrRespond with the durable wait: false means the 503 was already sent. */
const saveDbDurableOrRespond = async (res) => {
  if (await saveDbDurable()) return true;
  respondSaveFailed(res);
  return false;
};

/**
 * Saves a session generation bump that is kept even when the save fails. JSON mode as before: a failed
 * save is logged by saveDb and the bump stays in memory (resolves true, the caller answers as usual).
 * Postgres mode: resolves false when it is not stored in time, and the caller answers 503.
 */
const saveSessionBumpDurably = async () => {
  if (!isPostgresDb) {
    saveDb();
    return true;
  }
  return saveDbDurable();
};

// A raw SyntaxError message can quote file content, so it never reaches the logs.
const describeDbError = (err) => (err instanceof SyntaxError ? 'invalid JSON' : (err.code ?? err.name));

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Starting empty after these failures could let the next mutation overwrite a good database.
function exitOnDbLoadFailure(action, reason) {
  console.error(`[db] FATAL: could not ${action} ${DB_SOURCE_LABEL} (${reason}). Refusing to start so the database file is not overwritten.`);
  process.exit(1);
}

function readDbFileWithRetry() {
  try {
    return runDbFileOperationWithRetry('Read', DB_READ_RETRY_CODES, () => fs.readFileSync(DB_FILE));
  } catch (err) {
    exitOnDbLoadFailure('read', describeDbError(err));
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
  // Postgres mode: the stored row was copied into drinkme_state_history before loadDb (see its call site).
  if (isPostgresDb) {
    exitIfEmptyStartNotAllowed(reason, 'a copy is in drinkme_state_history');
    console.error(`[db] Failed to load ${DB_SOURCE_LABEL} (${reason}), a copy is in drinkme_state_history, starting empty.`);
    return;
  }
  let existingHash = null;
  try {
    existingHash = newestDbBackup('.corrupt-')?.hash ?? null;
  } catch (err) {
    console.warn('[db] Could not check existing backups, making a new one:', describeDbError(err));
  }
  if (existingHash === sha256(rawBytes)) {
    exitIfEmptyStartNotAllowed(reason, 'an identical backup already exists');
    console.error(`[db] Failed to load ${DB_SOURCE_LABEL} (${reason}), an identical backup already exists, starting empty.`);
    return;
  }

  const backupFile = `${DB_FILE}.corrupt-${Date.now()}`;
  try {
    writeDbBackup(backupFile, rawBytes);
  } catch (err) {
    exitOnDbLoadFailure(`back up (${reason}) to ${backupFile}`, describeDbError(err));
  }
  exitIfEmptyStartNotAllowed(reason, `saved a copy to ${backupFile}`);
  console.error(`[db] Failed to load ${DB_SOURCE_LABEL} (${reason}), saved a copy to ${backupFile}, starting empty.`);
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

// Postgres mode reads nothing here: preloadedDbText was fetched at startup, and is handled from this
// point exactly like the bytes of a file (a missing row like a missing file).
function readDbSourceOrStartEmpty() {
  if (isPostgresDb) {
    if (preloadedDbText === null) {
      console.log('[db] No saved state found in Postgres — starting with empty database.');
      return null;
    }
    const bytes = Buffer.from(preloadedDbText, 'utf8');
    preloadedDbText = undefined; // not kept in memory twice
    return bytes;
  }
  let dbStats;
  try {
    dbStats = fs.statSync(DB_FILE, { throwIfNoEntry: false });
  } catch (err) {
    exitOnDbLoadFailure('stat', describeDbError(err));
  }
  if (dbStats === undefined) {
    console.log(`[db] No saved state found at ${DB_FILE} — starting with empty database.`);
    return null;
  }
  return readDbFileWithRetry();
}

function loadDb() {
  let prunedAuditAtLoad = false;
  const rawBytes = readDbSourceOrStartEmpty();
  if (rawBytes === null) {
    recoveryStartedAt = Date.now();
    saveDb();
    return;
  }

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
    if (typeof data.nextAuditId      === 'number') nextAuditId      = data.nextAuditId;

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

    // Restore savedRecipesByUser (lists only; a bad entry is dropped, never fatal)
    if (isPlainObject(data.savedRecipesByUser)) {
      for (const [k, v] of Object.entries(data.savedRecipesByUser)) {
        if (Array.isArray(v)) savedRecipesByUser.set(k, v.filter(isPlainObject));
      }
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
      for (const { uid, until, anonId } of data.pendingAccountDeletions) {
        if (typeof uid === 'string' && uid && !pendingAccountDeletions.some((entry) => entry.uid === uid)) {
          // An unusable until counts as unfinished, the safe side. One too far ahead cannot outlast the retention.
          // A tombstone never keeps the anonymous id; an unfinished entry from before it has none (see getDeletionAnonId).
          pendingAccountDeletions.push(Number.isFinite(until)
            ? { uid, until: Math.min(until, Date.now() + ACCOUNT_TOMBSTONE_MS) }
            : { uid, ...(isDeletionAnonId(anonId) && { anonId }) });
        }
      }
    }

    // Restore auditLog. A file from before it has none. Expired entries go now (see pruneAuditLog).
    if (data.auditLog) {
      // Each entry is rebuilt with only the known fields and allowed meta keys. One that cannot be an entry
      // (no whole-number id, an unknown action, an id that is not a string or null) is left out.
      let changed = false;
      for (const stored of data.auditLog) {
        const entry = normalizeAuditEntry(stored);
        if (!entry || JSON.stringify(entry) !== JSON.stringify(stored)) changed = true;
        if (!entry) continue;
        auditLog.push(entry);
        if (entry.id >= nextAuditId) nextAuditId = entry.id + 1;
      }
      prunedAuditAtLoad = pruneAuditLog() > 0 || changed;
    }

    // A value ahead of the clock would hold the purge for longer than it should.
    if (typeof data.recoveryStartedAt === 'number') recoveryStartedAt = Math.min(data.recoveryStartedAt, Date.now());
  } catch (err) {
    exitOnDbLoadFailure('restore', describeDbError(err));
  }

  if (!(data.dbSchemaVersion >= DB_SCHEMA_VERSION)) {
    migrateLegacyDbText(rawBytes); // saves, expired audit entries included
  } else {
    dbSchemaVersion = data.dbSchemaVersion; // a newer version is kept as found
    // Expired or rebuilt audit entries reach the file now, not at the next mutation. A failed save is
    // logged, and the next successful save writes them.
    if (prunedAuditAtLoad) saveDb();
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

// ── Reserved display names (official DrinkMe account) ─────────────────────────
// Owner decision (2026-11-12): only the official account (OFFICIAL_USER_IDS) may carry the brand name in its
// profile name, so nobody can pose as DrinkMe (community guidelines, impersonation). Best effort, not a full
// Unicode TR39 confusables check (no extra dependency, lead decision). A name is folded like this:
//   1. NFKC, lowercase, diacritics stripped;
//   2. look-alikes mapped to a-z, twice (so Cyrillic "з" -> "3" -> "e"): the Cyrillic, Greek, Cherokee and
//      Latin letters in RESERVED_NAME_LOOKALIKES, regional-indicator letters, and digits and symbols used as
//      letters (0 o, 1 i, 3 e, 4 a, 5 s, 7 t, ! i, | i, $ s, @ a; "l" reads as "i");
//   3. any other letter or symbol becomes a wildcard ("?"); everything else (spaces, dots, underscores,
//      hyphens, other punctuation, invisible characters) is removed.
// The brand matches when "drinkme" appears with at most 2 of its 7 letters taken by wildcards (so at least
// 5 real a-z hits), or appears once the wildcards are removed. "rn" read as "m" and "cl" read as "d" (as
// "ci", since "l" already reads as "i") are checked as extra forms. A non-official name is also refused when
// it contains "official" / "oficial" or a check-mark character, so it cannot imitate the app's Official
// badge (lead decision, fix loop 1).
const RESERVED_NAME_WILDCARD = '?';
const RESERVED_NAME_MAX_WILDCARDS = 2;
const RESERVED_NAME_LOOKALIKES = new Map(Object.entries({
  // Cyrillic
  'а': 'a', 'в': 'b', 'г': 'r', 'е': 'e', 'ё': 'e', 'з': '3', 'і': 'i', 'ї': 'i', 'ј': 'j', 'к': 'k', 'м': 'm',
  'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h',
  'ԛ': 'q', 'ԝ': 'w', 'ӏ': 'i', 'п': 'n', 'и': 'n', 'ꙇ': 'i',
  // Greek
  'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'μ': 'm', 'ν': 'v', 'ο': 'o', 'ρ': 'p',
  'τ': 't', 'υ': 'u', 'χ': 'x', 'ϲ': 'c', 'ϳ': 'j',
  // Latin letters that do not decompose
  'ı': 'i', 'ł': 'l', 'ø': 'o', 'đ': 'd', 'ð': 'd', 'ħ': 'h', 'ŀ': 'l', 'ɩ': 'i', 'ɪ': 'i', 'ʀ': 'r', 'ᴍ': 'm',
  'ᴋ': 'k', 'ᴇ': 'e', 'ɴ': 'n', 'ᴅ': 'd', 'ɗ': 'd', 'ɖ': 'd', 'ɨ': 'i', 'ɍ': 'r', 'ɾ': 'r', 'ɼ': 'r',
  'ƙ': 'k', 'ɱ': 'm', 'ɛ': 'e', 'ə': 'e', 'ǝ': 'e',
  // Digits and symbols used as letters ("l" and "|" read as "i" next to "drinkme")
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '!': 'i', '|': 'i', 'l': 'i', '$': 's', '@': 'a',
}));
// Cherokee capitals that look like Latin ones. toLowerCase turns them into the small forms, so
// both are mapped.
for (const [cherokee, latin] of Object.entries({
  'Ꭰ': 'd', 'Ꭱ': 'r', 'Ꭵ': 'i', 'Ꭺ': 'a', 'Ꭻ': 'j', 'Ꭼ': 'e', 'Ꮃ': 'w', 'Ꮋ': 'h', 'Ꮇ': 'm', 'Ꮐ': 'g',
  'Ꮓ': 'z', 'Ꮢ': 'r', 'Ꮤ': 't', 'Ꮩ': 'v', 'Ꮪ': 's', 'Ꮮ': 'l', 'Ꮯ': 'c', 'Ꮲ': 'p', 'Ꮶ': 'k', 'Ᏼ': 'b',
})) {
  RESERVED_NAME_LOOKALIKES.set(cherokee, latin);
  RESERVED_NAME_LOOKALIKES.set(cherokee.toLowerCase(), latin);
}
const REGIONAL_INDICATOR_A = 0x1f1e6;
const REGIONAL_INDICATOR_Z = 0x1f1ff;
// ✓ ✔ ☑ ✅ 🗸 🗹 ⍻ √
const CHECK_MARK_PATTERN = /[✓✔☑✅\u{1F5F8}\u{1F5F9}⍻√]/u;

const mapLookalike = (char) => {
  const codePoint = char.codePointAt(0);
  if (codePoint >= REGIONAL_INDICATOR_A && codePoint <= REGIONAL_INDICATOR_Z) {
    return String.fromCharCode(0x61 + codePoint - REGIONAL_INDICATOR_A);
  }
  return RESERVED_NAME_LOOKALIKES.get(char) ?? char;
};

// Returns a-z and wildcards only.
const foldNameForReservedCheck = (value) => {
  if (typeof value !== 'string' || value === '') return '';
  const decomposed = value.normalize('NFKC').toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '');
  let folded = '';
  for (const char of decomposed) folded += mapLookalike(char);
  let mapped = '';
  for (const char of folded) {
    const next = mapLookalike(char);
    if (next >= 'a' && next <= 'z' && next.length === 1) mapped += next;
    else if (/^[\p{L}\p{So}]$/u.test(next)) mapped += RESERVED_NAME_WILDCARD;
  }
  return mapped;
};

// Linear in the name length (the token is fixed): every window of the token's length is compared once.
const containsWithWildcards = (form, token) => {
  for (let start = 0; start + token.length <= form.length; start += 1) {
    let wildcards = 0;
    let matches = true;
    for (let index = 0; index < token.length; index += 1) {
      const char = form[start + index];
      if (char === token[index]) continue;
      if (char === RESERVED_NAME_WILDCARD && wildcards < RESERVED_NAME_MAX_WILDCARDS) {
        wildcards += 1;
        continue;
      }
      matches = false;
      break;
    }
    if (matches) return true;
  }
  return false;
};

// The tokens go through the same folding, so "official" is compared as it folds ("l" reads as "i").
const RESERVED_NAME_TOKEN = foldNameForReservedCheck('drinkme');
const RESERVED_BADGE_TOKENS = ['official', 'oficial'].map(foldNameForReservedCheck);

const toReservedNameForms = (folded) => {
  const forms = new Set();
  for (const base of [folded, folded.replaceAll(RESERVED_NAME_WILDCARD, '')]) {
    const withM = base.replace(/rn/g, 'm');
    forms.add(base);
    forms.add(withM);
    forms.add(base.replace(/ci/g, 'd'));
    forms.add(withM.replace(/ci/g, 'd'));
  }
  return Array.from(forms);
};

// True when the first name, the last name or both together use the brand name, imitate the Official
// badge ("official", "oficial") or contain a check mark.
const isReservedDisplayName = (firstName, lastName) => {
  const parts = [firstName, lastName].map((part) => (typeof part === 'string' ? part : ''));
  if (parts.some((part) => CHECK_MARK_PATTERN.test(part.normalize('NFKC')))) return true;
  return [parts[0], parts[1], `${parts[0]}${parts[1]}`].some((part) => (
    toReservedNameForms(foldNameForReservedCheck(part)).some((form) => (
      containsWithWildcards(form, RESERVED_NAME_TOKEN)
      || RESERVED_BADGE_TOKENS.some((token) => form.includes(token))
    ))
  ));
};

const isOlderIdToken = (user, tokenIat) => Number.isFinite(tokenIat) && Number.isFinite(user.lastIdTokenIat) && tokenIat < user.lastIdTokenIat;

// A user with no usable name gets an empty one: the email must never become a public name.
// providerName comes from the verified token, so it is trusted even when it equals the email prefix.
// displayName comes from the request body, so a value equal to the prefix is refused. Anything with an @ is refused from both.
// A name is only set here, on creation: later sign-ins never refill it, so a cleared name stays cleared.
// A name that uses the reserved brand name (isReservedDisplayName) is dropped for a non-official account.
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
    // A provider name with the brand name in it is not stored for a non-official account: the account
    // starts without a name, like one whose provider sent none, and the app asks for one (needsName).
    // nameReservedAtSignIn lets the name prompt say why; it holds no name and goes with the next profile save.
    const isReservedName = !isOfficialUser(id) && isReservedDisplayName(name, '');
    const isUsableName = !name.includes('@') && !isReservedName && (Boolean(providerName) || !isPrefixName);
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
      ...(isReservedName && name !== '' && { nameReservedAtSignIn: true }),
      // Cleared by the privacy acknowledgement. Accounts from before the notice never get it.
      noticePending: true,
      // Read by the auto-hide: a reporter counts only once the account is 48 hours old. Accounts from
      // before this field have none and count as old enough (see getAutoHideReporterStatus).
      createdAt: new Date().toISOString(),
    });
  } else {
    const existing = userIndex.get(id);
    // Never replace an existing avatar: the client sends the Google photo on every app launch. A suspended
    // user cannot change their avatar, so sign-in does not set one for them either.
    if (photoURL && !existing.avatar && !existing.avatarClearedByAdmin && !getActiveSuspension(existing)) existing.avatar = photoURL;
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

// No HEIC for AI scans: the ai-service decodes JPEG, PNG and WebP only.
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
// Postgres mode: one jsonb value cannot exceed about 256 MiB, so growth stops lower there, counted on
// the compact JSON text that is sent (the stored jsonb is of a similar size).
const DEFAULT_POSTGRES_DB_GROWTH_MAX_BYTES = 200_000_000;
const DB_GROWTH_MAX_BYTES = parseTestOnlyLimit(
  process.env.DB_GROWTH_MAX_BYTES,
  isPostgresDb ? DEFAULT_POSTGRES_DB_GROWTH_MAX_BYTES : DEFAULT_DB_GROWTH_MAX_BYTES,
);
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

// ── Post categories ───────────────────────────────────────────────────────────
// The one list of post categories, split by whether the drink is alcoholic. A post stores its category
// as `tags: [category]` (no category: `tags: []`). Creating a post and the Explore filter validate
// against this list, and any future edit-post route must validate against this list too (through
// parseDrinkCategory). It must match the arrays in src/types/api.ts; test/categories.test.js checks that.
const DRINK_CATEGORIES = Object.freeze({
  alcoholic: Object.freeze(['cocktail', 'wine', 'beer', 'spirits']),
  nonAlcoholic: Object.freeze(['mocktail', 'coffee', 'tea', 'other']),
});
const ALCOHOLIC_DRINK_CATEGORIES = new Set(DRINK_CATEGORIES.alcoholic);
const NON_ALCOHOLIC_DRINK_CATEGORIES = new Set(DRINK_CATEGORIES.nonAlcoholic);

const isDrinkCategory = (value) => (
  typeof value === 'string' && (ALCOHOLIC_DRINK_CATEGORIES.has(value) || NON_ALCOHOLIC_DRINK_CATEGORIES.has(value))
);

/**
 * Validates an optional category against the post's alcoholic state (true unless isAlcoholic === false).
 * Returns { tags } to store, or { error } for a 400. undefined or null means no category.
 */
const parseDrinkCategory = (category, isAlcoholicPost) => {
  if (category === undefined || category === null) return { tags: [] };
  if (!isDrinkCategory(category)) return { error: 'Invalid category' };
  if (ALCOHOLIC_DRINK_CATEGORIES.has(category) !== isAlcoholicPost) {
    return { error: 'Category does not match isAlcoholic' };
  }
  return { tags: [category] };
};

// A stored post matches a category only if its alcoholic state agrees too, so an inconsistent record
// can never show under the wrong filter.
const drinkHasCategory = (drink, category) => (
  Array.isArray(drink.tags) && drink.tags.includes(category)
  && isAlcoholicDrink(drink) === ALCOHOLIC_DRINK_CATEGORIES.has(category)
);

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

// ── Auto-hide after reports ───────────────────────────────────────────────────
// Owner decision (2026-11-10): a post, comment or profile with this many DISTINCT counting reporters among
// its open reports is hidden from everyone but its owner and the admins until an admin resolves them.
// Derived from the open reports and never stored, so resolving them (a dismiss too) unhides it at once.
// A reporter counts only once their account is AUTO_HIDE_MIN_REPORTER_AGE_MS old and has accepted the
// privacy notice, so a batch of fresh accounts cannot hide content (lead decision, fix loop 1). Every
// report still reaches the admin queue. A counting reporter who was blocked keeps counting while the
// report is open. A deleted one keeps counting only if they counted when the account was deleted: their
// open reports keep an anonymous id and that fact (see deleteUserDataCascade), and never age into counting.
const AUTO_HIDE_REPORTER_THRESHOLD = 3;
const AUTO_HIDE_MIN_REPORTER_AGE_MS = 48 * 60 * 60 * 1000;

// A comment is named by its post too, like the reports do.
const reportTargetKey = ({ targetType, targetId, drinkId }) => (
  targetType === 'comment' ? `comment:${drinkId}:${targetId}` : `${targetType}:${targetId}`
);

// { counts, eligibleAt? }. eligibleAt is when a reporter too new to count will start counting.
// An account with no createdAt was made before the field existed (2026-11-11), so it counts as old enough.
// An unreadable createdAt does not count: the safe side.
const getAutoHideReporterStatus = (user) => {
  if (!user || user.noticePending) return { counts: false };
  if (user.createdAt === undefined) return { counts: true };
  const createdMs = new Date(user.createdAt).getTime();
  if (!Number.isFinite(createdMs)) return { counts: false };
  const eligibleAt = createdMs + AUTO_HIDE_MIN_REPORTER_AGE_MS;
  return Date.now() >= eligibleAt ? { counts: true } : { counts: false, eligibleAt };
};

// Target key to { all, counting }: Sets of the distinct reporters of its open reports, and of those who
// count towards the hide. Rebuilt on the first read after a change to the reports, a privacy
// acknowledgement or an account deletion, and once a new reporter's account becomes old enough. So a feed
// costs one Map lookup per item, never a scan. Every such change, rollbacks included, calls markReportsChanged.
let openReportersByTarget = new Map();
let isReportIndexStale = true;
let reportIndexRebuildAt = Infinity;
const markReportsChanged = () => {
  isReportIndexStale = true;
};

const getOpenReportersByTarget = () => {
  if (!isReportIndexStale && Date.now() < reportIndexRebuildAt) return openReportersByTarget;
  const index = new Map();
  let rebuildAt = Infinity;
  for (const report of reports) {
    if (!isPlainObject(report) || report.status !== 'open' || typeof report.reporterId !== 'string') continue;
    const key = reportTargetKey(report);
    if (!index.has(key)) index.set(key, { all: new Set(), counting: new Set() });
    const entry = index.get(key);
    entry.all.add(report.reporterId);
    const status = report.reporterDeleted === true
      ? { counts: report.countsForAutoHide === true }
      : getAutoHideReporterStatus(userIndex.get(report.reporterId));
    if (status.counts) entry.counting.add(report.reporterId);
    else if (status.eligibleAt !== undefined) rebuildAt = Math.min(rebuildAt, status.eligibleAt);
  }
  openReportersByTarget = index;
  isReportIndexStale = false;
  reportIndexRebuildAt = rebuildAt;
  return index;
};

// Every distinct open reporter, for the admin queue.
const countOpenReporters = (target) => getOpenReportersByTarget().get(reportTargetKey(target))?.all.size ?? 0;
// Only those who count towards the hide.
const countAutoHideReporters = (target) => getOpenReportersByTarget().get(reportTargetKey(target))?.counting.size ?? 0;
// ADMIN_USER_IDS and OFFICIAL_USER_IDS are read further down; these run only while requests are served.
const isAdmin = (uid) => typeof uid === 'string' && ADMIN_USER_IDS.has(uid);
const isOfficialUser = (uid) => typeof uid === 'string' && OFFICIAL_USER_IDS.has(uid);

// ownerId: whose content the target is. Owner decision (2026-11-12): content of the official DrinkMe account
// (its posts, comments and profile) is never hidden by reports, so a group of reporters cannot take the
// brand's account offline. Its reports are still accepted and queued (targetOfficial in the admin queue),
// and admins can still remove the content, clear the profile or suspend the account.
const isTargetAutoHidden = (target, ownerId) => (
  !isOfficialUser(ownerId) && countAutoHideReporters(target) >= AUTO_HIDE_REPORTER_THRESHOLD
);

// For everyone but its owner and the admins, hidden content answers exactly like content that does not exist.
const isHiddenFrom = (target, ownerId, viewerId) => (
  viewerId !== ownerId && !isAdmin(viewerId) && isTargetAutoHidden(target, ownerId)
);
const isDrinkHiddenFrom = (drink, viewerId) => isHiddenFrom({ targetType: 'drink', targetId: drink.id }, drink.userId, viewerId);
const isCommentHiddenFrom = (comment, drinkId, viewerId) => (
  isHiddenFrom({ targetType: 'comment', targetId: comment?.id, drinkId }, comment?.userId, viewerId)
);
// A hidden profile is shown stripped, like one whose privacy notice is pending, and is left out of search.
const isUserHiddenFrom = (userId, viewerId) => isHiddenFrom({ targetType: 'user', targetId: userId }, userId, viewerId);

// ── Suspension ────────────────────────────────────────────────────────────────
// Owner decision (2026-11-10): an admin can suspend an account. The first suspension lasts 7 days; any
// later one, with an earlier counted suspension on record, is permanent. It ends by date, or when an admin
// lifts it. A suspension lifted with void: true was a mistake: it stays in the history, marked voided, and
// does not count towards "a repeat is permanent". While one is in force a new one is refused
// (already_suspended) unless the admin sends permanent: true to escalate it (lead decision, fix loop 1).
// A suspended user can still read, cheer, save, block, log out, delete the account and get their data,
// but cannot post, comment, send or accept partner requests, change profile text or avatar, or report.
// The history on the user record keeps only dates, the permanent and voided flags, the reason and admin ids.
const SUSPENSION_FIRST_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const SUSPENSION_REASON_MAX_LENGTH = 300;

const getSuspensionHistory = (user) => (Array.isArray(user?.suspensions) ? user.suspensions.filter(isPlainObject) : []);
// The entries that count towards a permanent repeat.
const getCountedSuspensions = (user) => getSuspensionHistory(user).filter((entry) => entry.voided !== true);

// The latest entry while it is in force. Expiry is read from the date, so nothing runs when it ends.
const getActiveSuspension = (user) => {
  const latest = getSuspensionHistory(user).at(-1);
  if (!latest || latest.endedAt || latest.voided === true) return null;
  if (latest.permanent === true) return latest;
  return new Date(latest.until).getTime() > Date.now() ? latest : null;
};

// until is null for a permanent suspension.
const toSuspensionState = (suspension) => ({
  suspendedUntil: suspension.permanent === true ? null : suspension.until,
  suspendedPermanently: suspension.permanent === true,
});

const respondAccountSuspended = (res, suspension) => {
  const { suspendedUntil } = toSuspensionState(suspension);
  return res.status(403).json({
    error: suspendedUntil
      ? `Your account is suspended until ${suspendedUntil}, so you cannot do this.`
      : 'Your account is suspended, so you cannot do this.',
    code: 'account_suspended',
    until: suspendedUntil,
  });
};

// Runs after requireAuth and any ownership check, and before a body parser or upload.
const refuseIfSuspended = (req, res, next) => {
  const suspension = getActiveSuspension(userIndex.get(req.userId));
  if (suspension) return respondAccountSuspended(res, suspension);
  next();
};

// Adds a suspension and returns the undo, for a save that fails. The history is replaced, never changed in place.
// forcePermanent: the admin asked for a permanent suspension.
const suspendUser = (user, adminId, reason, { forcePermanent = false } = {}) => {
  const previous = user.suspensions;
  const now = Date.now();
  const permanent = forcePermanent || getCountedSuspensions(user).length > 0;
  user.suspensions = [...getSuspensionHistory(user), {
    at: new Date(now).toISOString(),
    until: permanent ? null : new Date(now + SUSPENSION_FIRST_DURATION_MS).toISOString(),
    permanent,
    reason: reason || null,
    by: adminId,
  }];
  return () => {
    if (previous === undefined) delete user.suspensions;
    else user.suspensions = previous;
  };
};

// True when a suspension is in force and the request does not escalate it: a double tap, or a second
// report on the same user, must not turn a 7-day suspension into a permanent one by accident.
const isAlreadySuspended = (user, forcePermanent) => {
  const active = getActiveSuspension(user);
  return Boolean(active) && (!forcePermanent || active.permanent === true);
};

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

// ── Audit log (T6-1, SEC-H) ───────────────────────────────────────────────────
// A GDPR-minimal record of security and moderation actions. Every read and write of auditLog goes through
// these helpers, so they can move to a real database (DATA-1) without touching the routes.
// An entry is { id, at, action, actorId, targetId, meta? }: ids are uids, a deleted-<hex> id or null, and
// meta holds only the keys AUDIT_META_KEYS allows for its action. Never stored: IP, user agent, email,
// names, report or suspension reason text, tokens or request bodies. Refused sign-ins are not logged:
// anyone could trigger them, so they would only be noise.
// Written in the same save as its action and undone with it when that save fails. Allowed while the
// growth guard blocks writes, because each budget below has a cap.
// Two budgets, so user activity can never push out a moderation record (lead decision): entries users
// cause themselves (AUDIT_SELF_ACTIONS) keep their newest AUDIT_USER_MAX_ENTRIES among themselves; admin
// entries and completed deletions leave only through the retention, plus a safety cap of
// AUDIT_SYSTEM_MAX_ENTRIES that only admins and completed deletions can fill.
// Kept AUDIT_RETENTION_DAYS (pruned at load and by the 24-hour purge timer); backups add up to 30 days.
const AUDIT_RETENTION_DAYS = 90;
const AUDIT_RETENTION_MS = AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const AUDIT_USER_MAX_ENTRIES = 15_000;
const AUDIT_SYSTEM_MAX_ENTRIES = 20_000;
const AUDIT_META_KEYS = {
  'ack.age_confirmed': [],
  'ack.privacy_accepted': ['version'],
  'ack.terms_accepted': ['version'],
  // reason: 'tokens_revoked' when Firebase revoked the refresh tokens (password reset or change, email
  // change, revokeRefreshTokens); 'account_disabled' / 'account_gone' when Firebase reports the account
  // disabled or deleted outside the app; absent for the email takeover guard's bump.
  'auth.session_revoked': ['reason'],
  'account.deletion_requested': [],
  'account.deletion_completed': [],
  // resolvedCount: how many open reports on the same target the resolve closed.
  'admin.report_resolved': ['reportId', 'action', 'resolvedCount'],
  'admin.user_suspended': ['permanent'],
  'admin.user_unsuspended': ['void'],
  // A user reported an AI answer (Google Play AI-generated content policy). AI text only, never personal data.
  'ai.output_reported': ['kind', 'reason', 'recipeId', 'recipeName', 'category', 'status'],
};
const AUDIT_ACTIONS = new Set(Object.keys(AUDIT_META_KEYS));
// The user's own actions. Lead decision (data minimisation): they are deleted with the account, not
// anonymised; account.deletion_completed under the anonymous id stays as the record. Admin entries keep
// the anonymous id instead of the uid.
const AUDIT_SELF_ACTIONS = new Set(['ack.age_confirmed', 'ack.privacy_accepted', 'ack.terms_accepted', 'auth.session_revoked', 'account.deletion_requested', 'ai.output_reported']);
const isUserAuditEntry = (entry) => AUDIT_SELF_ACTIONS.has(entry.action);
const auditCapFor = (entry) => (isUserAuditEntry(entry) ? AUDIT_USER_MAX_ENTRIES : AUDIT_SYSTEM_MAX_ENTRIES);

// Only the allowed meta keys with plain values, or undefined when none is left.
const pickAuditMeta = (action, meta) => {
  const kept = {};
  for (const key of AUDIT_META_KEYS[action]) {
    const value = meta?.[key];
    if (['string', 'number', 'boolean'].includes(typeof value)) kept[key] = value;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
};

// Rebuilds a stored entry with exactly the known fields, or returns null when it cannot be one.
const normalizeAuditEntry = (entry) => {
  if (!isPlainObject(entry) || !Number.isSafeInteger(entry.id) || !AUDIT_ACTIONS.has(entry.action)) return null;
  const isId = (value) => value === null || typeof value === 'string';
  if (!isId(entry.actorId) || !isId(entry.targetId)) return null;
  const meta = pickAuditMeta(entry.action, entry.meta);
  return { id: entry.id, at: entry.at, action: entry.action, actorId: entry.actorId, targetId: entry.targetId, ...(meta && { meta }) };
};

// Removes the oldest entries of this entry's budget beyond its cap. Returns [index, entry] pairs in
// ascending index order, so an undo can put them back exactly where they were.
const evictOverAuditCap = (entry) => {
  const sameBudget = isUserAuditEntry(entry);
  const indexes = [];
  auditLog.forEach((item, index) => {
    if (isUserAuditEntry(item) === sameBudget) indexes.push(index);
  });
  const excess = indexes.length - auditCapFor(entry);
  if (excess <= 0) return [];
  const evicted = indexes.slice(0, excess).map((index) => [index, auditLog[index]]);
  for (let i = evicted.length - 1; i >= 0; i--) auditLog.splice(evicted[i][0], 1);
  return evicted;
};

/**
 * Adds one entry and returns its undo, for a save that fails. actorId is who acted (null for the server),
 * targetId the account acted on. meta keeps only the keys allowed for the action.
 */
const appendAudit = (action, { actorId = null, targetId = null, meta } = {}) => {
  if (!AUDIT_ACTIONS.has(action)) throw new Error(`Unknown audit action ${action}`);
  const keptMeta = pickAuditMeta(action, meta);
  const entry = {
    id: nextAuditId++,
    at: new Date().toISOString(),
    action,
    actorId: actorId ?? null,
    targetId: targetId ?? null,
    ...(keptMeta && { meta: keptMeta }),
  };
  auditLog.push(entry);
  const evicted = evictOverAuditCap(entry);
  return () => {
    const index = auditLog.lastIndexOf(entry);
    if (index !== -1) auditLog.splice(index, 1);
    for (const [evictedIndex, evictedEntry] of evicted) auditLog.splice(evictedIndex, 0, evictedEntry);
    if (nextAuditId === entry.id + 1) nextAuditId = entry.id;
  };
};

// auth.session_revoked shares the users' audit budget, so repeated password resets by one account could
// push other users' consent records out. The sessionGen bump always happens; the entry is written at most
// once per account and reason per 24 hours (lead decision, fix loop 1). Entries are appended in time order,
// so the scan walks back from the newest and stops at the first one older than the window.
const SESSION_REVOKED_AUDIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const appendSessionRevokedAudit = (actorId, reason) => {
  const cutoff = Date.now() - SESSION_REVOKED_AUDIT_WINDOW_MS;
  for (let index = auditLog.length - 1; index >= 0; index -= 1) {
    const entry = auditLog[index];
    const at = Date.parse(entry?.at);
    if (!Number.isFinite(at) || at <= cutoff) break;
    if (entry.action === 'auth.session_revoked' && entry.actorId === actorId && entry.meta?.reason === reason) {
      return () => {};
    }
  }
  return appendAudit('auth.session_revoked', { actorId, ...(reason !== undefined && { meta: { reason } }) });
};

// Drops entries past the retention, or with an unreadable date, then keeps the newest of each budget
// within its cap. No save. Returns how many went.
const pruneAuditLog = () => {
  const cutoff = Date.now() - AUDIT_RETENTION_MS;
  const before = auditLog.length;
  const current = auditLog.filter((entry) => {
    const at = Date.parse(entry?.at);
    return Number.isFinite(at) && at > cutoff;
  });
  const userCount = current.filter(isUserAuditEntry).length;
  let userExcess = userCount - AUDIT_USER_MAX_ENTRIES;
  let systemExcess = current.length - userCount - AUDIT_SYSTEM_MAX_ENTRIES;
  const kept = current.filter((entry) => {
    if (isUserAuditEntry(entry)) return userExcess-- <= 0;
    return systemExcess-- <= 0;
  });
  auditLog.length = 0;
  for (const entry of kept) auditLog.push(entry);
  return before - auditLog.length;
};

// The deleted-<hex> id that stands for a deleted user in kept reports and audit entries.
const DELETION_ANON_ID_PATTERN = /^deleted-[0-9a-f]{16}$/;
const isDeletionAnonId = (value) => typeof value === 'string' && DELETION_ANON_ID_PATTERN.test(value);
const newDeletionAnonId = () => `deleted-${crypto.randomBytes(8).toString('hex')}`;
// The id saved on the unfinished deletion entry. An entry from before anonId (or a cascade with no entry)
// gets a new one, as before.
const getDeletionAnonId = (uid) => {
  const anonId = pendingAccountDeletions.find((entry) => entry.uid === uid && entry.until === undefined)?.anonId;
  return isDeletionAnonId(anonId) ? anonId : newDeletionAnonId();
};

// For account deletion. The user's own entries go; in the rest (admin actions by or about them) their
// uid becomes anonId, the deleted-<hex> id their anonymised reports carry. No save.
const anonymizeAuditForUser = (uid, anonId) => {
  for (let index = auditLog.length - 1; index >= 0; index--) {
    const entry = auditLog[index];
    if (entry.actorId !== uid && entry.targetId !== uid) continue;
    if (AUDIT_SELF_ACTIONS.has(entry.action)) {
      auditLog.splice(index, 1);
      continue;
    }
    if (entry.actorId === uid) entry.actorId = anonId;
    if (entry.targetId === uid) entry.targetId = anonId;
  }
};

// Newest first, paged like every other list. action, when given, must be one of AUDIT_ACTIONS.
// Copies, so a caller cannot change the stored entries.
const listAuditEntries = ({ action, limit, before }) => {
  const page = paginateById(action === undefined ? auditLog : auditLog.filter((entry) => entry.action === action), { limit, before });
  return { ...page, items: page.items.map((entry) => ({ ...entry, ...(entry.meta && { meta: { ...entry.meta } }) })) };
};

// ── Load persisted state on startup ──────────────────────────────────────────
// Postgres mode: a stored document that will not load as it is (invalid JSON or shape, or text from before
// schema version 2) is copied into drinkme_state_history first, in place of the .corrupt- file, because
// the start that follows overwrites the row. A failed copy stops the start with the row unchanged.
if (isPostgresDb && preloadedDbText) {
  let needsCopy;
  try {
    const parsed = JSON.parse(preloadedDbText);
    needsCopy = findDbShapeProblem(parsed) !== null || !(parsed.dbSchemaVersion >= DB_SCHEMA_VERSION);
  } catch {
    needsCopy = true;
  }
  if (needsCopy) {
    try {
      await postgresStore.snapshotCurrentToHistory();
      console.warn('[db] Copied the stored Postgres state to drinkme_state_history before loading it (it needs recovery or migration).');
    } catch (err) {
      exitOnDbLoadFailure('copy the state to drinkme_state_history', describePgError(err));
    }
  }
}
// Read by /readyz. True once the load (or a permitted empty start) is done; the server listens only after
// that today, so this guards against a future async load or a listen that moves earlier.
let isDbLoadComplete = false;
loadDb();
isDbLoadComplete = true;
// Set while a Postgres shutdown flush runs, so /readyz takes the instance out of rotation first.
let isShuttingDown = false;

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
// Content hidden after reports is refused here too, so every list and route that uses this leaves it out.
const canViewDrink = (drink, viewerId) => (
  !isBlockedBetween(drink.userId, viewerId) && !isDrinkHiddenFrom(drink, viewerId)
  && (!isAlcoholicDrink(drink) || isAgeConfirmed(viewerId))
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

// For a post canViewDrink refused. A block or a hide after reports comes first and reads exactly like a
// post that does not exist, so the answer says nothing about the post's flag or the viewer's age.
const respondDrinkHidden = (res, drink, viewerId) => (
  isBlockedBetween(drink.userId, viewerId) || isDrinkHiddenFrom(drink, viewerId)
    ? res.status(404).json({ error: 'Drink not found' })
    : respondAgeRequired(res)
);

// Notifications whose text can name a post, and what an unconfirmed reader gets instead.
const NOTIFICATION_TEXT_WITHOUT_POST_NAME = {
  cheer: 'Someone cheered your post.',
  comment: 'Someone commented on your post.',
};

// Every type the server stores. The app writes the text from `params` in the reader's language; the stored
// English `message` stays for older app versions and for entries the app cannot write itself.
const NOTIFICATION_PARAM_TYPES = new Set(['cheer', 'comment', 'partner', 'partner_request']);
const PARTNER_ADDED_NOTIFICATION_SUFFIX = ' added you as a drink partner.';

// How the stored text of each type continues after the actor's name (see the pushNotification calls).
const NOTIFICATION_VERBS_BY_TYPE = {
  cheer: ['cheered your '],
  comment: ['commented on '],
  partner: ['accepted your ', 'added you '],
  partner_request: ['sent you '],
};

// "Someone" when the entry was made while the actor's name was hidden (pending notice or hidden after
// reports): that stays for good, as in the stored text (see getDisplayName). Matched on "Someone <verb of
// this type>", so a user called "Someone Else" is not caught. A user whose own name starts with
// "Someone <that verb>" also reads "Someone": a false "Someone" names nobody, so it is acceptable by design,
// while a false name would not be. Otherwise the actor's name now, so a hidden profile or a later rename
// shows as it is now, and an account that is gone or being deleted reads "Someone".
const getNotificationActorName = (notification) => {
  const { type, message, actorId } = notification;
  const verbs = NOTIFICATION_VERBS_BY_TYPE[type] ?? [];
  if (typeof message === 'string' && verbs.some((verb) => message.startsWith(`Someone ${verb}`))) return 'Someone';
  return isLiveAccount(actorId) ? getDisplayName(actorId) : 'Someone';
};

// A cheer or comment notification is always about the reader's own post. The owner check also guards
// against a drinkId that now names another user's post (ids reused after a restore of an older file).
const getOwnNotificationDrink = (drinkId, viewerId, drinksById) => {
  const drink = drinkId === undefined ? undefined : drinksById.get(drinkId);
  return drink && drink.userId === viewerId ? drink : undefined;
};

// Worked out on each read, never stored. Null for entries from before actorId and for unknown types: the
// app then shows `message`. drinkName only while the post exists, is the reader's own and the reader may
// see it, under its current name. `variant` (partner only) tells the two partner texts apart, from the
// text the server itself wrote.
const toNotificationParams = (notification, viewerId, drinksById) => {
  const { type, actorId, drinkId, message } = notification;
  if (!NOTIFICATION_PARAM_TYPES.has(type) || typeof actorId !== 'string' || !actorId) return null;
  const drink = NOTIFICATION_TEXT_WITHOUT_POST_NAME[type] ? getOwnNotificationDrink(drinkId, viewerId, drinksById) : undefined;
  return {
    actorName: getNotificationActorName(notification),
    drinkName: drink && canViewDrink(drink, viewerId) ? drink.name : null,
    ...(type === 'partner' && {
      variant: typeof message === 'string' && message.endsWith(PARTNER_ADDED_NOTIFICATION_SUFFIX) ? 'added' : 'accepted',
    }),
  };
};

// Older notifications hold no drinkId, and a deleted post cannot be checked: both count as alcoholic.
// The stored text is kept, so it shows in full once the reader confirms. drinkId and actorId stay internal.
const toVisibleNotification = (storedNotification, viewerId, drinksById) => {
  const { drinkId, actorId, ...notification } = storedNotification;
  const params = toNotificationParams(storedNotification, viewerId, drinksById);
  const textWithoutPostName = NOTIFICATION_TEXT_WITHOUT_POST_NAME[notification.type];
  // Defence in depth: requireSignedInAdult already refuses unconfirmed readers of /api/notifications.
  if (!textWithoutPostName || isAgeConfirmed(viewerId)) return { ...notification, params };
  const drink = getOwnNotificationDrink(drinkId, viewerId, drinksById);
  if (drink && canViewDrink(drink, viewerId)) return { ...notification, params };
  // Same as the neutral text: no actor and no post name.
  return { ...notification, message: textWithoutPostName, params: params && { ...params, actorName: 'Someone', drinkName: null } };
};

// What other users may see. An allowlist, so a new field on the user record stays private by default.
// ageConfirmed must stay owner-only (toOwnerUser): the client takes its presence as proof that a JWT is the owner's.
// viewerId: who asks. Without it, a profile hidden after reports is always shown stripped.
const toPublicUser = (user, viewerId) => {
  if (!user) return undefined;
  // Hidden until the owner has read what becomes public, so a user who leaves at the notice was never public.
  // A profile hidden after reports looks the same to others, so the answer does not tell the two apart.
  // The stripped view never carries the official badge: it shows no name to put it next to.
  if (user.noticePending || isUserHiddenFrom(user.id, viewerId)) {
    return { id: user.id, lastName: '', city: '', bio: '', avatar: null, official: false };
  }
  const { id, firstName, lastName, city, bio } = user;
  return {
    id, ...(!isEmailDerivedName(user) && { firstName }), lastName, city, bio, avatar: toAvatarUrl(user), official: isOfficialUser(id),
  };
};

// Same number as PRIVACY_NOTICE_VERSION in src/screens/OnboardingScreen.tsx. Raise both when the notice
// text changes in substance. The notice describes the read rules in this file, so it must change with them.
// Rollout: deploy the server first, then release the client. Any version from 1 up to this one is accepted
// and the highest is stored, so older builds still answering their own notice are never stranded.
// Its partner sentence is untrue with PARTNER_CONSENT_REQUIRED=false, an emergency rollback only: anyone
// can then add themselves and read the list.
// Version 2: nothing is visible without signing in (requireSignedInAdult). Still unreleased, it also
// covers the hide after reports, suspensions and the 30-day backup rule (owner decisions of 2026-11-10),
// the 90-day audit log, and the reported version kept when a reported post is edited.
const PRIVACY_NOTICE_VERSION = 2;

// Legal T-06: the Terms of Use version the user accepted (docs/legal/terms.md). Raise it when the Terms change in
// a way that needs new acceptance; the app asks again (T-07, behind EXPO_PUBLIC_TERMS_STEP_ENABLED until the
// text is reviewed, D-01). Owner default N-2: the server records acceptance but refuses nothing without it.
const TERMS_VERSION = 1;
const getTermsVersion = (user) => (Number.isInteger(user.termsVersion) ? user.termsVersion : null);

const getPrivacyNoticeVersion = (user) => (Number.isInteger(user.privacyNoticeVersion) ? user.privacyNoticeVersion : null);

// What the owner gets back. An allowlist too, so internal fields such as nameSetByUser stay private.
// needsName looks at the record, not the public view, which hides every name while the notice is pending.
// A masked name still comes back in firstName, to the owner only.
const toOwnerUser = (user) => {
  const { id, email, emailVerified, firstName, lastName, city, bio } = user;
  const suspension = getActiveSuspension(user);
  const needsName = !firstName || isEmailDerivedName(user);
  return {
    id,
    email,
    emailVerified,
    firstName,
    lastName,
    city,
    bio,
    avatar: toAvatarUrl(user),
    official: isOfficialUser(id),
    ageConfirmed: isAgeConfirmed(id),
    needsName,
    privacyNoticeVersion: getPrivacyNoticeVersion(user),
    termsVersion: getTermsVersion(user),
    // Only while the name prompt is due: the Google or Apple name was dropped as reserved at sign-in.
    ...(needsName && user.nameReservedAtSignIn === true && { nameReservedAtSignIn: true }),
    // Only while true, so the client can explain it.
    ...(isTargetAutoHidden({ targetType: 'user', targetId: id }, id) && { hiddenPendingReview: true }),
    ...(suspension && toSuspensionState(suspension)),
  };
};

const getPublicName = (publicUser) => `${publicUser.firstName ?? ''} ${publicUser.lastName ?? ''}`.trim();

// No viewer is passed on purpose: the result is stored in notification text that other users read, so a
// profile hidden after reports is stored as "Someone". That stays even after the profile is unhidden,
// which is deliberate: a stored notification must never leak a name that was hidden when it was made.
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
    user: toPublicUser(user, currentUserId),
    isLiked:   likedSet.has(drink.id),
    isSaved:   savedSet.has(drink.id),
    isPartner: currentUserId
      ? (partnerSet.has(drink.userId) || drink.userId === currentUserId)
      : false,
    // Only the owner and the admins ever get a hidden post, so only they see this.
    ...(isTargetAutoHidden({ targetType: 'drink', targetId: drink.id }, drink.userId) && { hiddenPendingReview: true }),
  };
};

// drinkId: the post the comment is listed under, which is how reports name it.
const decorateComment = (comment, viewerId, drinkId = comment.drinkId) => ({
  ...comment,
  user: toPublicUser(userIndex.get(comment.userId), viewerId),
  ...(isTargetAutoHidden({ targetType: 'comment', targetId: comment.id, drinkId }, comment.userId) && { hiddenPendingReview: true }),
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
  // An open report the user filed about someone else stays, under an anonymous reporter id and without
  // its details, so it still reaches the admin queue. One id for all of them, so they stay one reporter.
  // It keeps counting towards the auto-hide only if the user counted at this moment (old enough, notice
  // accepted): the flag is fixed here, so a deleted account never ages into counting. The flag is a plain
  // boolean, which says nothing more about the person. Their resolved reports go, as before.
  const anonymousReporterId = getDeletionAnonId(uid);
  const countedForAutoHide = getAutoHideReporterStatus(user).counts;
  for (let index = reports.length - 1; index >= 0; index--) {
    const report = reports[index];
    const isAboutUser = (report.targetType === 'user' && report.targetId === uid)
      || (report.targetType === 'drink' && ownDrinkIds.has(report.targetId))
      || (report.targetType === 'comment' && (ownCommentKeys.has(`${report.drinkId}:${report.targetId}`) || ownDrinkIds.has(report.drinkId)));
    const isOwnReport = report.reporterId === uid;
    if (isAboutUser || (isOwnReport && report.status !== 'open')) {
      reports.splice(index, 1);
      continue;
    }
    if (isOwnReport) {
      Object.assign(report, { reporterId: anonymousReporterId, details: null, reporterDeleted: true, countsForAutoHide: countedForAutoHide });
      // Lead decision: an anonymised report keeps no copy of the content either.
      delete report.targetSnapshot;
    }
    if (report.resolvedBy === uid) delete report.resolvedBy;
  }
  markReportsChanged();
  // Right after the reports, with the same anonymous id, so an admin entry about this account still matches
  // its open reports. The user's own entries go (see AUDIT_SELF_ACTIONS); a retry finds nothing left to change.
  anonymizeAuditForUser(uid, anonymousReporterId);
  // Another account's suspension history names the admin who acted; that id goes with the admin's account.
  for (const other of userIndex.values()) {
    const history = getSuspensionHistory(other);
    if (!history.some((entry) => entry.by === uid || entry.endedBy === uid)) continue;
    other.suspensions = history.map(({ by, endedBy, ...entry }) => ({
      ...entry,
      ...(by !== undefined && by !== uid && { by }),
      ...(endedBy !== undefined && endedBy !== uid && { endedBy }),
    }));
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
  savedRecipesByUser.delete(uid);
  // Kept scan photos (opt-in only). A file that could not be deleted keeps the cascade open, so it is retried.
  if (aiPhotoStore.deleteForUser(uid).failed > 0) {
    throw Object.assign(new Error('Could not delete kept scan photos'), { code: 'EPHOTODELETE' });
  }
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
  // After everything else, so a cascade that threw records nothing. Only once: a repeat finds no record.
  // The anonymous id only, never the uid. Saved by the caller's save, like the rest of the cascade.
  if (user) appendAudit('account.deletion_completed', { targetId: anonymousReporterId });
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
// The tombstone drops the anonymous id, so nothing links the uid to it once the deletion is done.
const settleAccountDeletion = (uid) => {
  const pendingEntry = pendingAccountDeletions.find((entry) => entry.uid === uid && entry.until === undefined) ?? { uid };
  removeAccountDeletionEntries(uid);
  if (firebaseAuth) pendingAccountDeletions.push({ uid, until: Date.now() + ACCOUNT_TOMBSTONE_MS });
  if (saveDb()) return;
  // A failed save leaves the pending entry in the file, so it must stay in memory too.
  removeAccountDeletionEntries(uid);
  pendingAccountDeletions.push(pendingEntry);
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
    // Postgres mode: the pending entry (and the cascade) must be stored before the Firebase user goes, or
    // a crash could leave a live server record without its Firebase user. Not stored in time: nothing is
    // deleted in Firebase now, and the entry stays for the retry timer. JSON mode: always true here.
    if (!(await waitForDbWritten())) {
      console.warn('[account] A deletion waits for Postgres before removing the Firebase user. It is retried.');
      return false;
    }
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

// The one Firebase user lookup of a sign-in (Firebase mode only; owner decision of 2026-11-12). It answers:
// - 'gone': Firebase has no such user. The tombstone covers tokens issued before a deletion; this also
//   covers a tombstone lost with a restored file, and a user removed in the Firebase Console.
// - 'unavailable': the lookup failed (network, outage, permissions) or returned an unreadable date. Sign-in
//   fails closed, because without tokensValidAfterTime a password reset could not end older sessions.
// - 'ok' with tokensValidAfterMs (ms since epoch, or null when Firebase reports none) and disabled.
// tokensValidAfterTime moves forward whenever Firebase revokes the user's refresh tokens: a password reset
// or change, an email change, or revokeRefreshTokens(). Only the error code is logged, never the value.
const lookUpFirebaseUser = async (uid) => {
  let record;
  try {
    record = await firebaseAuth.getUser(uid);
  } catch (err) {
    if (err.code === 'auth/user-not-found') return { status: 'gone' };
    console.warn('[firebase-admin] getUser failed:', err.code ?? err.name);
    return { status: 'unavailable' };
  }
  const disabled = record?.disabled === true;
  const raw = record?.tokensValidAfterTime;
  if (raw === undefined || raw === null || raw === '') return { status: 'ok', tokensValidAfterMs: null, disabled };
  const tokensValidAfterMs = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(tokensValidAfterMs)) {
    console.warn('[firebase-admin] getUser returned an unreadable tokensValidAfterTime.');
    return { status: 'unavailable' };
  }
  return { status: 'ok', tokensValidAfterMs, disabled };
};

const respondAccountDeleted = (res) => res.status(410).json({
  error: 'This account has been deleted.',
  code: 'account_deleted',
});

// Firebase reports an existing, live account as disabled or gone (Console action): raise sessionGen so every
// API JWT ends, once per state (firebaseSessionEndedReason, cleared by the next good lookup), in its own
// save. A failed save keeps the bump in memory, like the other bumps. Writes nothing for an unknown uid.
// Resolves false only in Postgres mode when the bump is not stored in time (the caller answers 503).
const endSessionsForFirebaseState = async (uid, reason) => {
  const user = userIndex.get(uid);
  if (!user || !isLiveAccount(uid) || user.firebaseSessionEndedReason === reason) return true;
  user.sessionGen = getSessionGen(user) + 1;
  user.firebaseSessionEndedReason = reason;
  appendSessionRevokedAudit(uid, reason);
  return saveSessionBumpDurably();
};

// Retryable: the client shows its session error screen with Retry.
const respondAuthUnavailable = (res) => res.status(503).json({
  error: 'Sign-in is temporarily unavailable. Please try again.',
  code: 'auth_unavailable',
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

// Readiness for host health checks (Docker, Railway, Render): 200 only when the database is loaded and,
// under production rules, firebase-admin is initialised; 503 with a fixed reason code otherwise, never a
// detail or a value. /healthz stays the plain liveness answer. Deliberately not part of it: a failing
// Postgres write-behind (a restart would lose the queued changes; see "Database: JSON or Postgres") and
// the AI service (optional; its outage must not take the API out of rotation).
app.get('/readyz', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const reason = readinessReason({
    dbLoaded: isDbLoadComplete,
    firebaseRequired: isProduction,
    firebaseReady: Boolean(firebaseAuth),
    shuttingDown: isShuttingDown,
  });
  if (reason) return res.status(503).json({ status: 'not_ready', reason });
  res.json({ status: 'ready' });
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
  // ── Password reset ends the server session (Firebase mode only) ──
  // One getUser per sign-in. With REQUIRE_VERIFIED_EMAIL off (the default) it is the only Firebase call:
  // verifyIdToken(idToken, true) would make the same lookup inside firebase-admin and still not hand back
  // tokensValidAfterTime, so it would cost a second call. With the flag on, the flag's own
  // verifyIdToken(idToken, true) below still runs, so that mode makes two calls.
  // The refusal below is the same rule firebase-admin applies for checkRevoked: a token whose auth_time
  // is before tokensValidAfterTime was revoked, and a disabled user is refused.
  let firebaseTokensValidAfterMs = null;
  if (firebaseAuth) {
    const lookup = await lookUpFirebaseUser(verifiedUid);
    if (lookup.status === 'unavailable') return respondAuthUnavailable(res);
    // Disabled or deleted outside the app (Firebase Console): every API session of an existing account
    // ends too. The answers stay the usual ones, and a brand-new uid writes nothing.
    if (lookup.status === 'gone') {
      if (!(await endSessionsForFirebaseState(verifiedUid, 'account_gone'))) return respondSaveFailed(res);
      return respondAccountDeleted(res);
    }
    if (lookup.disabled) {
      if (!(await endSessionsForFirebaseState(verifiedUid, 'account_disabled'))) return respondSaveFailed(res);
      return res.status(401).json({ error: 'Invalid Firebase ID token' });
    }
    firebaseTokensValidAfterMs = lookup.tokensValidAfterMs;
    // Real ID tokens always carry auth_time; one without it cannot be checked, so it is refused.
    const isRevokedToken = firebaseTokensValidAfterMs !== null
      && !(Number.isFinite(authTimeSeconds) && authTimeSeconds * 1000 >= firebaseTokensValidAfterMs);
    if (isRevokedToken) return res.status(401).json({ error: 'Invalid Firebase ID token' });
  }
  // After the deletion checks, so a deleted account still gets 410. A failure here, including a Firebase
  // outage, refuses the sign-in.
  if (REQUIRE_VERIFIED_EMAIL && firebaseAuth && !(await verifyFirebaseToken(idToken, { checkRevoked: true }))) {
    return res.status(401).json({ error: 'Invalid Firebase ID token' });
  }
  // A deletion can have been accepted, or even finished, during that wait.
  if (isAccountDeletionPending(verifiedUid) || (firebaseAuth && isTokenFromBeforeDeletion(verifiedUid, issuedAtSeconds))) return respondAccountDeleted(res);

  const existingUser = userIndex.get(verifiedUid);
  // A concurrent sign-in may have stored a newer tokensValidAfterTime while this one waited for its lookup
  // (the reset happened in between). The stored value is a Firebase value too, so the same rule applies.
  if (
    firebaseAuth && existingUser?.tokensValidAfterSeen > 0
    && !(Number.isFinite(authTimeSeconds) && authTimeSeconds * 1000 >= existingUser.tokensValidAfterSeen)
  ) {
    return res.status(401).json({ error: 'Invalid Firebase ID token' });
  }
  // The token passed the revocation check. Firebase revoked the refresh tokens after the last value this
  // server saw, so every earlier JWT is logged out. Applied here, before the 403 answers below, which then
  // save it too: the revocation is real whatever happens to this sign-in.
  // tokensValidAfterSeen is ms since epoch, or 0 for "looked up, Firebase reported none"; missing means
  // never looked up. On that first lookup the value is compared with lastIdTokenIat (the iat of the last ID
  // token sign-in accepted, so no JWT is newer): a revocation after it bumps, anything else is only stored,
  // so the deploy logs out only accounts reset since their last sign-in. Repeated sign-ins see the stored
  // value and bump nothing. Kept on a failed save like the takeover bump, so a retry does not bump again.
  let revocationBumped = false;
  if (firebaseAuth && existingUser) {
    const storedTokensValidAfter = existingUser.tokensValidAfterSeen;
    const hasStoredValue = Number.isFinite(storedTokensValidAfter);
    const isNewerThanStored = hasStoredValue && firebaseTokensValidAfterMs !== null
      && firebaseTokensValidAfterMs > storedTokensValidAfter;
    const isRevokedSinceLastSignIn = !hasStoredValue && firebaseTokensValidAfterMs !== null
      && Number.isFinite(existingUser.lastIdTokenIat) && firebaseTokensValidAfterMs > existingUser.lastIdTokenIat * 1000;
    if (isNewerThanStored || isRevokedSinceLastSignIn) {
      existingUser.sessionGen = getSessionGen(existingUser) + 1;
      appendSessionRevokedAudit(verifiedUid, 'tokens_revoked');
      revocationBumped = true;
    }
    if (!hasStoredValue || isNewerThanStored) existingUser.tokensValidAfterSeen = firebaseTokensValidAfterMs ?? 0;
    // Firebase accepts the account again (re-enabled), so a later disable ends the sessions again.
    delete existingUser.firebaseSessionEndedReason;
  }
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
  // from before the owner's sign-in must not change the stored state or log the owner out. Only a Firebase
  // revocation applied above is saved here, because it holds whatever this token is.
  if (
    firebaseAuth && isPasswordToken && Number.isFinite(existingUser?.verifiedAuthFloor)
    && !(authTimeSeconds >= existingUser.verifiedAuthFloor)
  ) {
    if (revocationBumped && !(await saveSessionBumpDurably())) return respondSaveFailed(res);
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
      const losesVerifiedState = existingUser && !isStaleToken && !keepsVerifiedState && existingUser.emailVerified !== false;
      if (losesVerifiedState) {
        existingUser.emailVerified = false;
        if (Number.isFinite(issuedAtSeconds)) existingUser.lastIdTokenIat = issuedAtSeconds;
      }
      if (revocationBumped) {
        if (!(await saveSessionBumpDurably())) return respondSaveFailed(res);
      } else if (losesVerifiedState) {
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
      if (revocationBumped && !(await saveSessionBumpDurably())) return respondSaveFailed(res);
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
  if (bumpsSessionGen) user.emailVerified = true;
  // One bump and one entry even when the password-reset bump above already applied (its entry has the reason).
  if (bumpsSessionGen && !revocationBumped) {
    user.sessionGen = getSessionGen(user) + 1;
    // Kept with the bump when the save fails (see below), so the next save records the bump that stays.
    appendSessionRevokedAudit(verifiedUid, undefined);
  }
  // A new account stores the value without a bump (an existing one was handled above).
  if (firebaseAuth && !existingUser) user.tokensValidAfterSeen = firebaseTokensValidAfterMs ?? 0;
  if (isStrongFederatedSignIn && !user.federatedVerifiedAt) user.federatedVerifiedAt = new Date().toISOString();
  // Not rolled back when the save fails, like the rest of sign-in: earlier JWTs stay logged out in
  // memory, and a retry finds the work done and issues a JWT at the new generation.
  if (!saveDbOrRespond(res)) return;
  // Postgres mode: a session generation bump must be stored before the new JWT goes out (see saveDbDurable).
  if ((revocationBumped || bumpsSessionGen) && !(await waitForDbWritten())) return respondSaveFailed(res);

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
    .filter((user) => (
      isLiveAccount(user.id) && !user.noticePending && !isBlockedBetween(req.userId, user.id) && !isUserHiddenFrom(user.id, req.userId)
    ))
    .map((user) => toPublicUser(user, req.userId));
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
    ...toPublicUser(user, viewerId),
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
    .map((id) => ({ ...toPublicUser(userIndex.get(id), requesterId), isPartner: requesterPartners.has(id) })));
});

app.put('/api/users/:id', requireAuth, (req, res) => {
  // SEC-4: verifică că userul autentificat este proprietarul contului
  if (req.userId !== req.params.id) {
    return res.status(403).json({ error: 'Forbidden: cannot edit another user\'s profile' });
  }
  const suspension = getActiveSuspension(userIndex.get(req.userId));
  if (suspension) return respondAccountSuspended(res, suspension);
  const user = userIndex.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { firstName, lastName, city, bio, nameChosen } = req.body || {};
  const previousProfile = {
    firstName: user.firstName, lastName: user.lastName, city: user.city, bio: user.bio, nameSetByUser: user.nameSetByUser,
    nameReservedAtSignIn: user.nameReservedAtSignIn,
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
  const restorePreviousProfile = () => {
    for (const [key, value] of Object.entries(previousProfile)) {
      if (value === undefined) delete user[key];
      else user[key] = value;
    }
  };
  // Only the official account may use the brand name. Checked on the name as it would be saved, and only
  // when the name changes, so a name stored before this rule does not block edits to city or bio. The name
  // prompt making a masked email-prefix name public (nameSetByUser set) counts as a change too.
  const nameChanged = user.firstName !== previousProfile.firstName || user.lastName !== previousProfile.lastName
    || user.nameSetByUser !== previousProfile.nameSetByUser;
  if (nameChanged && !isOfficialUser(user.id) && isReservedDisplayName(user.firstName, user.lastName)) {
    restorePreviousProfile();
    return res.status(400).json({ error: 'This name is reserved for the official DrinkMe account.', code: 'name_reserved' });
  }
  // The sign-in hint has done its job once the owner saves the profile.
  delete user.nameReservedAtSignIn;
  if (!saveDbOrRespond(res)) {
    restorePreviousProfile();
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
  if (type === 'terms') {
    if (!Number.isInteger(version) || version < 1 || version > TERMS_VERSION) {
      return res.status(400).json({ error: 'Invalid acknowledgement' });
    }
    // The highest stays; a repeat or a lower version writes nothing.
    if (version <= (getTermsVersion(user) ?? 0)) return res.json(toOwnerUser(user));
    const { termsVersion: previousVersion, termsAcceptedAt: previousAt } = user;
    user.termsVersion = version;
    user.termsAcceptedAt = new Date().toISOString();
    const undoAudit = appendAudit('ack.terms_accepted', { actorId: user.id, meta: { version } });
    if (!saveDbOrRespond(res)) {
      undoAudit();
      if (previousVersion === undefined) delete user.termsVersion;
      else user.termsVersion = previousVersion;
      if (previousAt === undefined) delete user.termsAcceptedAt;
      else user.termsAcceptedAt = previousAt;
      return;
    }
    return res.json(toOwnerUser(user));
  }
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
    // The user's open reports may now count towards an auto-hide.
    markReportsChanged();
    // Only a new, higher version is an acceptance; ending the hidden state alone is not.
    const undoAudit = version > storedVersion ? appendAudit('ack.privacy_accepted', { actorId: user.id, meta: { version } }) : null;
    if (!saveDbOrRespond(res)) {
      undoAudit?.();
      markReportsChanged();
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
  const undoAudit = appendAudit('ack.age_confirmed', { actorId: user.id });
  if (!saveDbOrRespond(res)) {
    undoAudit();
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

app.post('/api/users/:id/avatar', requireAuth, requireAvatarOwner, refuseIfSuspended, avatarBodyParser, parseUpload(avatarUpload.single('avatar')), (req, res) => {
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
  // anonId: chosen once and saved with the entry, so a retried cascade uses the same id in the reports and the audit log.
  pendingAccountDeletions.push({ uid, anonId: newDeletionAnonId() });
  // Removed again by the cascade below, with the user's other own entries.
  const undoAudit = appendAudit('account.deletion_requested', { actorId: uid });
  // Durable: in Postgres mode the entry must be stored before any data goes (see saveDbDurable).
  if (!(await saveDbDurableOrRespond(res))) {
    undoAudit();
    pendingAccountDeletions.splice(0, pendingAccountDeletions.length, ...previousEntries);
    // Postgres mode: the queued snapshot still holds the entry; queue the undone state after it.
    if (isPostgresDb) saveDb();
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
    .map((id) => toPublicUser(userIndex.get(id), req.userId))
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

const toPartnerRequestUsers = (requests, viewerId) => requests
  .map(({ otherId, createdAt }) => ({ ...toPublicUser(userIndex.get(otherId), viewerId), createdAt }))
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

app.get('/api/drink-partners/requests', requireAuth, (req, res) => {
  res.json({
    incoming: toPartnerRequestUsers(getIncomingPartnerRequests(req.userId), req.userId),
    outgoing: toPartnerRequestUsers(getOutgoingPartnerRequests(req.userId), req.userId),
  });
});

// Comments and partner requests are the app's messaging, so a suspension refuses both sending and accepting.
app.post('/api/drink-partners/requests/:fromId/accept', requireAuth, refuseIfSuspended, (req, res) => {
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
app.post('/api/drink-partners/:targetId', requireAuth, refuseIfSuspended, (req, res) => {
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
  res.json(stories.map((story) => ({ ...story, user: toPublicUser(userIndex.get(story.userId), getUserId(req)) })));
});

app.get('/api/drinks', (req, res) => {
  const currentUserId = getUserId(req);
  const page = parsePageParams(req.query);
  if (!page) return respondInvalidPage(res);
  const cityQuery = parseSearchText(req.query.city);
  const searchQuery = parseSearchText(req.query.q);
  const { alcoholic, scope, sort, category } = req.query;
  const isTrending = sort === 'trending';
  // category works with every scope and sort here; it contradicts only alcoholic=false with an
  // alcoholic category, which is refused rather than answered with an always-empty list.
  const hasValidFilters = cityQuery !== null && searchQuery !== null
    && (alcoholic === undefined || alcoholic === 'false')
    && (scope === undefined || scope === 'discover')
    && (sort === undefined || isTrending)
    && (category === undefined || isDrinkCategory(category))
    && !(alcoholic === 'false' && ALCOHOLIC_DRINK_CATEGORIES.has(category))
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
  // Before the ranking and the paging, so every page is full and cursors stay stable.
  if (category !== undefined) {
    list = list.filter((d) => drinkHasCategory(d, category));
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
  // Before paging. The author of a comment can be blocked when the post's owner is not, and a comment
  // can be hidden after reports for everyone but its author and the admins.
  const visibleComments = (commentsByDrink.get(drinkId) ?? []).filter((comment) => (
    !isBlockedBetween(comment?.userId, viewerId) && !isCommentHiddenFrom(comment, drinkId, viewerId)
  ));
  const { items, nextCursor } = paginateById(visibleComments, page);
  res.json({ items: items.map((comment) => decorateComment(comment, viewerId, drinkId)), nextCursor });
});

app.post('/api/drinks/:id/comments', requireAuth, refuseIfSuspended, (req, res) => {
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
  res.status(201).json(decorateComment(comment, currentUserId, drinkId));
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
  // A comment hidden after reports is missing for everyone else, but the post's owner may still remove it
  // from their own post (lead decision, fix loop 1), even though their comment list leaves it out.
  if (!comment || (!canRemove && isBlockedBetween(comment.userId, currentUserId)) || (!canRemove && isCommentHiddenFrom(comment, drinkId, currentUserId))) {
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

app.post('/api/drinks', requireAuth, refuseIfSuspended, postBodyParser, (req, res) => {
  // The account can have been deleted while the body arrived, after requireAuth.
  if (!isLiveAccount(req.userId)) return res.status(401).json({ error: 'Authentication required' });
  const currentUserId = req.userId;
  const { name, description, rating, location, isAlcoholic, imageData, category } = req.body || {};
  // Before any validation, so the image of a post that would be refused is never processed.
  // Defence in depth: requireSignedInAdult already refuses an unconfirmed user before this route.
  if (isAlcoholic !== false && !isAgeConfirmed(currentUserId)) return respondAgeRequired(res);
  if (!name || !description || !imageData) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  // A missing isAlcoholic means alcoholic (the stored flag below); any other non-boolean is refused.
  if (isAlcoholic !== undefined && typeof isAlcoholic !== 'boolean') {
    return res.status(400).json({ error: 'Invalid isAlcoholic' });
  }
  const parsedCategory = parseDrinkCategory(category, isAlcoholic !== false);
  if (parsedCategory.error) return res.status(400).json({ error: parsedCategory.error });
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
    tags: parsedCategory.tags,
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

// ── Edit a post (Task F, T4-6) ────────────────────────────────────────────────
// The owner may change the text fields, the rating, the alcoholic flag and the category; never the image.
// A field left out stays as stored (a missing isAlcoholic never falls back to the create default). No edit
// history is kept (GDPR-minimal): the old values are overwritten and only `editedAt` records that an edit
// happened. No daily cap and no limit event: the mutation limiter (30/min) applies. The body is parsed by
// the global 100 KB JSON parser, like every small JSON route.
//
// Category and flag: the category is checked against the flag the post will have after the edit. When the
// flag changes, no category is sent and the stored one belongs to the other side, the edit is refused with
// 400 `category_required` rather than silently dropping or keeping a mismatched category; the app then
// sends a new category or null.
const EDITABLE_DRINK_FIELDS = ['name', 'description', 'rating', 'location', 'isAlcoholic', 'category'];

// Returns { changes } (the stored fields to set; never empty, but possibly all equal to the stored values),
// { status: 400, error, code? } for invalid input, or { status: 403, ageRequired: true } when an
// unconfirmed user asks for an alcoholic post.
const parseDrinkEdit = (body, drink, userId) => {
  if (!isPlainObject(body)) return { status: 400, error: 'Invalid body' };
  if (Object.hasOwn(body, 'imageData')) return { status: 400, error: 'Image cannot be changed' };
  const has = (field) => Object.hasOwn(body, field) && body[field] !== undefined;
  if (!EDITABLE_DRINK_FIELDS.some(has)) return { status: 400, error: 'Nothing to change' };

  const changes = {};
  if (has('name')) {
    const safeName = sanitizeText(body.name, 120);
    if (!safeName) return { status: 400, error: 'Name cannot be empty' };
    changes.name = safeName;
  }
  if (has('description')) {
    const safeDescription = sanitizeText(body.description, 1000);
    if (!safeDescription) return { status: 400, error: 'Description cannot be empty' };
    changes.description = safeDescription;
  }
  if (has('location')) {
    // null or '' clears it. A non-empty value that sanitizes to nothing (spaces, controls) is refused.
    if (body.location !== null && typeof body.location !== 'string') return { status: 400, error: 'Invalid location' };
    const safeLocation = sanitizeOptional(body.location, 180);
    if (safeLocation === '') return { status: 400, error: 'Location cannot be empty' };
    changes.location = safeLocation;
  }
  if (has('rating')) {
    if (typeof body.rating !== 'number' || !Number.isFinite(body.rating) || body.rating < 0 || body.rating > 5) {
      return { status: 400, error: 'Rating must be between 0 and 5' };
    }
    changes.rating = body.rating;
  }
  if (has('isAlcoholic')) {
    if (typeof body.isAlcoholic !== 'boolean') return { status: 400, error: 'Invalid isAlcoholic' };
    // Defence in depth: requireSignedInAdult already refuses an unconfirmed user before this route.
    if (body.isAlcoholic && !isAgeConfirmed(userId)) return { status: 403, ageRequired: true };
    changes.isAlcoholic = body.isAlcoholic;
  }
  const resultingAlcoholic = has('isAlcoholic') ? body.isAlcoholic : isAlcoholicDrink(drink);
  if (has('category')) {
    // A stored category that does not match the stored flag (an inconsistent older record) is replaced by
    // whatever is sent here, null included: clearing it is intended.
    const parsedCategory = parseDrinkCategory(body.category, resultingAlcoholic);
    if (parsedCategory.error) return { status: 400, error: parsedCategory.error };
    changes.tags = parsedCategory.tags;
  } else if (resultingAlcoholic !== isAlcoholicDrink(drink)) {
    const storedCategory = Array.isArray(drink.tags) ? drink.tags.find(isDrinkCategory) : undefined;
    if (storedCategory && ALCOHOLIC_DRINK_CATEGORIES.has(storedCategory) !== resultingAlcoholic) {
      return {
        status: 400,
        error: 'The category does not match the new isAlcoholic. Send a new category or null.',
        code: 'category_required',
      };
    }
  }
  return { changes };
};

// True when applying the change would leave the stored post as it is.
const isSameDrinkValue = (field, stored, next) => {
  if (field === 'tags') return JSON.stringify(Array.isArray(stored) ? stored : []) === JSON.stringify(next);
  if (field === 'location') return (stored || null) === (next || null);
  if (field === 'isAlcoholic') return (stored !== false) === next;
  return stored === next;
};

const DRINK_EDIT_SNAPSHOT_FIELDS = ['name', 'description', 'rating', 'location', 'isAlcoholic', 'tags', 'editedAt'];

// Moderation evidence (lead decision, Task F fix loop 1). An edit must not let an owner wipe what was
// reported, so the first edit after a report stores, on each open report about the post that has none yet,
// the content as it was reported: targetSnapshot { name, description, location, isAlcoholic, category,
// capturedAt }. GDPR basis: it is kept only for moderation (legitimate interest in reviewing the report),
// it holds the minimum the admin needs, and it is deleted when the report is resolved and by account
// deletion (deleteUserDataCascade). A second edit never overwrites it. Returns the reports that got one,
// so a failed save can take them off again.
const captureReportSnapshots = (drink) => {
  const openReports = reports.filter((report) => (
    report.status === 'open' && report.targetType === 'drink' && report.targetId === drink.id && !report.targetSnapshot
  ));
  if (!openReports.length) return [];
  const targetSnapshot = {
    name: drink.name,
    description: drink.description,
    location: drink.location ?? null,
    isAlcoholic: isAlcoholicDrink(drink),
    category: Array.isArray(drink.tags) ? drink.tags.find(isDrinkCategory) ?? null : null,
    capturedAt: new Date().toISOString(),
  };
  for (const report of openReports) report.targetSnapshot = { ...targetSnapshot };
  return openReports;
};

// The bytes captureReportSnapshots would add, for the growth guard.
const reportSnapshotBytes = (drink) => {
  const count = reports.filter((report) => (
    report.status === 'open' && report.targetType === 'drink' && report.targetId === drink.id && !report.targetSnapshot
  )).length;
  if (!count) return 0;
  const sample = {
    name: drink.name, description: drink.description, location: drink.location ?? null,
    isAlcoholic: true, category: null, capturedAt: new Date().toISOString(),
  };
  return count * Buffer.byteLength(JSON.stringify({ targetSnapshot: sample }));
};

app.put('/api/drinks/:id', requireAuth, refuseIfSuspended, (req, res) => {
  const currentUserId = req.userId;
  const drinkId = parsePositiveInteger(req.params.id);
  const drink = drinks.find((d) => d.id === drinkId);
  if (!drink) return res.status(404).json({ error: 'Drink not found' });
  if (drink.userId !== currentUserId) {
    return isBlockedBetween(drink.userId, currentUserId) || isDrinkHiddenFrom(drink, currentUserId)
      ? res.status(404).json({ error: 'Drink not found' })
      : res.status(403).json({ error: 'Forbidden' });
  }
  if (isTargetAutoHidden({ targetType: 'drink', targetId: drink.id }, drink.userId)) {
    return res.status(409).json({ error: 'This post is hidden pending review and cannot be edited.', code: 'hidden_pending_review' });
  }

  const parsed = parseDrinkEdit(req.body, drink, currentUserId);
  if (parsed.ageRequired) return respondAgeRequired(res);
  if (parsed.error) return res.status(parsed.status).json({ error: parsed.error, ...(parsed.code && { code: parsed.code }) });

  const changedFields = Object.keys(parsed.changes)
    .filter((field) => !isSameDrinkValue(field, drink[field], parsed.changes[field]));
  // Nothing changed: no save and no new editedAt.
  if (!changedFields.length) return res.json(decorateDrink(drink, currentUserId));
  const editedAt = new Date().toISOString();
  if (isDbGrowthBlocked()) {
    // The whole stored record, editedAt included, plus any report snapshots, because that is what the file holds.
    const candidate = { ...drink, ...parsed.changes, editedAt };
    const addedBytes = Buffer.byteLength(JSON.stringify(candidate)) - Buffer.byteLength(JSON.stringify(drink))
      + reportSnapshotBytes(drink);
    if (addedBytes > 0) return respondDbGrowthBlocked(res);
  }

  const snapshot = Object.fromEntries(
    DRINK_EDIT_SNAPSHOT_FIELDS.filter((field) => Object.hasOwn(drink, field)).map((field) => [field, drink[field]]),
  );
  // Before the change, so it holds the content as reported.
  const snapshotReports = captureReportSnapshots(drink);
  for (const field of changedFields) drink[field] = parsed.changes[field];
  drink.editedAt = editedAt;
  if (!saveDbOrRespond(res)) {
    for (const field of DRINK_EDIT_SNAPSHOT_FIELDS) {
      if (Object.hasOwn(snapshot, field)) drink[field] = snapshot[field];
      else delete drink[field];
    }
    for (const report of snapshotReports) delete report.targetSnapshot;
    return;
  }
  res.json(decorateDrink(drink, currentUserId));
});

// Optional body { cheered: boolean } or { saved: boolean } sets the state, so a repeated request leaves it
// as asked (the app sends one per tap, optimistically). Without that field the route toggles, as older
// apps expect. undefined means toggle, null an invalid body.
const readToggleTarget = (body, field) => {
  if (body === undefined || (isPlainObject(body) && !Object.hasOwn(body, field))) return undefined;
  return isPlainObject(body) && typeof body[field] === 'boolean' ? body[field] : null;
};

// Cheers and saves stay open to suspended users. Turning one on is growth, so it checks the size guard;
// asking for the state already held changes and saves nothing. A failed save puts back the set, the count
// and the post owner's notifications, so the server matches the app's rollback.
// One cheer notification per cheerer and post while it is kept (read or not), so cycling a cheer off
// and on cannot flood the owner's list, which keeps only the newest entries.
const hasCheerNotification = (ownerId, actorId, drinkId) => {
  const now = Date.now();
  return (notificationsByUser.get(ownerId) ?? []).some((item) => (
    item.type === 'cheer' && item.actorId === actorId && item.drinkId === drinkId
    && now - new Date(item.createdAt).getTime() <= NOTIFICATION_MAX_AGE_MS
  ));
};

app.post('/api/drinks/:id/like', requireAuth, (req, res) => {
  const currentUserId = req.userId;
  const target = readToggleTarget(req.body, 'cheered');
  if (target === null) return res.status(400).json({ error: 'cheered must be true or false' });
  const drinkId = parsePositiveInteger(req.params.id);
  const drink = drinks.find((d) => d.id === drinkId);
  if (!drink) return res.status(404).json({ error: 'Drink not found' });
  if (!canViewDrink(drink, currentUserId)) return respondDrinkHidden(res, drink, currentUserId);

  const hadSet = cheersByUser.has(currentUserId);
  const likedSet = cheersByUser.get(currentUserId) || new Set();
  const wasCheered = likedSet.has(drink.id);
  const cheered = target ?? !wasCheered;
  if (cheered === wasCheered) return res.json({ cheered, cheersCount: drink.cheersCount || 0 });
  if (cheered && isDbGrowthBlocked()) return respondDbGrowthBlocked(res);

  const previousCount = drink.cheersCount;
  const firstNewNotificationId = nextNotificationId;
  // A copy, because the per-user cap can drop the oldest notification from the live list.
  const previousNotifications = notificationsByUser.get(drink.userId)?.slice();
  if (cheered) {
    likedSet.add(drink.id);
    drink.cheersCount = (drink.cheersCount || 0) + 1;
    if (drink.userId !== currentUserId && !hasCheerNotification(drink.userId, currentUserId, drink.id)) {
      pushNotification(drink.userId, currentUserId, 'cheer', `${getDisplayName(currentUserId)} cheered your drink ${drink.name}.`, drink.id);
    }
  } else {
    likedSet.delete(drink.id);
    drink.cheersCount = Math.max(0, (drink.cheersCount || 0) - 1);
  }
  cheersByUser.set(currentUserId, likedSet);
  if (!saveDbOrRespond(res)) {
    if (cheered) likedSet.delete(drink.id);
    else likedSet.add(drink.id);
    if (!hadSet) cheersByUser.delete(currentUserId);
    drink.cheersCount = previousCount;
    if (nextNotificationId !== firstNewNotificationId) {
      if (previousNotifications) notificationsByUser.set(drink.userId, previousNotifications);
      else notificationsByUser.delete(drink.userId);
      nextNotificationId = firstNewNotificationId;
    }
    return;
  }
  res.json({ cheered, cheersCount: drink.cheersCount });
});

app.post('/api/drinks/:id/save', requireAuth, (req, res) => {
  const currentUserId = req.userId;
  const target = readToggleTarget(req.body, 'saved');
  if (target === null) return res.status(400).json({ error: 'saved must be true or false' });
  const drinkId = parsePositiveInteger(req.params.id);
  const drink = drinks.find((d) => d.id === drinkId);
  if (!drink) return res.status(404).json({ error: 'Drink not found' });
  if (!canViewDrink(drink, currentUserId)) return respondDrinkHidden(res, drink, currentUserId);

  const hadSet = savedByUser.has(currentUserId);
  const savedSet = savedByUser.get(currentUserId) || new Set();
  const wasSaved = savedSet.has(drink.id);
  const saved = target ?? !wasSaved;
  if (saved === wasSaved) return res.json({ saved });
  if (saved && isDbGrowthBlocked()) return respondDbGrowthBlocked(res);

  if (saved) savedSet.add(drink.id);
  else savedSet.delete(drink.id);
  savedByUser.set(currentUserId, savedSet);
  if (!saveDbOrRespond(res)) {
    if (saved) savedSet.delete(drink.id);
    else savedSet.add(drink.id);
    if (!hadSet) savedByUser.delete(currentUserId);
    return;
  }
  res.json({ saved });
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
  // Only the posts these entries name (at most 200), so one pass over the posts and a small map.
  const neededDrinkIds = new Set(list.map((n) => n.drinkId).filter((id) => id !== undefined));
  const drinksById  = new Map(neededDrinkIds.size === 0 ? [] : drinks.filter((drink) => neededDrinkIds.has(drink.id)).map((drink) => [drink.id, drink]));
  res.json({ notifications: list.map((n) => toVisibleNotification(n, req.userId, drinksById)), unreadCount });
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
    const user = isLiveAccount(id) ? toPublicUser(userIndex.get(id), req.userId) : undefined;
    if (!user || !hasBlocked(id, req.userId)) return user;
    // They blocked the caller too, so only what the caller needs to recognize the entry.
    return { id: user.id, firstName: user.firstName, lastName: user.lastName, official: user.official };
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

// The official DrinkMe account(s). Read once at start and parsed like ADMIN_USER_IDS; empty means none.
// Owner decision (2026-11-12): an official user gets official: true in every user view (and so on every post,
// comment, search result and partner entry that embeds one), may use the reserved brand name in its profile
// name, and its content is never auto-hidden by reports. It is not an admin: it gets no /api/admin access,
// and admins can suspend it like any user unless it is also listed in ADMIN_USER_IDS.
const OFFICIAL_USER_IDS = new Set(
  (process.env.OFFICIAL_USER_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean)
);

// Counts only, like the admin ids above.
const unknownOfficialCount = Array.from(OFFICIAL_USER_IDS).filter((id) => !userIndex.has(id)).length;
// One count-only line at every start, so a test session log shows whether an official account is set.
if (OFFICIAL_USER_IDS.size > 0) {
  console.log(`[official] ${OFFICIAL_USER_IDS.size} official account(s) configured, ${OFFICIAL_USER_IDS.size - unknownOfficialCount} of them known users.`);
}
if (unknownOfficialCount > 0) {
  console.warn(`[official] OFFICIAL_USER_IDS: ${unknownOfficialCount} of ${OFFICIAL_USER_IDS.size} match no known user.`);
}
// The official uid must never be an admin: an admin cannot be suspended, so the brand account would lose its
// kill switch. Counts only.
const officialAdminCount = Array.from(OFFICIAL_USER_IDS).filter((id) => ADMIN_USER_IDS.has(id)).length;
if (officialAdminCount > 0) {
  console.warn(`[official] ${officialAdminCount} OFFICIAL_USER_IDS entr(y/ies) also in ADMIN_USER_IDS: it cannot be suspended. Keep them separate.`);
}
// Dev sign-in trusts the client's uid, so anyone could sign in as the official account.
if (allowInsecureDevAuth && OFFICIAL_USER_IDS.size > 0) {
  console.warn(`[official] OFFICIAL_USER_IDS has ${OFFICIAL_USER_IDS.size} entr(y/ies) while ALLOW_INSECURE_DEV_AUTH=true: anyone can sign in as them.`);
}
// Names stored before the reserved-name rule are left as they are (no silent data change); the profile
// edit refuses any name change that still uses the brand name, and admins can clear such a profile
// (clear_profile) after a report. Counts only, so no name or id reaches the logs.
const reservedLegacyNameCount = Array.from(userIndex.values())
  .filter((user) => isPlainObject(user) && !isOfficialUser(user.id) && isReservedDisplayName(user.firstName, user.lastName)).length;
if (reservedLegacyNameCount > 0) {
  console.warn(`[official] ${reservedLegacyNameCount} non-official profile name(s) use a reserved name (brand, Official or a check mark).`);
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
    && !isCommentHiddenFrom(found.comment, found.drinkId, viewerId)
    ? found.comment.userId
    : null;
};

// The answer holds only the id: reporter and details are for admins.
app.post('/api/reports', requireAuth, refuseIfSuspended, (req, res) => {
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
  markReportsChanged();
  if (!saveDbOrRespond(res)) {
    reports.pop();
    markReportsChanged();
    nextReportId = report.id;
    return;
  }
  res.status(201).json({ id: report.id });
});

// Public fields only, so the target user's email never reaches a report. Null once the target is gone.
// viewerId is the admin, who sees a profile hidden after reports in full.
const toAdminReportTarget = ({ targetType, targetId, drinkId }, viewerId) => {
  if (targetType === 'user') return toPublicUser(userIndex.get(targetId), viewerId) ?? null;
  if (targetType === 'drink') {
    const drink = drinks.find((d) => d.id === targetId);
    if (!drink) return null;
    const { id, userId, name, description, location, isAlcoholic, rating, createdAt, editedAt } = drink;
    const category = Array.isArray(drink.tags) ? drink.tags.find(isDrinkCategory) ?? null : null;
    // The current content: an edit overwrites it, and editedAt tells the admin it changed. The content as
    // reported is on the report itself (targetSnapshot), from the first edit after the report.
    return {
      id, userId, name, description, location, isAlcoholic, category, rating, createdAt, ...(editedAt && { editedAt }),
      imageUrl: toDrinkImageUrl(drink), user: toPublicUser(userIndex.get(userId), viewerId),
    };
  }
  const comment = (commentsByDrink.get(drinkId) ?? []).find((item) => item?.id === targetId);
  if (!comment) return null;
  const { id, userId, content, createdAt } = comment;
  return { id, drinkId, userId, content, createdAt, user: toPublicUser(userIndex.get(userId), viewerId) };
};
// editedAfterReport: the reported post was edited after this report was filed, so target is no longer the
// content as reported; targetSnapshot (when present) is.
const isEditedAfterReport = (report) => {
  if (report.targetType !== 'drink') return false;
  const editedAt = drinks.find((d) => d.id === report.targetId)?.editedAt;
  return Boolean(editedAt) && new Date(editedAt).getTime() > new Date(report.createdAt).getTime();
};
const toAdminReport = (report, viewerId) => ({
  ...report,
  target: toAdminReportTarget(report, viewerId),
  editedAfterReport: isEditedAfterReport(report),
});

// Owner decision (2026-11-10): an open report should be reviewed within this time.
const REPORT_REVIEW_TARGET_MS = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

const reportAgeMs = (report, now) => now - new Date(report.createdAt).getTime();
const isReportOverdue = (report, now) => report.status === 'open' && reportAgeMs(report, now) > REPORT_REVIEW_TARGET_MS;

// Fields added for the review queue only; the stored report has none of them.
// openReporterCount: every distinct open reporter. autoHideReporterCount: those who count towards the
// hide (account 48 hours old and notice accepted), so an admin can see a hide that a batch of new accounts did not reach.
// targetOfficial: the content belongs to the official DrinkMe account, which is never auto-hidden.
// drinkOwners: post id to owner id, built once per request so a long queue does not scan the posts per item.
const toAdminReportListItem = (report, viewerId, now, drinkOwners) => {
  const ageMs = reportAgeMs(report, now);
  const ownerId = findReportTargetOwnerId(report, drinkOwners);
  return {
    ...toAdminReport(report, viewerId),
    ageHours: Number.isFinite(ageMs) ? Math.max(0, Math.floor(ageMs / MS_PER_HOUR)) : null,
    overdue: isReportOverdue(report, now),
    openReporterCount: countOpenReporters(report),
    autoHideReporterCount: countAutoHideReporters(report),
    autoHidden: isTargetAutoHidden(report, ownerId),
    targetOfficial: isOfficialUser(ownerId),
  };
};

// Oldest first and with no paging, so working through the queue reaches every report.
// overdueCount always counts the open queue, whichever status is listed.
app.get('/api/admin/reports', requireAuth, requireAdmin, (req, res) => {
  const { status = 'open' } = req.query;
  if (status !== 'open' && status !== 'resolved') return res.status(400).json({ error: 'Invalid status' });
  const now = Date.now();
  const matching = reports.filter((r) => r.status === status);
  const drinkOwners = new Map(drinks.map((drink) => [drink.id, drink.userId]));
  res.json({
    items: matching.slice(0, ADMIN_REPORTS_MAX_ITEMS).map((r) => toAdminReportListItem(r, req.userId, now, drinkOwners)),
    total: matching.length,
    overdueCount: reports.filter((r) => isReportOverdue(r, now)).length,
  });
});

// Returns the undo, or null when the target is already gone.
const removeReportTarget = ({ targetType, targetId, drinkId }) => {
  if (targetType === 'drink') return deleteDrinkCascade(targetId);
  if (targetType === 'user') return clearUserProfile(targetId);
  return deleteCommentFromDrink(drinkId, targetId);
};

// Whose content a report names, or undefined once it is gone.
// drinkOwners (optional): a Map of post id to owner id, for callers that look up many reports at once.
const findReportTargetOwnerId = ({ targetType, targetId, drinkId }, drinkOwners) => {
  if (targetType === 'user') return targetId;
  if (targetType === 'drink') return drinkOwners ? drinkOwners.get(targetId) : drinks.find((d) => d.id === targetId)?.userId;
  return (commentsByDrink.get(drinkId) ?? []).find((item) => item?.id === targetId)?.userId;
};

const respondCannotSuspendAdmin = (res) => res.status(403).json({ error: 'An admin account cannot be suspended.', code: 'cannot_suspend_admin' });

// The account an admin may suspend, or null once a response was sent.
const findSuspendableUser = (res, userId) => {
  const user = typeof userId === 'string' && isLiveAccount(userId) ? userIndex.get(userId) : undefined;
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return null;
  }
  // Covers the admin's own account too.
  if (isAdmin(userId)) {
    respondCannotSuspendAdmin(res);
    return null;
  }
  return user;
};

// suspensionCount counts the suspensions that count towards a permanent repeat, so not voided ones.
const toAdminSuspensionResult = (user) => {
  const suspension = getActiveSuspension(user);
  return {
    userId: user.id,
    suspended: Boolean(suspension),
    suspendedUntil: suspension ? toSuspensionState(suspension).suspendedUntil : null,
    suspendedPermanently: suspension ? suspension.permanent === true : false,
    suspensionCount: getCountedSuspensions(user).length,
  };
};

const ALREADY_SUSPENDED_MESSAGE = 'This account is already suspended. Send permanent: true to make it permanent.';

// Either action resolves every open report on the same target. No growth check: this frees storage.
// suspend: true also suspends the owner of the reported content (see suspendUser), and permanent: true makes
// that suspension permanent. Checked before anything changes: an admin owner (403) or content that is
// already gone (409 suspend_target_gone) resolves nothing. An owner who is already suspended is not
// suspended again unless permanent: true escalates it; the report is still resolved, and the answer's
// suspension says applied: false with code already_suspended.
app.post('/api/admin/reports/:id/resolve', requireAuth, requireAdmin, async (req, res) => {
  const reportId = parsePositiveInteger(req.params.id);
  const report = reports.find((r) => r.id === reportId);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  const { action, suspend, permanent } = req.body || {};
  if (!['dismiss', 'remove_content', 'clear_profile'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  if (suspend !== undefined && typeof suspend !== 'boolean') return res.status(400).json({ error: 'Invalid suspend' });
  if (permanent !== undefined && typeof permanent !== 'boolean') return res.status(400).json({ error: 'Invalid permanent' });
  if (action === 'remove_content' && report.targetType === 'user') {
    return res.status(400).json({ error: 'A user cannot be removed this way' });
  }
  if (action === 'clear_profile' && report.targetType !== 'user') {
    return res.status(400).json({ error: 'Only a user profile can be cleared' });
  }
  if (report.status !== 'open') return res.status(409).json({ error: 'Report already resolved' });
  // Before the removal below, which would lose who owned the content.
  let userToSuspend = null;
  if (suspend === true) {
    const ownerId = findReportTargetOwnerId(report);
    if (typeof ownerId !== 'string' || !isLiveAccount(ownerId)) {
      return res.status(409).json({ error: 'The reported content or its owner no longer exists.', code: 'suspend_target_gone' });
    }
    userToSuspend = findSuspendableUser(res, ownerId);
    if (!userToSuspend) return;
  }
  const forcePermanent = permanent === true;
  const skipsSuspension = Boolean(userToSuspend) && isAlreadySuspended(userToSuspend, forcePermanent);
  // Whose content it was, read before the removal below. Undefined once the content is gone.
  const targetOwnerId = findReportTargetOwnerId(report);

  const undoRemoval = action === 'dismiss' ? null : removeReportTarget(report);
  const removed = Boolean(undoRemoval); // false for a target that was already gone
  const resolvedAt = new Date().toISOString();
  const resolved = reports.filter((r) => (
    r.status === 'open' && r.targetType === report.targetType && r.targetId === report.targetId && r.drinkId === report.drinkId
  ));
  const previousDetails = resolved.map((item) => item.details);
  // The snapshot of an edited post is moderation evidence only, so it goes with the resolve.
  const previousSnapshots = resolved.map((item) => item.targetSnapshot);
  for (const item of resolved) {
    Object.assign(item, { status: 'resolved', action, removed, details: null, resolvedAt, resolvedBy: req.userId });
    delete item.targetSnapshot;
  }
  markReportsChanged();
  pruneResolvedReporters();
  // The reason names the report and its fixed reason code, never the reporter's text.
  const undoSuspension = userToSuspend && !skipsSuspension
    ? suspendUser(userToSuspend, req.userId, `report ${report.id}: ${report.reason}`, { forcePermanent })
    : null;
  const undoAudits = [appendAudit('admin.report_resolved', {
    actorId: req.userId,
    targetId: typeof targetOwnerId === 'string' ? targetOwnerId : null,
    meta: { reportId: report.id, action, resolvedCount: resolved.length },
  })];
  if (undoSuspension) {
    undoAudits.push(appendAudit('admin.user_suspended', {
      actorId: req.userId, targetId: userToSuspend.id, meta: { permanent: getActiveSuspension(userToSuspend)?.permanent === true },
    }));
  }
  // A suspension is saved durably like the direct route (Postgres mode); the rest as before.
  if (!(undoSuspension ? await saveDbDurableOrRespond(res) : saveDbOrRespond(res))) {
    for (const undo of undoAudits.reverse()) undo();
    undoSuspension?.();
    undoRemoval?.();
    resolved.forEach((item, index) => {
      item.status = 'open';
      item.details = previousDetails[index];
      if (previousSnapshots[index] !== undefined) item.targetSnapshot = previousSnapshots[index];
      delete item.action;
      delete item.removed;
      delete item.resolvedAt;
      delete item.resolvedBy;
    });
    markReportsChanged();
    // Postgres mode: the queued snapshot still holds the resolve; queue the undone state after it.
    if (isPostgresDb && undoSuspension) saveDb();
    return;
  }
  res.json({
    ...toAdminReport(report, req.userId),
    ...(userToSuspend && {
      suspension: {
        ...toAdminSuspensionResult(userToSuspend),
        applied: !skipsSuspension,
        ...(skipsSuspension && { code: 'already_suspended' }),
      },
    }),
  });
});

// Optional { reason } (up to 300 characters) and { permanent: true }. A first suspension lasts 7 days, any
// later counted one is permanent. One in force answers 409 already_suspended with the current state,
// unless permanent: true escalates a temporary one, so a double tap changes nothing.
// No growth check: the entry is small, and moderation must keep working once storage is full.
app.post('/api/admin/users/:id/suspend', requireAuth, requireAdmin, async (req, res) => {
  const { reason, permanent } = req.body || {};
  if (reason !== undefined && reason !== null && typeof reason !== 'string') return res.status(400).json({ error: 'Invalid reason' });
  if (permanent !== undefined && typeof permanent !== 'boolean') return res.status(400).json({ error: 'Invalid permanent' });
  const user = findSuspendableUser(res, req.params.id);
  if (!user) return;
  const forcePermanent = permanent === true;
  if (isAlreadySuspended(user, forcePermanent)) {
    return res.status(409).json({ error: ALREADY_SUSPENDED_MESSAGE, code: 'already_suspended', ...toAdminSuspensionResult(user) });
  }
  const undoSuspension = suspendUser(user, req.userId, sanitizeOptional(reason, SUSPENSION_REASON_MAX_LENGTH), { forcePermanent });
  // The reason stays in the user's history only, never in the audit log.
  const undoAudit = appendAudit('admin.user_suspended', {
    actorId: req.userId, targetId: user.id, meta: { permanent: getActiveSuspension(user)?.permanent === true },
  });
  // Durable (Postgres mode: stored before the admin is told it worked); undone and re-queued otherwise.
  if (!(await saveDbDurableOrRespond(res))) {
    undoAudit();
    undoSuspension();
    if (isPostgresDb) saveDb();
    return;
  }
  res.json(toAdminSuspensionResult(user));
});

// Ends a suspension in force now. The entry stays in the history, so a later suspension is still permanent,
// unless { void: true } marks it voided: a suspension made by mistake, kept for the record, that does not
// count towards a permanent repeat. Nothing in force: nothing changes.
app.post('/api/admin/users/:id/unsuspend', requireAuth, requireAdmin, async (req, res) => {
  const { void: isVoid } = req.body || {};
  if (isVoid !== undefined && typeof isVoid !== 'boolean') return res.status(400).json({ error: 'Invalid void' });
  const user = isLiveAccount(req.params.id) ? userIndex.get(req.params.id) : undefined;
  if (!user) return res.status(404).json({ error: 'User not found' });
  const active = getActiveSuspension(user);
  if (!active) return res.json(toAdminSuspensionResult(user));
  const previous = user.suspensions;
  const endedAt = new Date().toISOString();
  user.suspensions = getSuspensionHistory(user).map((entry) => (
    entry === active ? { ...entry, endedAt, endedBy: req.userId, ...(isVoid === true && { voided: true }) } : entry
  ));
  const undoAudit = appendAudit('admin.user_unsuspended', { actorId: req.userId, targetId: user.id, meta: { void: isVoid === true } });
  if (!(await saveDbDurableOrRespond(res))) {
    undoAudit();
    user.suspensions = previous;
    if (isPostgresDb) saveDb();
    return;
  }
  res.json(toAdminSuspensionResult(user));
});

// Admin only, no screen yet. Newest first, paged ({ items, nextCursor }); ?action= must be one of
// AUDIT_ACTIONS (400 otherwise). Entries hold ids only, never names or emails.
app.get('/api/admin/audit', requireAuth, requireAdmin, (req, res) => {
  const page = parsePageParams(req.query);
  if (!page) return respondInvalidPage(res);
  const { action } = req.query;
  if (action !== undefined && !(typeof action === 'string' && AUDIT_ACTIONS.has(action))) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  res.json(listAuditEntries({ action, ...page }));
});

// ── AI v1: scanner, barcode fallback, recipes, saved recipes ──────────────────
// Contracts: .claude/skills/drinkme-ai-service, recipe-schema, ingredient-taxonomy. The provider's output is
// never trusted: scans go through validateScanResult, recipes through normalizeRecipe + checkRecipe (S1-S13).
// Photos stay in memory unless the user opted in (aiPhotoOptIn). Request bodies are never logged.
// Raise when the AI notice text changes in substance (users then accept it again).
const AI_NOTICE_VERSION = 1;
const AI_SCHEMA_VERSION = '1';
// Version of the photo opt-in consent text (ai.settings.photoBody, docs/legal/ai-transparency.md §9.2). Stored with
// the time of consent (GDPR Art. 7(1)); raise it when the text changes in substance.
const AI_PHOTO_CONSENT_VERSION = 1;
// Per-user daily limits (rolling 24 hours). A failure that is not the user's doing gives the unit back.
const parseDailyLimit = (raw, fallback) => (/^\d{1,4}$/.test(raw ?? '') && Number(raw) > 0 ? Number(raw) : fallback);
const AI_DAILY_SCAN_LIMIT = parseDailyLimit(process.env.AI_DAILY_SCAN_LIMIT, 20);
const AI_DAILY_RECIPE_LIMIT = parseDailyLimit(process.env.AI_DAILY_RECIPE_LIMIT, 10);
const AI_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
// Recipe slots run in parallel on the GPU (Ollama OLLAMA_NUM_PARALLEL must allow it). 1-4, default 2.
const AI_RECIPE_CONCURRENCY = /^[1-4]$/.test(process.env.AI_RECIPE_CONCURRENCY ?? '') ? Number(process.env.AI_RECIPE_CONCURRENCY) : 2;
// D-22 (2026-11-22): no photo opt-in at launch. The code stays, behind this flag, off unless exactly 'true'.
const AI_PHOTO_OPT_IN_ENABLED = process.env.AI_PHOTO_OPT_IN_ENABLED === 'true';
const AI_V1_RATE_LIMIT_PER_HOUR = /^\d{1,4}$/.test(process.env.AI_RATE_LIMIT_PER_HOUR ?? '') ? Number(process.env.AI_RATE_LIMIT_PER_HOUR) : 30;
const BARCODE_RATE_LIMIT_PER_HOUR = 60;
const SAVED_RECIPES_MAX = 200;
const AI_BASICS_MAX_COUNT = 12;
const AI_BASIC_MAX_LENGTH = 40;
const AI_SMART_BAR_MAX_INPUTS = 60;
const AI_SCAN_NAME_MAX_LENGTH = 120;
const AI_HEALTH_CACHE_MS = 10_000;
const AI_LANGUAGES = ['en', 'ro'];
const AI_DEFAULT_BASICS = { en: ['ice', 'water', 'sugar', 'salt'], ro: ['gheață', 'apă', 'zahăr', 'sare'] };
const AI_SCAN_CATEGORIES = new Set(SCAN_CATEGORIES);

const toAiLanguage = (value) => (AI_LANGUAGES.includes(value) ? value : 'en');

const aiV1Limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: AI_V1_RATE_LIMIT_PER_HOUR,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `ai:${req.userId}`,
  message: { error: 'Too many AI requests. Try again later.', code: 'ai_rate_limit' },
});
const barcodeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: BARCODE_RATE_LIMIT_PER_HOUR,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `barcode:${req.userId}`,
  message: { error: 'Too many barcode lookups. Try again later.', code: 'ai_rate_limit' },
});

const hasAcceptedAiNotice = (user) => user?.aiNoticeVersion === AI_NOTICE_VERSION;

const requireAiProvider = (req, res, next) => (
  aiProvider ? next() : res.status(503).json({ error: 'AI features are unavailable', code: 'ai_disabled' })
);
const requireAiNotice = (req, res, next) => (
  hasAcceptedAiNotice(userIndex.get(req.userId))
    ? next()
    : res.status(403).json({ error: 'Please read and accept the AI notice first', code: 'ai_notice_required' })
);

// One model request per user at a time: the GPU serves everyone, so a second tap waits for nothing. The lock is
// released by the handler once the provider work has settled (req.aiDone), never when the client disconnects, so
// dropping connections cannot queue extra jobs; a disconnect aborts the provider call through req.aiSignal instead.
const aiBusyUsers = new Set();
const oneAiRequestPerUser = (req, res, next) => {
  if (aiBusyUsers.has(req.userId)) {
    return res.status(409).json({ error: 'Another AI request is still running', code: 'ai_busy' });
  }
  const userId = req.userId;
  aiBusyUsers.add(userId);
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  req.aiSignal = controller.signal;
  let released = false;
  req.aiDone = () => { if (!released) { released = true; aiBusyUsers.delete(userId); } };
  // A handler that answers without calling aiDone (input errors) still frees the lock once the answer is sent.
  res.on('finish', req.aiDone);
  next();
};

const AI_ERRORS = {
  ai_unavailable: [503, 'The AI service is not available right now. Try again later.'],
  ai_timeout: [504, 'The AI took too long. Try again.'],
  ai_invalid_output: [502, 'The AI could not produce a valid answer. Try again.'],
  ai_bad_request: [400, 'The AI could not read this input.'],
  barcode_unavailable: [503, 'Barcode lookup is not available right now. Try again later.'],
};
const sendAiError = (res, err) => {
  const code = AI_ERRORS[err?.code] ? err.code : 'ai_unavailable';
  if (!(err instanceof AiProviderError) && !AI_ERRORS[err?.code]) console.warn('[ai] Unexpected error:', err?.name);
  const [status, error] = AI_ERRORS[code];
  res.status(status).json({ error, code });
};

let aiHealthCache = { at: 0, ok: false };
const isAiHealthy = async () => {
  if (!aiProvider) return false;
  if (Date.now() - aiHealthCache.at < AI_HEALTH_CACHE_MS) return aiHealthCache.ok;
  const { ok } = await aiProvider.health();
  aiHealthCache = { at: Date.now(), ok };
  return ok;
};

const getAiSettings = (user, language) => ({
  basics: Array.isArray(user?.aiBasics) ? user.aiBasics : AI_DEFAULT_BASICS[language],
  basicsCustomized: Array.isArray(user?.aiBasics),
  photoOptIn: AI_PHOTO_OPT_IN_ENABLED && user?.aiPhotoOptIn === true,
  photoOptInAvailable: AI_PHOTO_OPT_IN_ENABLED,
});

const aiDailyUsed = (userId, kind) => limitEventsWithin(userId, kind, AI_DAILY_WINDOW_MS).length;
const aiDailyLeft = (userId) => ({
  scans: Math.max(0, AI_DAILY_SCAN_LIMIT - aiDailyUsed(userId, 'ai_scan')),
  recipeBatches: Math.max(0, AI_DAILY_RECIPE_LIMIT - aiDailyUsed(userId, 'ai_recipes')),
});
/** Takes one unit of today's quota, or answers 429 ai_daily_limit. Returns the event (for a refund) or null. */
const takeAiDailyUnit = (req, res, kind) => {
  const limit = kind === 'ai_scan' ? AI_DAILY_SCAN_LIMIT : AI_DAILY_RECIPE_LIMIT;
  if (aiDailyUsed(req.userId, kind) >= limit) {
    res.status(429).json({ error: 'Daily AI limit reached. Try again tomorrow.', code: 'ai_daily_limit', kind: kind === 'ai_scan' ? 'scan' : 'recipes', limit });
    return null;
  }
  return recordLimitEvent(req.userId, { kind, at: new Date().toISOString() });
};
// Outages, timeouts and unusable model answers are not the user's fault: the unit goes back.
const AI_REFUNDED_CODES = new Set(['ai_unavailable', 'ai_timeout', 'ai_invalid_output']);

// The app's feature flag: real AI screens only while available is true.
app.get('/api/ai/status', requireAuth, async (req, res, next) => {
  try {
    const language = toAiLanguage(req.query.language);
    const user = userIndex.get(req.userId);
    const available = await isAiHealthy();
    res.set('Cache-Control', 'no-store');
    res.json({
      schemaVersion: AI_SCHEMA_VERSION,
      available,
      provider: aiProvider ? AI_PROVIDER_NAME : 'off',
      scan: available,
      recipes: available,
      barcode: true,
      noticeVersion: AI_NOTICE_VERSION,
      noticeAccepted: hasAcceptedAiNotice(user),
      // Where photos and ingredient lists are processed; the app shows the matching notice text.
      processing: 'drinkme',
      settings: getAiSettings(user, language),
      dailyLeft: aiDailyLeft(req.userId),
      dailyLimits: { scans: AI_DAILY_SCAN_LIMIT, recipeBatches: AI_DAILY_RECIPE_LIMIT },
    });
  } catch (err) { next(err); }
});

app.post('/api/ai/notice', requireAuth, (req, res) => {
  if (req.body?.version !== AI_NOTICE_VERSION) return res.status(400).json({ error: 'Invalid version' });
  const user = userIndex.get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (hasAcceptedAiNotice(user)) return res.json({ noticeAccepted: true, noticeVersion: AI_NOTICE_VERSION });
  const previous = { version: user.aiNoticeVersion, at: user.aiNoticeAt };
  user.aiNoticeVersion = AI_NOTICE_VERSION;
  user.aiNoticeAt = new Date().toISOString();
  if (!saveDbOrRespond(res)) {
    if (previous.version === undefined) delete user.aiNoticeVersion; else user.aiNoticeVersion = previous.version;
    if (previous.at === undefined) delete user.aiNoticeAt; else user.aiNoticeAt = previous.at;
    return;
  }
  res.json({ noticeAccepted: true, noticeVersion: AI_NOTICE_VERSION });
});

// { basics?: string[] | null (null = defaults), photoOptIn?: boolean }. Turning the opt-in off deletes kept photos.
app.put('/api/ai/settings', requireAuth, (req, res) => {
  const user = userIndex.get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { basics, photoOptIn, language } = req.body || {};
  if (photoOptIn !== undefined && typeof photoOptIn !== 'boolean') return res.status(400).json({ error: 'Invalid photoOptIn' });
  if (photoOptIn === true && !AI_PHOTO_OPT_IN_ENABLED) {
    return res.status(400).json({ error: 'Keeping scan photos is not offered', code: 'photo_opt_in_unavailable' });
  }
  let cleanBasics;
  if (basics === null) {
    cleanBasics = null;
  } else if (basics !== undefined) {
    if (!Array.isArray(basics) || basics.length > AI_BASICS_MAX_COUNT || !basics.every((b) => typeof b === 'string')) {
      return res.status(400).json({ error: 'Invalid basics' });
    }
    const seen = new Set();
    cleanBasics = [];
    for (const basic of basics) {
      const clean = sanitizeText(basic, AI_BASIC_MAX_LENGTH);
      if (!clean) return res.status(400).json({ error: 'Invalid basics' });
      const key = clean.toLowerCase();
      if (!seen.has(key)) { seen.add(key); cleanBasics.push(clean); }
    }
  }
  if (cleanBasics !== undefined && cleanBasics !== null && isDbGrowthBlocked()) return respondDbGrowthBlocked(res);
  const consentFields = ['aiPhotoOptIn', 'aiPhotoOptInAt', 'aiPhotoConsentVersion'];
  const previous = { basics: user.aiBasics, ...Object.fromEntries(consentFields.map((f) => [f, user[f]])) };
  if (cleanBasics === null) delete user.aiBasics;
  else if (cleanBasics !== undefined) user.aiBasics = cleanBasics;
  if (photoOptIn === true && user.aiPhotoOptIn !== true) {
    user.aiPhotoOptIn = true;
    user.aiPhotoOptInAt = new Date().toISOString();
    user.aiPhotoConsentVersion = AI_PHOTO_CONSENT_VERSION;
  } else if (photoOptIn === false) {
    user.aiPhotoOptIn = false;
    delete user.aiPhotoOptInAt;
    delete user.aiPhotoConsentVersion;
  }
  if (!saveDbOrRespond(res)) {
    if (previous.basics === undefined) delete user.aiBasics; else user.aiBasics = previous.basics;
    for (const f of consentFields) { if (previous[f] === undefined) delete user[f]; else user[f] = previous[f]; }
    return;
  }
  if (photoOptIn === false && previous.aiPhotoOptIn === true) aiPhotoStore.deleteForUser(req.userId);
  res.json(getAiSettings(user, toAiLanguage(language)));
});

const handleAiScan = async (req, res) => {
  let dailyEvent = null;
  try {
    const image = validateImage(req.body?.imageBase64, AI_IMAGE_RULES);
    if (image.error) return res.status(image.status).json({ error: image.error });
    const [, mimeType, imageBase64] = image.dataUrl.match(/^data:(image\/[a-z]+);base64,(.*)$/s);
    const language = toAiLanguage(req.body?.language);
    dailyEvent = takeAiDailyUnit(req, res, 'ai_scan');
    if (!dailyEvent) return;
    const result = validateScanResult(await aiProvider.scan({ imageBase64, mimeType, language, signal: req.aiSignal }));
    if (!result) throw new AiProviderError('ai_invalid_output');
    if (AI_PHOTO_OPT_IN_ENABLED && userIndex.get(req.userId)?.aiPhotoOptIn === true) {
      aiPhotoStore.save(req.userId, Buffer.from(imageBase64, 'base64'), mimeType.split('/')[1], result);
    }
    res.json({ schemaVersion: AI_SCHEMA_VERSION, source: 'photo', ...result });
  } catch (err) {
    if (dailyEvent && AI_REFUNDED_CODES.has(err?.code)) removeLimitEvent(req.userId, dailyEvent);
    sendAiError(res, err);
  } finally {
    req.aiDone?.();
  }
};
app.post('/api/ai/scan', requireAuth, requireAiProvider, requireAiNotice, oneAiRequestPerUser, aiV1Limiter, postBodyParser, handleAiScan);

// Not AI: works whenever the user is signed in and 18+, even with AI_PROVIDER=off. Only the number leaves the server.
app.post('/api/ai/barcode', requireAuth, barcodeLimiter, async (req, res) => {
  const ean = typeof req.body?.ean === 'string' ? req.body.ean.trim() : '';
  if (!isValidEan(ean)) return res.status(400).json({ error: 'Invalid barcode', code: 'barcode_invalid' });
  try {
    const found = await lookupBarcode(ean, toAiLanguage(req.body?.language));
    if (!found) return res.status(404).json({ error: 'Product not found', code: 'barcode_not_found' });
    const result = validateScanResult(found);
    if (!result) return res.status(404).json({ error: 'Product not found', code: 'barcode_not_found' });
    res.json({ schemaVersion: AI_SCHEMA_VERSION, source: 'barcode', ...result });
  } catch (err) {
    sendAiError(res, err);
  }
});

// Turns the confirmed scan item from the app into the recipe input. Every field is re-checked here.
const toScanInput = (item) => {
  if (!isPlainObject(item) || !AI_SCAN_CATEGORIES.has(item.category)) return null;
  const brand = sanitizeOptional(item.brand, AI_SCAN_NAME_MAX_LENGTH);
  const product = sanitizeOptional(item.product, AI_SCAN_NAME_MAX_LENGTH);
  const style = sanitizeOptional(item.style, AI_SCAN_NAME_MAX_LENGTH);
  const name = sanitizeText([brand, product].filter(Boolean).join(' ') || style || item.category.replace(/_/g, ' '), AI_SCAN_NAME_MAX_LENGTH);
  if (!name) return null;
  const abv = typeof item.abv === 'number' && Number.isFinite(item.abv) && item.abv >= 0 && item.abv <= 100 ? item.abv : null;
  return {
    input: { name, category: item.category },
    aliases: [product, brand, style].filter(Boolean),
    // The confirmed bottle: its real category and ABV override whatever the model writes for it.
    known: knownItemFor({ names: [name, product, brand, style], category: item.category, abv }),
  };
};

// { mode: 'scan', item, language, newSession } or { mode: 'smart_bar', language, newSession }.
app.post('/api/ai/recipes', requireAuth, requireAiProvider, requireAiNotice, oneAiRequestPerUser, aiV1Limiter, async (req, res) => {
  const { mode, item, newSession, stream } = req.body || {};
  const language = toAiLanguage(req.body?.language);
  if (mode !== 'scan' && mode !== 'smart_bar') return res.status(400).json({ error: 'Invalid mode' });
  if (newSession !== undefined && typeof newSession !== 'boolean') return res.status(400).json({ error: 'Invalid newSession' });
  if (stream !== undefined && typeof stream !== 'boolean') return res.status(400).json({ error: 'Invalid stream' });
  let inputs;
  let scannedAliases = [];
  let knownItems = [];
  if (mode === 'scan') {
    const scan = toScanInput(item);
    if (!scan) return res.status(400).json({ error: 'Invalid item' });
    if (scan.input.category === 'water') {
      return res.status(400).json({ error: "It's water: no recipes for plain water.", code: 'water_no_recipes' });
    }
    inputs = [scan.input];
    scannedAliases = scan.aliases;
    knownItems = scan.known ? [scan.known] : [];
  } else {
    inputs = ensureSmartBar(req.userId)
      .map((barItem) => sanitizeText(typeof barItem?.name === 'string' ? barItem.name : '', AI_SCAN_NAME_MAX_LENGTH))
      .filter(Boolean)
      .slice(0, AI_SMART_BAR_MAX_INPUTS)
      .map((name) => ({ name }));
    if (inputs.length === 0) return res.status(400).json({ error: 'Your Smart Bar is empty', code: 'smart_bar_empty' });
  }
  const dailyEvent = takeAiDailyUnit(req, res, 'ai_recipes');
  if (!dailyEvent) return;
  // stream: true → NDJSON, one line per recipe as soon as it passes validation, then a "done" (or "error") line.
  // The status is 200 once streaming starts, so errors after that arrive as an "error" line.
  let delivered = 0;
  const writeLine = (value) => { if (!res.writableEnded) res.write(`${JSON.stringify(value)}\n`); };
  if (stream === true) {
    res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    writeLine({ type: 'start', schemaVersion: AI_SCHEMA_VERSION, expected: 4 });
  }
  try {
    const batch = await generateRecipeBatch({
      provider: aiProvider,
      userId: req.userId,
      adult: isAgeConfirmed(req.userId),
      mode,
      language,
      inputs,
      scannedAliases,
      knownItems,
      signal: req.aiSignal,
      concurrency: AI_RECIPE_CONCURRENCY,
      basics: getAiSettings(userIndex.get(req.userId), language).basics,
      newSession: newSession === true,
    }, { onRecipe: (recipe) => { delivered++; if (stream === true) writeLine({ type: 'recipe', recipe }); } });
    if (batch.exhausted) removeLimitEvent(req.userId, dailyEvent);
    if (stream === true) {
      writeLine({ type: 'done', exhausted: batch.exhausted, count: batch.recipes.length });
      res.end();
    } else {
      res.json({ schemaVersion: AI_SCHEMA_VERSION, recipes: batch.recipes, exhausted: batch.exhausted });
    }
  } catch (err) {
    if (delivered === 0 && AI_REFUNDED_CODES.has(err?.code)) removeLimitEvent(req.userId, dailyEvent);
    if (stream === true) {
      const code = AI_ERRORS[err?.code] ? err.code : 'ai_unavailable';
      writeLine({ type: 'error', code, error: AI_ERRORS[code][1] });
      res.end();
    } else {
      sendAiError(res, err);
    }
  } finally {
    req.aiDone?.();
  }
});

const ensureSavedRecipes = (userId) => {
  if (!savedRecipesByUser.has(userId)) savedRecipesByUser.set(userId, []);
  return savedRecipesByUser.get(userId);
};

app.get('/api/recipes/saved', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ items: savedRecipesByUser.get(req.userId) ?? [] });
});

// The app sends back a recipe it received; it is validated and safety-checked again, so a modified client
// cannot store something the generator would have refused.
app.post('/api/recipes/saved', requireAuth, (req, res) => {
  const raw = req.body?.recipe;
  const recipe = normalizeRecipe(raw, toAiLanguage(raw?.language));
  const verdict = checkRecipe(recipe, { adult: isAgeConfirmed(req.userId), mocktailsOnly: false, language: recipe?.language });
  if (!verdict.recipe) return res.status(400).json({ error: 'Invalid recipe', code: 'recipe_invalid' });
  const alsoNeed = (Array.isArray(raw?.youWillAlsoNeed) ? raw.youWillAlsoNeed : [])
    .filter((name) => typeof name === 'string')
    .map((name) => sanitizeText(name, 80))
    .filter(Boolean)
    .slice(0, 12);
  const id = recipeIdFor(verdict.recipe);
  const list = ensureSavedRecipes(req.userId);
  const existing = list.find((saved) => saved.id === id);
  if (existing) return res.json(existing);
  if (list.length >= SAVED_RECIPES_MAX) {
    return res.status(429).json({ error: 'You have saved the maximum number of recipes. Remove one to save another.', code: 'recipe_limit' });
  }
  if (isDbGrowthBlocked()) return respondDbGrowthBlocked(res);
  const saved = { ...verdict.recipe, youWillAlsoNeed: alsoNeed, id, savedAt: new Date().toISOString() };
  list.unshift(saved);
  if (!saveDbOrRespond(res)) {
    list.shift();
    return;
  }
  res.status(201).json(saved);
});

app.delete('/api/recipes/saved/:recipeId', requireAuth, (req, res) => {
  const list = savedRecipesByUser.get(req.userId) ?? [];
  const index = list.findIndex((saved) => saved.id === req.params.recipeId);
  if (index === -1) return res.status(404).json({ error: 'Recipe not found' });
  const [removed] = list.splice(index, 1);
  if (!saveDbOrRespond(res)) {
    list.splice(index, 0, removed);
    return;
  }
  res.status(204).end();
});

// Report an AI answer (recipe or scan result) from the app. Reviewed through GET /api/admin/audit?action=ai.output_reported.
const AI_REPORT_REASONS = new Set(['offensive', 'unsafe', 'wrong', 'other']);
const aiReportLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `ai-report:${req.userId}`,
  message: { error: 'Too many reports. Try again tomorrow.', code: 'ai_rate_limit' },
});
app.post('/api/ai/report', requireAuth, aiReportLimiter, (req, res) => {
  const { kind, reason, recipeId, recipeName, category, status } = req.body || {};
  if (!['recipe', 'scan'].includes(kind) || !AI_REPORT_REASONS.has(reason)) return res.status(400).json({ error: 'Invalid report' });
  const meta = { kind, reason };
  if (kind === 'recipe') {
    if (typeof recipeId !== 'string' || !/^r_[0-9a-f]{16}$/.test(recipeId)) return res.status(400).json({ error: 'Invalid report' });
    meta.recipeId = recipeId;
    const name = sanitizeOptional(recipeName, 80);
    if (name) meta.recipeName = name;
  } else {
    if (category !== undefined && !AI_SCAN_CATEGORIES.has(category)) return res.status(400).json({ error: 'Invalid report' });
    if (status !== undefined && !['recognized', 'low_confidence', 'water', 'not_ingredient', 'unclear'].includes(status)) {
      return res.status(400).json({ error: 'Invalid report' });
    }
    if (category) meta.category = category;
    if (status) meta.status = status;
  }
  if (isDbGrowthBlocked()) return respondDbGrowthBlocked(res);
  const undo = appendAudit('ai.output_reported', { actorId: req.userId, meta });
  if (!saveDbOrRespond(res)) {
    undo?.();
    return;
  }
  res.status(201).json({ reported: true });
});

// D-21/D-22 (LC-49): while the opt-in is not offered, no scan photo may exist and no opt-in may stay on. Photos
// kept by testers before the flag are deleted at start, and the old opt-in fields cleared. Counts only are logged.
if (!AI_PHOTO_OPT_IN_ENABLED) {
  const { removed, failed } = aiPhotoStore.deleteAll();
  let cleared = 0;
  for (const user of userIndex.values()) {
    if (user.aiPhotoOptIn === undefined && user.aiPhotoOptInAt === undefined && user.aiPhotoConsentVersion === undefined) continue;
    delete user.aiPhotoOptIn;
    delete user.aiPhotoOptInAt;
    delete user.aiPhotoConsentVersion;
    cleared++;
  }
  if (cleared > 0) saveDb();
  if (removed + failed + cleared > 0) console.log(`[ai] No photo retention: deleted ${removed} kept file(s)${failed ? `, ${failed} could not be deleted` : ''}, cleared the opt-in on ${cleared} account(s).`);
}
aiPhotoStore.purgeExpired();
setInterval(() => aiPhotoStore.purgeExpired(), 6 * 60 * 60 * 1000).unref();

// ── Dev log bridge (NODE_ENV=development only) ────────────────────────────────
// The app (only when __DEV__) sends its errors, warnings, failed API calls, screen changes and tester
// notes here during a device test session. Outside /api and /media, so it needs no sign-in: errors on
// the sign-in screen are wanted too. Only JSON with the app's header and no Origin is taken, so a web
// page cannot post here (see refuseUntrustedRequest); a device on the same Wi-Fi still can. It writes to
// DEV_SESSION_DIR. Bodies above the JSON parser's 100 kB are refused before this point.
if (devLogBridge) {
  const devLogSink = devLogBridge.createClientLogSink(devSessionDir);
  // The app sends at most one batch every 2 seconds.
  const devLogLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });
  console.log(`[dev-log] Development only: app logs go to ${devLogSink.file}`);
  app.post('/__dev/client-log', devLogLimiter, (req, res) => {
    const refusal = devLogBridge.refuseUntrustedRequest(req);
    if (refusal) return res.status(refusal.status).json({ error: refusal.error });
    let result;
    try {
      result = devLogSink.append(req.body);
    } catch (err) {
      console.warn('[dev-log] Could not write the app log:', err.code ?? err.name);
      return res.status(500).json({ error: 'Could not write the log' });
    }
    if (!result.ok) return res.status(400).json({ error: 'Invalid log batch' });
    return res.status(204).end();
  });
}

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
// edited person by person. Owner decision (2026-11-10): a deleted account is gone from backups within
// 30 days, and the app says so. These 21 days plus up to 7 for the recovery hold below make 28, which
// leaves 2 days for a purge that waits for a healthy start. Whatever happens, DB_BACKUP_HARD_MAX_DAYS
// (30) is a ceiling no backup outlives, recovery hold or not. The scheduled backups of scripts/backup.js
// (7 daily, 4 weekly) stay within 30 days on their own.
const DEFAULT_DB_BACKUP_RETENTION_DAYS = 21;
// The most CORRUPT_BACKUP_RETENTION_DAYS may give: a longer period would break the promise above.
const DB_BACKUP_RETENTION_MAX_DAYS = DEFAULT_DB_BACKUP_RETENTION_DAYS;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DB_BACKUP_PURGE_INTERVAL_MS = parseTestOnlyLimit(process.env.DB_BACKUP_PURGE_INTERVAL_MS, MS_PER_DAY);
const DB_BACKUP_PURGE_MIN_WAIT_MS = 1000;
const DB_BACKUP_MARKERS = ['.corrupt-', '.pre-migration-'];
// Exactly what Date.now() writes in a backup's name, so a name with other digits is not a backup of ours.
const DB_BACKUP_TIMESTAMP_PATTERN = /^[1-9]\d{12}$/;

// A shorter period is allowed. A longer one is capped at the maximum with a warning, because the app
// tells users backups are removed within 30 days.
const parseBackupRetentionDays = (rawValue) => {
  const value = (rawValue ?? '').trim();
  if (!value) return DEFAULT_DB_BACKUP_RETENTION_DAYS;
  if (!/^[1-9]\d*$/.test(value)) {
    console.warn(`[config] CORRUPT_BACKUP_RETENTION_DAYS must be a whole number from 1 to ${DB_BACKUP_RETENTION_MAX_DAYS} — using ${DEFAULT_DB_BACKUP_RETENTION_DAYS}.`);
    return DEFAULT_DB_BACKUP_RETENTION_DAYS;
  }
  if (Number(value) > DB_BACKUP_RETENTION_MAX_DAYS) {
    console.warn(`[config] CORRUPT_BACKUP_RETENTION_DAYS is above ${DB_BACKUP_RETENTION_MAX_DAYS} — using ${DB_BACKUP_RETENTION_MAX_DAYS}. The app tells users backups are removed within 30 days: ${DB_BACKUP_RETENTION_MAX_DAYS} days plus the 7-day recovery hold and a purge delay.`);
    return DB_BACKUP_RETENTION_MAX_DAYS;
  }
  return Number(value);
};
const DB_BACKUP_RETENTION_DAYS = parseBackupRetentionDays(process.env.CORRUPT_BACKUP_RETENTION_DAYS);

// Held after a start that lost its data, however many restarts follow: an empty database with old
// backups beside it is what recovery looks like, and those backups may be the only copy. It also starts
// when the last user leaves. It always ends: the saved time stays while there are no users, so a
// restart cannot start it again and the 30-day promise still holds after the last account is deleted.
// Retention plus this hold must stay within 30 days; see DEFAULT_DB_BACKUP_RETENTION_DAYS.
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

// Removes every backup whose deadline (from deadlineOf) has passed, logging each with describe. Returns
// the next deadline, or Infinity. Never throws: whatever fails is logged and retried later.
const removeDbBackupsPastDeadline = (deadlineOf, describe) => {
  let nextDeadline = Infinity;
  try {
    let backups = listDbBackups();
    const now = Date.now();
    for (const backup of [...backups]) {
      const deadline = deadlineOf(backup);
      if (deadline > now) {
        nextDeadline = Math.min(nextDeadline, deadline);
        continue;
      }
      try {
        fs.unlinkSync(backup.file);
        backups = backups.filter((item) => item !== backup);
        console.log(`[db] ${describe}, ${describeBackupsLeft(backups)}.`);
      } catch (err) {
        console.warn('[db] Could not remove an expired backup:', describeDbError(err));
      }
    }
  } catch (err) {
    console.warn('[db] Could not check backups for expiry:', describeDbError(err));
  }
  return nextDeadline;
};

// The hard ceiling (lead decision, fix loop 1): a backup older than this goes even while the recovery
// hold is on, and even at a start that lost its data or just migrated, so no copy of a deleted account
// outlives the 30 days the app promises. Counted from the name's timestamp, like the retention.
const DB_BACKUP_HARD_MAX_DAYS = 30;
const purgeDbBackupsPastCeiling = () => removeDbBackupsPastDeadline(
  (backup) => backup.timestamp + DB_BACKUP_HARD_MAX_DAYS * MS_PER_DAY,
  `Removed a backup older than the ${DB_BACKUP_HARD_MAX_DAYS}-day ceiling, recovery hold or not`,
);

// The age comes from the name, so a copied file or a changed clock on the file does not extend it, and
// a timestamp in the future is simply kept. Never throws, whatever fails is logged and retried later.
// Returns when the next backup expires, or Infinity. While the recovery hold is on, only the ceiling applies.
function purgeExpiredDbBackups() {
  try {
    if (isDbBackupPurgeHeld()) return Math.min(recoveryStartedAt + DB_RECOVERY_PURGE_HOLD_MS, purgeDbBackupsPastCeiling());
    const now = Date.now();
    const aheadCount = listDbBackups().filter((backup) => backup.timestamp > now).length;
    if (aheadCount > 0) console.warn(`[db] ${aheadCount} backup(s) have a timestamp ahead of the current time, and are kept until they expire from it.`);
  } catch (err) {
    console.warn('[db] Could not check backups for expiry:', describeDbError(err));
    return Infinity;
  }
  return removeDbBackupsPastDeadline((backup) => backup.expiresAt, 'Removed an expired backup');
}

// Runs with the backup purge timer. Saves only when an entry went; a failed save is logged and the
// entries go with the next save.
const purgeExpiredAuditEntries = () => {
  const removed = pruneAuditLog();
  if (removed > 0 && saveDb()) console.log(`[audit] Removed ${removed} entr${removed === 1 ? 'y' : 'ies'} past the ${AUDIT_RETENTION_DAYS}-day retention.`);
};

// Postgres mode: every write prunes the history table too, but an idle server writes nothing, so this
// also runs at start and with the purge timer (at least every 24 hours): snapshots older than 28 days go,
// so none outlives the 30 days the app promises (the row limit is left to the writes). Never throws.
const purgePostgresHistoryPastCeiling = () => {
  if (!postgresStore) return;
  postgresStore.pruneHistory({ byCount: false }).then(
    (removed) => {
      if (removed > 0) console.log(`[db] Removed ${removed} Postgres history snapshot(s) older than ${Math.round(DEFAULT_HISTORY_MAX_AGE_MS / MS_PER_DAY)} days.`);
    },
    (err) => console.warn(`[db] Could not prune the Postgres history (${describePgError(err)}); retried at the next run.`),
  );
};

// Every 24 hours, or sooner when a backup expires sooner, so none outlives the period by up to a day.
// unref: this timer alone never keeps the process alive.
function scheduleDbBackupPurge(nextExpiry) {
  const wait = Math.max(DB_BACKUP_PURGE_MIN_WAIT_MS, Math.min(DB_BACKUP_PURGE_INTERVAL_MS, nextExpiry - Date.now()));
  setTimeout(() => {
    purgeExpiredAuditEntries();
    purgePostgresHistoryPastCeiling();
    scheduleDbBackupPurge(purgeExpiredDbBackups());
  }, wait).unref();
}

// A start that lost its data purges only past the ceiling: an operator may need the rest to recover, so
// the full look comes when the hold ends. A start that just migrated applies the ceiling and waits for the timer.
purgePostgresHistoryPastCeiling();
if (isDbLoaded) scheduleDbBackupPurge(didBackUpDbOnLoad ? purgeDbBackupsPastCeiling() : purgeExpiredDbBackups());
else scheduleDbBackupPurge(Math.min(recoveryStartedAt + DB_RECOVERY_PURGE_HOLD_MS, purgeDbBackupsPastCeiling()));

resumePendingAccountDeletions();
setInterval(retryAccountDeletions, ACCOUNT_DELETION_RETRY_INTERVAL_MS).unref();

// Postgres mode: on SIGTERM/SIGINT (a host stop or redeploy, Ctrl+C) the queued snapshot is written
// before exit. Kept under Docker's default 10-second stop grace. JSON mode registers nothing: every save
// there is already on disk when the route answers.
const POSTGRES_SHUTDOWN_FLUSH_MS = 8000;
if (isPostgresDb) {
  const flushPostgresAndExit = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    const flushed = await postgresWriteQueue.flush(POSTGRES_SHUTDOWN_FLUSH_MS);
    if (flushed) console.log(`[db] ${signal}: every change is written to Postgres, exiting.`);
    else console.error(`[db] ${signal}: changes not yet written to Postgres could not be saved within ${POSTGRES_SHUTDOWN_FLUSH_MS} ms and are lost.`);
    try {
      await postgresStore.close();
    } catch (err) {
      console.warn(`[db] Could not close the Postgres pool (${describePgError(err)}).`);
    }
    process.exit(flushed ? 0 : 1);
  };
  process.on('SIGTERM', () => flushPostgresAndExit('SIGTERM'));
  process.on('SIGINT', () => flushPostgresAndExit('SIGINT'));
}

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`API running at http://${HOST}:${PORT}`);
});
