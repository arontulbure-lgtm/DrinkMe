// Ingredient taxonomy v1 (see .claude/skills/ingredient-taxonomy). Must equal ai-service/app/taxonomy.py and src/types/api.ts;
// test/ai-safety.test.js ("contract with ai-service") compares them.

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
    'brandy', 'cognac', 'coniac', 'tuica', 'palinca', 'horinca', 'rachiu', 'pisco', 'cachaca', 'grappa', 'absinthe', 'ouzo',
    // Brands, so a bar item named only by its brand is not taken for a soft drink.
    'smirnoff', 'absolut', 'finlandia', 'stolichnaya', 'grey goose', 'belvedere', 'beluga', 'ciroc', 'wyborowa', 'eristoff',
    'jack daniel', 'jack daniels', 'jameson', 'johnnie walker', 'ballantine', 'ballantines', 'chivas', 'jim beam', 'glenfiddich',
    'tullamore', 'bushmills', 'famous grouse', 'grants', 'william lawson', 'bacardi', 'captain morgan', 'havana club', 'malibu',
    'kraken', 'sailor jerry', 'jose cuervo', 'olmeca', 'patron', 'tanqueray', 'bombay', 'beefeater', 'hendricks',
    'gordons', 'gordon', 'larios', 'metaxa', 'hennessy', 'remy martin', 'martell', 'alexandrion', 'zarea', 'unirea']],
  ['liqueur', ['liqueur', 'lichior', 'amaretto', 'triple sec', 'cointreau', 'kahlua', 'baileys', 'limoncello', 'sambuca',
    'curacao', 'schnapps', 'visinata', 'afinata', 'jagermeister', 'jager', 'disaronno', 'frangelico', 'malibu', 'southern comfort',
    'grand marnier', 'chambord', 'st germain', 'midori', 'sheridans', 'becherovka', 'fernet', 'unicum']],
  ['vermouth_aperitif', ['vermouth', 'vermut', 'aperol', 'campari', 'aperitif', 'amaro', 'sherry', 'port', 'porto', 'martini',
    'cinzano', 'lillet', 'dubonnet', 'pernod', 'ricard', 'pastis']],
  ['sparkling_wine', ['prosecco', 'champagne', 'sampanie', 'cava', 'spumant', 'sparkling wine']],
  ['wine', ['wine', 'vin', 'vinul']],
  ['beer', ['beer', 'bere', 'lager', 'ipa', 'stout', 'pilsner', 'ale', 'ursus', 'timisoreana', 'ciuc', 'bergenbier', 'silva',
    'skol', 'tuborg', 'carlsberg', 'heineken', 'stella artois', 'peroni', 'corona', 'guinness', 'beck s', 'becks', 'budweiser',
    'leffe', 'hoegaarden', 'kozel', 'pilsner urquell', 'staropramen', 'grolsch', 'desperados', 'birra moretti', 'efes']],
  ['cider', ['cider', 'cidru', 'strongbow', 'somersby', 'kingswood', 'savanna', 'kopparberg', 'rekorderlig']],
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
