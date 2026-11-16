// Alcohol word list shared by the legacy OpenAI routes (server.js) and the recipe safety validator (ai/recipeSafety.js).
// The model can call anything a mocktail, so the text of a mocktail-only answer is checked too. This is a
// safety net with known limits: a drink it does not list gets through, and "non-alcoholic beer" is dropped.
// All of these are matched after toAlcoholCheckText, so they are written without diacritics.
export const AI_ALCOHOL_WORDS = [
  'whisky', 'whiskey', 'whiskies', 'whiskeys', 'bourbon', 'scotch', 'vodka', 'vodkas', 'gin', 'gins', 'rum', 'rums',
  'tequila', 'tequilas', 'mezcal', 'brandy', 'brandies', 'cognac', 'armagnac', 'liqueur', 'liqueurs', 'liquor', 'liquors',
  'spirit', 'spirits', 'wine', 'wines', 'beer', 'beers', 'lager', 'lagers', 'stout', 'porter', 'ipa', 'pale ale', 'brown ale',
  'cider', 'ciders', 'hard seltzer', 'champagne', 'prosecco', 'cava', 'sake', 'soju', 'mead', 'vermouth', 'bitters', 'amaro',
  'campari', 'aperol', 'absinthe', 'sambuca', 'ouzo', 'grappa', 'pastis', 'kahlua', 'baileys', 'cointreau', 'triple sec',
  'curacao', 'schnapps', 'sherry', 'madeira', 'marsala', 'jagermeister', 'limoncello', 'amaretto', 'pisco', 'cachaca',
  'alcohol', 'alcoholic', 'alcoholice',
  'tuica', 'tuici', 'palinca', 'palinci', 'horinca', 'rachiu', 'rachiuri', 'rakia', 'vin', 'vinuri', 'bere', 'beri',
  'lichior', 'lichioruri', 'coniac', 'coniacuri', 'votca', 'vodca', 'rom', 'sampanie', 'spumant', 'cidru', 'vermut',
  'visinata', 'afinata', 'tarie', 'tarii', 'alcool', 'alcoolic', 'alcoolica', 'alcoolice',
];
const toAlcoholWordPattern = (word) => word.replace(/ /g, '[\\s-]+');
export const AI_ALCOHOL_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${AI_ALCOHOL_WORDS.map(toAlcoholWordPattern).join('|')})(?![\\p{L}\\p{N}])`,
  'u'
);
// Removed before the check, because they name no alcoholic drink. "nonalcoholic" needs no entry: it is one word.
// An alcohol-free qualifier also covers the drink it qualifies: "non-alcoholic gin", "alcohol-free beer", "0.0 beer",
// "gin (alcohol-free)", "bere fara alcool" name no alcoholic drink.
const FREE_QUALIFIER = '(?:(?:non|no|zero|without|fara)[\\s-]*(?:alcoholic|alcohol|alcoolica|alcoolice|alcoolic|alcool)|(?:alcohol|alcool)[\\s-]*free|0[.,]0(?:\\s*%)?)';
const QUALIFIED_DRINK = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${FREE_QUALIFIER}(?:[\\s-]+\\p{L}+)?|\\p{L}+[\\s-]*\\(?\\s*${FREE_QUALIFIER}\\s*\\)?)(?![\\p{L}\\p{N}])`,
  'gu',
);
export const AI_ALCOHOL_FREE_PHRASES = /(?<![\p{L}\p{N}])(?:(?:non|no|zero|without|fara)[\s-]+(?:alcoholic|alcohol|alcoolica|alcoolice|alcoolic|alcool)|(?:alcohol|alcool)[\s-]*free|ginger[\s-]+beer|root[\s-]+beer|bere[\s-]+de[\s-]+ghimbir|(?:wine|beer)[\s-]*glass(?:es)?|pahar(?:e)?[\s-]+de[\s-]+(?:vin|bere)|(?:wine|cider)[\s-]+vinegar|otet[\s-]+de[\s-]+vin)(?![\p{L}\p{N}])/gu;

// Removes accents and invisible format characters, so neither can hide a word.
export const toAlcoholCheckText = (value) => value.normalize('NFKD').replace(/[\p{M}\p{Cf}]/gu, '').toLowerCase();


/** True when the text names an alcoholic drink (after removing alcohol-free phrases such as "ginger beer"). */
export const textMentionsAlcohol = (text) => AI_ALCOHOL_PATTERN.test(
  toAlcoholCheckText(text).replace(QUALIFIED_DRINK, ' ').replace(AI_ALCOHOL_FREE_PHRASES, ' '),
);
