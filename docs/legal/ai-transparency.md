DRAFT v0.2 – 2026-11-22 – to be reviewed by a qualified lawyer before publication. Not legal advice.

# How AI works in DrinkMe – AI Transparency Notice

Version 0.2 · Effective date: [to be set at publication] · Matches the in-app AI notice version 1 (`AI_NOTICE_VERSION = 1`, text in §9.1) · Operator: Tulbure Aron PFA (DrinkMe), drinkmesocialapp@gmail.com

*This page applies once the AI features are switched on in the app. While they are off, the app shows a "Coming soon" preview and none of the processing below takes place.*

DrinkMe has two optional AI features: the **drink scanner** and **AI recipes**. This page explains what they do, what they cannot do, and what happens to your data. The Privacy Policy (§5a) is the legal reference for your data and the Terms (§7a) set the rules for using the AI; this page is the plain-language guide.

## 1. What the AI does
- **Scanner:** you photograph the label of a bottle, can or carton, or a fresh ingredient (fruit, herb). The AI reads the label and tells you what it is: the type (for example gin, tonic, lime), and where it can, the brand, product, % alcohol and volume, with a confidence score. You check and correct the result before you add it to your Smart Bar or ask for recipes.
- **Barcode:** if the photo is not clear, you can scan the barcode. This is not AI: we look the number up in Open Food Facts, a free open food database.
- **AI recipes:** the AI writes drink recipes built around the item you scanned, or using only what is in your Smart Bar plus a few basics you choose (for example ice, water, sugar, salt). The recipes appear **one by one** as they are created; our server checks each recipe before it is shown to you (§5). A batch includes a non-alcoholic option when your ingredients allow it.

## 2. Which AI we use
- An **open-weights AI model that we run ourselves**, on DrinkMe's own AI server, together with text recognition (OCR): currently **Qwen3-VL 4B Instruct** for every scan and recipe. We may also switch on **Qwen3-VL 8B Instruct**, a larger model that reads a label a second time when the first model is not sure (currently switched off). Both are published by the Qwen team under the Apache 2.0 licence and run on the same DrinkMe server, so a second reading does not send your photo anywhere else.
- Your photos and ingredients are **never sent to an outside AI company** (such as OpenAI or Google). Our AI server runs in the European Union or the European Economic Area.
- DrinkMe's server checks every AI answer before you see it (format, ingredients, and the safety rules in §5). The AI does not learn from you: your photos, ingredients and reports are not used to train any model.
- We may change the models to improve quality. If a change affects your data (for example a different place of processing), we will update this page and the Privacy Policy and tell you in the app first.

## 3. What the AI cannot do – please read
- **AI can be wrong.** It can misread a label, mix up products, or get the alcohol content or volume wrong. Always check the scan result before you save it.
- **Recipes are suggestions, not tested recipes.** They can contain mistakes in amounts, steps or ingredient names. Use your own judgement.
- **Language mistakes.** AI text can contain spelling, grammar or wording errors – especially in Romanian, where the current model is weaker than in English. If a step is unclear, do not guess with alcohol amounts or unfamiliar ingredients.
- **Allergies and intolerances:** the AI does not know your allergies. Check every ingredient (and the labels of the products you use) yourself.
- **Not medical, health or nutrition advice.** The strength shown (% ABV and standard drinks) is an estimate. Do not rely on it to decide whether you can drive, work, take medication or drink safely.
- **The scanner only knows drink ingredients.** It does not recognise people, and it refuses things that are not drink ingredients (for example medicines or cleaning products).

## 4. How AI content is marked
- Every AI recipe and every photo scan result carries the label **"AI-generated"** in the app – also while recipes are still appearing one by one – and recipes also carry a machine-readable AI marker in the data our server sends to the app (EU AI Act, Regulation (EU) 2024/1689, Art. 50).
- Every recipe shows this disclaimer: *"AI-generated recipe. It can contain mistakes: check every ingredient for allergies and intolerances. Amounts are for one serving. Not medical or nutrition advice."*
- Saved recipes keep the "AI-generated" label.
- Results found by barcode are labelled "Found by barcode (Open Food Facts)".

## 5. Safety rules and warnings on recipes
Our server removes or labels AI recipes before you see them – each recipe on its own, before it appears:
- **Removed:** more than 2 standard drinks per serving; drinking games, shots challenges, binge or "get drunk" language; fire, dry ice or inhaling vapours; medicines, drugs, supplements or non-food ingredients; any mention of driving in an alcoholic recipe; ingredients you do not have (Smart Bar recipes); repeats.
- **Warning – raw egg:** "Contains raw egg: not recommended during pregnancy, for young children, older people or anyone with a weak immune system."
- **Warning – energy drink with alcohol:** "Energy drink with alcohol: caffeine can hide how drunk you are. We do not recommend this mix."
- **Every alcoholic recipe** shows: "Enjoy responsibly. 18+ only. Never drink and drive, and skip alcohol if you are pregnant, on medication or under the legal drinking age."
These rules reduce risk; they cannot remove it. If you see something unsafe, report it (§7).

