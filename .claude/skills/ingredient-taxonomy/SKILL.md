---
name: ingredient-taxonomy
description: What DrinkMe counts as a drink ingredient - the scan categories, which are alcoholic, the water rule, the energy-drink flag and what must be refused (non-drinks, medicines, cleaning products). Use for scanner prompts, scan validation, barcode mapping, Smart Bar categories and recipe ingredient checks.
---

# Ingredient taxonomy (v1)

| category | examples | alcoholic | recipes |
|---|---|---|---|
| `spirit` | vodka, gin, rum, whisky, tequila, brandy, țuică, pălincă | yes | yes |
| `liqueur` | amaretto, triple sec, coffee liqueur, vișinată | yes | yes |
| `wine` | red, white, rosé, fortified (port, sherry) | yes | yes |
| `sparkling_wine` | prosecco, champagne, cava, spumant | yes | yes |
| `beer` | lager, IPA, stout; 0.0 beer → `abv: 0`, not alcoholic | yes unless abv ≤ 0.5 | yes |
| `cider` | apple/pear cider | yes unless abv ≤ 0.5 | yes |
| `vermouth_aperitif` | vermouth, Aperol-style bitters aperitifs, Campari-style | yes | yes |
| `bitters` | aromatic/orange bitters (used in dashes) | yes (tiny amounts) | yes |
| `syrup` | simple, grenadine, orgeat, fruit syrups | no | yes |
| `juice` | orange, lime, cranberry, tomato | no | yes |
| `soda_mixer` | tonic, cola, ginger beer/ale, soda water with flavour, lemonade | no | yes |
| `energy_drink` | any energy drink → flag `energy_drink` (+ `contains_caffeine`) | no | yes, warning when mixed with alcohol |
| `dairy_cream` | milk, cream, plant milks, coconut cream | no | yes |
| `fresh_fruit` | lemon, lime, orange, berries, pineapple | no | yes |
| `herb_spice` | mint, basil, rosemary, cinnamon, ginger, pepper | no | yes |
| `water` | still or plain sparkling water with no flavour | no | **no - "it's water"** |

Rules:
1. `isAlcoholic` comes from the category and the label ABV: alcoholic categories are alcoholic unless the ABV read
   from the label is ≤ 0.5 %. Unknown ABV on an alcoholic category counts as alcoholic.
2. Plain water is recognised (`status: water`) but gets no recipes. Flavoured sparkling water is `soda_mixer`.
3. Anything that is not a food/drink ingredient - people, pets, furniture, phones, medicines, supplements, cleaning
   products, cosmetics, tobacco, cannabis, candy and mints, chewing gum, pickles, sauces and snacks - is
   `status: not_ingredient` with a polite message. Never a recipe. Branded mineral or spring water is `water`.
   Cordials and concentrates "to dilute", including zero-sugar ones, are `syrup`; semi-sparkling rosé is `wine`.
4. A blurry, dark or partial photo where nothing can be read is `status: unclear` and suggests the barcode.
5. Coffee and tea are not scan categories in v1 (they belong to posts, not the Smart Bar mixer flow); a cold-brew or
   iced-tea bottle maps to `soda_mixer`, coffee beans to `not_ingredient`. Revisit with the data-curator.
6. Open Food Facts mapping (`server/ai/openFoodFacts.js`): categories tags such as `en:spirits`, `en:wines`,
   `en:beers`, `en:sodas`, `en:juices`, `en:waters`, `en:energy-drinks`, `en:syrups` map to the table above;
   `alcohol_100g` / `nutriments.alcohol` gives the ABV; `quantity` gives the volume. No match → `not_ingredient`.
7. The canonical list lives in `ai-service/app/taxonomy.py` and `server/ai/taxonomy.js`; a server test checks they
   are equal.
