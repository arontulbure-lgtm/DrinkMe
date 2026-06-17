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
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const JWT_SECRET = process.env.JWT_SECRET || 'drinkme-dev-secret-change-in-production';

// ── Firebase Admin SDK ────────────────────────────────────────────────────────
// AUTH-1: Verify Firebase ID tokens server-side.
// Set FIREBASE_SERVICE_ACCOUNT_KEY in server/.env (JSON string or file path)
// to enable full verification. Without it, falls back to JWT-only mode (beta ok).
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
      console.warn('[firebase-admin] Could not parse FIREBASE_SERVICE_ACCOUNT_KEY:', e.message);
    }
  }

  if (serviceAccount) {
    if (!adminGetApps().length) {
      adminInitializeApp({ credential: cert(serviceAccount) });
    }
    firebaseAuth = adminGetAuth();
    console.log('[firebase-admin] ✅ Initialized — ID tokens will be fully verified server-side.');
  } else {
    console.warn('[firebase-admin] ⚠️  No service account key — running in JWT-only mode. Set FIREBASE_SERVICE_ACCOUNT_KEY for production.');
  }
}

/**
 * Verify a Firebase ID token using Firebase Admin SDK.
 * Returns { uid, email } on success, null on failure.
 */
async function verifyFirebaseToken(idToken) {
  if (!firebaseAuth) return null;
  try {
    const decoded = await firebaseAuth.verifyIdToken(idToken);
    return { uid: decoded.uid, email: decoded.email };
  } catch (e) {
    console.warn('[firebase-admin] verifyIdToken failed:', e.message);
    return null;
  }
}

// ── Persistence ───────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE  = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
app.set('trust proxy', 1);

const isProduction = process.env.NODE_ENV === 'production';
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
        const error = new Error('Not allowed by CORS');
        error.status = 403;
        return callback(error, false);
      },
      credentials: true,
    }
  : { origin: true, credentials: true };

app.use(cors(corsOptions));
app.use(helmet());
app.use(morgan(isProduction ? 'combined' : 'dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
        const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
        return `user:${decoded.uid}`;
      }
    } catch {}
    return req.ip;
  },
  skip: (req) => req.method === 'GET', // only rate-limit writes
});
app.use('/api', mutationLimiter);

// ── Input sanitization helper (SEC-A) ─────────────────────────────────────────
const sanitizeText = (value, maxLength = 500) => {
  if (typeof value !== 'string') return '';
  return validator.escape(value.trim()).slice(0, maxLength);
};
const sanitizeOptional = (value, maxLength = 500) => {
  if (!value) return null;
  return sanitizeText(String(value), maxLength);
};

if (!process.env.OPENAI_API_KEY) {
  console.warn('OPENAI_API_KEY not set. AI endpoints will respond with errors.');
}

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ── Default seed data — EMPTY (no dummy users for production) ─────────────────
const DEFAULT_USERS = [];
const DEFAULT_DRINKS = [];

// ── Mutable state (populated from file or seed on startup) ────────────────────
let drinks           = [];
let nextDrinkId      = 1;
let nextNotificationId = 1;
let nextCommentId    = 1;

const userIndex         = new Map();
const cheersByUser      = new Map();
const savedByUser       = new Map();
const smartBarByUser    = new Map();
const partnersByUser    = new Map();
const notificationsByUser = new Map();
const commentsByDrink   = new Map();

const stories = [];

