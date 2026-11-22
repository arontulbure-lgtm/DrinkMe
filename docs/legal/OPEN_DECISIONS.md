DRAFT v0.2 – 2026-11-22 (D-21 to D-30 added; launch status section) – to be reviewed by a qualified lawyer before publication. Not legal advice.

# Open decisions for John

Each decision lists options and consequences. The drafts use the **recommended** option until you decide.

| ID | Decision | Options and consequences | Recommended |
|---|---|---|---|
| D-01 | Lawyer review | (a) Romanian lawyer reviews the EN master + RO before publication – needed before any document goes live; (b) publish drafts – not acceptable (not legal advice, risk of wrong promises) | (a); record sign-off in `CHANGELOG.md` |
| D-02 | Launch markets and exclusions | (a) Romania only, then EU – simplest, all docs EU-based; (b) worldwide minus excluded list in `age-and-alcohol.md` §3 – needs LC-01, LC-26, addenda review; (c) EU + UK + US – needs D-03, D-05, LC-26 | (a) for public launch; (b) only after LC-01 ships |
| D-03 | UK | (a) Do not offer in the UK at launch; (b) offer: appoint a UK GDPR Art. 27 representative (paid service), complete OSA illegal-content and children's assessments, likely add highly effective age assurance (LC-27) | (a) |
| D-04 | Mainland China | (a) Not offered (PIPL localisation/transfer rules, separate consent); (b) offer – heavy compliance | (a) |
| D-05 | US DMCA designated agent | (a) Register with the US Copyright Office (fee USD 6, renew every 3 years – VERIFY) – keeps the §512 safe harbour; (b) skip – no safe harbour for US copyright claims | (a) if US is offered |
| D-06 | Where to host the legal pages | (a) Simple website (e.g. drinkme domain, GitHub Pages) with stable URLs – needed for stores (privacy URL, deletion URL) and LC-04; (b) in-app only – stores still need public URLs | (a) |
| D-07 | Hosting and database provider and region | (a) EU region (Railway/Render EU, Supabase EU) – simpler transfers; (b) US region – SCCs/DPF and transfer statements | (a) |
| D-08 | Governing law and disputes | (a) Romanian law + consumer carve-out (drafted); (b) for US users, an arbitration clause with class-action waiver – common but complex and unpopular, needs US counsel | (a), no arbitration |
| D-09 | Ban evasion | (a) Keep nothing after deletion (current) – suspended users can return; (b) keep a salted hash of the email of permanently suspended accounts for 12 months, disclosed in the privacy policy, legal basis legitimate interest – needs code and a policy update; (c) device fingerprinting – not recommended (ePrivacy consent) | (b) after lawyer review |
| D-10 | Age assurance strength | (a) Self-declaration with country + neutral year of birth (LC-01/02) – proportionate for an 18+ social app in the EU; (b) store age signals where available (US) (LC-26); (c) third-party age estimation/ID – costly, DPIA needed, only if UK or regulators require | (a) + (b) where available |
| D-11 | Use of user content outside the app (marketing) | (a) Only with separate permission (drafted); (b) broad licence in the Terms – may be unfair to consumers | (a) |
| D-12 | Brand-partner content markets | (a) Show partner alcohol posts only in markets where alcohol advertising on social media is allowed and to users above the local age; (b) show everywhere – risk under e.g. Loi Évin, Nordic and Lithuanian rules | (a) |
| D-13 | DPIA | (a) Short DPIA before public launch / AI / analytics (recommended in `internal/dpia-screening.md`); (b) none until scale. **Update 2026-11-16/22:** with the AI features on, two WP248 criteria apply (innovative technology + possibly sensitive data) – a DPIA is expected (LC-47) | (a), before AI is switched on for users |
| D-14 | Report outcome and statement of reasons in app | (a) Build LC-06/LC-07 before public launch; (b) email-only interim (documented) | (a); (b) for beta |
| D-15 | Contact mailbox | (a) Move from consumer Gmail to a business mailbox with a DPA (Google Workspace or similar) and a domain address; (b) keep Gmail – no DPA | (a) |
| D-16 | Enterprise size check | DSA Art. 19 exemptions depend on staying a micro/small enterprise (< 50 staff and ≤ EUR 10 m turnover/balance) – confirm yearly | Confirm in January |
| D-17 | Registration data | Fill CUI, Trade Register number, VAT status (and optional phone) in `imprint.md`, `terms.md`, `internal/ropa.md` | Fill before publication |
| D-18 | Misleading "Featured venues" card (LC-18) | (a) Remove/mark "coming soon" now; (b) keep – risk under consumer law | (a) |
| D-19 | Liability cap | (a) EUR 100 cap for free service, subject to mandatory law (drafted, VERIFY); (b) no cap | Lawyer decides |
| D-20 | Who reviews reports about the official DrinkMe account (added 2026-11-13) | (a) John reviews them himself and the conflict is disclosed (drafted in `content-moderation.md` §2.6) – no cost, but a user can argue the review is not objective (DSA Art. 14(4)); (b) a second trusted admin (in `ADMIN_USER_IDS`, not the official uid) reviews every `targetOfficial` report – more objective, needs a person and a confidentiality note; (c) reports about the official account go first in the queue and are decided within a shorter target (e.g. 12 h) – reduces the time possibly unlawful brand content stays visible (it is never auto-hidden) | (a) for beta; (b) + (c) before brand-partner posts start |
| D-21 | Retention of opt-in scan photos (AI) | (a) **90 days** (code default `AI_PHOTO_RETENTION_DAYS`, drafted everywhere); (b) 30 days – stronger minimisation; (c) 180 days – harder to justify | (a); any change → env var, consent version, privacy §5a/§7 |
| D-22 | Offer "Help improve the scanner" at AI launch | (a) Hide the switch at first (no photo ever kept; simplest Data safety answers); (b) offer it (consent record and metadata removal are built in PR #4; Data safety "Photos collected"); (c) beta group only | (a) or (c) for the first AI release; the drafts describe (b) so they stay true either way |
| D-23 | GPU host for the AI service | (a) **EU-region provider with a GDPR DPA** (e.g. Hetzner DE/FI, Scaleway/OVH FR); (b) US provider – SCCs/DPF and a transfer note; (c) a machine John controls – no processor, availability risk | (a); fill privacy §5a "Where" and `internal/subprocessors.md`. `docs/store/review-notes.md` option (b) already says "our own server in the EU" – true only with (a) |
| D-24 | Use of opted-in photos | (a) **Evaluation only, no training** (what all drafts and the in-app consent say); (b) also fine-tuning – new consent version, opt-ins reset, policy and Terms change | (a) |
| D-25 | Response target for reports about AI output | (a) 24 h like content reports; (b) 24 h unsafe/offensive, 72 h wrong | (b) |
| D-26 | OpenAI as AI provider or fallback | (a) **Never in production** – remove or gate the legacy routes (LC-41); (b) only with DPA, explicit in-app permission (Apple 5.1.2(i)), AI notice v2 and policy update | (a) |
| D-27 | AI section in the Terms | (a) Section 7a in Terms v1 now, "applies once switched on" – no re-acceptance when AI starts (**drafted 2026-11-22**); (b) add it later with `TERMS_VERSION = 2` | (a) – lawyer to review with D-01 |
| D-28 | "Beta" wording at v1.0.0 (added 2026-11-22) | Terms §2/§11 and the store listing still call DrinkMe a beta. (a) Keep "beta" – honest while features are missing, but sounds odd in a 1.0 store release; (b) replace with "new service, features may change" in Terms, listing and in-app texts together | Decide before the lawyer review; texts must match |
| D-29 | App Check native provider (added 2026-11-22) | (a) Add `@react-native-firebase/app-check` (new dependency, development build) and go monitor → enforce – check store forms (LC-49); (b) stay without App Check at launch (`APP_CHECK_MODE=off`) | Developer decision; legally neutral if disclosed (already drafted as "once switched on") |
| D-30 | Server-side Terms enforcement (N-2, added 2026-11-22) | (a) App step only (built) – old app versions or direct API calls can post without acceptance; (b) server refuses content routes until `termsVersion` is current | (a) at launch; (b) before the first Terms change that users must accept |

## Status of earlier decisions (2026-11-22, launch pass)
- **Blocking launch:** D-01 (lawyer), D-06 (hosting of the legal pages), D-07 (host/DB region + DPAs), D-17 (registration data), D-02/D-03 (launch countries; UK), D-18 (partners/discount card is still shown in Explore – `LocalizationContext.tsx:315`, `:843`).
- **Can follow launch (interim documented):** D-09, D-10/LC-01, D-12 (no brand posts yet), D-14 (email interim), D-15, D-19, D-20.
- **Only before AI is switched on:** D-13, D-21 to D-27.
