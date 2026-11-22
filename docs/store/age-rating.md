DRAFT v0.2 – 2026-11-22 – to be reviewed by a qualified lawyer before publication. Not legal advice.

# Age rating questionnaires – answers

Principle: answer for **everything a user can see in the app, including user-generated content**, and answer high when unsure. A lower-than-true rating is a rejection or removal risk; a higher rating costs nothing because DrinkMe is 18+ anyway.

## 1. Apple – App Store Connect → App Information → Age Rating

Checked 2026-11-16 against Apple's "Age ratings values and definitions" (developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions). Apple's global tiers are now **4+, 9+, 13+, 16+, 18+** (the old 12+/17+ tiers were replaced). **"Frequent" alcohol, tobacco or drug use or references gives 18+** (the older expectation of 17+ in `docs/JOHN_TODO.md` §5.3 is outdated). Answer options in the console may be worded "None / Infrequent / Frequent" or "No / Yes" – VERIFY the labels.

| Section → question | Answer | Reason |
|---|---|---|
| In-App Controls → Parental Controls | No | No parental-control features |
| In-App Controls → Age Assurance | No | The app uses a self-declared "18 or older" confirmation, not an age-verification or estimation method. VERIFY Apple's definition; change to Yes only if the per-country check (LC-01) or the Declared Age Range API (LC-26) is shipped and Apple counts it |
| Capabilities → Unrestricted Web Access | No | No in-app browser to arbitrary sites (legal links planned in T-01 open our own pages) |
| Capabilities → User-Generated Content | **Yes** | Posts with photos, comments, profiles |
| Capabilities → Social Media | **Yes** | Profiles, public posts, cheers, comments, drink partners (rates 13+ on its own) |
| Capabilities → Messaging and Chat | No | No private messages; comments are public user content on a post. VERIFY: if App Review treats comments as chat, answer Yes (no effect on the 18+ result) |
| Capabilities → Advertising | No | No ads |
| Mature Themes → Profanity or Crude Humor | Infrequent | Forbidden by the Community Guidelines but possible in user comments until removed |
| Mature Themes → Horror/Fear Themes | None | — |
| Mature Themes → **Alcohol, Tobacco, or Drug Use or References** | **Frequent** | Alcoholic drinks are a core subject of posts → **18+** |
| Medical or Wellness → Medical or Treatment Information | None | — |
| Medical or Wellness → Health or Wellness Topics | None | No health content; the Age and Alcohol Policy only names help lines (web page, not in-app content) |
| Sexuality or Nudity → all three | None | Forbidden by the Community Guidelines; reported and removed |
| Violence → Cartoon/Fantasy, Realistic, Prolonged Graphic, Guns or Other Weapons | None | Forbidden; reported and removed |
| Chance-Based Activities → Gambling, Simulated Gambling, Contests, Loot Boxes | None | No contests or prizes |
| Made for Kids | No | — |

**Expected result: 18+** (global). Regional results to check on the summary screen: **Brazil gives A16 for "Frequent"** alcohol references – DrinkMe's own minimum is still 18, enforced by the age gate and Terms; Australia and Korea have their own mappings – VERIFY on the summary screen.
Also in App Store Connect: Pricing and Availability → limit countries to the launch markets (decision D-02; exclude the countries in `docs/legal/age-and-alcohol.md` §3).

## 2. Google Play – Content rating (IARC questionnaire)

Where: Play Console → Policy → App content → Content rating → Start questionnaire. Email for the IARC certificate: drinkmesocialapp@gmail.com. The questionnaire was **not** opened for this draft (needs the console) – VERIFY each question's wording.

| Step / question | Answer | Reason |
|---|---|---|
| Category | **Social Networking, Forums, Blogs and User-Generated Content Sharing** (if offered; otherwise "All other app types") | Core of the app is user posts and profiles |
| Violence (any) | No | Forbidden content |
| Fear / horror | No | — |
| Sexuality / nudity | No | Forbidden content |
| Gambling / simulated gambling | No | — |
| Language (profanity, crude humour) | No for the app's own content; if asked about user content: may appear, moderated | Comments can contain it until removed |
| **Controlled substances: references to or depictions of alcohol** | **Yes** | Alcoholic drinks shown in posts |
| Controlled substances: encourages or glamorises use / shows use by minors | **No** | Forbidden by the Community Guidelines §1; reported and removed |
| Tobacco / illegal drugs | No (forbidden by the Guidelines) | — |
| Users can interact or exchange content (comments, posts, partners) | **Yes** | Interactive element "Users Interact" |
| Shares user's location with other users | **Yes** (conservative) | A post can show a place name the user chose; no GPS is shared. VERIFY: if IARC defines this as the device's real-time location only, answer No |
| Digital purchases | No | Free, no in-app purchases |
| Unrestricted internet access | No | — |
| Is the app primarily a web browser or search engine? | No | — |
| Does the app contain content moderation / reporting? | Yes, if asked | Report (6 reasons), block, human review, auto-hide after 3 reports |

**Expected result:** alcohol references usually give **PEGI 16 / USK 16 / ESRB Teen or Mature 17+ / IARC 16+**, with interactive elements "Users Interact, Shares Location". IARC does not usually reach 18 for references alone – that is fine because the **Target audience is set to 18+ only** (`play-data-safety.md` §4), which is the setting that restricts the audience on Play. VERIFY the actual certificate after submission and keep a copy.

## 3. Consistency
- Listing text (`listing.en.md`, `listing.ro.md`) states 18+.
- In-app: the age gate appears before any content; Terms §3; Age and Alcohol Policy §1.
- If brand-partner posts start (LC-11/LC-13), re-check both questionnaires (Apple "Advertising" may become relevant for paid partnerships – VERIFY).

## 4. When AI is enabled (separate release – not v1.0.0)
- Apple: no change to the alcohol answer (already Frequent → 18+). If the questionnaire asks about AI-generated content or a chatbot, answer **Yes** for AI-generated recipes (text, no free chat) – VERIFY the wording; the result stays 18+.
- Google Play / IARC: if asked whether the app generates content with AI, answer **Yes**; the content is drink recipes with alcohol references (already declared). Generated content never encourages excessive drinking (server safety rules S1–S13) and can be reported in the app (LC-39).
- Both: recipes with alcohol are only for users who confirmed 18+; AI results are labelled "AI-generated".
