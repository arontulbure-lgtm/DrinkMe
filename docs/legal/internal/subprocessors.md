DRAFT v0.1 – 2026-11-12 (database and App Check rows 2026-11-22) – to be reviewed by a qualified lawyer before publication. Not legal advice.

# Processors, sub-processors and other recipients (internal)

| Recipient | Role (GDPR) | Data | Location / transfer mechanism | Agreement | Status |
|---|---|---|---|---|---|
| Google LLC / Google Ireland – Firebase Authentication | Processor (Firebase Data Processing and Security Terms) – VERIFY entity and role | Email, password hash, provider ids, name and photo from Google/Apple, sign-in metadata, IP of sign-in requests | Global infrastructure incl. US. Mechanism: EU-US Data Privacy Framework certification of Google LLC and/or SCCs in Google's terms – VERIFY on dataprivacyframework.gov and the current Firebase terms | Accept the Firebase Data Processing and Security Terms in the Firebase console | **Action for John: confirm accepted** |
| Google – Maps Platform (Places API) | Independent controller or processor under the Google Maps Platform terms – VERIFY | Place search text, phone IP, API key | US/global; DPF/SCCs – VERIFY | Google Maps Platform Terms + data processing terms | Active (client) |
| Google – profile photo hosting (`googleusercontent.com`) | Independent controller (Google's own service) | Viewer's IP when the photo loads | US/global | none needed – disclose | Active |
| Apple – Sign in with Apple (iOS) | Independent controller for the Apple ID; may relay email (private relay) | Name, email or relay address | US/global | Apple Developer agreement | Code present; Firebase Apple provider status VERIFY |
| Hosting provider (Railway or Render planned, INFRA-1) | Processor | Whole database, backups, request logs | Choose an EU region; if US company: DPF/SCCs | Provider DPA | **Not chosen (decision D-07)** |
| Backup storage (separate from the database volume) | Processor | Database copies | Same as hosting, EU region | DPA | Not chosen |
| Managed Postgres provider (only if `DB_DRIVER=postgres`, DATA-1) | Processor | Whole database (one JSON document), its history table (≤ 28 days) and the provider's own backups/PITR (must be ≤ 30 days) | Choose EU region; TLS with certificate check | DPA | Not chosen (decision D-07) |
| Google (Firebase App Check, Play Integrity) and Apple (App Attest / DeviceCheck) – only once App Check is switched on | Google: processor for token verification under the Firebase terms; Play Integrity / App Attest: device-side attestation by the platform – VERIFY roles | Attestation token (app id, no account data); device integrity signals processed by Google/Apple | US/global; Firebase data processing terms | Firebase terms (already accepted for Authentication – VERIFY App Check is covered) | Code ready, not active (`APP_CHECK_MODE=off`, no native provider) |
| Email provider for the contact address (`drinkmesocialapp@gmail.com`, Gmail) | Processor/controller for mailbox content – VERIFY consumer Gmail terms | User emails, DSR, notices | US/global | Consumer Gmail has no DPA – **recommend Google Workspace or another business mailbox with a DPA** (decision D-15) | Active |
| OpenAI (only if `AI_ENABLED=true`) | Processor | Scanner photos, ingredient lists | US; SCCs / DPF – VERIFY | OpenAI DPA | **Off. Do not enable before the privacy documents are updated and the DPA is signed** |
| Apple App Store, Google Play | Independent controllers | Store account, downloads, crash data they collect | Global | Store agreements | Disclose in privacy policy |
| Expo (EAS Build / Expo services) | Processor for build artefacts; no user data unless `expo-updates` or Expo push are used – VERIFY | none currently | US | Expo terms | Check before release |

Review this list whenever a package or provider is added. Notify users of material changes via the privacy policy CHANGELOG.
