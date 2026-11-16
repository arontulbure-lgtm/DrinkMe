// Generates one batch of recipes: provider call → schema (S9) → safety (S1-S13) → regenerate once if too few →
// one mocktail top-up if the batch has none and the input allows it. Remembers names shown per generation session,
// so "Generate another batch" never repeats a recipe (S12).
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
// No regeneration once this much time has gone: the app waits at most ~120 s.
const REGENERATE_BUDGET_MS = 45_000;

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

/** True when a mocktail can be made: some input is a non-alcoholic ingredient other than plain water. */
const allowsMocktail = (mode, inputs) => {
  if (mode === 'scan') return true;
  return inputs.some((i) => i.category !== 'water' && abvFloor(i.name) === 0 && !/^(?:water|apa|ice|gheata)$/.test(foldText(i.name)));
};

/**
 * input: { provider, userId, adult, mode, language, inputs: [{ name, category? }], scannedAliases?, basics, newSession }
 * Returns { recipes, exhausted, dropped: { S1: n, ... } }.
 */
export const generateRecipeBatch = async (input) => {
  const { provider, userId, adult, mode, language, inputs, basics, newSession } = input;
  const started = Date.now();
  const session = getSession(sessionKey(userId, mode, inputs.map((i) => i.name)), newSession === true);
  const mocktailsOnly = !adult;
  const ctx = {
    mode, language, adult, mocktailsOnly, basics: expandBasics(basics),
    allowedNames: [...inputs.map((i) => i.name), ...expandBasics(basics)],
    scannedName: inputs[0]?.name, scannedAliases: input.scannedAliases ?? [],
    shownNames: session.names,
  };
  const dropped = {};
  const accepted = [];
  const batchNames = new Set();

  const ask = async (extra) => {
    const response = await provider.recipes({
      schemaVersion: AI_SCHEMA_VERSION, mode, language, ingredients: inputs, basics,
      mocktailsOnly, excludeNames: [...session.display, ...accepted.map((r) => r.name)].slice(-SESSION_MAX_NAMES),
      count: BATCH_SIZE, ...extra,
    });
    if (!Array.isArray(response?.recipes)) throw new AiProviderError('ai_invalid_output');
    for (const raw of response.recipes) {
      const verdict = checkRecipe(normalizeRecipe(raw, language), ctx);
      if (verdict.dropped) { dropped[verdict.dropped] = (dropped[verdict.dropped] ?? 0) + 1; continue; }
      const folded = foldText(verdict.recipe.name);
      if (batchNames.has(folded)) { dropped.S12 = (dropped.S12 ?? 0) + 1; continue; }
      batchNames.add(folded);
      accepted.push({ id: recipeId(verdict.recipe), ...verdict.recipe });
    }
  };

  await ask({});
  if (accepted.length < MIN_BATCH && Date.now() - started < REGENERATE_BUDGET_MS) {
    try {
      await ask({});
    } catch (err) {
      if (accepted.length === 0) throw err;
    }
  }
  if (adult && accepted.length > 0 && !accepted.some((r) => !r.isAlcoholic) && allowsMocktail(mode, inputs)
      && Date.now() - started < REGENERATE_BUDGET_MS) {
    try {
      await ask({ mocktailsOnly: true, count: 1 });
    } catch {
      // The batch is still useful without the extra mocktail.
    }
  }
  const recipes = accepted.slice(0, MAX_BATCH);
  if (recipes.length === 0) {
    const onlyRepeats = Object.keys(dropped).every((rule) => rule === 'S12') && dropped.S12 > 0;
    if (onlyRepeats) return { recipes: [], exhausted: true, dropped };
    throw new AiProviderError('ai_invalid_output');
  }
  for (const recipe of recipes) {
    session.names.add(foldText(recipe.name));
    session.display.push(recipe.name);
  }
  if (session.display.length > SESSION_MAX_NAMES) session.display.splice(0, session.display.length - SESSION_MAX_NAMES);
  return { recipes, exhausted: false, dropped };
};
