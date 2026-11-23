DRAFT v0.1 – 2026-11-22 – to be reviewed by a qualified lawyer before publication. Not legal advice.

# Data protection impact assessment – AI scanner and AI recipes (GDPR Art. 35) (internal)

Controller: Tulbure Aron PFA (DrinkMe), B-dul Bucureștii Noi 136, Parter, Ap. 5, Sector 1, Bucharest, Romania. CUI `[TO FILL BY JOHN]`. Contact: drinkmesocialapp@gmail.com. DPO: none (Art. 37 conditions not met – VERIFY at scale).
Prepared by: legal-compliance agent (not a lawyer), 2026-11-22. **Approval: John `[date, signature]` after lawyer review (D-01).** Review again: before any of the triggers in §8, and at least every 12 months.
Why a DPIA: screening (`dpia-screening.md`) found two WP248 criteria once AI is on – innovative technology (8) and possibly highly personal data (4) – so a DPIA is expected (WP248 rev.01; decision D-13, LC-47). Structure follows Art. 35(7)(a)–(d).
Facts: `data-inventory.md` §8 (file:line, code re-read 2026-11-22). Decisions: `../OPEN_DECISIONS.md` D-21 to D-27 (2026-11-22).

## 1. Systematic description of the processing (Art. 35(7)(a))

### 1.1 Nature, scope, context, purposes
| Item | Description |
|---|---|
| Features | (1) **Scanner:** the user photographs a drink label or fresh ingredient → our own ai-service (OCR + vision-language model) returns category, brand, product, % ABV, volume, confidence; the user confirms or corrects. (2) **Barcode fallback** (not AI): EAN looked up in Open Food Facts. (3) **AI recipes:** drink recipes generated from the confirmed item or the user's Smart Bar plus basics, validated by the server (schema + safety rules S1–S13) and **streamed one by one**. (4) **Saved recipes** (max 200). (5) **Report** of an AI answer. |
| Purposes | Help adult users identify ingredients and get drink ideas (service under the Terms §7a); keep the AI safe and available (limits, safety checks, reports) |
| Data subjects | Signed-in users who confirmed 18+ and accepted the AI notice; incidentally people or objects visible in a photo (bystanders) |
| Personal data | Scan photo (in memory only); language; confirmed item; Smart Bar item names; basics; saved recipes; AI notice version + time; daily-limit events (uid, kind, time); hourly counters; AI reports (kind, reason, recipe id/name or scan category/status, uid, time) |
| Special categories (Art. 9) | Not intended. Possible incidental: a photo could show a face, medicine or religious item; alcohol preferences may allow inferences about health or religion. Not processed for those purposes; the scanner refuses non-ingredients and does not identify people |
| Scale | Beta: tens of users. Planned: 5k–10k MAU in Romania (CLAUDE.md roadmap). Not large-scale yet – re-assess at 10,000 MAU |
| Technology | Open-weights model `qwen3-vl:4b-instruct` (Apache-2.0) via Ollama + RapidOCR; optional second pass `qwen3-vl:8b-instruct` on the same host, **off by default**; Express server validates every answer |
| Recipients | None outside DrinkMe for photos/ingredients except the **EU/EEA GPU host** as processor (D-23); Open Food Facts receives only the EAN (no personal data). **No outside AI company** (OpenAI removed, D-24/D-26) |
| Retention | Photo: request only (D-21). Saved recipes, basics, notice: account lifetime. Daily-limit events 24 h. AI reports 90 days, deleted with the account. Recipe-session names 2 h in memory. Backups ≤ 30 days |
| Opt-in photo keeping | **Not offered** (D-22). Code exists behind `AI_PHOTO_OPT_IN_ENABLED`, off; enabling it is out of scope of this DPIA and needs a new one |

### 1.2 Data flow
```
Phone --HTTPS + JWT--> Express server (EU host) --private network + token--> ai-service + Ollama (EU/EEA GPU host)
  photo (base64, memory)        validate image, 18+, AI notice,                 OCR + model in RAM, nothing on disk,
                                 daily/hourly limit, one at a time               access log: method/path/status only
                         <-- validated scan result / recipes streamed one by one (each checked S1-S13) --
Express --EAN only--> Open Food Facts (France)          Express --> db.json: saved recipes, basics, notice, limit events, AI reports (audit)
```