// ── Persistence helpers ───────────────────────────────────────────────────────
function saveDb() {
  try {
    const data = {
      drinks,
      nextDrinkId,
      nextNotificationId,
      nextCommentId,
      users: Array.from(userIndex.values()),
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
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[db] Failed to save:', err.message);
  }
}

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    console.log('[db] No saved state found — starting with empty database.');
    saveDb();
    return;
  }

  try {
    const raw  = fs.readFileSync(DB_FILE, 'utf8');
    const data = JSON.parse(raw);

    // Restore counters
    if (typeof data.nextDrinkId      === 'number') nextDrinkId      = data.nextDrinkId;
    if (typeof data.nextNotificationId === 'number') nextNotificationId = data.nextNotificationId;
    if (typeof data.nextCommentId    === 'number') nextCommentId    = data.nextCommentId;

    // Restore drinks
    if (Array.isArray(data.drinks)) {
      drinks.push(...data.drinks);
    }

    // Restore users
    if (Array.isArray(data.users)) {
      for (const u of data.users) userIndex.set(u.id, u);
    }
    // Restore Sets: cheersByUser
    if (data.cheersByUser && typeof data.cheersByUser === 'object') {
      for (const [k, v] of Object.entries(data.cheersByUser)) {
        cheersByUser.set(k, new Set(Array.isArray(v) ? v : []));
      }
    }

    // Restore Sets: savedByUser
    if (data.savedByUser && typeof data.savedByUser === 'object') {
      for (const [k, v] of Object.entries(data.savedByUser)) {
        savedByUser.set(k, new Set(Array.isArray(v) ? v : []));
      }
    }

    // Restore smartBarByUser
    if (data.smartBarByUser && typeof data.smartBarByUser === 'object') {
      for (const [k, v] of Object.entries(data.smartBarByUser)) {
        smartBarByUser.set(k, Array.isArray(v) ? v : []);
      }
    }

    // Restore Sets: partnersByUser
    if (data.partnersByUser && typeof data.partnersByUser === 'object') {
      for (const [k, v] of Object.entries(data.partnersByUser)) {
        partnersByUser.set(k, new Set(Array.isArray(v) ? v : []));
      }
    }

    // Restore notificationsByUser
    if (data.notificationsByUser && typeof data.notificationsByUser === 'object') {
      for (const [k, v] of Object.entries(data.notificationsByUser)) {
        notificationsByUser.set(k, Array.isArray(v) ? v : []);
      }
    }

    // Restore commentsByDrink (keys are strings in JSON, need number)
    if (data.commentsByDrink && typeof data.commentsByDrink === 'object') {
      for (const [k, v] of Object.entries(data.commentsByDrink)) {
        commentsByDrink.set(Number(k), Array.isArray(v) ? v : []);
      }
    }

    console.log(
      `[db] Loaded — ${drinks.length} drinks, ${userIndex.size} users.`
    );
  } catch (err) {
    console.error('[db] Failed to load db.json, starting empty:', err.message);
  }
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

const cleanupNotifications = (userId) => {
  const list = ensureNotifications(userId);
  const now = Date.now();
  const filtered = list.filter(
    (item) => now - new Date(item.createdAt).getTime() <= 7 * 24 * 60 * 60 * 1000
  );
  if (filtered.length !== list.length) {
    notificationsByUser.set(userId, filtered);
  }
  return filtered;
};

const pushNotification = (targetUserId, type, message) => {
  if (!userIndex.has(targetUserId)) return;
  const list = ensureNotifications(targetUserId);
  list.unshift({
    id: nextNotificationId++,
    type,
    message,
    read: false,
    createdAt: new Date().toISOString(),
  });
  notificationsByUser.set(targetUserId, list);
};

const ensureSmartBar = (userId) => {
  if (!smartBarByUser.has(userId)) {
    smartBarByUser.set(userId, [
      { id: 1, name: 'Whiskey single malt', quantity: '1',    unit: 'bottle' },
      { id: 2, name: 'Sirop de soc artizanal', quantity: '750ml', unit: 'bottle' },
    ]);
  }
  return smartBarByUser.get(userId);
};

const ensureComments = (drinkId) => {
  if (!commentsByDrink.has(drinkId)) {
    commentsByDrink.set(drinkId, []);
  }
  return commentsByDrink.get(drinkId);
};

