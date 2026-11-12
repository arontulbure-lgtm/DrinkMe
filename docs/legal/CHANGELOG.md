DRAFT v0.1 – 2026-11-12 – to be reviewed by a qualified lawyer before publication. Not legal advice.

# Legal documents changelog

Lawyer sign-off: **none yet.** When a lawyer approves a document, add a line: date, document, version, lawyer's name, scope of review. Only then remove the DRAFT line from that document.

## v0.1 – 2026-11-12 (first drafts, legal-compliance agent)
Created (EN master + RO translation):
- `terms.md` / `terms.ro.md` – Terms version for in-app acceptance: 1 (needs LC-03 `TERMS_VERSION`).
- `privacy-policy.md` / `.ro.md`, `privacy-eu-uk.md` / `.ro.md`, `privacy-us.md` / `.ro.md`, `privacy-apac.md` / `.ro.md`, `privacy-other.md` / `.ro.md` – consistent with in-app notice version 2 (`PRIVACY_NOTICE_VERSION = 2`, unreleased).
- `community-guidelines.md` / `.ro.md`, `content-moderation.md` / `.ro.md`, `copyright.md` / `.ro.md`, `age-and-alcohol.md` / `.ro.md`, `brand-partner-terms.md` / `.ro.md`, `imprint.md` / `.ro.md`, `account-deletion.md` / `.ro.md`, `device-storage-notice.md` / `.ro.md`.
Internal: `internal/data-inventory.md`, `ropa.md`, `dpia-screening.md`, `retention-schedule.md`, `subprocessors.md`, `dsr-procedure.md`, `breach-response.md`, `law-enforcement-requests.md`, `uk-online-safety-assessments.md`, `store-disclosures.md`; `compliance-matrix.md`; `OPEN_DECISIONS.md`.

Re-acceptance needed: users have never accepted Terms (no terms step exists). When LC-03 ships, every user accepts `TERMS_VERSION = 1`. The privacy notice: if the link to the full policy (LC-04/LC-23) ships before notice v2 is released, keep version 2; otherwise raise `PRIVACY_NOTICE_VERSION` to 3 on server and client.

Follow-ups when in-progress work merges: password reset ends server sessions (update `terms.md` §4, `privacy-policy.md` §11); official account (update `data-inventory.md` §5 with file:line, `community-guidelines.md` §4).
