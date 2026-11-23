DRAFT v0.2 – 2026-11-22 – to be reviewed by a qualified lawyer before publication. Not legal advice.

# Store listing – English (App Store + Google Play)

Paste-ready text. Each field shows its store limit and the measured length (Unicode characters, counted with Node on 2026-11-16). Apply to both stores unless a row says otherwise.

Rules this text follows (checked 2026-11-16):
- **Apple App Review Guideline 1.4.3:** no encouragement of excessive alcohol consumption, nothing aimed at minors, no sales.
- **Google Play "Tobacco and Alcohol" policy** (support.google.com/googleplay/android-developer/answer/9878810): no facilitation of sales, no depiction of alcohol to minors, no favourable portrayal of excessive, binge or competitive drinking.
- **Apple 2.3 (accurate metadata):** only features that work today are described. Stories is switched off (`src/screens/HomeScreen.tsx:30`) and is **not** mentioned. The AI scanner and AI recipes are shown only when the server runs `AI_PROVIDER=local`; they are not mentioned in the main texts below – add the line in §7 only when AI is on at submission.
- 18+ is stated in the short and full descriptions; non-alcoholic drinks are presented as equal (Age and Alcohol Policy §4).

## 1. Short fields

| Field | Store | Limit | Text | Length |
|---|---|---|---|---|
| App name | Apple | 30 | DrinkMe | 7 |
| App title | Google Play | 30 | DrinkMe | 7 |
| Subtitle | Apple | 30 | Discover & share great drinks | 29 |
| Short description | Google Play | 80 | Discover, rate and share drinks with or without alcohol. For adults 18+. | 72 |
| Promotional text ("marketing text", can change without a review) | Apple | 170 | Discover drinks worth sharing – cocktails, mocktails, wine, beer, coffee and tea. Rate them, add a photo and a place, and see what your drink partners are tasting. | 163 |
| Keywords (comma-separated, no spaces after commas) | Apple | 100 | cocktail,mocktail,drinks,wine,beer,coffee,tea,spirits,home bar,rating,tasting,discover,friends | 94 |

Keywords: no brand names, no competitor names, no words about getting drunk, parties or quantity (Apple 2.3.7, 1.4.3). The app name and category are not repeated (Apple indexes them already).

## 2. Category
- **Apple:** Primary **Food & Drink**; Secondary **Social Networking**.
- **Google Play:** Category **Food & Drink**. Tags (Play Console → Store settings): choose food/drink and social tags offered in the console; avoid any "party" or "nightlife" tag.

## 3. Full description (Apple "Description", Play "Full description"; limit 4000)

> Length: 2,165 characters with the URL placeholders (well under 4,000 after the real URLs are filled in). Paste from "DrinkMe is a place" to the last line.

DrinkMe is a place to discover, rate and share great drinks – with or without alcohol.

Snap a photo of the drink in front of you, give it a rating, write what you liked and add where you had it. Cocktails, wine, beer and spirits sit next to mocktails, coffee, tea and everything else: non-alcoholic drinks are first-class on DrinkMe.

WHAT YOU CAN DO
• Post a drink with a photo, a rating, a short description, a category and the place you had it.
• Mark every drink honestly as alcoholic or non-alcoholic.
• Explore drinks from the community and search for drinks and people.
• Give a "cheers", comment, and save the posts you want to come back to.
• Connect with drink partners – both of you have to agree.
• Keep a private Smart Bar: a list of the drinks you have at home, plus your saved posts.
• Get in-app notifications when someone cheers, comments or sends you a partner request.

TASTE, NOT QUANTITY
DrinkMe celebrates flavour, craft and good company. Content that encourages excessive or fast drinking, drinking games, drinking and driving, or drinking by minors is not allowed. DrinkMe does not sell or deliver alcohol, and posts may not sell or advertise it.

ADULTS ONLY (18+)
DrinkMe is only for adults who have reached the legal drinking age where they live, and never under 18. You confirm your age before any content is shown, and nothing on DrinkMe is visible without an account.

A SAFE COMMUNITY
• Report any post, comment or profile that breaks the Community Guidelines.
• Block anyone you don't want to interact with.
• Reported content is reviewed by a person; content reported by several people is hidden until it is checked.

YOUR DATA, YOUR CHOICE
• No ads, no ad tracking, no analytics trackers. We do not sell your data.
• Your email, saved posts, Smart Bar and blocks are private.
• Delete your account at any time in the app (Edit Profile → Delete account).

Sign in with email, Google or – on iPhone – Apple.

DrinkMe is in beta: we are improving it every week and welcome your feedback at drinkmesocialapp@gmail.com.

Privacy Policy: [PRIVACY_URL]
Terms: [TERMS_URL]

Please enjoy responsibly.

## 4. URLs and contact (fill when hosting is chosen – decision D-06)

| Field | Store | Value |
|---|---|---|
| Privacy Policy URL | Apple (App Privacy) + Play (Policy → App content → Privacy policy) | `[BASE_URL]/en/privacy.html` |
| Support URL | Apple (required) | `[BASE_URL]/en/index.html` (lists all documents + the contact email) – VERIFY that Apple accepts a page whose only support channel is email; a dedicated `support.html` page can be added if review asks |
| Marketing URL | Apple (optional) | leave empty until there is a website |
| Contact email | Play (Store settings → Store listing contact details, required) | drinkmesocialapp@gmail.com |
| Website | Play (optional) | `[BASE_URL]/` |
| Account deletion URL | Play (Data safety) | `[BASE_URL]/en/account-deletion.html` |
| Terms of Use (EULA) | Apple: App Store Connect → App Information → License Agreement | Use the standard Apple EULA **or** paste a link to `[BASE_URL]/en/terms.html` in the description (done above). VERIFY with the lawyer which one to use. |

Replace `[BASE_URL]`, `[PRIVACY_URL]` and `[TERMS_URL]` before pasting. Until the lawyer signs off (D-01), the hosted pages show a "Draft – pending legal review" banner; **the stores need final texts** – see `README.md`.

## 5. What's new (first release)
> First public beta of DrinkMe: post, rate and discover drinks with or without alcohol, connect with drink partners, and keep your private Smart Bar.

## 6. Screenshot and preview rules (for John)
- Show real app screens. Good subjects: a mocktail or coffee post, a cocktail post with a rating, the Explore grid with both alcoholic and non-alcoholic drinks, the Smart Bar list, the report/block menu.
- Never show: anyone who looks under 25 with alcohol, several drinks lined up for one person, shots or "drinking game" content, drinking near cars or at work, prices, shop links or "buy" buttons, brand logos used as advertising.
- Do not show the "AI Scanner – Coming soon" or "AI Recipe Generator – Coming soon" screens (Apple 2.1 / 2.3: unfinished features). VERIFY with the planner whether the Scanner tab should be hidden in the store build (see `README.md` §4).
- Captions follow the same rules as the description ("Taste, not quantity").

## 7. When AI is enabled (applies once the AI features are switched on)
Do not mention the scanner or AI recipes while the server runs `AI_PROVIDER=off`. When AI is on at submission (or later, in a listing update), add at most one honest line, for example: "Scan a bottle or a barcode to add it to your Smart Bar, and get AI drink ideas – AI suggestions can be wrong; always check ingredients." Rules: call it AI; no "instant", "personalised" or "perfect" promises (LC-44); keep non-alcoholic options visible; screenshots only from a build where the feature works.
