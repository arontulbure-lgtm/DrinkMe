// Barcode fallback: EAN lookup in Open Food Facts (database ODbL, images CC BY-SA). Only the barcode number
// leaves the server; no user data is sent. Results are cached in memory for a day.
import { SCAN_CATEGORIES, flagsFor, isAlcoholicCategory } from './taxonomy.js';

const OFF_URL = 'https://world.openfoodfacts.org/api/v2/product';
const USER_AGENT = 'DrinkMe/1.0 (barcode lookup)';
const LOOKUP_TIMEOUT_MS = 6000;
const CACHE_MAX = 1000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BARCODE_CONFIDENCE = 0.95;

/** EAN-8, UPC-A (12) or EAN-13 with a valid check digit. */
export const isValidEan = (value) => {
  if (typeof value !== 'string' || !/^(?:\d{8}|\d{12}|\d{13})$/.test(value)) return false;
  const digits = value.split('').map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
};

// Most specific first. Flavoured water is a mixer, plain water is water.
const TAG_MAP = [
  [['en:energy-drinks'], 'energy_drink'],
  [['en:flavoured-waters', 'en:flavored-waters'], 'soda_mixer'],
  [['en:waters', 'en:mineral-waters', 'en:spring-waters', 'en:natural-mineral-waters', 'en:sparkling-waters'], 'water'],
  [['en:tonic-water', 'en:tonic-waters', 'en:sodas', 'en:colas', 'en:carbonated-drinks', 'en:lemonades', 'en:iced-teas', 'en:ginger-beers', 'en:ginger-ales'], 'soda_mixer'],
  [['en:syrups', 'en:simple-syrups', 'en:flavoured-syrups'], 'syrup'],
  [['en:juices', 'en:fruit-juices', 'en:nectars', 'en:vegetable-juices', 'en:orange-juices'], 'juice'],
  [['en:milks', 'en:creams', 'en:plant-based-milks', 'en:dairy-drinks'], 'dairy_cream'],
  [['en:liqueurs', 'en:cream-liqueurs'], 'liqueur'],
  [['en:vermouths', 'en:aperitifs', 'en:bitters', 'en:bitter-aperitifs'], 'vermouth_aperitif'],
  [['en:sparkling-wines', 'en:champagnes', 'en:proseccos', 'en:cavas'], 'sparkling_wine'],
  [['en:wines', 'en:red-wines', 'en:white-wines', 'en:rose-wines', 'en:fortified-wines'], 'wine'],
  [['en:ciders'], 'cider'],
  [['en:beers', 'en:lagers', 'en:non-alcoholic-beers'], 'beer'],
  [['en:spirits', 'en:distilled-spirits', 'en:gins', 'en:vodkas', 'en:rums', 'en:whiskies', 'en:brandies', 'en:tequilas', 'en:fruit-brandies'], 'spirit'],
  [['en:fresh-fruits', 'en:citrus', 'en:lemons', 'en:limes', 'en:berries'], 'fresh_fruit'],
  [['en:herbs', 'en:fresh-herbs', 'en:spices', 'en:mint'], 'herb_spice'],
];

export const categoryFromTags = (tags) => {
  const set = new Set(Array.isArray(tags) ? tags : []);
  for (const [candidates, category] of TAG_MAP) {
    if (candidates.some((tag) => set.has(tag))) return category;
  }
  return null;
};

const parseVolumeMl = (quantity) => {
  const match = typeof quantity === 'string' ? quantity.match(/(\d+(?:[.,]\d+)?)\s*(ml|cl|l)\b/i) : null;
  if (!match) return null;
  const value = Number(match[1].replace(',', '.')) * { ml: 1, cl: 10, l: 1000 }[match[2].toLowerCase()];
  return value >= 20 && value <= 10_000 ? Math.round(value) : null;
};

const pickText = (product, field, language) => {
  const value = product[`${field}_${language}`] || product[field] || product[`${field}_en`];
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null;
};

/** Maps an OFF product to a ScanResult-shaped answer (validated again by validateScanResult). */
export const scanResultFromProduct = (product, language) => {
  const category = categoryFromTags(product.categories_tags);
  if (!category || !SCAN_CATEGORIES.includes(category)) {
    return { status: 'not_ingredient', item: null };
  }
  const rawAbv = Number(product.nutriments?.alcohol_100g ?? product.nutriments?.alcohol ?? product.alcohol_value);
  const abv = Number.isFinite(rawAbv) && rawAbv >= 0 && rawAbv <= 100 ? rawAbv : null;
  const item = {
    category,
    brand: typeof product.brands === 'string' ? product.brands.split(',')[0].trim().slice(0, 80) || null : null,
    product: pickText(product, 'product_name', language),
    style: null,
    abv,
    volumeMl: parseVolumeMl(product.quantity),
    isAlcoholic: isAlcoholicCategory(category, abv),
    flags: flagsFor(category),
    confidence: BARCODE_CONFIDENCE,
  };
  return { status: category === 'water' ? 'water' : 'recognized', item };
};

export const createBarcodeLookup = ({ fetchImpl = fetch, baseUrl = OFF_URL } = {}) => {
  const cache = new Map();
  return async (ean, language) => {
    const key = `${ean}:${language}`;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const fields = 'product_name,product_name_en,product_name_ro,brands,categories_tags,quantity,nutriments,alcohol_value';
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/${ean}.json?fields=${fields}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
    } catch (err) {
      throw Object.assign(new Error('Barcode lookup failed'), { code: err?.name === 'TimeoutError' ? 'ai_timeout' : 'barcode_unavailable' });
    }
    if (response.status === 404) return null;
    if (!response.ok) throw Object.assign(new Error('Barcode lookup failed'), { code: 'barcode_unavailable' });
    let body;
    try {
      body = await response.json();
    } catch {
      throw Object.assign(new Error('Barcode lookup failed'), { code: 'barcode_unavailable' });
    }
    const value = body?.status === 1 && body.product ? scanResultFromProduct(body.product, language) : null;
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  };
};
