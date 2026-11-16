// Server-side validators for the ai-service wire schema v1 (see ai-service/schemas/*.schema.json).
// No validation library: each function returns a clean copy built from an allowlist, or null.
import validator from 'validator';

import { SCAN_CATEGORIES, SCAN_FLAGS, SCAN_STATUSES, abvFloor, isAlcoholicCategory, flagsFor } from './taxonomy.js';

export const RECIPE_UNITS = ['ml', 'g', 'piece'];
export const RECIPE_METHODS = ['build', 'stir', 'shake', 'blend', 'muddle'];
export const RECIPE_LANGUAGES = ['en', 'ro'];
export const RECIPE_WARNINGS = ['raw_egg', 'energy_alcohol'];
export const RECIPE_LIMITS = {
  name: 80, description: 300, ingredientName: 80, ingredients: 12, steps: 10, step: 300, glass: 60, garnish: 80,
  tags: 6, tag: 30, alsoNeed: 12, amountMax: 1000,
};
const ETHANOL_G_PER_ML = 0.789;
const GRAMS_PER_STANDARD_DRINK = 10;

// Same cleaning as sanitizeText in server.js (control chars, C1, bidi overrides), plus a length cap.
export const cleanAiText = (value, maxLength) => {
  if (typeof value !== 'string') return '';
  const cleaned = validator.stripLow(value.replace(/[\t\r\n]+/g, ' '), true)
    .replace(/[\u0080-\u009F‪-‮⁦-⁩]/g, '')
    .toWellFormed()
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, maxLength).replace(/[\uD800-\uDBFF]$/, '').trim();
};

const optionalText = (value, maxLength) => {
  const cleaned = cleanAiText(value, maxLength);
  return cleaned && !['null', 'none', 'n/a', 'unknown'].includes(cleaned.toLowerCase()) ? cleaned : null;
};

const finiteIn = (value, min, max) => (
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null
);

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/** ScanResult from a provider → clean copy, or null when it breaks the schema. */
export const validateScanResult = (raw) => {
  if (!raw || typeof raw !== 'object' || !SCAN_STATUSES.includes(raw.status)) return null;
  const needsItem = ['recognized', 'low_confidence', 'water'].includes(raw.status);
  let item = null;
  if (raw.item) {
    const it = raw.item;
    if (!SCAN_CATEGORIES.includes(it.category)) return null;
    const confidence = finiteIn(it.confidence, 0, 1);
    if (confidence === null) return null;
    const abv = it.abv === null || it.abv === undefined ? null : finiteIn(it.abv, 0, 100);
    if (abv === null && it.abv !== null && it.abv !== undefined) return null;
    const volumeMl = it.volumeMl === null || it.volumeMl === undefined ? null : finiteIn(it.volumeMl, 0.001, 10_000);
    item = {
      category: it.category,
      brand: optionalText(it.brand, 80),
      product: optionalText(it.product, 120),
      style: optionalText(it.style, 80),
      abv,
      volumeMl: volumeMl === null ? null : Math.round(volumeMl),
      // Recomputed here: the taxonomy decides, not the provider.
      isAlcoholic: isAlcoholicCategory(it.category, abv),
      flags: flagsFor(it.category).filter((flag) => SCAN_FLAGS.includes(flag)),
      confidence: round(confidence, 3),
    };
  }
  if (needsItem && !item) return null;
  return {
    status: raw.status,
    item: needsItem ? item : null,
    suggestBarcode: raw.status === 'low_confidence' || raw.status === 'unclear',
  };
};

/** Standard drinks and ABV from ml ingredients (ice and solids ignored). */
export const computeStrength = (ingredients) => {
  let totalMl = 0;
  let ethanolMl = 0;
  for (const ingredient of ingredients) {
    if (ingredient.unit !== 'ml') continue;
    totalMl += ingredient.amount;
    ethanolMl += ingredient.amount * ingredient.abv / 100;
  }
  if (totalMl <= 0) return { estimatedAbv: 0, standardDrinks: 0 };
  return {
    estimatedAbv: round(ethanolMl / totalMl * 100, 1),
    standardDrinks: round(ethanolMl * ETHANOL_G_PER_ML / GRAMS_PER_STANDARD_DRINK, 2),
  };
};

/**
 * A recipe from a provider (or from the app, when saving) → clean recipe per recipe-schema v1, or null (rule S9).
 * Strength is always recomputed with the server's ABV floors; the provider's numbers are not trusted.
 */
export const normalizeRecipe = (raw, fallbackLanguage) => {
  if (!raw || typeof raw !== 'object') return null;
  const name = cleanAiText(raw.name, RECIPE_LIMITS.name);
  const glass = cleanAiText(raw.glass, RECIPE_LIMITS.glass);
  if (!name || !glass || !RECIPE_METHODS.includes(raw.method)) return null;
  if (!Array.isArray(raw.ingredients) || raw.ingredients.length === 0 || raw.ingredients.length > RECIPE_LIMITS.ingredients) return null;
  if (!Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > RECIPE_LIMITS.steps) return null;
  const ingredients = [];
  for (const ing of raw.ingredients) {
    const ingName = cleanAiText(ing?.name, RECIPE_LIMITS.ingredientName);
    const amount = finiteIn(ing?.amount, 0.01, RECIPE_LIMITS.amountMax);
    if (!ingName || amount === null || !RECIPE_UNITS.includes(ing.unit)) return null;
    const statedAbv = finiteIn(ing.abv ?? 0, 0, 100);
    if (statedAbv === null) return null;
    ingredients.push({
      name: ingName,
      amount: round(amount, 1),
      unit: ing.unit,
      abv: Math.max(statedAbv, abvFloor(ingName)),
      optional: ing.optional === true,
    });
  }
  const steps = raw.steps.map((step) => cleanAiText(step, RECIPE_LIMITS.step)).filter(Boolean);
  if (steps.length === 0) return null;
  const tags = (Array.isArray(raw.tags) ? raw.tags : [])
    .map((tag) => cleanAiText(tag, RECIPE_LIMITS.tag)).filter(Boolean).slice(0, RECIPE_LIMITS.tags);
  const language = RECIPE_LANGUAGES.includes(raw.language) ? raw.language : fallbackLanguage;
  if (!RECIPE_LANGUAGES.includes(language)) return null;
  const { estimatedAbv, standardDrinks } = computeStrength(ingredients);
  return {
    name,
    description: cleanAiText(raw.description, RECIPE_LIMITS.description),
    ingredients,
    steps,
    glass,
    garnish: optionalText(raw.garnish, RECIPE_LIMITS.garnish),
    method: raw.method,
    estimatedAbv,
    standardDrinks,
    isAlcoholic: standardDrinks > 0,
    tags,
    language,
    aiGenerated: true,
  };
};
