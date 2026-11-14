---
name: legal-compliance
description: DrinkMe legal framework - which laws and store rules apply per market, which documents must exist, their structure, the per-country alcohol age table and the drafting rules. Read before writing or changing any legal text or compliance record.
---

# DrinkMe legal and compliance framework

**Status line for every draft (first line of each document):**
`DRAFT vX.Y – <date> – to be reviewed by a qualified lawyer before publication. Not legal advice.`

## 1. Product facts that drive the legal analysis (verify against the code)
- Social app (user-to-user service): profiles, posts with photos, ratings, comments, cheers, saves, drink partners
  (consented connections), notifications, Smart Bar (private home-bar list), Explore and search.
- Alcohol-related content; 18+ gate enforced on the server; non-alcoholic drinks are first-class.
- Moderation: report (6 reasons), block, auto-hide at 3 distinct reporters pending review, admin removal,
  suspensions (7 days, then permanent), audit log (ids only, 90 days).
- Accounts: email/password, Google, Apple sign-in via Firebase Authentication; account deletion in-app
  (also deletes the Firebase user); backups gone within 30 days.
- AI features exist but are off (`AI_ENABLED=false`); Stories off. If turned on, OpenAI becomes a processor and the
  documents must change before release.
- Operator: Tulbure Aron PFA (Romania). Sole founder. Free app, no in-app purchases, no ads yet; brand partnerships
  (e.g. recipes posted by the official DrinkMe account) planned – these are commercial communications.
- No sales or delivery of alcohol in the app.

## 2. Documents to produce (`docs/legal/`)
User-facing (EN master + RO):
1. `terms.md` – Terms and Conditions: eligibility and age, account, user content licence, prohibited conduct,
   alcohol disclaimer (no encouragement of excessive drinking, no drink-driving), moderation and suspension
   (with statement of reasons and appeal), IP, liability limits (subject to mandatory consumer law), termination,
   changes, governing law Romania + consumer carve-out (consumers keep their home-country protections), disputes
   (EU ODR note, Romanian ANPC/SAL), contact.
