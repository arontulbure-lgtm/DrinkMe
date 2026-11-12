DRAFT v0.3 – 2026-11-13 – to be reviewed by a qualified lawyer before publication. Not legal advice.

# Content Moderation Policy (notice and action)

Version 0.3 · Effective date: [to be set at publication]

This policy explains how DrinkMe handles reports, what happens to reported content and accounts, and how to ask for a review. It implements the Digital Services Act (Regulation (EU) 2022/2065, "DSA") for an online platform established in Romania and, if DrinkMe is offered in the UK, the Online Safety Act 2023.

**Status markers:** ✅ = done in the app · 🛠 = being built (planning row in the compliance matrix) · ✉ = handled by email for now.

## 1. How to report (notice)
- ✅ **In the app** (signed-in users): Report on any post, comment or profile. Reasons: spam, harassment, underage, dangerous drinking, mislabelled alcohol, other (with optional details up to 300 characters). A user can send up to 20 reports per 24 hours.
- ✉ **By email** (anyone, including people without an account, and for illegal content or rights infringement): drinkmesocialapp@gmail.com. Please include: why you believe the content is illegal or breaks our rules; where it is (user name, post description, date, screenshot); your name and email (except for some child-safety reports, where you may stay anonymous); and a statement that you believe your notice is accurate and complete (DSA Art. 16(2)).
- 🛠 A specific "illegal content" and "intellectual property" reason in the app (LC-09).
- We confirm receipt of email notices. ✅ In-app reports are acknowledged on screen.

## 2. What happens after a report
1. ✅ Every report goes to the moderation queue. Our target is to review reports within **24 hours**.
2. ✅ **Automatic hiding:** when three different users whose accounts are at least 48 hours old and have accepted the privacy notice report the same item, it is hidden from everyone except its owner and moderators until a moderator reviews it. The owner sees a notice in the app. This is the only automated step; it does not delete anything.
3. ✅ A moderator (a person) decides: **dismiss** (content stays; if hidden it reappears), **remove** the post or comment, or **clear** a profile (name, bio, photo), and optionally **suspend** the owner.
4. ✅ If the owner edits a reported post, moderators still see the version that was reported.
5. ✅ **The official DrinkMe account** (the account run by DrinkMe itself, marked with an "Official" badge) is treated differently in one way only: its posts, comments and profile are **not hidden automatically** by reports, so that a group of reporters cannot take the service's own account offline. Everything else is the same. Reports about it are accepted, put in the same queue (marked as concerning the official account), checked against the same rules and law, with the same 24-hour target, and moderators can remove its content, clear its profile or suspend it like any other account. While the reports are reviewed, the content stays visible.
6. DrinkMe publishes the official account's content itself and is responsible for it as its author. DrinkMe currently has one operator, so the person who runs the official account may also review reports about it. If you disagree with the outcome you can ask for a review (section 5) or complain to ANCOM.
7. ✅ **Reserved names.** Profile names that contain "DrinkMe" (in any spelling or look-alike form) are reserved for the official account, and the app refuses them for everyone else, together with names that contain "Official" / "Oficial" or a check mark, which could imitate the badge (see the Community Guidelines §4). This is an automated check on the name only (not on bios, cities or photos), it removes nothing already published, and the message shown says why; a name from Google or Apple refused this way is not stored. The check is best effort: names that get past it can still be reported as impersonation. Names saved before this rule are not changed automatically; they can be reported as impersonation and moderators can clear them.

## 3. Suspensions and repeat offenders
- ✅ First suspension: 7 days. Any later suspension: permanent. Serious breaches (e.g. sexual content involving minors, credible threats, selling drugs) can lead to a permanent suspension at once.
- ✅ While suspended, you cannot post, edit posts, comment, send or accept partner requests, edit your profile or report; you can still read, give cheers, save, block, log out and delete your account. A banner shows the end date.
- A suspension made by mistake is lifted and not counted.
- We may also suspend accounts that often send manifestly unfounded reports (DSA Art. 23) after a warning.

## 4. Statement of reasons (DSA Art. 17)
When we remove or hide your content or suspend your account, you are entitled to a statement of reasons: what we did, the facts, whether automated means were used (for the automatic hiding), the rule or law relied on, and how to seek redress.
- ✅ Automatic hiding: an in-app notice on the item.
- ✅ Suspension: an in-app banner with the end date.
- 🛠 Full statement of reasons in the app for removals and suspensions (LC-06). ✉ Until then we send it by email to the address of the account.
- 🛠 The person who reported is told the outcome (DSA Art. 16(5)) (LC-07). ✉ For email notices we reply by email.

## 5. Asking for a review (appeal)
- ✉ If you disagree with a decision (as the owner of the content or as the reporter), write to drinkmesocialapp@gmail.com within **6 months**, saying which decision and why. A different moderator where possible, or the operator, reviews it and replies, normally within 14 days. We reverse decisions that were wrong.
- As a micro enterprise, DrinkMe is currently exempt from the formal internal complaint system and out-of-court settlement duties of DSA Arts. 20–21 (Art. 19) – VERIFY the enterprise size each year – but we offer this review anyway. You can always go to court, and you may contact a certified out-of-court dispute settlement body; complaints about DSA compliance can go to **ANCOM**, Romania's Digital Services Coordinator (ancom.ro).

## 6. Orders from authorities
We act on orders from judicial or administrative authorities against illegal content and tell the user concerned unless the order says otherwise (DSA Arts. 9–10). If we learn of a threat to someone's life or safety, we inform the competent authorities (DSA Art. 18).

## 7. Transparency
Micro and small enterprises are exempt from the DSA transparency reporting duty (Art. 15(2)). We keep internal statistics (number of reports by reason, decisions, time to decision, with reports about the official account counted separately) and will publish a yearly summary when we are no longer exempt or earlier as good practice.

## 8. United Kingdom
If DrinkMe is offered in the UK: UK users can report illegal content and complain about our decisions through the same channels; we keep records of our risk assessments (Online Safety Act 2023 ss. 9, 20–21 – VERIFY).

---
Sources checked 2026-11-12: DSA Art. 19 exemption (EUR-Lex text via secondary summaries: springlex.eu, prighter.com); Romanian Law 50/2024 designating ANCOM as Digital Services Coordinator (ANCOM; Mondaq). Checked 2026-11-13: DSA Art. 14(1) (terms must describe content moderation measures and tools, incl. automated ones), Art. 14(4) (diligent, objective, proportionate enforcement), Art. 17(1) (statement of reasons) – EUR-Lex CELEX 32022R2065. Code facts: `server/server.js` (`REPORT_REASONS`, `AUTO_HIDE_REPORTER_THRESHOLD`, `SUSPENSION_FIRST_DURATION_MS`; official account: `isTargetAutoHidden` `:1824-1826`, `targetOfficial` `:4378`, reserved-name check `isReservedDisplayName` `:1184` (fold `:1085-1180`, check marks `:1121`, "official"/"oficial" `:1168`), `name_reserved` `:3148-3151`, provider name dropped at sign-in `:1217-1231`, `OFFICIAL_USER_IDS` `:4203-4205`; working tree read 2026-11-13, uncommitted), `server/README.md` "Moderation" and "Official account".
