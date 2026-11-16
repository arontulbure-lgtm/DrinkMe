// Ingredient taxonomy v1 (see .claude/skills/ingredient-taxonomy). Must equal ai-service/app/taxonomy.py;
// test/ai-contract.test.js compares them.

export const AI_SCHEMA_VERSION = '1';

export const SCAN_CATEGORIES = [
  'spirit', 'liqueur', 'wine', 'sparkling_wine', 'beer', 'cider', 'vermouth_aperitif', 'bitters',
  'syrup', 'juice', 'soda_mixer', 'energy_drink', 'dairy_cream', 'fresh_fruit', 'herb_spice', 'water',
];
export const ALCOHOLIC_CATEGORIES = new Set([
  'spirit', 'liqueur', 'wine', 'sparkling_wine', 'beer', 'cider', 'vermouth_aperitif', 'bitters',
]);
export const DEFAULT_ABV = {
  spirit: 40, liqueur: 25, vermouth_aperitif: 16, wine: 12, sparkling_wine: 12, beer: 5, cider: 5, bitters: 40,
};
export const SCAN_STATUSES = ['recognized', 'low_confidence', 'water', 'not_ingredient', 'unclear'];
export const SCAN_FLAGS = ['energy_drink', 'contains_caffeine'];
export const NON_ALCOHOLIC_MAX_ABV = 0.5;

export const isAlcoholicCategory = (category, abv) => (
  ALCOHOLIC_CATEGORIES.has(category) && (abv === null || abv === undefined || abv > NON_ALCOHOLIC_MAX_ABV)
);
export const flagsFor = (category) => (category === 'energy_drink' ? ['energy_drink', 'contains_caffeine'] : []);

/** Lower-case, no accents, single spaces: for comparing ingredient names. */
export const foldText = (value) => String(value ?? '')
  .normalize('NFKD').replace(/[\p{M}\p{Cf}]/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}%.]+/gu, ' ').trim();

// Words that mean an ingredient is alcoholic, per category. Used to raise an ABV the model under-reported.
const ABV_HINTS = [
  ['spirit', ['vodka', 'vodca', 'votca', 'gin', 'rum', 'rom', 'whisky', 'whiskey', 'bourbon', 'scotch', 'tequila', 'mezcal',
    'brandy', 'cognac', 'coniac', 'tuica', 'palinca', 'horinca', 'rachiu', 'pisco', 'cachaca', 'grappa', 'absinthe', 'ouzo']],
  ['liqueur', ['liqueur', 'lichior', 'amaretto', 'triple sec', 'cointreau', 'kahlua', 'baileys', 'limoncello', 'sambuca',
    'curacao', 'schnapps', 'visinata', 'afinata', 'jagermeister']],
  ['vermouth_aperitif', ['vermouth', 'vermut', 'aperol', 'campari', 'aperitif', 'amaro', 'sherry', 'port', 'porto']],
  ['sparkling_wine', ['prosecco', 'champagne', 'sampanie', 'cava', 'spumant', 'sparkling wine']],
  ['wine', ['wine', 'vin', 'vinul']],
  ['beer', ['beer', 'bere', 'lager', 'ipa', 'stout', 'pilsner', 'ale']],
  ['cider', ['cider', 'cidru']],
  ['bitters', ['bitters', 'angostura']],
];
const ALCOHOL_FREE_HINT = /(non[\s-]?alcoholic|alcohol[\s-]?free|fara alcool|0[.,]0|zero|ginger beer|ginger ale|root beer|bere de ghimbir|vinegar|otet|wine glass|pahar de vin)/;

/** The ABV the server assumes at least for an ingredient name (0 when it names no alcoholic drink). */
export const abvFloor = (name) => {
  const folded = ` ${foldText(name)} `;
  if (ALCOHOL_FREE_HINT.test(folded)) return 0;
  for (const [category, words] of ABV_HINTS) {
    if (words.some((word) => folded.includes(` ${word} `))) return DEFAULT_ABV[category];
  }
  return 0;
};
