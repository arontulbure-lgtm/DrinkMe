// Generates one batch of recipes as SLOTS: each slot is one model call for one recipe, so a recipe can be shown as
// soon as it passes validation (streaming), and slots run in parallel (AI_RECIPE_CONCURRENCY, default 2).
//   - 3 regular slots with different style hints + 1 mocktail slot whenever a mocktail is possible
//     (users not confirmed 18+ get mocktail slots only).
//   - The mocktail slot never sees an alcoholic ingredient: a scanned spirit is described by its flavour only,
//     and in Smart Bar mode only the non-alcoholic items are sent.
//   - Every recipe: schema (S9) → safety (S1-S13); a failed slot is retried once while the time budget lasts.
//   - Names shown per generation session are remembered, so "Generate another batch" never repeats (S12).
import crypto from 'node:crypto';

import { AiProviderError } from './provider.js';
import { checkRecipe, expandBasics } from './recipeSafety.js';
import { normalizeRecipe } from './schemas.js';
import { AI_SCHEMA_VERSION, abvFloor, foldText } from './taxonomy.js';

export const BATCH_SIZE = 4;
export const MIN_BATCH = 3;
const MAX_BATCH = 5;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_MAX_NAMES = 60;
const SESSIONS_MAX = 5000;
// No new attempt starts once this much time has gone: the app waits at most ~150 s.
const RETRY_BUDGET_MS = 60_000;
const STYLE_HINTS = [
  'a short drink, stirred or built over ice',
  'a long, refreshing highball',
  'a citrusy drink, shaken or sour-style',
  'a creative signature drink',
];

const sessions = new Map(); // key → { names: Set<folded>, display: string[], expires }

const sessionKey = (userId, mode, inputNames) => crypto.createHash('sha256')
  .update(JSON.stringify([userId, mode, inputNames.map(foldText).sort()])).digest('hex');

const getSession = (key, reset) => {
  const now = Date.now();
  if (sessions.size > SESSIONS_MAX) {
    for (const [k, s] of sessions) if (s.expires < now) sessions.delete(k);
    while (sessions.size > SESSIONS_MAX) sessions.delete(sessions.keys().next().value);
  }
  let session = sessions.get(key);
  if (reset || !session || session.expires < now) {
    session = { names: new Set(), display: [], expires: now + SESSION_TTL_MS };
    sessions.set(key, session);
  }
  session.expires = now + SESSION_TTL_MS;
  return session;
};

export const resetRecipeSessions = () => sessions.clear();

export const recipeId = (recipe) => `r_${crypto.createHash('sha256')
  .update(JSON.stringify([foldText(recipe.name), recipe.ingredients.map((i) => [foldText(i.name), i.amount, i.unit])]))
  .digest('hex').slice(0, 16)}`;

const isNonAlcoholicInput = (i) => i.category !== 'water' && abvFloor(i.name) === 0 && !/^(?:water|apa|ice|gheata)$/.test(foldText(i.name));

/** True when a mocktail can be made: scan mode, or some Smart Bar item is non-alcoholic (not plain water). */
const allowsMocktail = (mode, inputs) => mode === 'scan' || inputs.some(isNonAlcoholicInput);

// Flavour notes of an alcoholic bottle, so a mocktail can echo it without the model ever seeing the drink's name.
const FLAVOURS = [
  [/\bgin\b|genever/, 'juniper, citrus peel and fresh herbal notes'],
  [/whisk|bourbon|scotch/, 'oak, vanilla, caramel and light smoke'],
  [/\brum\b|\brom\b|cachaca/, 'molasses, vanilla and tropical fruit'],
  [/tequila|mezcal/, 'agave, lime and black pepper'],
  [/vodka|vodca|votca/, 'a clean, neutral base with citrus'],
  [/brandy|cognac|coniac|alexandrion|metaxa/, 'dried fruit, oak and warm spice'],
  [/tuica|palinca|horinca|rachiu|plum|prune/, 'ripe plum and orchard fruit'],
  [/coffee|kahlua|espresso|cafea/, 'roasted coffee and dark sugar'],
  [/cream|baileys|frisca/, 'creamy vanilla and cocoa'],
  [/orange|triple sec|cointreau|curacao|portocal/, 'bitter orange peel'],
  [/amaretto|almond|migdal/, 'almond and marzipan'],
  [/aperol|campari|bitter|vermouth|vermut|martini/, 'bitter orange, rhubarb and herbs'],
  [/prosecco|champagne|spumant|sparkling|sekt|cava/, 'green apple, citrus and fine bubbles'],
  [/rose|rosé/, 'strawberry and red berries'],
  [/red|rosu|negru|merlot|cabernet|feteasca neagra/, 'dark berries, plum and spice'],
  [/wine|vin|riesling|sauvignon|grasa|tamaioasa|feteasca/, 'green apple, white grape and citrus'],
  [/stout|porter|dark|negru/, 'roasted malt and cocoa'],
  [/beer|bere|lager|ipa|pils|ursus|timisoreana|ciuc|bergenbier/, 'light malt, bread and citrusy hops'],
  [/cider|cidru/, 'crisp apple'],
];
const CATEGORY_FLAVOURS = {
  spirit: 'warm spice and citrus peel', liqueur: 'sweet fruit and spice', wine: 'grape and berries',
  sparkling_wine: 'green apple and fine bubbles', beer: 'malt and citrus', cider: 'crisp apple',
  vermouth_aperitif: 'bitter orange and herbs', bitters: 'aromatic spice',
};
export const flavourDescription = (known) => {
  const text = foldText(known.names.join(' '));
  const found = FLAVOURS.find(([re]) => re.test(text));
  const notes = found ? found[1] : (CATEGORY_FLAVOURS[known.category] ?? 'fresh fruit and herbs');
  return `alcohol-free drink with ${notes}`;
};