## 2. Necessity and proportionality (Art. 35(7)(b))
| Principle | Assessment |
|---|---|
| Lawfulness (Art. 6) | Scanner, barcode, recipes, saved recipes, settings: Art. 6(1)(b) – the user asks for the feature. Limits, safety checks, reports: Art. 6(1)(f) – legitimate interest in a safe, fair service and compliance with store and AI-transparency rules; balancing: low intrusion (counters and short report records, no content), expected by users, disclosed. No consent-based processing at launch |
| Purpose limitation | Photos are used only to answer the request; never for training, analytics or advertising; reports only to review and improve safety rules |
| Data minimisation | Photo not stored, not logged; OCR text not logged; barcode lookup sends the number only; reports hold no photo and no free text; daily usage stored as bare events |
| Accuracy | AI can be wrong: the user confirms/corrects the scan before saving; recipes are labelled as untested suggestions; ABV/standard drinks recomputed by the server; known weakness: Romanian wording (disclosed) |
| Storage limitation | See retention above; nothing persistent from the scan itself |
| Necessity of the technology | A vision model is needed to read labels from photos; a local open-weights model avoids sending photos to a third-party AI company; the barcode path offers a non-AI alternative; manual Smart Bar entry offers a no-AI alternative |
| Transparency (Arts. 12–14) | Just-in-time AI notice (`AI_NOTICE_VERSION = 1`) before first use; privacy policy §5a; AI transparency notice; Terms §7a. Gap: notice does not render the links yet (LC-43) |
| Data subject rights | Access/erasure via in-app deletion (cascade includes saved recipes, settings, AI reports) and email; portability export planned (LC-14) |
| Processors (Art. 28) | GPU host in the EU/EEA with a DPA (D-23) – **not contracted yet (LC-45)** |
| International transfers | None for the AI features (EU/EEA host; Open Food Facts in France receives no personal data) |
| Automated decisions (Art. 22) | None – suggestions only; daily limits pause the feature, they decide nothing with legal or similar effect |

## 3. Risks to the rights and freedoms of data subjects (Art. 35(7)(c))
Likelihood × severity before measures (L = low, M = medium, H = high).
| # | Risk | Source | Likelihood | Severity | Inherent |
|---|---|---|---|---|---|
| R1 | Photo shows a person, a document or a home interior; it is retained or leaks | User photographs more than the label | M | M | M |
| R2 | Photo or OCR text written to logs or disk (debug settings, crash dumps, Ollama logs) | Misconfiguration on the GPU host | L | H | M |
| R3 | Unauthorised access to the ai-service or the GPU host (photos in transit/RAM) | Exposed port, weak token, host compromise | L | H | M |
| R4 | Transfer outside the EEA / processor uses data for itself | Wrong provider choice | L (after D-23) | H | M |
| R5 | Inaccurate scan or recipe causes harm (wrong ABV, allergen, raw egg, energy drink + alcohol, excessive strength) | Model error, language errors in Romanian | M | H | **H** |
| R6 | AI output encourages excessive or underage drinking, or is offensive | Prompt injection via Smart Bar names/basics, model behaviour | M | H | **H** |
| R7 | Minors use the AI (alcoholic recipes) | Self-declared age gate | M | H | **H** |
| R8 | Profiling of alcohol habits (saved recipes, Smart Bar) used beyond the service or exposed | Future product/monetisation, breach | L | M | L–M |
| R9 | Users are not aware they deal with AI / AI text is taken as advice | Missing labels | L | M | L |
| R10 | Photos kept by beta testers under the former opt-in remain after launch | Files created before the flag existed | M (until cleaned) | M | M |
| R11 | Re-introduction of an outside AI provider without notice | Future code change | L | H | M |

