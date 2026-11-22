DRAFT v0.3 – 2026-11-22 (full AI DPIA drafted in `dpia-ai.md`; no photo retention, no OpenAI; AI Act dates re-checked; AI scanner and recipes added 2026-11-16) – to be reviewed by a qualified lawyer before publication. Not legal advice.

**Update 2026-11-22:** the short DPIA recommended below is drafted in `dpia-ai.md` (v0.1). John's decisions D-21 to D-24/D-26 remove the opt-in photo store and OpenAI, which lowers criterion 4 for the AI features (no kept photos) – but criterion 8 still applies, so the DPIA stays. Art. 50 AI Act re-checked 2026-11-22: applies from 2 August 2026, not postponed; Commission Art. 50 guidelines adopted 20 July 2026 (VERIFY on EUR-Lex).

# DPIA screening – GDPR Art. 35 (internal)

Sources: GDPR Art. 35(1), (3); EDPB-endorsed WP29 Guidelines on DPIA (WP248 rev.01), nine criteria; ANSPDCP Decision no. 174/2018 (list of operations requiring a DPIA) – **VERIFY current text on dataprotection.ro**. Checked: 2026-11-12 (from knowledge; not re-fetched).

| WP248 criterion | Applies? | Why |
|---|---|---|
| 1. Evaluation or scoring | No | No profiling; "Trending" sorts by cheers only |
| 2. Automated decision with legal or similar effect | Partly | Auto-hide after 3 qualified reporters is automated, temporary, reversible and reviewed by an admin; no suspension is automatic |
| 3. Systematic monitoring | No | No tracking, no location tracking |
| 4. Sensitive or highly personal data | Possibly | Posts show alcohol consumption habits; may allow inferences about health or religion (abstinence). Photos may show third parties. AI: scan photos of a user's bottles and saved alcoholic recipes add to the same consumption picture; opt-in photos may contain EXIF location (LC-38) or people in the background |
| 5. Large scale | Not yet | Beta; reassess at 10,000 MAU or national launch |
| 6. Matching or combining datasets | No | — |
| 7. Vulnerable data subjects | Mitigated | Minors excluded by the 18+ gate (self-declared) |
| 8. Innovative technology | **Yes once AI is switched on** (`AI_PROVIDER=local`) | Vision-language model + OCR on user photos and generative recipes. Mitigated: local open-weights model, no outside AI company, no photo retention by default, server-side safety rules S1–S13 |
| 9. Prevents exercising a right or using a service | No | — |

**Result (2026-11-12, AI off):** 1–2 criteria at most; a full DPIA is **not mandatory now** (WP248: generally two or more criteria). Recommendation: do a short full DPIA before (a) the public launch beyond beta, (b) enabling AI, (c) adding analytics or ads, or (d) adding stronger age assurance (ID or face estimation). Record the decision in `../OPEN_DECISIONS.md` (D-13).

**Re-assessment 2026-11-16 (AI branch `auto/ai-2026-11-16`):** with the AI features switched on, criteria 4 ("possibly") and 8 (yes) both apply, which reaches the WP248 rule of thumb of two criteria. Large scale (5) is still "not yet". **Recommendation: complete a short DPIA for the AI features before `AI_PROVIDER=local` is switched on for users outside the beta test group** (decision D-13, now required in practice rather than optional). Scope of that DPIA: photo flow and opt-in store, GPU host location (D-23), EXIF (LC-38), consent record (LC-37), accuracy and safety of recipes (S1–S13, LC-39), age gate (self-declared). ANSPDCP list (Decision 174/2018) – VERIFY whether any item matches (e.g. large-scale processing with innovative technology) when user numbers grow.

Mitigations already in place: nothing readable without sign-in; private Smart Bar and saves; partner list visible only to partners; audit log without IPs or text; 30-day backup ceiling; in-app deletion; no birth date stored.

## EU AI Act classification of the AI features (Regulation (EU) 2024/1689) – 2026-11-16

**Systems:** (1) bottle/label scanner – vision-language model `qwen3-vl:4b-instruct` + OCR returns a drink-ingredient category, brand, product, ABV and confidence; (2) recipe generator – the same model writes 3–5 drink recipes (text) from the scanned item or the user's Smart Bar. Both run on DrinkMe's own ai-service; the server validates every answer (`data-inventory.md` §8).

**Our role:** DrinkMe develops an AI system on top of a general-purpose AI model published by a third party and puts it into service under its own name → **provider of an AI system** (Art. 3(3)) and also its **deployer** (Art. 3(4)). We are **not** the provider of the general-purpose AI model (the Qwen team is; GPAI model duties in Arts. 53–55 are theirs). We do not modify the model weights (no fine-tuning; since 2026-11-22 no photos are kept, so there is no training data from users – re-check the role if fine-tuning is ever considered).

