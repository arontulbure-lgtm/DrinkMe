import 'dotenv/config';

export default {
  expo: {
    // Home-screen and store name. The slug below is the Expo project id and stays.
    name: "DrinkMe",
    slug: "DrinkMeFinal",
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "light",
    newArchEnabled: true,
    splash: {
      image: "./assets/splash-icon.png",
      resizeMode: "contain",
      backgroundColor: "#ffffff"
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: "com.aroncarola.drinkmefinal",
      infoPlist: {
        NSCameraUsageDescription: "DrinkMe needs the camera to photograph your drinks.",
        // No NSPhotoLibraryAddUsageDescription: the app never saves photos to the library (Apple 5.1.1).
        NSPhotoLibraryUsageDescription: "DrinkMe needs access to your photos to add drink images."
      }
    },
    android: {
      package: "com.aroncarola.drinkmefinal",
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        backgroundColor: "#ffffff"
      },
      edgeToEdgeEnabled: true
    },
    web: {
      favicon: "./assets/favicon.png"
    },
    scheme: "drinkme",
    plugins: [
      "expo-secure-store",
      "expo-apple-authentication",
      ["expo-image-picker", {
        "photosPermission": "DrinkMe needs access to your photos to add drink images.",
        "cameraPermission": "DrinkMe needs the camera to photograph your drinks."
      }],
      ["expo-camera", {
        "cameraPermission": "DrinkMe uses the camera to scan bottle labels and barcodes.",
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