## 4. Measures to address the risks (Art. 35(7)(d))
| Risk | Measures in place (code 2026-11-22 unless stated) | Still to do |
|---|---|---|
| R1 | Photo in memory only, never stored (D-21, `server/server.js:5143` flag off); scanner refuses non-ingredients and does not identify people; notice and policy ask users to photograph only the product; Terms §7a forbid photographing people/documents | – |
| R2 | No request-body logging in Express; ai-service access log only method/path/status, uvicorn access log off; nothing written to disk | Production checklist: never `OLLAMA_DEBUG`, no core dumps, no swap to unencrypted disk; verify Ollama logs on the host (LC-36) |
| R3 | Token 32+ chars and loopback/https required in production (`server/server.js:511-520`); ai-service refuses non-loopback without token; private network/WireGuard plan (`docs/ai/PRODUCTION_PLAN.md`) | Firewall the ai-service port; disk encryption on the GPU host |
| R4 | D-23: EU/EEA host only, DPA | **Sign the DPA, record the provider (LC-45)** before AI is offered beyond beta |
| R5 | User confirms the scan; disclaimers on every recipe; server recomputes ABV/standard drinks; warnings (raw egg, energy + alcohol); max 2 standard drinks (S1); language-error warning; in-app report with 24 h/72 h targets (D-25) | Admin review routine (LC-54); keep `docs/ai/EVAL_REPORT.md` and red-team set current |
| R6 | Safety rules S1–S13 on every recipe before it is streamed; user text only in the user message (never system prompt); report button; one request at a time; daily and hourly limits | Use reports to extend S1–S13 |
| R7 | Server-side 18+ gate; mocktails only without confirmation; AI notice | Per-country age and neutral age screen (LC-01, LC-02) |
| R8 | Saved recipes and Smart Bar private; no ads/analytics; deletion cascade | Any future aggregate use needs a new assessment (CLAUDE.md exit plan mentions data as an asset – only anonymised/aggregated, never photos) |
| R9 | "AI-generated" label on every recipe and scan result, machine-readable marker; notice before first use (AI Act Art. 50) | Check against the final Code of Practice on marking/labelling (LC-35) |
| R10 | Opt-in can no longer be switched on; ignored while the flag is off | **Delete all files in `AI_PHOTO_DIR` and clear `aiPhotoOptIn*` before launch (LC-49)** |
| R11 | Provider layer accepts only `local`; OpenAI code and dependency removed | Any change: new decision, DPIA update, new notice version (LC-50) |

## 5. Residual risk
After the measures above (and the "still to do" items for R3, R4, R10): R1, R2, R3, R4, R8, R9, R10, R11 → **low**. R5, R6, R7 → **medium** (inherent to AI suggestions about alcohol and to self-declared age; mitigated by disclaimers, safety rules, reports and the age gate, accepted as proportionate for an optional feature for adults). **No residual high risk identified.**

## 6. Consultation
- **DPO:** none appointed (Art. 37 not met) – not applicable; John signs as controller.
- **Supervisory authority (Art. 36, ANSPDCP):** **not required** – prior consultation is needed only where a high residual risk remains after measures; none does. Re-check if the residual assessment changes (e.g. opt-in photo keeping, face/age estimation, large scale). VERIFY ANSPDCP Decision 174/2018 list when user numbers grow.
- **Data subjects' views (Art. 35(9)):** optional; beta testers' feedback and AI reports serve as input.

## 7. EU AI Act (Regulation (EU) 2024/1689) – link with this DPIA
Classification (details `dpia-screening.md`): not prohibited (Art. 5), not high-risk (no Annex I/III use), **limited-risk transparency duties under Art. 50**: users told before first use that they deal with AI (Art. 50(1)); generated recipe text marked in a machine-readable way and labelled "AI-generated" (Art. 50(2)); information clear at the first interaction (Art. 50(5)). Art. 50 applies from **2 August 2026**, not postponed by the Digital Omnibus; the 2 December 2026 marking grace period covers only systems on the market before 2 August 2026, so DrinkMe complies from launch (checked 2026-11-22 via Morgan Lewis, Jones Walker, Reed Smith commentary; Commission Art. 50 guidelines adopted 20 July 2026 – VERIFY on EUR-Lex). AI literacy (Art. 4): keep `docs/ai/` notes and brief moderators.

## 8. Triggers for a new DPIA
Turning on `AI_PHOTO_OPT_IN_ENABLED`; any outside AI provider; fine-tuning on user data; face or age estimation; using AI to decide about users (moderation, eligibility); moving the GPU host outside the EU/EEA; 10,000+ MAU; personalised alcohol promotion.

## 9. Sign-off
| Role | Name | Date | Decision |
|---|---|---|---|
| Controller | John (Tulbure Aron PFA) | `[ ]` | `[approve / approve with conditions]` |
| Lawyer review (D-01) | `[ ]` | `[ ]` | `[ ]` |
