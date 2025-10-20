import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import multer from 'multer';
import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const app = express();
const upload = multer({ limits: { fileSize: 8 * 1024 * 1024 } });

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

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

if (!process.env.OPENAI_API_KEY) {
  console.warn('OPENAI_API_KEY not set. AI endpoints will respond with errors.');
}

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const users = [
  {
    id: 'user_demo',
    email: 'alex@drinkme.app',
    firstName: 'Alex',
    lastName: 'Ionescu',
    city: 'București',
    bio: 'Exploring Romania one cocktail at a time.',
  },
  {
    id: 'user_anamaria',
    email: 'ana@drinkme.app',
    firstName: 'Ana-Maria',
    lastName: 'Popescu',
    city: 'Cluj-Napoca',
    bio: 'Sommelier & mixology coach.',
  },
  {
    id: 'user_dragos',
    email: 'dragos@drinkme.app',
    firstName: 'Dragoș',
    lastName: 'Stoica',
    city: 'Timișoara',
    bio: 'Craft beer aficionado and bar crawler.',
  },
];

const userIndex = new Map(users.map((user) => [user.id, user]));

let nextDrinkId = 4;
let nextNotificationId = 1;
let nextCommentId = 3;

const drinks = [
  {
    id: 1,
    userId: 'user_demo',
    name: 'Negroni Proaspăt',
    description:
      'Clasic italian reinterpretat cu gin local de la Sabatini și bitteruri artizanale din Cluj.',
    rating: 5,
    location: 'Bar A1, București',
    createdAt: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
    cheersCount: 12,
    tags: ['cocktail', 'gin'],
    isAlcoholic: true,
    imageUrl:
      'https://images.unsplash.com/photo-1546171757-0661cbab13b2?auto=format&fit=crop&w=800&q=60',
    isPartner: true,
  },
  {
    id: 2,
    userId: 'user_anamaria',
    name: 'Fetească Neagră Reserva 2019',
    description: 'Vin roșu corpolent din Dealu Mare, note de prune coapte și ciocolată neagră.',
    rating: 4,
    location: 'Crama Rotenberg, Dealu Mare',
    createdAt: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
    cheersCount: 18,
    tags: ['wine', 'romanian'],
    isAlcoholic: true,
    imageUrl:
      'https://images.unsplash.com/photo-1510626176961-4b57d4fbad03?auto=format&fit=crop&w=800&q=60',
    isPartner: true,
  },
  {
    id: 3,
    userId: 'user_dragos',
    name: 'IPA Transilvania',
    description: 'Bere artizanală cu hamei Citra și Mosaic, amăreală balansată și finish floral.',
    rating: 5,
    location: 'OneTwo Brewery, Timișoara',
    createdAt: new Date(Date.now() - 1000 * 60 * 300).toISOString(),
    cheersCount: 9,
    tags: ['beer', 'craft'],
    isAlcoholic: true,
    imageUrl:
      'https://images.unsplash.com/photo-1552566626-52f8b828add9?auto=format&fit=crop&w=800&q=60',
    isPartner: false,
  },
];

const stories = [
  {
    id: 1,
    userId: 'user_demo',
    content: 'Descoperă noul meniu de vară la Bar A1! 🍸',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
  },
  {
    id: 2,
    userId: 'user_anamaria',
    content: 'Degustare specială de vinuri autohtone în weekend.',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 6).toISOString(),
  },
];

const cheersByUser = new Map();
const savedByUser = new Map();
const smartBarByUser = new Map();
const partnersByUser = new Map();
const notificationsByUser = new Map();
const commentsByDrink = new Map();

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
      {
        id: 1,
        name: 'Whiskey single malt',
        quantity: '1',
        unit: 'bottle',
      },
      {
        id: 2,
        name: 'Sirop de soc artizanal',
        quantity: '750ml',
        unit: 'bottle',
      },
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

ensurePartnerSet('user_demo').add('user_anamaria');
ensurePartnerSet('user_anamaria').add('user_demo');

ensureComments(1).push(
  {
    id: 1,
    drinkId: 1,
    userId: 'user_anamaria',
    content: 'Abia aștept să îl încerc și eu! 🍸',
    createdAt: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
  },
  {
    id: 2,
    drinkId: 1,
    userId: 'user_demo',
    content: 'Îl pregătesc și diseară, te aștept la Bar A1!',
    createdAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
  }
);

