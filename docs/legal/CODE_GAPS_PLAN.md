# Legal code gaps: build plan (not built yet)

Planner output of 2026-11-12, from `compliance-matrix.md` (LC rows) and `OPEN_DECISIONS.md` (D-xx). Nothing here is implemented. N-xx are new decisions raised by the planner. File:line references were correct on 2026-11-12 and will drift.

## Ground facts (checked in code)
- One 18+ rule: `isAgeConfirmed` only checks `ageConfirmedAt` (server.js ~1995); acknowledgement route ~2948 accepts only `{type:'age', confirmed:true}`.
- `PRIVACY_NOTICE_VERSION = 2` (server.js ~2164, OnboardingScreen.tsx:20), still unreleased.
- Report reasons at server.js ~3965; resolve ~4196; suspend ~4287. `pruneResolvedReporters` runs only at load and on resolve.
- Production morgan format `combined` (server.js ~244) logs IP and user agent.
- `expo-web-browser` and `expo-constants` installed; `expo-localization`, `expo-file-system`, `expo-sharing`, `expo-image-manipulator` are not. The plan assumes no new dependencies.
- Test churn for any stricter age check: 43 calls in 19 files post the age acknowledgement; 27 files seed `ageConfirmedAt`.
- Explore shows a "partners offer discounts to beta testers" card that no code backs (ExploreScreen.tsx ~375-381).

