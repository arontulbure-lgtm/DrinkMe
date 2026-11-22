DRAFT v0.2 – 2026-11-22 – to be reviewed by a qualified lawyer before publication. Not legal advice.

# Device Storage Notice

Version 0.2 · Effective date: [to be set at publication]

DrinkMe stores a few items on your phone. All of them are **strictly necessary** to provide the service you asked for, so no consent is required (Directive 2002/58/EC Art. 5(3); Romanian Law 506/2004 Art. 4(5)). **We use no tracking, advertising or analytics technologies.**

| What | Where on the phone | Why | How long |
|---|---|---|---|
| Your DrinkMe sign-in token | Secure storage (iOS Keychain / Android Keystore) | Keep you signed in to our server | Until you log out, or 30 days |
| Your Firebase sign-in session | App storage | Keep you signed in | Until you log out or uninstall |
| Your language choice | App storage | Show the app in your language | Until you change it or uninstall |
| When a verification email was last sent | App storage | Avoid sending repeated emails | Until you uninstall |
| Images you viewed | App cache | Faster loading | About 1 day |
| App-integrity token (only once we switch app-integrity checks on) | App storage, managed by the Firebase App Check library | Show our server that requests come from the genuine DrinkMe app (security) | Short-lived; renewed automatically – VERIFY the exact lifetime when the library is added |

**Permissions:** camera and photo library, only when you choose to add a photo (and, once the AI features are switched on, the camera when you scan a label or barcode; scan photos are not saved on your phone by DrinkMe). DrinkMe does not ask for your location; the place search sends the text you type to Google Maps Platform.
**Push notifications:** not used; notifications appear inside the app.
**Third-party content:** Google profile photos are loaded directly from Google's servers, which see your IP address.

If we ever add analytics, advertising or crash reporting, we will update this notice and ask for consent where required.