const getUserId = (req) => {
  const header = req.headers.authorization || '';
  const match = header.match(/Bearer\s+(.+)/i);
  if (match && userIndex.has(match[1])) {
    return match[1];
  }
  return 'user_demo';
};

const getDisplayName = (userId) => {
  const user = userIndex.get(userId);
  if (!user) return 'Someone';
  return user.firstName ? `${user.firstName} ${user.lastName || ''}`.trim() : user.email;
};

const decorateDrink = (drink, currentUserId) => {
  const user = userIndex.get(drink.userId);
  const likedSet = cheersByUser.get(currentUserId) || new Set();
  const savedSet = savedByUser.get(currentUserId) || new Set();
  const partnerSet = ensurePartnerSet(currentUserId);
  return {
    ...drink,
    user,
    isLiked: likedSet.has(drink.id),
    isSaved: savedSet.has(drink.id),
    isPartner: partnerSet.has(drink.userId) || drink.userId === currentUserId,
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

app.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/auth/mobile', (req, res) => {
  const { uid } = req.body || {};
  const fallback = 'mock-jwt-token';
  res.json({ token: uid && userIndex.has(uid) ? uid : fallback });
});

app.get('/api/users/:id', (req, res) => {
  const user = userIndex.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.put('/api/users/:id', (req, res) => {
  const user = userIndex.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { firstName, lastName, city, bio } = req.body || {};
  if (typeof firstName === 'string') user.firstName = firstName.slice(0, 120);
  if (typeof lastName === 'string') user.lastName = lastName.slice(0, 120);
  if (typeof city === 'string') user.city = city.slice(0, 120);
  if (typeof bio === 'string') user.bio = bio.slice(0, 500);

  res.json(user);
});

app.get('/api/users/search', (req, res) => {
  const currentUserId = getUserId(req);
  const partnerSet = ensurePartnerSet(currentUserId);
  const term = (req.query.q || '').toString().toLowerCase();
  const filtered = term
    ? users.filter((candidate) => {
        const fullName = `${candidate.firstName} ${candidate.lastName}`.toLowerCase();
        return (
          candidate.email.toLowerCase().includes(term) ||
          fullName.includes(term) ||
          (candidate.city || '').toLowerCase().includes(term)
        );
      })
    : users;

  res.json(
    filtered.map((candidate) => ({
      ...candidate,
      isPartner: partnerSet.has(candidate.id),
    }))
  );
});

app.get('/api/drink-partners', (req, res) => {
  const userId = getUserId(req);
  const partnerSet = Array.from(ensurePartnerSet(userId));
  res.json(partnerSet.map((id) => userIndex.get(id)).filter(Boolean));
});

app.post('/api/drink-partners/:targetId', (req, res) => {
  const userId = getUserId(req);
  const targetId = req.params.targetId;
  if (!userIndex.has(targetId)) return res.status(404).json({ error: 'User not found' });
  if (targetId === userId) return res.status(400).json({ error: 'Cannot add yourself' });

  const userSet = ensurePartnerSet(userId);
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

  res.json({ isPartner });
});

app.get('/api/friends/count', (req, res) => {
  const userId = getUserId(req);
  res.json(ensurePartnerSet(userId).size);
});

app.get('/api/stories', (req, res) => {
  res.json(
    stories.map((story) => ({
      ...story,
      user: userIndex.get(story.userId),
    }))
  );
});

app.get('/api/drinks', (req, res) => {
  const currentUserId = getUserId(req);
  res.json(drinks.map((drink) => decorateDrink(drink, currentUserId)));
});

app.get('/api/drinks/partners', (req, res) => {
  const currentUserId = getUserId(req);
  const partnerSet = ensurePartnerSet(currentUserId);
  const list = drinks.filter((drink) => partnerSet.has(drink.userId) || drink.userId === currentUserId);
  res.json(list.map((drink) => decorateDrink(drink, currentUserId)));
});

app.get('/api/drinks/:id', (req, res) => {
  const currentUserId = getUserId(req);
  const drink = drinks.find((item) => item.id === Number(req.params.id));
  if (!drink) return res.status(404).json({ error: 'Drink not found' });
  res.json(decorateDrink(drink, currentUserId));
});

app.get('/api/drinks/:id/comments', (req, res) => {
  const comments = ensureComments(Number(req.params.id));
  res.json(comments.map(decorateComment));
});

app.post('/api/drinks/:id/comments', (req, res) => {
  const currentUserId = getUserId(req);
  const drinkId = Number(req.params.id);
  const { content } = req.body || {};
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Missing comment content' });
  }
  if (content.length > 500) {
    return res.status(400).json({ error: 'Comment too long' });
  }
  const drink = drinks.find((item) => item.id === drinkId);
  if (!drink) return res.status(404).json({ error: 'Drink not found' });

  const comment = {
    id: nextCommentId++,
    drinkId,
    userId: currentUserId,
    content: content.trim(),
    createdAt: new Date().toISOString(),
  };
  ensureComments(drinkId).push(comment);

  if (drink.userId !== currentUserId) {
    pushNotification(
      drink.userId,
      'comment',
      `${getDisplayName(currentUserId)} commented on ${drink.name}.`
    );
  }

  res.status(201).json(decorateComment(comment));
});

app.get('/api/drinks/user/:userId', (req, res) => {
  const currentUserId = getUserId(req);
  const list = drinks
    .filter((drink) => drink.userId === req.params.userId)
    .map((drink) => decorateDrink(drink, currentUserId));
  res.json(list);
});

app.post('/api/drinks', (req, res) => {
  const currentUserId = getUserId(req);
  const { name, description, rating, location, isAlcoholic, imageData } = req.body || {};
  if (!name || !description || !imageData) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const normalizedRating = Number(rating);
  if (Number.isNaN(normalizedRating) || normalizedRating < 0 || normalizedRating > 5) {
    return res.status(400).json({ error: 'Rating must be between 0 and 5' });
  }

  const normalizedImage = imageData.startsWith('data:')
    ? imageData
    : `data:image/jpeg;base64,${imageData}`;

  const newDrink = {
    id: nextDrinkId++,
    userId: currentUserId,
    name: String(name).slice(0, 120),
    description: String(description).slice(0, 1000),
    rating: normalizedRating,
    location: location ? String(location).slice(0, 180) : null,
    isAlcoholic: isAlcoholic !== false,
    createdAt: new Date().toISOString(),
    cheersCount: 0,
    tags: [],
    imageUrl: normalizedImage,
    isPartner: true,
  };
  drinks.unshift(newDrink);
  res.status(201).json(decorateDrink(newDrink, currentUserId));
});

app.post('/api/drinks/:id/like', (req, res) => {
  const currentUserId = getUserId(req);
  const drink = drinks.find((item) => item.id === Number(req.params.id));
  if (!drink) return res.status(404).json({ error: 'Drink not found' });

  const likedSet = cheersByUser.get(currentUserId) || new Set();
  if (likedSet.has(drink.id)) {
    likedSet.delete(drink.id);
    drink.cheersCount = Math.max(0, (drink.cheersCount || 0) - 1);
  } else {
    likedSet.add(drink.id);
    drink.cheersCount = (drink.cheersCount || 0) + 1;
    if (drink.userId !== currentUserId) {
      pushNotification(
        drink.userId,
        'cheer',
        `${getDisplayName(currentUserId)} cheered your drink ${drink.name}.`
      );
    }
  }
  cheersByUser.set(currentUserId, likedSet);

  res.json({
    cheered: likedSet.has(drink.id),
    cheersCount: drink.cheersCount,
  });
});

app.post('/api/drinks/:id/save', (req, res) => {
  const currentUserId = getUserId(req);
  const drink = drinks.find((item) => item.id === Number(req.params.id));
  if (!drink) return res.status(404).json({ error: 'Drink not found' });

  const savedSet = savedByUser.get(currentUserId) || new Set();
  if (savedSet.has(drink.id)) {
    savedSet.delete(drink.id);
  } else {
    savedSet.add(drink.id);
  }
  savedByUser.set(currentUserId, savedSet);

  res.json({
    saved: savedSet.has(drink.id),
  });
});

app.get('/api/users/:userId/saved-drinks', (req, res) => {
  const currentUserId = getUserId(req);
  const savedSet = savedByUser.get(req.params.userId) || new Set();
  res.json(
    drinks
      .filter((drink) => savedSet.has(drink.id))
      .map((drink) => decorateDrink(drink, currentUserId))
  );
});

app.get('/api/notifications', (req, res) => {
  const userId = getUserId(req);
  const list = cleanupNotifications(userId);
  const unreadCount = list.filter((item) => !item.read).length;
  res.json({ notifications: list, unreadCount });
});

app.post('/api/notifications/read', (req, res) => {
  const userId = getUserId(req);
  const list = cleanupNotifications(userId);
  list.forEach((item) => {
    item.read = true;
  });
  notificationsByUser.set(userId, list);
  res.json({ success: true });
});

app.get('/api/smart-bar', (req, res) => {
  const userId = getUserId(req);
  res.json(ensureSmartBar(userId));
});

app.post('/api/smart-bar', (req, res) => {
  const userId = getUserId(req);
  const bar = ensureSmartBar(userId);
  const { name, quantity, unit } = req.body || {};
  if (!name || !quantity) {
    return res.status(400).json({ error: 'Missing name or quantity' });
  }
  const newItem = {
    id: Math.max(0, ...bar.map((item) => item.id)) + 1,
    name: String(name).slice(0, 120),
    quantity: String(quantity).slice(0, 60),
    unit: (unit ? String(unit) : 'bottle').slice(0, 60),
  };
  bar.push(newItem);
  res.status(201).json(newItem);
});

app.delete('/api/smart-bar/:itemId', (req, res) => {
  const userId = getUserId(req);
  const bar = ensureSmartBar(userId);
  const index = bar.findIndex((item) => item.id === Number(req.params.itemId));
  if (index === -1) {
    return res.status(404).json({ error: 'Item not found' });
  }
  bar.splice(index, 1);
  res.status(204).end();
});

const handleDetectProduct = async (req, res, next) => {
  try {
    if (!openai) {
      const error = new Error('AI detection unavailable');
      error.status = 503;
      throw error;
    }
    const file =
      req.file ||
      (Array.isArray(req.files) && req.files.find((f) => f.fieldname === 'file')) ||
      (Array.isArray(req.files) && req.files.find((f) => f.fieldname === 'image')) ||
      (Array.isArray(req.files) ? req.files[0] : null);
    if (!file) {
      const error = new Error('Missing image file (field: file or image)');
      error.status = 400;
      throw error;
    }

    const imageDataUrl = toDataUrl(file.buffer, file.mimetype || 'image/jpeg');

    const prompt =
      'You are a product recognition expert. From the image provided, extract the product name as specifically as possible (brand + product if possible), and determine whether it is alcoholic or non-alcoholic. Return strictly JSON with keys: productName (string), isAlcoholic (boolean).';

    const response = await openai.responses.create({
      model: 'gpt-4o-mini',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: imageDataUrl },
          ],
        },
      ],
    });

    const text = response.output_text || '';
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (error) {
      console.warn('Failed to parse detect-product response', error, text);
    }
    if (!data || typeof data.productName !== 'string' || !data.productName.trim()) {
      return res.json({ error: 'Product not recognized, please try again.' });
    }
    res.json({ productName: data.productName.trim(), isAlcoholic: !!data.isAlcoholic });
  } catch (error) {
    next(error);
  }
};

