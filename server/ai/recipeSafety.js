// Recipe safety rules S1-S13 (see .claude/skills/recipe-schema). Every generated recipe passes through
// checkRecipe before a user sees it, whichever provider made it. Patterns are matched on folded text
// (lower case, no accents), so they are written without diacritics.
import { textMentionsAlcohol } from './alcoholWords.js';
import { computeStrength } from './schemas.js';
import { ALCOHOLIC_CATEGORIES, DEFAULT_ABV, foldText, isAlcoholicCategory } from './taxonomy.js';

export const MAX_STANDARD_DRINKS = 2;

const pattern = (words) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join('|')})(?![\\p{L}\\p{N}])`, 'u');

// S2: shots challenge, drinking games, binge or intoxication framing.
const BINGE = pattern([
  'shots? challenge', 'drinking games?', 'beer pong', 'flip cup', 'chug(?:ged|ging|s)?', 'down it', 'down in one',
  'bottoms up', 'shotgun(?:ning)?', 'keg stand', 'get(?:ting)? (?:drunk|wasted|hammered|smashed|plastered|tipsy)',
  'blackout', 'binge', 'as fast as (?:you|possible)', 'in one (?:go|gulp|sip)', 'last one standing',
  'provocare', 'joc(?:uri)? de baut', 'pe nerasuflate', 'dintr o suflare', 'sa te imbeti', 'te imbeti', 'beat crita',
]);
// S3: fire, dry ice, inhalation.
const DANGEROUS_TECHNIQUE = pattern([
  'flam(?:e|es|ed|ing)', 'flamb\\w*','fire', 'ignite[sd]?', 'igniting', 'set (?:it )?alight', 'light (?:it|the \\w+) on fire',
  'torch(?:ed|ing)?', 'blowtorch', 'dry ice', 'liquid nitrogen', 'inhal(?:e|ed|ing|ation)', 'vapou?r(?:ize|ise|ized|ised)?',
  'aerosol', 'smoke (?:it )?in', 'breathe in', 'snort',
  'flambat', 'flambare', 'aprinde', 'aprins', 'foc', 'gheata carbonica', 'gheata uscata', 'azot lichid', 'inhal\\w*', 'vapori\\w*', 'fum de inhalat', 'de inhalat',
]);
// S4: raw egg (warning, not a drop). Aquafaba and egg-free foams do not count.
const RAW_EGG = pattern([
  'egg whites?', 'egg yolks?', 'whole eggs?', 'raw eggs?', 'eggs?', 'albus(?:uri)?(?: de ou)?', 'galbenus(?:uri)?', 'ou', 'oua',
]);
const EGG_FREE = /(?<![\p{L}\p{N}])(?:aquafaba|egg[\s-]?free|fara ou|vegan foam|eggnog flavou?red syrup)(?![\p{L}\p{N}])/u;
// S5: energy drinks.
const ENERGY = pattern([
  'energy drinks?', 'energy', 'energizant\\w*', 'bautura energizanta', 'red bull', 'redbull', 'monster', 'rockstar', 'burn', 'hell',
  'battery', 'xixo energy', 'shark energy', 'tiger energy',
]);
// S6: medicines, drugs, supplements and non-food items.
const NON_FOOD = pattern([
  'paracetamol', 'acetaminophen', 'ibuprofen', 'aspirin', 'aspirina', 'codeine', 'codeina', 'cough syrup', 'sirop de tuse',
  'antihistamine', 'melatonin', 'melatonina', 'sleeping pills?', 'pills?', 'tablets?', 'pastil(?:a|e)', 'capsul(?:a|e|es?)',
  'medicine', 'medication', 'medicament(?:e)?', 'painkillers?', 'viagra', 'xanax', 'benzodiazepines?', 'opioids?',
  'cannabis', 'marijuana', 'weed', 'thc', 'cbd', 'mushrooms? (?:magic|psilocybin)', 'psilocybin', 'cocaine', 'mdma', 'ecstasy',
  'nicotine', 'tobacco', 'tutun', 'vape juice', 'kratom', 'poppers', 'ghb', 'laxative', 'pre workout', 'creatine', 'protein powder',
  'bleach', 'clor', 'inalbitor', 'detergent', 'soap', 'sapun', 'antifreeze', 'antigel', 'methanol', 'metanol', 'isopropyl',
  'rubbing alcohol', 'spirt medicinal', 'alcool sanitar', 'hand sanitizer', 'dezinfectant', 'disinfectant', 'mouthwash',
  'apa de gura', 'perfume', 'parfum', 'cologne', 'lighter fluid', 'gasoline', 'benzina', 'kerosene', 'ethanol 96', 'pure ethanol',
  'grain alcohol', 'everclear', 'spirytus', 'alcool alimentar 96', 'cleaning (?:product|spray|agent)s?', 'lye', 'borax',
]);
// S9 (label honesty): names or tags that claim there is no alcohol.
const NON_ALCOHOLIC_CLAIM = pattern([
  'mocktails?', 'virgin', 'non alcoholic', 'nonalcoholic', 'alcohol free', 'zero proof', 'spirit free', 'no alcohol',
  'fara alcool', 'analcolic\\w*', 'sin alcohol', 'sans alcool', 'alkoholfrei\\w*',
]);
// S8: driving.
const DRIVING = pattern([
  'drive', 'drives', 'driving', 'drove', 'driver', 'behind the wheel', 'road trip', 'conduc(?:i|e|ere|and)?', 'la volan',
  'sofer(?:ul)?', 'condus',
]);

const LOCALIZED = {
  en: {
    responsible: 'Enjoy responsibly. 18+ only. Never drink and drive, and skip alcohol if you are pregnant, on medication or under the legal drinking age.',
  },
  ro: {
    responsible: 'Consumă responsabil. Doar 18+. Nu conduce după ce ai băut și evită alcoolul dacă ești însărcinată, iei medicamente sau nu ai vârsta legală.',
  },
};

export const responsibleNoteFor = (language) => (LOCALIZED[language] ?? LOCALIZED.en).responsible;

const recipeText = (recipe) => foldText([
  recipe.name, recipe.description, recipe.glass, recipe.garnish ?? '', ...recipe.steps, ...recipe.tags,
  ...recipe.ingredients.map((ingredient) => ingredient.name),
].join(' \n '));

const ingredientText = (recipe) => foldText(recipe.ingredients.map((i) => i.name).join(' \n '));

// Words that do not change what an ingredient is ("fresh lime juice" is "lime juice").
const FILLER = new Set([
  'fresh', 'freshly', 'squeezed', 'chilled', 'cold', 'of', 'the', 'a', 'some', 'proaspat', 'proaspata', 'stors', 'stoarsa',
  'rece', 'de', 'cu', 'si', 'and', 'or', 'sau', 'cubes', 'cuburi', 'crushed', 'pisata', 'cubed', 'slice', 'slices', 'wedge',
  'wedges', 'wheel', 'twist', 'peel', 'zest', 'leaves', 'leaf', 'sprig', 'frunze', 'frunza', 'felie', 'felii', 'coaja',
  'juice', 'suc', 'top', 'up', 'splash', 'dash', 'dashes', 'to', 'taste', 'optional', 'garnish', 'pentru', 'decor',
]);
const stem = (word) => (word.length > 4 ? word.replace(/(?:es|s|uri|ele|ul|ii|a|e)$/u, '') : word);
// Two-word names that mean one product, collapsed before comparing.
const SYNONYMS = [
  [/\b(?:tonic water|apa tonica)\b/g, 'tonic'],
  [/\b(?:soda water|club soda|sparkling water|apa minerala|apa carbogazoasa|sifon)\b/g, 'soda'],
];
const collapse = (folded) => SYNONYMS.reduce((text, [re, to]) => text.replace(re, to), folded);
const keyWords = (name) => collapse(foldText(name)).split(' ').filter((w) => w && !FILLER.has(w)).map(stem);

// Words that name a different product when added to an allowed name: "orange" does not cover "orange liqueur",
// "water" does not cover "soda water".
const PRODUCT_NOUNS = new Set([
  'liqueur', 'lichior', 'syrup', 'sirop', 'soda', 'tonic', 'water', 'apa', 'beer', 'bere', 'wine', 'vin', 'cream', 'frisca',
  'smantana', 'milk', 'lapte', 'bitter', 'cordial', 'vodka', 'gin', 'rum', 'whisky', 'whiskey', 'tequila', 'brandy', 'cider',
  'vermouth', 'vermut', 'puree', 'piure', 'jam', 'gem', 'nectar', 'lemonade', 'limonada', 'cola', 'energy', 'tea', 'ceai',
  'coffee', 'cafea', 'spirit', 'schnapps', 'brandy', 'egg', 'ou', 'honey', 'miere', 'salt', 'sare', 'pepper', 'piper',
]);
const PRODUCT_STEMS = new Set([...PRODUCT_NOUNS].map(stem));

// Basics the model names in other words: "sugar" covers "simple syrup".
const BASIC_ALIASES = {
  sugar: ['simple syrup', 'sugar syrup', 'sirop simplu', 'sirop de zahar', 'caster sugar', 'brown sugar'],
  zahar: ['sirop simplu', 'sirop de zahar', 'simple syrup', 'zahar brun'],
  water: ['still water', 'cold water', 'hot water', 'apa plata'],
  apa: ['apa plata', 'apa rece', 'still water'],
  ice: ['crushed ice', 'ice cubes', 'gheata pisata'],
  gheata: ['gheata pisata', 'cuburi de gheata', 'crushed ice'],
  salt: ['sea salt', 'flaky salt', 'sare de mare'],
  sare: ['sare de mare', 'sea salt'],
};

/** The basics plus the other names the model may use for them. */
export const expandBasics = (basics) => basics.flatMap((basic) => [basic, ...(BASIC_ALIASES[foldText(basic)] ?? [])]);

/**
 * True when `name` is covered by one of the allowed names: every key word of the ingredient appears in the
 * allowed name ("gin" is covered by "Bombay London Dry Gin"), or the allowed name's key words all appear in the
 * ingredient and the extra words are descriptors, not another product ("London dry gin" by "gin").
 */
export const isAllowedIngredient = (name, allowedNames) => {
  const words = keyWords(name);
  if (words.length === 0) return true; // only filler words
  return allowedNames.some((allowed) => {
    const allowedWords = keyWords(allowed);
    if (allowedWords.length === 0) return false;
    if (words.every((w) => allowedWords.includes(w))) return true;
    if (!allowedWords.every((w) => words.includes(w))) return false;
    return words.filter((w) => !allowedWords.includes(w)).every((w) => !PRODUCT_STEMS.has(w));
  });
};

/**
 * What the server knows for sure about an input ingredient (the confirmed scan item): its names, category and ABV.
 * Returns { names, category, abv } or null.
 */
export const knownItemFor = ({ names, category, abv }) => {
  if (!category) return null;
  const alcoholic = isAlcoholicCategory(category, abv ?? null);
  const kept = names.filter(Boolean);
  return {
    names: kept,
    category,
    // The label's ABV when known, else the category default (a spirit without a readable ABV counts as 40 %).
    abv: alcoholic ? (typeof abv === 'number' ? abv : (DEFAULT_ABV[category] ?? 40)) : 0,
    // A confirmed alcohol-free item overrides brand guesses ("Ursus" counts as beer by default): only for a
    // non-alcoholic category, or an alcoholic one whose name says it is alcohol-free ("0.0", "fara alcool").
    // An alcoholic category can never be talked down to 0 by an edited ABV alone.
    zeroIsCertain: !alcoholic && (!ALCOHOLIC_CATEGORIES.has(category) || ALCOHOL_FREE_NAME.test(foldText(kept.join(' ')))),
  };
};

const ALCOHOL_FREE_NAME = /(?:\b0[.,]0\b|alcohol[\s-]*free|non[\s-]*alcoholic|fara alcool|zero alcohol|alkoholfrei|sin alcohol|sans alcool)/;

const matchesKnown = (ingredientName, known) => known.names.some((name) => (
  isAllowedIngredient(ingredientName, [name]) || isAllowedIngredient(name, [ingredientName])
));

/**
 * Raises the ABV of every ingredient that is a known item (the scanned bottle) to the item's real ABV, then
 * recomputes strength. The model's numbers are never trusted for the bottle the user actually scanned.
 */
const applyKnownItems = (recipe, knownItems) => {
  if (!knownItems?.length) return recipe;
  let changed = false;
  const ingredients = recipe.ingredients.map((ingredient) => {
    const known = knownItems.find((k) => matchesKnown(ingredient.name, k));
    if (!known) return ingredient;
    if (known.abv > ingredient.abv || (known.zeroIsCertain && ingredient.abv > 0)) {
      changed = true;
      return { ...ingredient, abv: known.abv };
    }
    return ingredient;
  });
  if (!changed) return recipe;
  const { estimatedAbv, standardDrinks } = computeStrength(ingredients);
  return { ...recipe, ingredients, estimatedAbv, standardDrinks, isAlcoholic: standardDrinks > 0 };
};

/**
 * Applies S1-S13 to one normalised recipe.
 * ctx: { mode: 'scan'|'smart_bar', language, adult, mocktailsOnly, allowedNames (smart_bar: bar + basics),
 *        scannedName + scannedAliases (scan), knownItems (from knownItemFor), basics,
 *        shownNames: Set of folded names already shown }
 * Returns { recipe } (possibly with warnings / responsibleNote / youWillAlsoNeed added) or { dropped: rule }.
 */
export const checkRecipe = (normalized, ctx) => {
  if (!normalized) return { dropped: 'S9' };
  const recipe = applyKnownItems(normalized, ctx.knownItems);
  const text = recipeText(recipe);
  const folded = foldText(recipe.name);
  if (ctx.shownNames?.has(folded)) return { dropped: 'S12' };
  if (NON_FOOD.test(text)) return { dropped: 'S6' };
  if (BINGE.test(text)) return { dropped: 'S2' };
  if (DANGEROUS_TECHNIQUE.test(text)) return { dropped: 'S3' };
  // A recipe that names an alcoholic drink is alcoholic, whatever its ABV numbers say.
  const namesAlcohol = textMentionsAlcohol(ingredientText(recipe));
  const isAlcoholic = recipe.isAlcoholic || namesAlcohol;
  // Label honesty (S9): an alcoholic recipe must never be called a mocktail, virgin or alcohol-free.
  if (isAlcoholic && NON_ALCOHOLIC_CLAIM.test(foldText([recipe.name, ...recipe.tags].join(' ')))) return { dropped: 'S9' };
  if (isAlcoholic && (ctx.mocktailsOnly || !ctx.adult)) return { dropped: 'S13' };
  if (recipe.standardDrinks > MAX_STANDARD_DRINKS) return { dropped: 'S1' };
  if (isAlcoholic && DRIVING.test(text)) return { dropped: 'S8' };

  const result = { ...recipe, isAlcoholic, warnings: [], youWillAlsoNeed: [], responsibleNote: null };
  if (ctx.mode === 'smart_bar') {
    const names = [...recipe.ingredients.map((i) => i.name), ...(recipe.garnish ? [recipe.garnish] : [])];
    if (!names.every((name) => isAllowedIngredient(name, ctx.allowedNames))) return { dropped: 'S10' };
  } else if (ctx.mode === 'scan') {
    // A mocktail cannot contain an alcoholic scanned bottle: it may be inspired by it instead (the batch's mocktail).
    const scannedIsAlcoholic = (ctx.knownItems ?? []).some((k) => k.abv > 0);
    const usesItem = recipe.ingredients.some((i) => isAllowedIngredient(i.name, [ctx.scannedName, ...(ctx.scannedAliases ?? [])])
      || isAllowedIngredient(ctx.scannedName, [i.name]));
    if (!usesItem && !(scannedIsAlcoholic && !isAlcoholic)) {
      return { dropped: 'S11' };
    }
    result.youWillAlsoNeed = recipe.ingredients
      .filter((i) => !isAllowedIngredient(i.name, [ctx.scannedName, ...(ctx.scannedAliases ?? [])])
        && !isAllowedIngredient(ctx.scannedName, [i.name])
        && !isAllowedIngredient(i.name, ctx.basics ?? []))
      .map((i) => i.name)
      .slice(0, 12);
  }
  // Per ingredient: an "aquafaba" in the description must not hide an egg-white ingredient.
  const egg = recipe.ingredients.some((i) => RAW_EGG.test(foldText(i.name)) && !EGG_FREE.test(foldText(i.name)));
  if (egg) result.warnings.push('raw_egg');
  const knownEnergy = (ctx.knownItems ?? []).filter((k) => k.category === 'energy_drink');
  const hasEnergy = ENERGY.test(text) || recipe.ingredients.some((i) => knownEnergy.some((k) => matchesKnown(i.name, k)));
  if (isAlcoholic && hasEnergy) result.warnings.push('energy_alcohol');
  if (isAlcoholic) result.responsibleNote = responsibleNoteFor(recipe.language);
  return { recipe: result };
};
