// Minimal test server for DrinkMe MVP (CommonJS for Node on Windows)
// Usage:
//   1) npm install express cors multer dotenv openai
//   2) set OPENAI_API_KEY=sk-...
//   3) node server.js

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const dotenv = require('dotenv');
const OpenAI = require('openai');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const upload = multer({ limits: { fileSize: 8 * 1024 * 1024 } }); // 8MB

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* -------------------------------------------------------------------------- */
/*                              In-memory store                               */
/* -------------------------------------------------------------------------- */

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
let nextCommentId = 1;

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

ensureComments(1);
ensureComments(1).push({
  id: 1,
  drinkId: 1,
  userId: 'user_anamaria',
  content: 'Abia aștept să îl încerc și eu! 🍸',
  createdAt: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
});
ensureComments(1).push({
  id: 2,
  drinkId: 1,
  userId: 'user_demo',
  content: 'Îl pregătesc și diseară, te aștept la Bar A1!',
  createdAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
});

nextCommentId = 3;


function ensurePartnerSet(userId) {
  if (!partnersByUser.has(userId)) {
    partnersByUser.set(userId, new Set());
  }
  return partnersByUser.get(userId);
}

function getUserId(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/Bearer\s+(.+)/i);
  if (match && userIndex.has(match[1])) {
    return match[1];
  }
  return 'user_demo';
}

function getDisplayName(userId) {
  const user = userIndex.get(userId);
  if (!user) return 'Someone';
  return user.firstName ? `${user.firstName} ${user.lastName || ''}`.trim() : user.email;
}

function decorateDrink(drink, currentUserId) {
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
}

function decorateComment(comment) {
  return {
    ...comment,
    user: userIndex.get(comment.userId),
  };
}

function ensureSmartBar(userId) {
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
}

function ensureNotifications(userId) {
  if (!notificationsByUser.has(userId)) {
    notificationsByUser.set(userId, []);
  }
  return notificationsByUser.get(userId);
}

function cleanupNotifications(userId) {
  const list = ensureNotifications(userId);
  const now = Date.now();
  const filtered = list.filter(
    (item) => now - new Date(item.createdAt).getTime() <= 7 * 24 * 60 * 60 * 1000
  );
  if (filtered.length !== list.length) {
    notificationsByUser.set(userId, filtered);
  }
  return filtered;
}

function pushNotification(targetUserId, type, message) {
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
}

function ensureComments(drinkId) {
  if (!commentsByDrink.has(drinkId)) {
    commentsByDrink.set(drinkId, []);
  }
  return commentsByDrink.get(drinkId);
}

// Seed initial partnerships
ensurePartnerSet('user_demo').add('user_anamaria');
ensurePartnerSet('user_anamaria').add('user_demo');

/* -------------------------------------------------------------------------- */
/*                               Auth endpoint                                */
/* -------------------------------------------------------------------------- */

app.post('/api/auth/mobile', (req, res) => {
  const { uid } = req.body || {};
  const fallback = 'mock-jwt-token';
  res.json({ token: uid && userIndex.has(uid) ? uid : fallback });
});

/* -------------------------------------------------------------------------- */
/*                                User routes                                 */
/* -------------------------------------------------------------------------- */

