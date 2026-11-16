// Debug helper: why does a Smart Bar batch end with nothing valid? Prints each recipe and the server's verdict.
import { createLocalProvider } from '../../server/ai/localProvider.js';
import { checkRecipe, expandBasics } from '../../server/ai/recipeSafety.js';
import { normalizeRecipe } from '../../server/ai/schemas.js';

const provider = createLocalProvider({ url: 'http://127.0.0.1:8088', timeoutMs: 120_000 });
const bar = ['Bombay Sapphire Gin', 'Schweppes Tonic', 'cucumber', 'lime', 'orange juice'];
const basics = ['ice', 'water', 'sugar', 'salt'];
for (let run = 0; run < Number(process.argv[2] ?? 3); run++) {
  const res = await provider.recipes({ schemaVersion: '1', mode: 'smart_bar', language: 'en', ingredients: bar.map((name) => ({ name })),
    basics, mocktailsOnly: false, excludeNames: [], count: 4 });
  console.log(`## run ${run + 1}: ${res.recipes.length} recipes, service dropped ${res.dropped}`);
  for (const raw of res.recipes) {
    const v = checkRecipe(normalizeRecipe(raw, 'en'), { mode: 'smart_bar', language: 'en', adult: true, mocktailsOnly: false,
      basics: expandBasics(basics), allowedNames: [...bar, ...expandBasics(basics)], shownNames: new Set() });
    console.log('  ', raw.name, '|', raw.isAlcoholic, '|', [...raw.ingredients.map((i) => i.name), raw.garnish ?? ''].join(', '), '→', v.dropped ?? 'accepted');
  }
}