const registerUserIfNeeded = ({ id, email, displayName, photoURL }) => {
  if (!id) return;
  const normalizedEmail = email || `${id}@drinkme.app`;
  if (!userIndex.has(id)) {
    const nameSource = displayName || normalizedEmail.split('@')[0];
    const nameParts  = nameSource.trim().split(/\s+/);
    userIndex.set(id, {
      id,
      email: normalizedEmail,
      firstName: nameParts[0] || normalizedEmail.split('@')[0],
      lastName:  nameParts.slice(1).join(' '),
      city: 'Bucharest',
      bio:  'DrinkMe explorer',
      avatar: photoURL || null,
    });
  } else {
    const existing = userIndex.get(id);
    if (photoURL)        existing.avatar = photoURL;
    if (!existing.email) existing.email  = normalizedEmail;
    if (!existing.firstName && displayName) {
      const nameParts = displayName.trim().split(/\s+/);
      existing.firstName = nameParts[0] || existing.firstName;
      existing.lastName  = nameParts.slice(1).join(' ') || existing.lastName;
    }
  }
  ensurePartnerSet(id);
  ensureSmartBar(id);
};

// ── Image validation ──────────────────────────────────────────────────────────
const ALLOWED_IMAGE_PREFIXES = [
  'data:image/jpeg;base64,',
  'data:image/jpg;base64,',
  'data:image/png;base64,',
  'data:image/webp;base64,',
  'data:image/heic;base64,',
];

/**
 * Validează și normalizează un string imageData.
 * Returnează string-ul normalizat sau null dacă tipul nu e permis.
 */
const validateImage = (imageData) => {
  if (!imageData || typeof imageData !== 'string') return null;
  if (imageData.startsWith('data:')) {
    const allowed = ALLOWED_IMAGE_PREFIXES.some((p) => imageData.startsWith(p));
    return allowed ? imageData : null;
  }
  // Base64 raw fără prefix — considerăm jpeg (vine din expo-image-picker)
  return `data:image/jpeg;base64,${imageData}`;
};

// ── Load persisted state on startup ──────────────────────────────────────────
loadDb();

// ── Auth helpers ──────────────────────────────────────────────────────────────
/**
 * Extrage userId din JWT-ul Bearer. Returnează null dacă tokenul lipsește sau e invalid.
 * Nu mai există fallback la user_demo — fiecare request neautentificat primește null.
 */
const getUserId = (req) => {
  const header = req.headers.authorization || '';
  const match  = header.match(/Bearer\s+(.+)/i);
  if (!match) return null;
  try {
    const payload = jwt.verify(match[1], JWT_SECRET);
    return payload.uid || null;
  } catch {
    return null;
  }
};

/**
 * Middleware: blochează request-ul cu 401 dacă tokenul lipsește sau e invalid.
 * Stochează userId în req.userId pentru rutele downstream.
 */
const requireAuth = (req, res, next) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Authentication required' });
  req.userId = userId;
  next();
};

const getDisplayName = (userId) => {
  const user = userIndex.get(userId);
  if (!user) return 'Someone';
  return user.firstName ? `${user.firstName} ${user.lastName || ''}`.trim() : user.email;
};

const decorateDrink = (drink, currentUserId) => {
  const user       = userIndex.get(drink.userId);
  const likedSet   = currentUserId ? (cheersByUser.get(currentUserId) || new Set()) : new Set();
  const savedSet   = currentUserId ? (savedByUser.get(currentUserId)  || new Set()) : new Set();
  const partnerSet = currentUserId ? ensurePartnerSet(currentUserId)               : new Set();
  return {
    ...drink,
    user,
    isLiked:   likedSet.has(drink.id),
    isSaved:   savedSet.has(drink.id),
    isPartner: currentUserId
      ? (partnerSet.has(drink.userId) || drink.userId === currentUserId)
      : false,
  };
};

const decorateComment = (comment) => ({
  ...comment,
  user: userIndex.get(comment.userId),
});