app.get('/api/users/:id', (req, res) => {
  const user = userIndex.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.put('/api/users/:id', (req, res) => {
  const user = userIndex.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { firstName, lastName, city, bio } = req.body || {};
  if (typeof firstName === 'string') user.firstName = firstName;
  if (typeof lastName === 'string') user.lastName = lastName;
  if (typeof city === 'string') user.city = city;
  if (typeof bio === 'string') user.bio = bio;

  res.json(user);
});

app.get('/api/users/search', (req, res) => {
  const currentUserId = getUserId(req);
  const partnerSet = ensurePartnerSet(currentUserId);
  const term = (req.query.q || '').toString().toLowerCase();
  const filtered = term
    ? users.filter((user) => {
        const fullName = `${user.firstName} ${user.lastName}`.toLowerCase();
        return (
          user.email.toLowerCase().includes(term) ||
          fullName.includes(term) ||
          (user.city || '').toLowerCase().includes(term)
        );
      })
    : users;

  res.json(
    filtered.map((user) => ({
      ...user,
      isPartner: partnerSet.has(user.id),
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

/* -------------------------------------------------------------------------- */
/*                                Story routes                                */
/* -------------------------------------------------------------------------- */

app.get('/api/stories', (req, res) => {
  res.json(
    stories.map((story) => ({
      ...story,
      user: userIndex.get(story.userId),
    }))
  );
});

/* -------------------------------------------------------------------------- */
/*                                Drinks routes                                */
/* -------------------------------------------------------------------------- */

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

  const normalizedImage = imageData.startsWith('data:')
    ? imageData
    : `data:image/jpeg;base64,${imageData}`;

  const newDrink = {
    id: nextDrinkId++,
    userId: currentUserId,
    name,
    description,
    rating: Number(rating) || 0,
    location: location || null,
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

/* -------------------------------------------------------------------------- */
/*                              Notification API                              */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/*                             Smart Bar routes                               */
/* -------------------------------------------------------------------------- */

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
    name,
    quantity,
    unit: unit || 'bottle',
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

/* -------------------------------------------------------------------------- */
/*                             AI helper routes                                */
/* -------------------------------------------------------------------------- */

function toDataUrl(buffer, mime = 'image/jpeg') {
  const base64 = buffer.toString('base64');
  return `data:${mime};base64,${base64}`;
}

async function handleDetectProduct(req, res) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY missing on server' });
    }
    const file =
      req.file ||
      (Array.isArray(req.files) && req.files.find((f) => f.fieldname === 'file')) ||
      (Array.isArray(req.files) && req.files.find((f) => f.fieldname === 'image')) ||
      (Array.isArray(req.files) ? req.files[0] : null);
    if (!file) return res.status(400).json({ error: 'Missing image file (field: file or image)' });

    const imageDataUrl = toDataUrl(file.buffer, file.mimetype || 'image/jpeg');

    const prompt =
      'You are a product recognition expert. From the image provided, extract the product name as specifically as possible (brand + product if possible), and determine whether it is alcoholic or non-alcoholic. Return strictly JSON with keys: productName (string), isAlcoholic (boolean).';

    const resp = await openai.responses.create({
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

    const text = resp.output_text || '';
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (err) {
      console.warn('Failed to parse detect json', err, text);
    }
    if (!data || typeof data.productName !== 'string' || !data.productName.trim()) {
      return res.json({ error: 'Product not recognized, please try again.' });
    }
    res.json({ productName: data.productName.trim(), isAlcoholic: !!data.isAlcoholic });
  } catch (err) {
    console.error('detect error', err);
    res.status(500).json({ error: 'Detection failed' });
  }
}

app.post('/api/detect-product', upload.any(), handleDetectProduct);

app.post('/api/generate-recipes', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY missing on server' });
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

    const resp = await openai.responses.create({
      model: 'gpt-4o-mini',
      input: [{ role: 'user', content: [{ type: 'input_text', text: userPrompt }] }],
      response_format: { type: 'json_object' },
    });

    const text = resp.output_text || '{}';
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (err) {
      console.warn('Failed to parse recipe json', err, text);
    }
    if (!data || !Array.isArray(data.recipes)) {
      return res.status(502).json({ error: 'Invalid AI output', raw: text });
    }
    res.json({ recipes: data.recipes });
  } catch (err) {
    console.error('recipes error', err);
    res.status(500).json({ error: 'Generation failed' });
  }
});

/* -------------------------------------------------------------------------- */
/*                                 Bootstrap                                  */
/* -------------------------------------------------------------------------- */

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API running at http://0.0.0.0:${PORT}`);
});