**Classification**
| Check | Result | Reasoning |
|---|---|---|
| Prohibited practices (Art. 5) | No | No manipulation, exploitation of vulnerabilities, social scoring, biometric identification or categorisation, emotion recognition. Recipes are user-requested suggestions; safety rules drop binge/drinking-game content (S2) |
| High-risk via product safety law (Art. 6(1), Annex I) | No | Not a safety component of a regulated product; not a product under Annex I legislation |
| High-risk via Annex III (Art. 6(2)) | No | None of the Annex III areas: no biometrics, critical infrastructure, education, employment, access to essential services (credit, insurance, benefits), law enforcement, migration, justice or elections. Ingredient recognition and recipe suggestions decide nothing about a person |
| Transparency obligations (Art. 50) | **Yes – limited-risk / transparency tier** | Art. 50(2): the recipe generator generates synthetic **text**, so outputs must be marked in a machine-readable format and be detectable as AI-generated. Art. 50(1): users interact with the AI features, so they must be told they are dealing with AI unless obvious (the AI notice and the "AI-generated" label do this). Art. 50(5): information clear and distinguishable at the latest at the first interaction, accessible. Art. 50(3) (emotion recognition / biometric categorisation) and 50(4) (deep fakes; AI text published to inform the public on matters of public interest) do **not** apply |
| AI literacy (Art. 4) | Applies to us as provider/deployer (from 2 February 2025) – VERIFY whether the Digital Omnibus (Regulation (EU) 2026/1744) changed it into a promotion duty of Member States/Commission | Keep a short internal note on how the model works and its limits (this file, `docs/ai/`), and brief anyone who helps with moderation |
| General-purpose AI model duties (Arts. 53–55) | No (not our model) | Keep the model card and licence with each release |

**How DrinkMe meets Art. 50 (facts from code):** AI notice before first use, accepted and versioned (`AI_NOTICE_VERSION = 1`, `server/server.js:4920`, `:4970-4974`, re-read 2026-11-22); "AI-generated" shown also on recipes streamed one by one (LC-53); "AI-generated" label on every recipe and on photo scan results (`data-inventory.md` §8); disclaimer and warnings on every recipe; machine-readable marker `aiGenerated: true` in every recipe object (recipe-schema v1) and in saved recipes. **Open points:** (a) the marker exists in our API JSON, but text that a user copies or screenshots carries no mark – for short text the Commission's Code of Practice on marking and labelling of AI-generated content is expected to accept metadata/visible labels; VERIFY against the final Code of Practice and the Commission guidelines on Art. 50 before launch (LC-35); (b) scan results are classification, not synthetic content, but they are labelled anyway.

**Dates (checked 2026-11-16; sources below – secondary commentary plus artificialintelligenceact.eu; VERIFY against EUR-Lex, Regulation (EU) 2026/1744):**
- Art. 50 applies from **2 August 2026** (Art. 113 of Regulation (EU) 2024/1689). The Digital Omnibus on AI (Regulation (EU) 2026/1744, in force 27 July 2026, per secondary sources) did **not** postpone Art. 50.
- Grace period: providers of generative systems **already placed on the market before 2 August 2026** have until **2 December 2026** for the Art. 50(2) machine-readable marking. DrinkMe's AI features have not been placed on the market (beta, default off), so they must comply **from launch** – the grace period does not help us.
- High-risk deadlines moved (Annex III to 2 December 2027, Annex I to 2 August 2028) – not relevant to DrinkMe.

Sources: artificialintelligenceact.eu/article/50 (Art. 50 text, application date per Art. 113; fetched 2026-11-16); Gibson Dunn, "EU AI Act Omnibus Agreement – Postponed High-Risk Deadlines and Other Key Changes"; Future of Privacy Forum, "The AI Act Implementation Timeline: What Changes Under the AI Omnibus?"; Cuatrecasas, "Digital Omnibus on AI has been published"; Cloud Security Alliance research note on Art. 50 (2026-07-29) – all searched 2026-11-16.

**Conclusion:** not high-risk; **transparency (limited-risk) obligations under Art. 50 apply from launch**; no conformity assessment, registration or CE marking needed. Re-assess if the AI is ever used to decide about people (e.g. age estimation from photos, moderation decisions about users, personalised alcohol promotions) – age estimation from a face would be biometric and could change the classification and the GDPR analysis.
