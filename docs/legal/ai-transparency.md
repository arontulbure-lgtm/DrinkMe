DRAFT v0.1 – 2026-11-16 – to be reviewed by a qualified lawyer before publication. Not legal advice.

# How AI works in DrinkMe – AI Transparency Notice

Version 0.1 · Effective date: [to be set at publication] · Matches the in-app AI notice version 1 (`AI_NOTICE_VERSION = 1`) · Operator: Tulbure Aron PFA (DrinkMe), drinkmesocialapp@gmail.com

DrinkMe has two optional AI features: the **drink scanner** and **AI recipes**. This page explains what they do, what they cannot do, and what happens to your data. The Privacy Policy (§5a) is the legal reference for your data; this page is the plain-language guide.

## 1. What the AI does
- **Scanner:** you photograph the label of a bottle, can or carton, or a fresh ingredient (fruit, herb). The AI reads the label and tells you what it is: the type (for example gin, tonic, lime), and where it can, the brand, product, % alcohol and volume, with a confidence score. You check and correct the result before you add it to your Smart Bar or ask for recipes.
- **Barcode:** if the photo is not clear, you can scan the barcode. This is not AI: we look the number up in Open Food Facts, a free open food database.
- **AI recipes:** the AI writes 3 to 5 drink recipes built around the item you scanned, or using only what is in your Smart Bar plus a few basics you choose (for example ice, water, sugar, salt). Every batch includes a non-alcoholic option when your ingredients allow it.

## 2. Which AI we use
- An **open-weights AI model** (currently Qwen3-VL 4B Instruct, published by the Qwen team under the Apache 2.0 licence) together with text recognition (OCR). **We run it ourselves**, on DrinkMe's own AI server. Your photos and ingredients are **not sent to an outside AI company** such as OpenAI or Google.
- DrinkMe's server checks every AI answer before you see it (format, ingredients, and the safety rules in §5). The AI does not learn from you while you use it.
- We may change the model to improve quality. If a change affects your data (for example a different provider), we will update this page and the Privacy Policy and tell you in the app first.

## 3. What the AI cannot do – please read
- **AI can be wrong.** It can misread a label, mix up products, or get the alcohol content or volume wrong. Always check the scan result before you save it.
- **Recipes are suggestions, not tested recipes.** They can contain mistakes in amounts, steps or ingredient names. Use your own judgement.
- **Allergies and intolerances:** the AI does not know your allergies. Check every ingredient (and the labels of the products you use) yourself.
- **Not medical, health or nutrition advice.** The strength shown (% ABV and standard drinks) is an estimate. Do not rely on it to decide whether you can drive, work, take medication or drink safely.
- **The scanner only knows drink ingredients.** It does not recognise people, and it refuses things that are not drink ingredients (for example medicines or cleaning products).

## 4. How AI content is marked
- Every AI recipe and every photo scan result carries the label **"AI-generated"** in the app, and recipes also carry a machine-readable AI marker in the data our server sends to the app (EU AI Act, Regulation (EU) 2024/1689, Art. 50).
- Every recipe shows this disclaimer: *"AI-generated recipe. It can contain mistakes: check every ingredient for allergies and intolerances. Amounts are for one serving."*
- Results found by barcode are labelled "Found by barcode (Open Food Facts)".

## 5. Safety rules and warnings on recipes
Our server removes or labels AI recipes before you see them:
- **Removed:** more than 2 standard drinks per serving; drinking games, shots challenges, binge or "get drunk" language; fire, dry ice or inhaling vapours; medicines, drugs, supplements or non-food ingredients; any mention of driving in an alcoholic recipe; ingredients you do not have (Smart Bar recipes); repeats.
- **Warning – raw egg:** "Contains raw egg: not recommended during pregnancy, for young children, older people or anyone with a weak immune system."
- **Warning – energy drink with alcohol:** "Energy drink with alcohol: caffeine can hide how drunk you are. We do not recommend this mix."
- **Every alcoholic recipe** shows: "Enjoy responsibly. 18+ only. Never drink and drive, and skip alcohol if you are pregnant, on medication or under the legal drinking age."
These rules reduce risk; they cannot remove it. If you see something unsafe, tell us (§7).