## 6. Age and limits
- **18+ only.** The AI features are only available to signed-in users who confirmed they are 18 or older. Where the legal drinking age in your country is higher, you must also be of that age to use alcoholic recipes (see `age-and-alcohol.md`). Our server also refuses alcoholic recipes to anyone who has not confirmed their age. DrinkMe never sells alcohol.
- **Daily limits.** Each account can make at most **20 photo scans and 10 recipe batches per day**; there is also a limit per hour and only one AI request can run at a time. Barcode lookups have their own limit. The app tells you when you reach a limit. We may change the limits and will update this page when we do.

## 7. Report a wrong, unsafe or offensive AI answer
Tap **Report** on the recipe or on the scan result and choose a reason: offensive or inappropriate; unsafe or encourages excessive drinking; wrong ingredient, amount or product; something else. You stay in the app.
- **Our targets:** we review reports about **unsafe or offensive** answers within **24 hours**, and reports about **wrong** answers or "something else" within **72 hours**.
- We use reports to fix problems and improve our safety rules. We do not reply to each report individually; if you want an answer, write to **drinkmesocialapp@gmail.com** with the recipe name (a screenshot helps).
- What a report stores: the type of answer (recipe or scan), the reason, the recipe's id and name or the scan's category and status, your user id and the time – no photo. It is kept for about 90 days and deleted earlier if you delete your account (Privacy Policy §7).

## 8. Your photos and data (summary – full details in the Privacy Policy §5a)
- **Photos are never kept.** The photo you scan is processed in memory on our AI server, only to answer you, and deleted as soon as the answer is ready. It is not stored, not written to our logs and not used to train AI. DrinkMe does not offer an option to keep scan photos.
- **Barcode:** only the barcode number goes to Open Food Facts – no name, account or IP address.
- **Saved recipes:** kept until you remove them or delete your account (up to 200).
- **Where:** DrinkMe's servers and our AI server, run for us by a hosting provider in the EU/EEA under a data processing agreement. No outside AI company.

## 9. In-app texts (drafts – the app must show exactly the final approved wording)

### 9.1 AI notice (shown before the first use; button "I understand")
**Title:** Before you use AI
**Text:**
DrinkMe's scanner and recipes use AI. Your photo goes to DrinkMe's own AI server, where an open-weights model that we run ourselves reads it – no outside AI company receives it. The photo is used only to answer you and is deleted right after; it is never stored. If you scan a barcode, only the number is looked up in Open Food Facts.
AI can be wrong: check what the scanner found, and check every recipe ingredient for allergies and intolerances. Recipes are suggestions, not medical or nutrition advice. Alcoholic recipes are for adults 18+: drink responsibly and never drink and drive. Everything the AI creates is marked "AI-generated"[optional: ", and you can report any answer"].
**Links:** Privacy policy · How AI works in DrinkMe (this page)
**Button:** I understand
*This is the text already in the app (`ai.notice.body`, checked 2026-11-22). It matches the launch state. The bracketed ending is an optional improvement; adding it does not need a new `AI_NOTICE_VERSION` (it adds no new data use).*

### 9.2 Photo opt-in – not offered at launch
DrinkMe does not keep scan photos and does **not** offer a "Help improve the scanner" option (decisions D-21 and D-22 of 2026-11-22). The switch is hidden in the app while the server flag `AI_PHOTO_OPT_IN_ENABLED` is off (default). No consent text is in use. Offering an opt-in later needs a new decision by John, an updated DPIA (`internal/dpia-ai.md`), a newly drafted and reviewed consent text with a new consent version, and updates to this page, the Privacy Policy, the store disclosures and the AI notice. (The 2026-11-16 draft consent text is kept only in the history of this file.)

### 9.3 Recipe disclaimer (every recipe)
AI-generated recipe. It can contain mistakes: check every ingredient for allergies and intolerances. Amounts are for one serving. Not medical or nutrition advice.

## 10. Changes and contact
We will update this page when the AI features change and tell you in the app if the change affects your data. Questions: drinkmesocialapp@gmail.com.

---
Facts from the code: `internal/data-inventory.md` §8 (file:line). Legal analysis: `internal/dpia-screening.md` ("EU AI Act classification") and `internal/dpia-ai.md`. Model licences: Hugging Face model cards Qwen/Qwen3-VL-4B-Instruct (checked 2026-11-16) and Qwen/Qwen3-VL-8B-Instruct (Apache-2.0, checked 2026-11-22) – VERIFY that the Ollama packages carry the same licence. AI Act Art. 50 applies from 2 August 2026 (re-checked 2026-11-22; the 2 December 2026 marking grace period covers only systems on the market before 2 August 2026; Commission guidelines on Art. 50 adopted 20 July 2026 – VERIFY on EUR-Lex).
**Launch state (decisions of 2026-11-22):** matches the code re-read on 2026-11-22 (photo opt-in behind `AI_PHOTO_OPT_IN_ENABLED`, off; OpenAI removed; daily limits; recipes streamed one by one after validation; optional second model off by default). Before publication: delete photos kept by beta testers before the flag existed (LC-49), sign the EU/EEA GPU host DPA (LC-45), render the links in the AI notice (LC-43). If the second model is switched on in production, remove "(currently switched off)" in §2 (no new notice version needed: same server, same controller).