const toDataUrl = (buffer, mime = 'image/jpeg') => {
  const base64 = buffer.toString('base64');
  return `data:${mime};base64,${base64}`;
};

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/auth/mobile', async (req, res) => {
  const { idToken, uid: clientUid, email, displayName, photoURL } = req.body || {};

  if (!idToken) return res.status(400).json({ error: 'Missing idToken' });

  let verifiedUid = null;

  // AUTH-1: Verify Firebase ID token server-side using Firebase Admin SDK
  if (firebaseAuth) {
    const verified = await verifyFirebaseToken(idToken);
    if (!verified) {
      return res.status(401).json({ error: 'Invalid Firebase ID token' });
    }
    verifiedUid = verified.uid;
    // Reject if client-provided uid doesn't match the verified token
    if (clientUid && clientUid !== verifiedUid) {
      return res.status(401).json({ error: 'UID mismatch' });
    }
  } else {
    // Fallback (no service account): trust the client-provided uid
    // ⚠️ This is insecure — set FIREBASE_SERVICE_ACCOUNT_KEY for production
    if (!clientUid) return res.status(400).json({ error: 'Missing uid' });
    verifiedUid = clientUid;
  }

  registerUserIfNeeded({ id: verifiedUid, email, displayName, photoURL });
  saveDb();

  const token = jwt.sign({ uid: verifiedUid }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
});

app.get('/api/users/search', (req, res) => {
  const currentUserId = getUserId(req);
  const partnerSet    = ensurePartnerSet(currentUserId);
  const normalized    = (req.query.q ?? '').toString().trim().replace(/^@+/, '').toLowerCase();
  const allUsers      = Array.from(userIndex.values());
  const filtered = normalized
    ? allUsers.filter((c) => {
        const fullName = `${c.firstName} ${c.lastName}`.toLowerCase();
        return (
          c.email.toLowerCase().includes(normalized) ||
          fullName.includes(normalized) ||
          (c.city || '').toLowerCase().includes(normalized)
        );
      })
    : allUsers;
  res.json(filtered.map((c) => ({ ...c, isPartner: partnerSet.has(c.id) })));
});