/**
 * input: { provider, userId, adult, mode, language, inputs: [{ name, category? }], scannedAliases?, knownItems?, basics,
 *          newSession, signal?, concurrency? }
 * onRecipe(recipe): called for each accepted recipe as soon as it passes validation (streaming).
 * Returns { recipes, exhausted, dropped: { S1: n, ... }, errors: [code] }.
 */
export const generateRecipeBatch = async (input, { onRecipe } = {}) => {
  const { provider, userId, adult, mode, language, inputs, basics, newSession } = input;
  const started = Date.now();
  const session = getSession(sessionKey(userId, mode, inputs.map((i) => i.name)), newSession === true);
  const knownItems = input.knownItems ?? [];
  const ctx = {
    mode, language, adult, mocktailsOnly: !adult, basics: expandBasics(basics),
    allowedNames: [...inputs.map((i) => i.name), ...expandBasics(basics)],
    scannedName: inputs[0]?.name, scannedAliases: input.scannedAliases ?? [], knownItems,
    shownNames: session.names,
  };
  const dropped = {};
  const errors = [];
  const accepted = [];
  const batchNames = new Set();
  const attemptedNames = [];

  // What the mocktail slot may see.
  const alcoholicKnown = knownItems.find((k) => k.abv > 0);
  const mocktailInputs = mode === 'scan'
    ? (alcoholicKnown ? [{ name: flavourDescription(alcoholicKnown) }] : inputs)
    : inputs.filter(isNonAlcoholicInput);

  const slots = [];
  const wantMocktail = allowsMocktail(mode, inputs) && mocktailInputs.length > 0;
  if (!adult) {
    for (let i = 0; i < BATCH_SIZE; i++) slots.push({ mocktail: true, styleHint: STYLE_HINTS[i] });
  } else {
    const regular = wantMocktail ? BATCH_SIZE - 1 : BATCH_SIZE;
    for (let i = 0; i < regular; i++) slots.push({ mocktail: false, styleHint: STYLE_HINTS[i] });
    if (wantMocktail) slots.push({ mocktail: true, styleHint: 'a refreshing mocktail' });
  }

  const accept = (recipe) => {
    const folded = foldText(recipe.name);
    if (batchNames.has(folded) || session.names.has(folded)) { dropped.S12 = (dropped.S12 ?? 0) + 1; return false; }
    batchNames.add(folded);
    session.names.add(folded);
    session.display.push(recipe.name);
    const withId = { id: recipeId(recipe), ...recipe };
    accepted.push(withId);
    onRecipe?.(withId);
    return true;
  };

  const runSlot = async (slot) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (input.signal?.aborted || accepted.length >= MAX_BATCH) return;
      if (attempt > 0 && Date.now() - started > RETRY_BUDGET_MS) return;
      let response;
      try {
        response = await provider.recipes({
          schemaVersion: AI_SCHEMA_VERSION, mode, language,
          ingredients: slot.mocktail ? mocktailInputs : inputs,
          basics, mocktailsOnly: slot.mocktail,
          excludeNames: [...session.display, ...attemptedNames].slice(-SESSION_MAX_NAMES),
          count: 1, styleHint: slot.styleHint,
        }, { signal: input.signal });
      } catch (err) {
        errors.push(err?.code ?? 'ai_unavailable');
        // Outages and timeouts are not worth a second wait; an unusable answer is.
        if (err?.code !== 'ai_invalid_output') return;
        continue;
      }
      for (const raw of Array.isArray(response?.recipes) ? response.recipes : []) {
        if (typeof raw?.name === 'string') attemptedNames.push(raw.name.slice(0, 80));
        const verdict = checkRecipe(normalizeRecipe(raw, language), ctx);
        if (verdict.dropped) { dropped[verdict.dropped] = (dropped[verdict.dropped] ?? 0) + 1; continue; }
        if (slot.mocktail && verdict.recipe.isAlcoholic) { dropped.S13 = (dropped.S13 ?? 0) + 1; continue; }
        if (accept(verdict.recipe)) return;
      }
    }
  };

  const runAll = async (list) => {
    const concurrency = Math.max(1, Math.min(4, input.concurrency ?? 2));
    const queue = [...list];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) await runSlot(queue.shift());
    });
    await Promise.all(workers);
  };

  await runAll(slots);
  // Too few survived: one refill round of regular slots while the budget lasts.
  if (accepted.length > 0 && accepted.length < MIN_BATCH && adult && Date.now() - started < RETRY_BUDGET_MS && !input.signal?.aborted) {
    await runAll(STYLE_HINTS.slice(0, MIN_BATCH - accepted.length).map((styleHint) => ({ mocktail: false, styleHint })));
  }

  if (session.display.length > SESSION_MAX_NAMES) {
    session.display.splice(0, session.display.length - SESSION_MAX_NAMES);
    session.names = new Set(session.display.map(foldText));
  }
  if (accepted.length === 0) {
    const onlyRepeats = errors.length === 0 && Object.keys(dropped).every((rule) => rule === 'S12') && dropped.S12 > 0;
    if (onlyRepeats) return { recipes: [], exhausted: true, dropped, errors };
    const code = errors.includes('ai_unavailable') ? 'ai_unavailable' : errors.includes('ai_timeout') ? 'ai_timeout' : 'ai_invalid_output';
    throw new AiProviderError(code);
  }
  return { recipes: accepted, exhausted: false, dropped, errors };
};