## 6. Age: 18+ only
The AI features are only available to signed-in users who confirmed they are 18 or older. Where the legal drinking age in your country is higher, you must also be of that age to use alcoholic recipes (see `age-and-alcohol.md`). Our server also refuses alcoholic recipes to anyone who has not confirmed their age. DrinkMe never sells alcohol.

## 7. Report a wrong, unsafe or offensive AI answer
[TO ADD WHEN LC-39 SHIPS: "Tap **Report** on the recipe or scan result and choose a reason. You stay in the app."]
Until then: write to **drinkmesocialapp@gmail.com** with the recipe name (a screenshot helps) and what is wrong. We use reports to improve our safety rules and remove problems; we answer within [TARGET – decision D-25].

## 8. Your photos and data (summary – full details in the Privacy Policy §5a)
- **Default:** the photo you scan is processed in memory on our server and discarded once you get the answer. It is not stored and not written to our logs.
- **Barcode:** only the barcode number goes to Open Food Facts – no name, account or IP address.
- **Saved recipes:** kept until you remove them or delete your account (up to 200).
- **"Help improve the scanner":** off by default. Only if you turn it on do we keep your scan photos for up to 90 days (text below). Turning it off deletes them.

## 9. In-app texts (drafts – the app must show exactly the final approved wording)

### 9.1 AI notice (shown before the first use; button "I understand")
**Title:** Before you use AI
**Text:**
DrinkMe's scanner and recipes use AI. Your photo goes to DrinkMe's own AI server, where an open-weights model that we run ourselves reads it – no outside AI company receives it. The photo is used only to answer you and is not stored, unless you turn on "Help improve the scanner" in AI settings. If you scan a barcode, only the number is looked up in Open Food Facts.
AI can be wrong: check what the scanner found, and check every recipe ingredient for allergies and intolerances. Recipes are suggestions, not medical or nutrition advice. Alcoholic recipes are for adults 18+: drink responsibly and never drink and drive. Everything the AI creates is marked "AI-generated".
**Links:** Privacy policy · How AI works in DrinkMe (this page)
**Button:** I understand

### 9.2 Photo opt-in – consent text (AI settings; switch off by default)
**Title:** Help improve the scanner
**Text:**
Off unless you turn it on. When it is on, DrinkMe keeps each photo you scan, together with what the scanner recognised, for up to 90 days, only to test and improve how well the scanner recognises drinks. Only the DrinkMe team can see them; they are never shown to other users, sold or used for advertising. Photograph only the product – avoid people, faces and documents. Your camera may add the place where a photo was taken; turn off location tagging if you do not want it kept. You can turn this off at any time: the photos already kept are deleted straight away, and they are also deleted if you delete your account. Using the scanner does not depend on this choice. Details: Privacy policy.
**Switch label (accessibility):** Keep my scan photos to help improve the scanner

*Variant if decision D-24 allows model training:* replace "only to test and improve how well the scanner recognises drinks" with "to test the scanner and to train our own AI model so it recognises drinks better (the photos are never given to anyone else)".

### 9.3 Recipe disclaimer (every recipe)
AI-generated recipe. It can contain mistakes: check every ingredient for allergies and intolerances. Amounts are for one serving. Not medical or nutrition advice.

## 10. Changes and contact
We will update this page when the AI features change and tell you in the app if the change affects your data. Questions: drinkmesocialapp@gmail.com.

---
Facts from the code: `internal/data-inventory.md` §8 (file:line). Legal analysis: `internal/dpia-screening.md` ("EU AI Act classification"). Model licence: Hugging Face model card Qwen/Qwen3-VL-4B-Instruct (Apache-2.0), checked 2026-11-16 – VERIFY the Ollama package. Open points: in-app report (LC-39), consent record (LC-37), EXIF removal (LC-38), links in the AI notice (LC-43).