app.get('/api/users/:id', (req, res) => {
  const user = userIndex.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.get('/api/users/:id/partners', (req, res) => {
  const requesterId = getUserId(req);
  const targetId    = req.params.id;
  if (!userIndex.has(targetId)) return res.status(404).json({ error: 'User not found' });
  const partnerSet = ensurePartnerSet(targetId);
  const list = Array.from(partnerSet)
    .map((id) => userIndex.get(id))
    .filter(Boolean)
    .map((user) => ({ ...user, isPartner: ensurePartnerSet(requesterId).has(user.id) }));
  res.json(list);
});

app.put('/api/users/:id', requireAuth, (req, res) => {
  // SEC-4: verifică că userul autentificat este proprietarul contului
  if (req.userId !== req.params.id) {
    return res.status(403).json({ error: 'Forbidden: cannot edit another user\'s profile' });
  }
  const user = userIndex.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { firstName, lastName, city, bio } = req.body || {};
  // SEC-A: sanitize profile fields
  if (typeof firstName === 'string') user.firstName = sanitizeText(firstName, 120);
  if (typeof lastName  === 'string') user.lastName  = sanitizeText(lastName, 120);
  if (typeof city      === 'string') user.city      = sanitizeText(city, 120);
  if (typeof bio       === 'string') user.bio       = sanitizeText(bio, 500);
  saveDb();
  res.json(user);
});

app.post('/api/users/:id/avatar', requireAuth, upload.single('avatar'), (req, res) => {
  const targetId    = req.params.id;
  const requesterId = req.userId;
  if (requesterId !== targetId) return res.status(403).json({ error: 'Forbidden' });
  const user = userIndex.get(targetId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  let avatarData = null;
  if (req.file?.buffer) {
    const mime = req.file.mimetype || 'image/jpeg';
    if (!mime.startsWith('image/')) {
      return res.status(400).json({ error: 'Invalid file type. Use JPEG, PNG or WebP.' });
    }
    avatarData = toDataUrl(req.file.buffer, mime);
  } else if (typeof req.body?.imageData === 'string') {
    avatarData = validateImage(req.body.imageData);
  }
  if (!avatarData) return res.status(400).json({ error: 'Missing or invalid avatar payload' });
  user.avatar = avatarData;
  saveDb();
  res.json(user);
});

app.get('/api/drink-partners', requireAuth, (req, res) => {
  const partnerSet = Array.from(ensurePartnerSet(req.userId));
  res.json(partnerSet.map((id) => userIndex.get(id)).filter(Boolean));
});

app.post('/api/drink-partners/:targetId', requireAuth, (req, res) => {
  const userId   = req.userId;
  const targetId = req.params.targetId;
  if (!userIndex.has(targetId)) return res.status(404).json({ error: 'User not found' });
  if (targetId === userId)      return res.status(400).json({ error: 'Cannot add yourself' });

  const userSet   = ensurePartnerSet(userId);
  const targetSet = ensurePartnerSet(targetId);
  let isPartner;
  if (userSet.has(targetId)) {
    userSet.delete(targetId);
    targetSet.delete(userId);
    isPartner = false;
  } else {
    userSet.add(targetId);
    targetSet.add(userId);
    isPartner = true;
    pushNotification(targetId, 'partner', `${getDisplayName(userId)} added you as a drink partner.`);
  }
  saveDb();
  res.json({ isPartner });
});

app.get('/api/friends/count', requireAuth, (req, res) => {
  res.json(ensurePartnerSet(req.userId).size);
});

app.get('/api/stories', (req, res) => {
  res.json(stories.map((story) => ({ ...story, user: userIndex.get(story.userId) })));
});

app.get('/api/drinks', (req, res) => {
  const currentUserId = getUserId(req);
  const cityQuery = (req.query.city || '').toString().toLowerCase();
  let list = drinks;
  if (cityQuery) {
    list = list.filter((d) => (d.location || '').toLowerCase().includes(cityQuery));
  }
  res.json(list.map((d) => decorateDrink(d, currentUserId)));
});

app.get('/api/drinks/partners', (req, res) => {
  const currentUserId = getUserId(req);
  const partnerSet    = ensurePartnerSet(currentUserId);
  const list = drinks.filter((d) => partnerSet.has(d.userId) || d.userId === currentUserId);
  res.json(list.map((d) => decorateDrink(d, currentUserId)));
});

app.get('/api/drinks/:id', (req, res) => {
  const currentUserId = getUserId(req);
  const drink = drinks.find((d) => d.id === Number(req.params.id));
  if (!drink) return res.status(404).json({ error: 'Drink not found' });
  res.json(decorateDrink(drink, currentUserId));
});

app.get('/api/drinks/:id/comments', (req, res) => {
  const comments = ensureComments(Number(req.params.id));
  res.json(comments.map(decorateComment));
});

app.post('/api/drinks/:id/comments', requireAuth, (req, res) => {
  const currentUserId = req.userId;
  const drinkId = Number(req.params.id);
  const { content } = req.body || {};
  if (!content?.trim())   return res.status(400).json({ error: 'Missing comment content' });
  if (content.length > 500) return res.status(400).json({ error: 'Comment too long' });
  const drink = drinks.find((d) => d.id === drinkId);
  if (!drink) return res.status(404).json({ error: 'Drink not found' });

  const safeContent = sanitizeText(content, 500);
  if (!safeContent) return res.status(400).json({ error: 'Comment cannot be empty' });

  const comment = {
    id: nextCommentId++,
    drinkId,
    userId: currentUserId,
    content: safeContent,
    createdAt: new Date().toISOString(),
  };
  ensureComments(drinkId).push(comment);
  if (drink.userId !== currentUserId) {
    pushNotification(drink.userId, 'comment', `${getDisplayName(currentUserId)} commented on ${drink.name}.`);
  }
  saveDb();
  res.status(201).json(decorateComment(comment));
});

app.get('/api/drinks/user/:userId', (req, res) => {
  const currentUserId = getUserId(req);
  const list = drinks
    .filter((d) => d.userId === req.params.userId)
    .map((d) => decorateDrink(d, currentUserId));
  res.json(list);
});

app.post('/api/drinks', requireAuth, (req, res) => {
  const currentUserId = req.userId;
  const { name, description, rating, location, isAlcoholic, imageData } = req.body || {};
  if (!name || !description || !imageData) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const normalizedRating = Number(rating);
  if (Number.isNaN(normalizedRating) || normalizedRating < 0 || normalizedRating > 5) {
    return res.status(400).json({ error: 'Rating must be between 0 and 5' });
  }
  // SEC-10: validate image MIME type
  const normalizedImage = validateImage(imageData);
  if (!normalizedImage) {
    return res.status(400).json({ error: 'Invalid image format. Use JPEG, PNG or WebP.' });
  }

  // SEC-A: sanitize text inputs
  const safeName        = sanitizeText(name, 120);
  const safeDescription = sanitizeText(description, 1000);
  const safeLocation    = sanitizeOptional(location, 180);
  if (!safeName || !safeDescription) {
    return res.status(400).json({ error: 'Name and description cannot be empty' });
  }

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
    imageUrl: normalizedImage,
    isPartner: true,
  };
  drinks.unshift(newDrink);
  saveDb();
  res.status(201).json(decorateDrink(newDrink, currentUserId));
});

app.post('/api/drinks/:id/like', requireAuth, (req, res) => {
  const currentUserId = req.userId;
  const drink = drinks.find((d) => d.id === Number(req.params.id));
  if (!drink) return res.status(404).json({ error: 'Drink not found' });

  const likedSet = cheersByUser.get(currentUserId) || new Set();
  if (likedSet.has(drink.id)) {
    likedSet.delete(drink.id);
    drink.cheersCount = Math.max(0, (drink.cheersCount || 0) - 1);
  } else {
    likedSet.add(drink.id);
    drink.cheersCount = (drink.cheersCount || 0) + 1;
    if (drink.userId !== currentUserId) {
      pushNotification(drink.userId, 'cheer', `${getDisplayName(currentUserId)} cheered your drink ${drink.name}.`);
    }
  }
  cheersByUser.set(currentUserId, likedSet);
  saveDb();
  res.json({ cheered: likedSet.has(drink.id), cheersCount: drink.cheersCount });
});

app.post('/api/drinks/:id/save', requireAuth, (req, res) => {
  const currentUserId = req.userId;
  const drink = drinks.find((d) => d.id === Number(req.params.id));
  if (!drink) return res.status(404).json({ error: 'Drink not found' });

  const savedSet = savedByUser.get(currentUserId) || new Set();
  if (savedSet.has(drink.id)) {
    savedSet.delete(drink.id);
  } else {
    savedSet.add(drink.id);
  }
  savedByUser.set(currentUserId, savedSet);
  saveDb();
  res.json({ saved: savedSet.has(drink.id) });
});

app.get('/api/users/:userId/saved-drinks', requireAuth, (req, res) => {
  const currentUserId = req.userId;
  const savedSet = savedByUser.get(req.params.userId) || new Set();
  res.json(
    drinks
      .filter((d) => savedSet.has(d.id))
      .map((d) => decorateDrink(d, currentUserId))
  );
});

app.get('/api/notifications', requireAuth, (req, res) => {
  const list        = cleanupNotifications(req.userId);
  const unreadCount = list.filter((n) => !n.read).length;
  res.json({ notifications: list, unreadCount });
});

app.post('/api/notifications/read', requireAuth, (req, res) => {
  const list = cleanupNotifications(req.userId);
  list.forEach((n) => { n.read = true; });
  notificationsByUser.set(req.userId, list);
  saveDb();
  res.json({ success: true });
});

app.get('/api/smart-bar', requireAuth, (req, res) => {
  res.json(ensureSmartBar(req.userId));
});

app.post('/api/smart-bar', requireAuth, (req, res) => {
  const userId    = req.userId;
  const bar       = ensureSmartBar(userId);
  const { name, quantity, unit } = req.body || {};
  if (!name || !quantity) return res.status(400).json({ error: 'Missing name or quantity' });
  const newItem = {
    id: Math.max(0, ...bar.map((i) => i.id)) + 1,
    name:     String(name).slice(0, 120),
    quantity: String(quantity).slice(0, 60),
    unit:     (unit ? String(unit) : 'bottle').slice(0, 60),
  };
  bar.push(newItem);
  saveDb();
  res.status(201).json(newItem);
});

app.delete('/api/smart-bar/:itemId', requireAuth, (req, res) => {
  const userId = req.userId;
  const bar    = ensureSmartBar(userId);
  const index  = bar.findIndex((i) => i.id === Number(req.params.itemId));
  if (index === -1) return res.status(404).json({ error: 'Item not found' });
  bar.splice(index, 1);
  saveDb();
  res.status(204).end();
});

// ── AI endpoints (no changes needed — disabled on client side for beta) ────────
app.post('/api/smart-bar/generate-recipes', requireAuth, async (req, res, next) => {
  try {
    if (!openai) {
      const error = new Error('AI generation unavailable');
      error.status = 503;
      throw error;
    }
    const { ingredients } = req.body || {};
    if (!Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({ error: 'Missing ingredients array' });
    }
    const ingredientList = ingredients.join(', ');
    const userPrompt = `You are a professional mixologist. Create 5 unique cocktail/drink recipes using ONLY these available ingredients (plus standard mixers like juice, soda, sugar, bitters, ice): ${ingredientList}.

Rules:
- Create 5 recipes total: 1 easy, 2 medium, 1 hard, 1 mocktail (no alcohol).
- Only use ingredients from the provided list plus common pantry items (lime juice, lemon juice, simple syrup, soda water, tonic water, ice, salt, sugar, bitters, mint, etc.).
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
    const response = await openai.responses.create({
      model: 'gpt-4o-mini',
      input: [{ role: 'user', content: [{ type: 'input_text', text: userPrompt }] }],
      text: { format: { type: 'json_object' } },
    });
    const rawText = response.output_text || '';
    let parsed = rawText.trim();
    if (parsed.startsWith('```')) parsed = parsed.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
    if (!parsed.startsWith('{')) { const m = parsed.match(/\{[\s\S]*\}/); if (m) parsed = m[0]; }
    let data = null;
    try { data = JSON.parse(parsed); } catch (e) { console.warn('Failed to parse smart-bar recipe response', e); }
    if (!data || !Array.isArray(data.recipes)) return res.status(502).json({ error: 'Invalid AI output' });
    const allowedDiff = ['easy', 'medium', 'hard', 'mocktail'];
    const toNum = (v) => { if (typeof v === 'number' && Number.isFinite(v)) return v; const n = parseFloat(String(v ?? '').replace(/[^\d.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
    const recipes = data.recipes.map((r) => ({
      title: typeof r.title === 'string' ? r.title.trim() : '',
      difficulty: allowedDiff.includes((r.difficulty || '').toLowerCase()) ? r.difficulty.toLowerCase() : 'medium',
      ingredients: (Array.isArray(r.ingredients) ? r.ingredients : []).map((i) => i?.name ? { name: String(i.name).trim(), amount_oz: toNum(i.amount_oz), amount_ml: toNum(i.amount_ml) || Math.round(toNum(i.amount_oz) * 29.5735) } : null).filter(Boolean),
      garnish: r.garnish == null ? null : String(r.garnish).trim() || null,
      instructions: typeof r.instructions === 'string' ? r.instructions.trim() : '',
    })).filter((r) => r.title && r.instructions && r.ingredients.length > 0);
    res.json(recipes);
  } catch (err) { next(err); }
});

const handleDetectProduct = async (req, res, next) => {
  try {
    if (!openai) { const e = new Error('AI detection unavailable'); e.status = 503; throw e; }
    const file = req.file || (Array.isArray(req.files) ? req.files[0] : null);
    if (!file) { const e = new Error('Missing image file'); e.status = 400; throw e; }
    const imageDataUrl = toDataUrl(file.buffer, file.mimetype || 'image/jpeg');
    const prompt = 'You are a product recognition expert. From the image provided, extract the product name as specifically as possible (brand + product if possible), and determine whether it is alcoholic or non-alcoholic. Return strictly JSON with keys: productName (string), isAlcoholic (boolean).';
    const response = await openai.responses.create({
      model: 'gpt-4o-mini',
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: imageDataUrl }] }],
      text: { format: { type: 'json_object' } },
    });
    const text = response.output_text || '';
    let parsed = text.trim();
    if (parsed.startsWith('```')) parsed = parsed.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
    if (!parsed.startsWith('{')) { const m = parsed.match(/\{[\s\S]*\}/); if (m) parsed = m[0]; }
    let data = null;
    try { data = JSON.parse(parsed); } catch (e) { console.warn('Failed to parse detect-product response', e); }
    if (!data || typeof data.productName !== 'string' || !data.productName.trim()) return res.json({ error: 'Product not recognized, please try again.' });
    res.json({ productName: data.productName.trim(), isAlcoholic: !!data.isAlcoholic });
  } catch (error) { next(error); }
};
app.post('/api/detect-product', requireAuth, upload.any(), handleDetectProduct);

app.post('/api/generate-recipes', requireAuth, async (req, res, next) => {
  try {
    if (!openai) { const e = new Error('AI generation unavailable'); e.status = 503; throw e; }
    const { productName, isAlcoholic } = req.body || {};
    if (!productName) return res.status(400).json({ error: 'Missing productName' });
    const difficultyBreakdown = isAlcoholic === false
      ? 'Create 5 recipes total: exactly 3 alcoholic cocktails (one easy, one medium, one hard difficulty) and exactly 2 mocktails.'
      : 'Create 5 alcoholic cocktail recipes: exactly 2 medium difficulty, 1 easy, and 2 hard. Do not include mocktails.';
    const userPrompt = `You are a professional mixologist. Using the product "${productName}", craft 5 unique recipes.\n- ${difficultyBreakdown}\n- List ingredient quantities in both ounces and milliliters.\n- Respond strictly as JSON with schema: {"recipes":[{"title":"string","difficulty":"easy|medium|hard|mocktail","ingredients":[{"name":"string","amount_oz":number,"amount_ml":number}],"garnish":"string|null","instructions":"string"}]}`;
    const response = await openai.responses.create({
      model: 'gpt-4o-mini',
      input: [{ role: 'user', content: [{ type: 'input_text', text: userPrompt }] }],
      text: { format: { type: 'json_object' } },
    });
    const rawText = response.output_text || '';
    let parsed = rawText.trim();
    if (parsed.startsWith('```')) parsed = parsed.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
    if (!parsed.startsWith('{')) { const m = parsed.match(/\{[\s\S]*\}/); if (m) parsed = m[0]; }
    let data = null;
    try { data = JSON.parse(parsed); } catch (e) { console.warn('Failed to parse recipe response', e); }
    if (!data || !Array.isArray(data.recipes)) return res.status(502).json({ error: 'Invalid AI output' });
    const allowedDiff = ['easy', 'medium', 'hard', 'mocktail'];
    const toNum = (v) => { if (typeof v === 'number' && Number.isFinite(v)) return v; const n = parseFloat(String(v ?? '').replace(/[^\d.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
    const recipes = data.recipes.map((r) => ({
      title: typeof r.title === 'string' ? r.title.trim() : '',
      difficulty: allowedDiff.includes((r.difficulty || '').toLowerCase()) ? r.difficulty.toLowerCase() : 'medium',
      ingredients: (Array.isArray(r.ingredients) ? r.ingredients : []).map((i) => i?.name ? { name: String(i.name).trim(), amount_oz: toNum(i.amount_oz), amount_ml: toNum(i.amount_ml) || Math.round(toNum(i.amount_oz) * 29.5735) } : null).filter(Boolean),
      garnish: r.garnish == null ? null : String(r.garnish).trim() || null,
      instructions: typeof r.instructions === 'string' ? r.instructions.trim() : '',
    })).filter((r) => r.title && r.instructions && r.ingredients.length > 0);
    res.json({ recipes });
  } catch (error) { next(error); }
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
  const status = err.status && Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) console.error(err);
  return res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API running at http://0.0.0.0:${PORT}`);
});
