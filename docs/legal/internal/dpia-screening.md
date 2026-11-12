DRAFT v0.1 – 2026-11-12 – to be reviewed by a qualified lawyer before publication. Not legal advice.

# DPIA screening – GDPR Art. 35 (internal)

Sources: GDPR Art. 35(1), (3); EDPB-endorsed WP29 Guidelines on DPIA (WP248 rev.01), nine criteria; ANSPDCP Decision no. 174/2018 (list of operations requiring a DPIA) – **VERIFY current text on dataprotection.ro**. Checked: 2026-11-12 (from knowledge; not re-fetched).

| WP248 criterion | Applies? | Why |
|---|---|---|
| 1. Evaluation or scoring | No | No profiling; "Trending" sorts by cheers only |
| 2. Automated decision with legal or similar effect | Partly | Auto-hide after 3 qualified reporters is automated, temporary, reversible and reviewed by an admin; no suspension is automatic |
| 3. Systematic monitoring | No | No tracking, no location tracking |
| 4. Sensitive or highly personal data | Possibly | Posts show alcohol consumption habits; may allow inferences about health or religion (abstinence). Photos may show third parties |
| 5. Large scale | Not yet | Beta; reassess at 10,000 MAU or national launch |
| 6. Matching or combining datasets | No | — |
| 7. Vulnerable data subjects | Mitigated | Minors excluded by the 18+ gate (self-declared) |
| 8. Innovative technology | No (AI off) | Becomes Yes if the AI scanner is enabled |
| 9. Prevents exercising a right or using a service | No | — |

**Result:** 1–2 criteria at most today; a full DPIA is **not mandatory now** (WP248: generally two or more criteria). Recommendation: do a short full DPIA before (a) the public launch beyond beta, (b) enabling AI, (c) adding analytics or ads, or (d) adding stronger age assurance (ID or face estimation). Record the decision in `../OPEN_DECISIONS.md` (D-13).

Mitigations already in place: nothing readable without sign-in; private Smart Bar and saves; partner list visible only to partners; audit log without IPs or text; 30-day backup ceiling; in-app deletion; no birth date stored.
