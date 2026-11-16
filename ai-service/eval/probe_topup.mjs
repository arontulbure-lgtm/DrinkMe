// Debug helper: what does the mocktail top-up call return, and what does the server validator do with it?
import { createLocalProvider } from '../../server/ai/localProvider.js';
import { checkRecipe, expandBasics, knownItemFor } from '../../server/ai/recipeSafety.js';
import { normalizeRecipe } from '../../server/ai/schemas.js';

const provider = createLocalProvider({ url: 'http://127.0.0.1:8088', timeoutMs: 120_000 });
const cases = [
  { mode: 'scan', ingredients: [{ name: 'Tanqueray London Dry Gin', category: 'spirit' }] },
  { mode: 'smart_bar', ingredients: [{ name: 'bourbon' }, { name: 'angostura bitters' }, { name: 'orange' }, { name: 'honey' }] },
  { mode: 'scan', ingredients: [{ name: 'Red Bull', category: 'energy_drink' }] },
];
for (const c of cases) {
  const basics = ['ice', 'water', 'sugar', 'salt'];
  const res = await provider.recipes({ schemaVersion: '1', mode: c.mode, language: 'en', ingredients: c.ingredients, basics, mocktailsOnly: true, excludeNames: [], count: 1 });
  const known = c.mode === 'scan' ? [knownItemFor({ names: [c.ingredients[0].name], category: c.ingredients[0].category, abv: null })] : [];
  console.log(`## ${c.ingredients.map((i) => i.name).join(', ')} → ${res.recipes.length} recipe(s), service dropped ${res.dropped}`);
  for (const raw of res.recipes) {
    const v = checkRecipe(normalizeRecipe(raw, 'en'), { mode: c.mode, language: 'en', adult: true, mocktailsOnly: false, basics: expandBasics(basics),
      allowedNames: [...c.ingredients.map((i) => i.name), ...expandBasics(basics)], scannedName: c.ingredients[0].name, scannedAliases: [], knownItems: known, shownNames: new Set() });
    console.log('  ', raw.name, '|', raw.ingredients.map((i) => `${i.name} ${i.amount}${i.unit} ${i.abv}%`).join(', '), '→', v.dropped ?? 'accepted');
  }
}
