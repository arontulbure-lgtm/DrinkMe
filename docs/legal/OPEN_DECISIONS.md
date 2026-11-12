DRAFT v0.1 – 2026-11-12 – to be reviewed by a qualified lawyer before publication. Not legal advice.

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
| D-13 | DPIA | (a) Short DPIA before public launch / AI / analytics (recommended in `internal/dpia-screening.md`); (b) none until scale | (a) |
| D-14 | Report outcome and statement of reasons in app | (a) Build LC-06/LC-07 before public launch; (b) email-only interim (documented) | (a); (b) for beta |
| D-15 | Contact mailbox | (a) Move from consumer Gmail to a business mailbox with a DPA (Google Workspace or similar) and a domain address; (b) keep Gmail – no DPA | (a) |
| D-16 | Enterprise size check | DSA Art. 19 exemptions depend on staying a micro/small enterprise (< 50 staff and ≤ EUR 10 m turnover/balance) – confirm yearly | Confirm in January |
| D-17 | Registration data | Fill CUI, Trade Register number, VAT status (and optional phone) in `imprint.md`, `terms.md`, `internal/ropa.md` | Fill before publication |
| D-18 | Misleading "Featured venues" card (LC-18) | (a) Remove/mark "coming soon" now; (b) keep – risk under consumer law | (a) |
| D-19 | Liability cap | (a) EUR 100 cap for free service, subject to mandatory law (drafted, VERIFY); (b) no cap | Lawyer decides |
| D-20 | Who reviews reports about the official DrinkMe account (added 2026-11-13) | (a) John reviews them himself and the conflict is disclosed (drafted in `content-moderation.md` §2.6) – no cost, but a user can argue the review is not objective (DSA Art. 14(4)); (b) a second trusted admin (in `ADMIN_USER_IDS`, not the official uid) reviews every `targetOfficial` report – more objective, needs a person and a confidentiality note; (c) reports about the official account go first in the queue and are decided within a shorter target (e.g. 12 h) – reduces the time possibly unlawful brand content stays visible (it is never auto-hidden) | (a) for beta; (b) + (c) before brand-partner posts start |