## Tasks
| ID | Rows | What | Side | Size | Blocked by (default) |
|---|---|---|---|---|---|
| T-01 | LC-04, LC-05 | `src/config/legal.ts` (`getLegalUrl(doc, locale)`, base URL from `EXPO_PUBLIC_LEGAL_BASE_URL` via app.config extra, one `CONTACT_EMAIL`), `LegalLinks` component (expo-web-browser; mailto with fallback), "Legal & help" section in EditProfile (Terms, Privacy, Guidelines, Moderation, Imprint, Responsible drinking, Contact). Rows hidden without a base URL except Contact. | client | S | D-06 (static site `<base>/{en,ro}/<doc>`) |
| T-02 | LC-04, LC-05, LC-23 | Links on AuthScreen ("By continuing you agree to the Terms…"), Onboarding notice (full policy), AgeGate and SessionError screens. Check the Google PKCE flow after visiting a link. | client | S | D-06 |
| T-03 | LC-18 | Remove the misleading partners/discount card; give the first Explore section its own title. | client | S | D-18 (remove) |
| T-04 | LC-31 | "Powered by Google" under Places results; replace Google's raw `error_message` with `t('location.loadError')`. | client | S | asset file; VERIFY Google terms |
| T-05 | LC-15 | Production log format without IP/UA/referrer; README + retention schedule. | server | S | none |
| T-06 | LC-03 | `TERMS_VERSION = 1`; acknowledgement `{type:'terms', version}` with the privacy rules; `termsVersion`/`termsAcceptedAt`; `ack.terms_accepted` (self action). | server | S | N-2 (client step only) |
| T-07 | LC-03, LC-04 | Terms step in Onboarding after the privacy notice (summary bullets, links, "I agree"); AppNavigator re-asks on a version bump. | client | S | D-01 (text reviewed before release) |
| T-08 | LC-01 | `server/age-rules.js` (`AGE_RULES_VERSION`, `MIN_AGE_BY_COUNTRY`, `EXCLUDED_COUNTRIES`, ISO list) + client mirror `src/lib/ageRules.ts`, static `countries.ts` (Hermes lacks `Intl.DisplayNames`), parity test. | both | M | D-02/03/04 (excluded set), N-11 (new files) |
| T-09 | LC-01, LC-28 | Age acknowledgement takes `country` + `rulesVersion`; excluded → 403 `country_not_available`; stores `ageCountry`, `ageMinAge`, `ageRuleVersion`; `isAgeConfirmed` also requires a country and `ageMinAge >= minAgeFor(country)`, so a table change re-gates exactly the affected users; legacy users without a country are re-gated; never store a birth date; shared test fixture `adult({country})`. | server | L | N-1 (re-gate), after the official-account merge |
| T-10 | LC-01, LC-02 | Neutral AgeGate: country list (prefill from device locale region, user confirms), neutral year of birth (month/day only in the boundary year; KR by year), computed on device; under-age → device lock 24 h, nothing sent; excluded → not-available screen; remove `promptConfirmAge`. | client | L | N-3 (device lock), D-10 |
| T-11 | LC-23 | Notice sentence on the stored country; bump `PRIVACY_NOTICE_VERSION` to 3 in the release that ships T-09 (server first). | both | S | N-4 |
| T-12 | LC-01 | Change country later from EditProfile (re-uses T-10 steps). | client | M | N-3; can wait if Romania-only |
| T-13 | LC-11 | `commercialPartner: {name, kind: paid\|gifted}` on posts, official users only (403 otherwise), shown in every view and in admin report targets. | server | M | official account |
| T-14 | LC-11 | "Paid partnership with X" / "Collaboration with X" label (ro/en, accessible) on cards and detail; fields in CreatePost for official users. | client | S | T-13; wording VERIFY |
| T-15 | LC-13 | Hide alcoholic brand posts (404) from viewers in `ALCOHOL_AD_RESTRICTED_COUNTRIES`, in `canViewDrink` (covers media). | server | M | D-12 (FR, NO, FI, LT, SE + excluded) |
| T-16 | LC-09 | Report reasons `illegal_content`, `intellectual_property` with required details (10-300 chars) and an accuracy confirmation (DSA 16(2)(d)); second step in ReportSheet. | both | M | none |
| T-17 | LC-06 | Statement of reasons: `ruleCode` on resolve/suspend, `moderation_decision` notification to the affected user (kept 180 days, own cap 50, survives full storage), `suspensionRuleCode` for the owner. | server | M | D-14, N-7, N-13 |
| T-18 | LC-07 | `report_outcome` notification to each live reporter at resolve (no target name). | server | S | D-14 |
| T-19 | LC-06/07/08 | Client texts for decisions and outcomes, full statement sheet, "Ask for a review" mailto, banner rule label. | client | M | T-17, T-18, D-15 |
| T-20 | LC-16 | Delete resolved reports after 12 months (load, resolve and the daily timer). | server | S | N-6 |
| T-21 | LC-17 | **Done 2026-11-23** (server side): pure-JS strip for JPEG/PNG/WebP at upload (`server/imageMetadata.js`), HEIC with metadata refused. No migration: production starts empty. Device check still to do. | both | M/L | N-8 |
| T-22 | LC-14 | `GET /api/users/:id/export` (owner, adult gate, allowed while suspended, 3 per 24 h, own data only, uid masked in logs). | server | M | N-12 |
| T-23 | LC-14 | "Download my data" via the Share sheet (500 KB cap, email fallback). | client | S | T-22, N-5 |
| T-24 | LC-20 | Log a count of reports past 24 h daily; warn when `ADMIN_USER_IDS` is empty with reports open. | server | S | none |
| T-25 | LC-19 | Short ro/en objectionable-word filter (normalised, whole words) → 400 `content_not_allowed`; never logged. | both | M | N-9 |
| T-26 | new LC-34 | Admin "close under-age account" (deletion cascade + Firebase delete, audited). | server | M (irreversible) | N-10 |

LC-12/LC-33 (look-alike brand names: NFKC, diacritics, separators, Cyrillic/Greek and digit look-alikes, also on Google/Apple display names at sign-in; official content still reported, queued and given statements of reasons) belong to the official-account task.

Not code here: LC-10, LC-20 routine, LC-21 (D-09), LC-22, LC-26 (needs native modules), LC-27 (follows D-03), LC-28 store settings, LC-29, LC-30, LC-32, LC-24 (docs after the reset change).

