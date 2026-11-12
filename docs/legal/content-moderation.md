DRAFT v0.1 – 2026-11-12 – to be reviewed by a qualified lawyer before publication. Not legal advice.

# Content Moderation Policy (notice and action)

Version 0.1 · Effective date: [to be set at publication]

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
5. 🛠 Content from the official DrinkMe account is not hidden automatically by reports (to prevent abuse), but moderators review reports about it like any other.

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
Micro and small enterprises are exempt from the DSA transparency reporting duty (Art. 15(2)). We keep internal statistics (number of reports by reason, decisions, time to decision) and will publish a yearly summary when we are no longer exempt or earlier as good practice.

## 8. United Kingdom
If DrinkMe is offered in the UK: UK users can report illegal content and complain about our decisions through the same channels; we keep records of our risk assessments (Online Safety Act 2023 ss. 9, 20–21 – VERIFY).

---
Sources checked 2026-11-12: DSA Art. 19 exemption (EUR-Lex text via secondary summaries: springlex.eu, prighter.com); Romanian Law 50/2024 designating ANCOM as Digital Services Coordinator (ANCOM; Mondaq). Code facts: `server/server.js` (`REPORT_REASONS`, `AUTO_HIDE_REPORTER_THRESHOLD`, `SUSPENSION_FIRST_DURATION_MS`), `server/README.md` "Moderation".
