---
name: recipe-schema
description: The JSON schema of an AI-generated DrinkMe recipe (v1) and the safety rules every generated recipe must pass on the server before a user sees it. Use when generating, validating, storing, rendering or testing recipes, and in every review of recipe code or prompts.
---

# Recipe schema v1

```json
{
  "id": "r_<16 hex>",               // server-assigned: hash of normalised name + ingredients
  "name": "string, 1-80",
  "description": "string, 0-300",
  "ingredients": [
    { "name": "string 1-80", "amount": 0.1-1000, "unit": "ml" | "g" | "piece", "abv": 0-100, "optional": false }
  ],                                 // 1-12 items
  "steps": ["string 1-300"],        // 1-10 items
  "glass": "string 1-60",
  "garnish": "string 1-80 | null",
  "method": "build" | "stir" | "shake" | "blend" | "muddle",
  "estimatedAbv": 0-40,              // server recomputes; the model's value is ignored when they differ
  "standardDrinks": 0-2,             // server-computed, 10 g ethanol per standard drink
  "isAlcoholic": true | false,
  "tags": ["string 1-30"],          // 0-6
  "language": "en" | "ro",
  "aiGenerated": true,
  "youWillAlsoNeed": ["string"],    // scan mode only: ingredients other than the scanned item and basics
  "warnings": ["raw_egg" | "energy_alcohol"],
  "responsibleNote": "string | null" // server-added on alcoholic recipes, in the recipe language
}
```
- Units are only ml, g or piece. Dashes are ml (1 dash ≈ 1 ml). Ice is not counted in volume.
- `abv` is per ingredient. The server raises an `abv` the model set too low for a known alcoholic category
  (spirit 40, liqueur 25, vermouth/aperitif 16, wine 12, sparkling 12, beer 5, cider 5, bitters 40) - the model is not trusted.
- Standard drinks = Σ(ml × abv/100 × 0.789 g/ml) / 10 g. `estimatedAbv` = ethanol ml / total liquid ml × 100 (dilution ignored).
- `isAlcoholic` = standardDrinks > 0. A recipe marked non-alcoholic that names an alcoholic drink is dropped.

## Safety rules (server/ai/recipeSafety.js; validated after every generation)
| # | Rule | Action |
|---|---|---|
| S1 | More than 2.0 standard drinks per serving | drop |
| S2 | Shots challenge, drinking game, binge or intoxication framing ("chug", "down it", "get drunk", "drinking game", "beer pong", "shotgun", RO equivalents) | drop |
| S3 | Flaming, fire, torch, dry ice, smoke inhalation, vapour, aerosol | drop |
| S4 | Raw egg (egg white, yolk, whole egg; RO ou, albuș, gălbenuș) | keep, add warning `raw_egg` |
| S5 | Energy drink together with alcohol | keep, add warning `energy_alcohol` |
| S6 | Medicine, drug, supplement or non-food ingredient (cough syrup, paracetamol, cannabis, bleach, rubbing alcohol, hand sanitizer, ...) | drop |
| S7 | Alcoholic recipe | add `responsibleNote` (localised) |
| S8 | Any mention of driving on an alcoholic recipe | drop |
| S9 | Schema invalid (any field) | drop |
| S10 | Smart Bar mode: an ingredient or garnish not in the user's Smart Bar or basics | drop |
| S11 | Scan mode: the scanned item is not an ingredient | drop |
| S12 | Same normalised name already shown in this generation session | drop |
| S13 | Under-18 or `mocktailsOnly`: any alcoholic recipe | drop |

If fewer than 3 recipes survive, the server regenerates once with the dropped names excluded. If still none: 502
`ai_invalid_output`. If the batch has no mocktail and the input allows one (any non-alcoholic, non-water ingredient
or scan mode), the server asks once for a single mocktail and appends it.

Each rule has a red-team prompt in `ai-service/eval/redteam.jsonl` and a unit test in `server/test/ai-safety.test.js`.
