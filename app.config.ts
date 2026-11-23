import 'dotenv/config';

export default {
  expo: {
    // Home-screen and store name. The slug below is the Expo project id and stays.
    name: "DrinkMe",
    slug: "DrinkMeFinal",
    // Store version (docs/RELEASE_BUILD.md). Build numbers below are only the starting values: eas.json uses
    // appVersionSource "remote", so EAS keeps and increments them for production builds.
    version: "1.0.0",
    // OTA-compatible runtime = the app version (only used if expo-updates is ever added).
    runtimeVersion: { policy: "appVersion" },
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "light",
    splash: {
      image: "./assets/splash-icon.png",
      resizeMode: "contain",
      backgroundColor: "#000000"
    },
    // Localized iOS permission prompts (InfoPlist.strings per language). The infoPlist strings below are
    // the English base used when the device language has no file here.
    locales: {
      en: "./locales/en.json",
      ro: "./locales/ro.json"
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: "com.aroncarola.drinkmefinal",
      buildNumber: "1",
      infoPlist: {
        CFBundleDevelopmentRegion: "en",
        CFBundleLocalizations: ["en", "ro"],
        // Lets system strings follow the device language even where the app has no translation.
        CFBundleAllowMixedLocalizations: true,
        NSCameraUsageDescription: "DrinkMe uses the camera to photograph your drinks and to scan bottle labels and barcodes.",
        // No NSPhotoLibraryAddUsageDescription: the app never saves photos to the library (Apple 5.1.1).
        NSPhotoLibraryUsageDescription: "DrinkMe needs access to your photos to add drink images."
      }
    },
    android: {
      package: "com.aroncarola.drinkmefinal",
      versionCode: 1,
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        backgroundColor: "#000000"
      },
      // No Google Drive backup of app data: the Firebase session must not be restored on another device.
      allowBackup: false,
      // Permissions the app never uses. RECORD_AUDIO: photos only, no video. SYSTEM_ALERT_WINDOW: comes from
      // the Expo template for the dev menu overlay. READ/WRITE_EXTERNAL_STORAGE stay: expo-image-picker asks
      // for them on Android 12 and older (Android 13+ uses the system photo picker, no permission).
      blockedPermissions: [
        "android.permission.RECORD_AUDIO",
        "android.permission.SYSTEM_ALERT_WINDOW"
      ]
    },
    web: {
      favicon: "./assets/favicon.png"
    },
    scheme: "drinkme",
    plugins: [
      // No Face ID prompt: the token is stored without requireAuthentication.
      ["expo-secure-store", { "faceIDPermission": false }],
      "expo-image",
      "expo-web-browser",
      "expo-apple-authentication",
      ["expo-image-picker", {
        "photosPermission": "DrinkMe needs access to your photos to add drink images.",
        "cameraPermission": "DrinkMe uses the camera to photograph your drinks and to scan bottle labels and barcodes.",
        // Photos only: no NSMicrophoneUsageDescription and no Android RECORD_AUDIO.
        "microphonePermission": false
      }],
      // Scanner (AI track): same camera text, no audio.
      ["expo-camera", {
        "cameraPermission": "DrinkMe uses the camera to photograph your drinks and to scan bottle labels and barcodes.",
        "recordAudioAndroid": false
      }]
    ],
    extra: {
      firebaseApiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
      firebaseAuthDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
      firebaseProjectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
      firebaseStorageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
      firebaseMessagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
      firebaseAppId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
      apiUrl: process.env.EXPO_PUBLIC_API_URL,
      googleMapsApiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY,
      googleWebClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
      // SHA-1 of the Android signing certificate (a public fingerprint) for the Places key restriction.
      androidCertSha1: process.env.EXPO_PUBLIC_ANDROID_CERT_SHA1,
      // Where docs/public is hosted (decision D-06), e.g. https://legal.example.com. Unset: no legal links.
      legalBaseUrl: process.env.EXPO_PUBLIC_LEGAL_BASE_URL,
    }
  }
};