## Status (2026-11-16)
| Task | Status | Waiting on |
|---|---|---|
| T-01 legal links + contact | done (0c858f9): hidden until `EXPO_PUBLIC_LEGAL_BASE_URL` is set | D-06 (hosting) to switch on; pages ready in `docs/public` |
| T-02 links on sign-in and notice | done (0c858f9) | D-06 |
| T-03 remove the partners/discount card | not done | D-18 (default "remove" not confirmed) |
| T-04 Powered by Google, no raw Google errors | done (ffa9b89); coordinates no longer requested (d25b861) | VERIFY Google attribution rules for a text-only notice |
| T-05 logs without IP/UA | done (325e0ee) | — |
| T-06 terms acceptance on the server | done (f4c06ba) | — |
| T-07 Terms step in the app | done behind `EXPO_PUBLIC_TERMS_STEP_ENABLED` (off) | D-01 (lawyer reviews the Terms), D-06 |
| T-08 … T-12 per-country age gate | not started | D-02/03/04 (excluded countries, Qatar), N-1 (re-gate), N-3 (under-age answer), D-10 |
| T-13 … T-15 brand labels and markets | not started | official account live (done), D-12; wording VERIFY |
| T-16 … T-19 DSA reasons, statements, outcomes | not started | D-14, D-15, N-7, N-13 |
| T-20 … T-26 retention, EXIF, export, filter, under-age closure | not started | N-5, N-6, N-8, N-9, N-10, N-12 |

## Order
- **Phase 0 (now):** T-03, T-01, T-02, T-04, T-05.
- **Phase 1:** T-06 → T-07; T-08 → T-09 → T-10 → T-11 in one release (server first); T-12 optional.
- **Phase 2 (after the official account):** T-13 → T-14 → T-15. No brand post before T-14.
- **Phase 3:** T-16 → T-17 → T-18 → T-19.
- **Phase 4:** T-20, T-24, T-21, T-22 → T-23, T-25, T-26.
- Every task: developer → code-reviewer + test-engineer + security-reviewer (server) + legal-compliance → docs-writer.

## Decisions for John first
| ID | Decision | Default assumed |
|---|---|---|
| D-06 | Where the legal pages are hosted | Static site, `EXPO_PUBLIC_LEGAL_BASE_URL` |
| D-02/03/04 | Excluded countries (Qatar is both "21" and "excluded" in age-and-alcohol.md) | §3 list + CN + IN + GB; Qatar excluded |
| D-12 | Markets where brand alcohol posts are hidden | FR, NO, FI, LT, SE + excluded |
| D-14 | When to build statements of reasons / reporter outcomes | Before public launch; email in beta |
| D-15 | Contact address | Gmail now, one constant |
| D-18 | Explore partners card | Remove |
| D-10 | Age-check strength | Self-declared country + neutral year of birth |
| N-1 | Existing 18+ users | Re-gate everyone |
| N-2 | Server refuses posting until terms accepted? | No, client step only |
| N-3 | Under-age answer | Device-only 24 h lock, nothing sent |
| N-4 | Notice version | Link only now; v3 with the country release |
| N-5 | Export delivery | Share sheet (no new dependency) |
| N-6 | Resolved-report retention | 12 months |
| N-7 | Moderation notices | 180 days, cap 50 |
| N-8 | HEIC uploads | Refuse if the app never sends them |
| N-9 | Content-filter list | Short list from John/legal |
| N-10 | Admin close under-age account | Build it |
| N-11 | Age table in new files | Yes |
| N-12 | Export before 18+ or with admin details | No / no |
| N-13 | Keep the removed post's name in the statement for 180 days | Yes |

Other open points: does a brand-post label need a fixed responsible-drinking line (Law 148/2000)? May ordinary users mark their own posts as paid/gifted (default: official only)?
