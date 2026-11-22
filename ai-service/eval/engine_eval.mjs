// Recipe evaluation through the SERVER's real pipeline (server/ai/recipeEngine.js + the local provider): schema +
// safety validation, one regeneration when fewer than 3 survive, the mocktail top-up and no-repeat sessions – exactly
// what POST /api/ai/recipes returns to the app. Needs `npm run ai:start`.
// Usage: node ai-service/eval/engine_eval.mjs <report dir> [inputs per mode, default 10]
import fs from 'node:fs';
import path from 'node:path';

import { createLocalProvider } from '../../server/ai/localProvider.js';
import { generateRecipeBatch } from '../../server/ai/recipeEngine.js';
import { knownItemFor } from '../../server/ai/recipeSafety.js';
import { abvFloor, foldText } from '../../server/ai/taxonomy.js';

const dir = process.argv[2];
const perMode = Number(process.argv[3] ?? 10);
const inputs = fs.readFileSync(path.join(dir, 'recipes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const chosen = [...inputs.filter((c) => c.mode === 'smart_bar').slice(0, perMode), ...inputs.filter((c) => c.mode === 'scan').slice(0, perMode)];
const provider = createLocalProvider({ url: 'http://127.0.0.1:8088', timeoutMs: 120_000 });
const BASICS = { en: ['ice', 'water', 'sugar', 'salt'], ro: ['gheață', 'apă', 'zahăr', 'sare'] };

const rows = [];
for (const c of chosen) {
  const item = c.mode === 'scan' ? c.ingredients[0] : null;
  const known = item ? knownItemFor({ names: [item.name], category: item.category, abv: null }) : null;
  const row = { id: c.id, mode: c.mode, language: c.language, batches: [] };
  for (const newSession of [true, false]) {
    const t0 = Date.now();
    let firstMs = null;
    try {
      const out = await generateRecipeBatch({
        provider, userId: `eval-${c.id}`, adult: true, mode: c.mode, language: c.language,
        inputs: c.ingredients, scannedAliases: [], knownItems: known ? [known] : [], basics: BASICS[c.language], newSession, concurrency: 2,
      }, { onRecipe: () => { if (firstMs === null) firstMs = Date.now() - t0; } });
      row.batches.push({ ms: Date.now() - t0, firstMs, count: out.recipes.length, exhausted: out.exhausted, dropped: out.dropped,
        mocktail: out.recipes.some((r) => !r.isAlcoholic), names: out.recipes.map((r) => r.name),
        maxStandardDrinks: Math.max(0, ...out.recipes.map((r) => r.standardDrinks)) });
    } catch (err) {
      row.batches.push({ ms: Date.now() - t0, error: err.code ?? err.name });
    }
  }
  rows.push(row);
  console.log(c.id, row.batches.map((b) => b.error ?? `${b.count}${b.mocktail ? '+M' : ''} ${b.ms}ms`).join(' | '));
}

const first = rows.map((r) => r.batches[0]);
const all = rows.flatMap((r) => r.batches);
const ok = all.filter((b) => !b.error);
const mocktailPossible = rows.filter((r) => {
  const c = chosen.find((x) => x.id === r.id);
  return c.mode === 'scan' || c.ingredients.some((i) => abvFloor(i.name) === 0 && !/^(water|apa)$/.test(foldText(i.name)));
});
const repeats = rows.reduce((n, r) => {
  const [a, b] = r.batches;
  if (!a?.names || !b?.names) return n;
  const seen = new Set(a.names.map(foldText));
  return n + b.names.filter((x) => seen.has(foldText(x))).length;
}, 0);
const ms = ok.map((b) => b.ms).sort((x, y) => x - y);
const firstTimes = ok.map((b) => b.firstMs).filter((v) => v !== null).sort((x, y) => x - y);
const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(arr.length * p) - 1))];
const summary = {
  inputs: rows.length,
  batches: all.length,
  errors: all.filter((b) => b.error).map((b) => b.error),
  firstBatchAtLeast3: first.filter((b) => b.count >= 3).length,
  firstBatchMocktailWhenPossible: `${mocktailPossible.filter((r) => r.batches[0].mocktail).length}/${mocktailPossible.length}`,
  repeatsAcrossBatches: repeats,
  maxStandardDrinksSeen: Math.max(0, ...ok.map((b) => b.maxStandardDrinks)),
  firstRecipeMs: { p50: q(firstTimes, 0.5), p90: q(firstTimes, 0.9), max: firstTimes.at(-1) },
  latencyMs: { p50: ms[Math.floor(ms.length / 2)], p95: ms[Math.min(ms.length - 1, Math.round(ms.length * 0.95) - 1)], max: ms.at(-1) },
};
fs.writeFileSync(path.join(dir, 'engine-eval.json'), JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
