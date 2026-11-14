DRAFT v0.1 – 2026-11-12 – to be reviewed by a qualified lawyer before publication. Not legal advice.

# Data subject request procedure (internal)

Law: GDPR Arts. 12–22 (deadline: one month from receipt, extendable by two months for complex or numerous requests, with notice within the first month – Art. 12(3)); UK GDPR same; CCPA-style requests (US) handled the same way as best practice (45 days); LGPD 15 days for simplified access (VERIFY); APPI, PIPA, PDPA: "without delay" / per law – VERIFY.

## Intake
- Channel: drinkmesocialapp@gmail.com (subject "Privacy request"). Also accept requests in any form (Art. 12(2)).
- Log each request: date received, deadline, type, how identity was checked, actions, date closed. Keep the log 3 years (proposal).

## Identity check
- Ask the requester to send the request from the email of the account, or to sign in and confirm. Never ask for ID documents unless doubt remains (minimisation).
- Map the email to the Firebase uid via the Firebase console (no email lookup exists in the API by design).

## Per right
| Right | How | Tooling |
|---|---|---|
| Access (Art. 15) and portability (Art. 20) | Export the user's records (user, posts with photos, comments, cheers, saves, partners, blocks, reports they filed, Smart Bar, notifications, audit entries about them) as JSON and send through a secure channel | **No export route yet (gap LC-14)**: a developer must extract from the database by uid with a reviewed script. Never send other users' data (redact names of others in comments/notifications if not needed) |
| Rectification (Art. 16) | Most fields are editable in the app (profile, posts). Email: change in Firebase | In app / Firebase console |
| Erasure (Art. 17) | Point to in-app Delete account (Edit Profile, or the age gate). If the user cannot sign in, delete via a reviewed admin script calling the same cascade, then delete the Firebase user | `POST /api/users/:id/delete-account` |
| Restriction (Art. 18) | Admin suspends write access and marks the record; document | Manual |
| Objection (Art. 21) | Assess against the legitimate interest (P5–P8 in `ropa.md`) | Manual |
| Automated decisions (Art. 22) | Auto-hide is not a decision with legal or similarly significant effect, and an admin reviews it; explain on request | — |
| Withdraw consent | No consent-based processing today | — |

## Refusals
Explain the reason and the right to complain to ANSPDCP (or the user's local authority) and to go to court (Art. 12(4)).