2. `privacy-policy.md` – base policy + addenda: `privacy-eu-uk.md` (GDPR/UK GDPR rights, lawful bases per purpose,
   transfers, DPA complaint: ANSPDCP; ICO), `privacy-us.md` (CalOPPA, CCPA/CPRA and other state laws – thresholds
   likely not met, apply as best practice and say so; "Do Not Sell/Share": we don't), `privacy-apac.md`
   (Japan APPI, South Korea PIPA, Singapore PDPA, Australia Privacy Act, India DPDP, Thailand PDPA, Vietnam
   Decree 13/2023), `privacy-other.md` (Brazil LGPD, Canada PIPEDA / Quebec Law 25, Switzerland nFADP).
3. `community-guidelines.md` – plain-language rules incl. alcohol rules (no minors, no pressure to drink, no
   dangerous challenges, no drink-driving, no selling), harassment, illegal content, IP, spam, impersonation
   (the official DrinkMe account is the only one allowed to use the brand).
4. `content-moderation.md` – notice and action, what reporters and affected users are told, statement of reasons,
   internal appeal, timelines, repeat-offender policy, transparency reporting needs (DSA, UK Online Safety Act).
5. `copyright.md` – IP complaints; US DMCA §512 notice/counter-notice (designated agent registration = decision).
6. `age-and-alcohol.md` – minimum age per country (table below), excluded markets, responsible-drinking message,
   brand content rules.
7. `brand-partner-terms.md` – terms for brands whose content the official account publishes (free collaboration,
   licence to use logo/photos/recipes, approval before publication, ad/sponsorship disclosure, alcohol advertising
   rules per market, takedown on request).
8. `imprint.md` – operator identity (EU e-commerce directive / Romanian Law 365/2002), contact, DSA single point of
   contact (Art. 11/12).
9. `account-deletion.md` – public page text for the store "delete account" URL.
10. `device-storage-notice.md` – local storage, push tokens, no tracking (ePrivacy / Romanian Law 506/2004);
    update if analytics or ads are ever added.

Internal (`docs/legal/internal/`):
- `data-inventory.md`, `ropa.md` (GDPR Art. 30), `dpia-screening.md` (Art. 35 – user-generated content incl. photos
  and alcohol consumption; decide whether a full DPIA is needed), `retention-schedule.md` (from code),
  `subprocessors.md` (Google/Firebase, hosting TBD, OpenAI if enabled; transfer mechanism each),
  `dsr-procedure.md` (access, rectification, erasure, portability, objection; 1-month deadline),
  `breach-response.md` (72 h to ANSPDCP; user notice), `law-enforcement-requests.md`,
  `uk-online-safety-assessments.md` (illegal-content and children's-access assessments, if the UK is in scope),
  `store-disclosures.md` (Apple privacy labels, Google Play Data safety form, age ratings, UGC answers).
- `compliance-matrix.md` and `OPEN_DECISIONS.md` at `docs/legal/`.

## 3. Laws and rules per zone (checklist – verify current status with web search)
- **Romania/EU/EEA:** GDPR; Romanian Law 190/2018; ePrivacy / Law 506/2004; Digital Services Act (online platform:
  Art. 11–12 contact points, 14 terms, 16 notice and action, 17 statement of reasons, 20–21 complaints and
  out-of-court settlement – check micro/small-enterprise exemptions in Art. 19 and 29); Unfair Contract Terms
  Directive and consumer law; P2B not applicable unless business users; European Accessibility Act (check
  microenterprise exemption); Romanian alcohol advertising rules (Law 148/2000) and audiovisual/influencer guidance
  for brand posts.
- **UK:** UK GDPR + DPA 2018 (UK representative under Art. 27 if offering to UK users), ICO; Online Safety Act 2023
  (user-to-user service duties); Age Appropriate Design Code (we exclude under-18s – document how).
- **US:** no federal privacy law; CalOPPA (posted policy), CCPA/CPRA and other state laws (thresholds), COPPA (we
  exclude under-13 and under-21 for alcohol content), Section 230, DMCA §512, FTC Endorsement Guides for brand
  content, state alcohol advertising self-regulation codes. **Minimum age 21.**
- **Asia-Pacific:** Japan APPI (cross-border transfer disclosures; age 20), South Korea PIPA (separate consents,
  age 19), Singapore PDPA (age 18), Australia Privacy Act (age 18), India DPDP Act 2023 (age varies by state –
  consider 21 or exclusion), Thailand PDPA (age 20), Vietnam Decree 13/2023, China PIPL (recommend: do not offer in
  mainland China – decision).
- **Other:** Brazil LGPD (age 18), Canada PIPEDA / Quebec Law 25 (age 18–19 by province), Switzerland nFADP.
- **App stores:** Apple App Review Guidelines 1.2 (UGC: filter, report, block, contact info), 1.4.3 / alcohol
  rules, 5.1.1(v) in-app account deletion, 4.8 Sign in with Apple, privacy nutrition labels, 18+ rating, restrict
  distribution where alcohol content is illegal; Google Play UGC policy, Data safety form, account-deletion URL,
  alcohol/age-restricted content policy, target audience 18+.
- **Markets to exclude from store distribution (decision):** countries where alcohol is prohibited or alcohol
  content is restricted (e.g. Saudi Arabia, Kuwait, Iran, Libya, Sudan, and others – build the list with sources).

## 4. Minimum age table (starting point – VERIFY each with a current source)
Default 18. US 21. Japan 20. Thailand 20. South Korea 19. Canada: 19 in most provinces, 18 in AB, MB, QC.
India: state-dependent (18–25) → treat as 21 or exclude. Iceland 20. Countries with prohibition → excluded.
The app currently enforces one 18+ gate: a per-country minimum age is a **code gap** for the matrix.

## 5. Drafting rules
- Plain language first, legal precision second; short sections; no hidden clauses.
- Never claim the app does something it does not do; never promise a deadline the code cannot meet.
- Consumer-friendly: no waiver of mandatory rights; governing law Romania without removing protections of the
  user's country of residence.
- Name every processor and transfer mechanism; give real retention periods from the code.
- Keep the in-app privacy notice and the published policy consistent; when the policy changes materially, the app
  must ask for acceptance again (bump `PRIVACY_NOTICE_VERSION`).