app.post('/api/detect-product', upload.any(), handleDetectProduct);

app.post('/api/generate-recipes', async (req, res, next) => {
  try {
    if (!openai) {
      const error = new Error('AI generation unavailable');
      error.status = 503;
      throw error;
    }
    const { productName, count = 5, isAlcoholic } = req.body || {};
    if (!productName) return res.status(400).json({ error: 'Missing productName' });

    const userPrompt = `You are a professional mixologist. Create exactly ${count} cocktail recipes using: ${productName}.
- Include ingredient amounts in both ounces and milliliters for each ingredient (e.g., 2 oz / 60 ml).
- Return exactly: 2 medium difficulty, 1 easy, 1 hard and ${
      isAlcoholic === false
        ? '1 mocktail (the product is non-alcoholic)'
        : '1 mocktail if possible'
    }.
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
      response_format: { type: 'json_object' },
    });

    const text = response.output_text || '{}';
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (error) {
      console.warn('Failed to parse recipe response', error, text);
    }
    if (!data || !Array.isArray(data.recipes)) {
      return res.status(502).json({ error: 'Invalid AI output', raw: text });
    }
    res.json({ recipes: data.recipes });
  } catch (error) {
    next(error);
  }
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large' });
  }
  const status = err.status && Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) {
    console.error(err);
  }
  return res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API running at http://0.0.0.0:${PORT}`);
});
