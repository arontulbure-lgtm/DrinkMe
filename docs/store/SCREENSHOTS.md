# Store screenshots plan

Taken from the release candidate (after the Expo SDK 58 upgrade and the AI merge), on the Android emulator with test users and demo posts, then sized with ffmpeg into `D:\DrinkMeApp\_release\store-assets\`. Real-looking drink photos for the demo posts are John's (no stock images without a licence; no brands or people without consent; nobody who looks under 25, per alcohol advertising codes).

## Screens (order = store order)
| # | Screen | Shows | Caption (en / ro) |
|---|---|---|---|
| 1 | Home feed | partner posts with photos, cheers | Share the drinks you love / Împărtășește băuturile preferate |
| 2 | Post detail | rating, place, comments | Rate, review and discuss / Notează, recenzează, discută |
| 3 | Explore | search and categories | Discover new drinks and places / Descoperă băuturi și locuri noi |
| 4 | Smart Bar | inventory | Keep track of your home bar / Ține evidența barului de acasă |
| 5 | AI scanner or recipes (if AI ships enabled) | scan result | Scan a bottle, get ideas / Scanează o sticlă, primește idei |
| 6 | Profile | posts, partners, Official badge example | Your taste, your profile / Gustul tău, profilul tău |
| 7 | Create post | photo, rating, non-alcoholic toggle | Mocktails welcome too / Și mocktailurile sunt binevenite |

No screenshot shows drinking games, quantities, sales, prices or anyone drinking. At least one shows a non-alcoholic drink.

## Sizes
| Store | Device class | Size (portrait) | Files |
|---|---|---|---|
| Google Play | phone | 1080x1920 (9:16; Play allows at most 2:1) | `play/phone-<n>.png` |
| Google Play | feature graphic | 1024x500 | `play/feature-graphic.png` (John's design) |
| Apple | 6.9" iPhone | 1320x2868 | `apple/6.9-<n>.png` |
| Apple | 6.5" iPhone | 1284x2778 | `apple/6.5-<n>.png` |

Apple screenshots must show the iOS app: the Android-derived files are layout drafts; retake them on the iPhone once the SDK 58 build runs there (Expo Go 58 from the App Store).

## How they are made
`adb exec-out screencap -p` on the emulator (1080x2400), then ffmpeg: crop the status/navigation bars and scale/pad to each size with the app's black background (`scale` + `pad=...:color=black`).
