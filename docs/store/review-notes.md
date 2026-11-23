DRAFT v0.1 – 2026-11-22 – to be reviewed before submission. Not legal advice.

# App Review notes – Apple and Google

Paste into App Store Connect → App Review Information → Notes, and into Play Console → App content → App access → Instructions. Update the **AI** paragraph to match the shipped build (see "Before pasting"). This replaces the short note in `README.md` §2 step 6.

## Test account
- Email: `[REVIEW ACCOUNT EMAIL – TO FILL BY JOHN]`
- Password: `[TO FILL BY JOHN – enter only in the console, never in this repo]`
- The account must exist on the **production** server, have confirmed 18+, accepted the current Terms (if the Terms step is on) and have at least one post and one partner so the feed is not empty. Create it by signing up in the release build; never use a personal account, and never the dev test users (test1–4@drinkme.test): delete those with `npm run testusers:delete` before launch and never put a test uid in `ADMIN_USER_IDS`.

## Notes (English – both stores)
> DrinkMe is a social app about drinks, alcoholic and non-alcoholic, for adults 18+. It does not sell, deliver or advertise alcohol and has no prices, promotions or drinking games.
>
> Sign in with the test account above. After the first sign-in every user must confirm they are 18 or older before any content is shown; the test account has already confirmed.
>
> User-generated content (posts with a photo, comments, profiles): every post, comment and profile has a Report action (reasons: spam, harassment, underage, dangerous drinking, mislabeled alcohol, other) and users can block other users from their profile. Reports are reviewed by a moderator within 24 hours; content reported by 3 different users is hidden automatically until reviewed; users who break the rules are suspended.
>
> Account deletion: Profile → Edit Profile → Delete account (deletes the account and its content). It is also described at [BASE_URL]/en/account-deletion.html.
>
> To create a post: tap +, pick any photo from the gallery, add a name and rating. Non-alcoholic drinks are marked with the "non-alcoholic" toggle.
>
> AI: [choose one] (a) "AI features are not available in this version; the Scanner tab and the Recipes tab show a 'Coming soon' preview." or (b) "The Scanner tab identifies a bottle from a photo or a barcode and the Smart Bar Recipes tab suggests recipes from the user's inventory. Images are processed by our own server in the EU and are not used to train models; results are suggestions and can be wrong."
>
> Contact: drinkmesocialapp@gmail.com

## Apple only
- Sign in with Apple: offered next to Google sign-in (guideline 4.8) once it is enabled in Firebase (LC-22); if it is not enabled at submission, do not ship the Google button on iOS either.
- No permission is requested at launch; camera and photo access are requested only when the user adds a photo.

## Google only
- Target audience: 18+ only. Ads: none. The app does not use background location.

## Before pasting
1. Pick the AI paragraph: (a) if `AI_ENABLED`/`AI_RECIPES_ENABLED` are `false` in the store build, (b) if the AI track shipped enabled. Apple 2.1: a "Coming soon" tab may be questioned; say so in the note rather than hide it.
2. Replace `[BASE_URL]` with the hosted legal pages (D-06).
3. Check that the reviewer account works on the production API from a clean install.
