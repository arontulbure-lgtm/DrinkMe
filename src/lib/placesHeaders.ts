// Headers that let Google check a Places API key restricted to this app (JOHN_TODO section 3, Maps key).
// The app calls Places over plain HTTPS, not through the Maps SDK, so Google only knows which app is
// asking when the request says so:
//   Android: X-Android-Package (applicationId) + X-Android-Cert (SHA-1 of the signing certificate)
//   iOS:     X-Ios-Bundle-Identifier
// The package and bundle ID come from app.config.ts; the SHA-1 from EXPO_PUBLIC_ANDROID_CERT_SHA1 (a public
// fingerprint, not a secret: `eas credentials` or the Play Console shows it). Without the SHA-1, Android
// sends no restriction headers, so an Android-restricted key would refuse the request: set the SHA-1 before
// turning the restriction on. The headers are sent from Expo Go too, so a restricted key keeps working there.
import Constants from 'expo-constants';
import { Platform } from 'react-native';

type AppConfigBits = {
  android?: { package?: string };
  ios?: { bundleIdentifier?: string };
  extra?: { androidCertSha1?: string };
};

const SHA1_FINGERPRINT = /^([0-9A-F]{2}:){19}[0-9A-F]{2}$/;

/** "AB:CD:…" or "abcd…" (40 hex characters) to the colon-free upper-case form Google expects. */
export function normalizeCertSha1(value: string | undefined | null): string | null {
  if (!value) return null;
  const hex = value.trim().toUpperCase().replace(/:/g, '');
  if (!/^[0-9A-F]{40}$/.test(hex)) return null;
  return hex;
}

export function placesRequestHeaders(
  platform: string = Platform.OS,
  config: AppConfigBits | null | undefined = Constants.expoConfig as AppConfigBits | null,
): Record<string, string> {
  if (platform === 'ios') {
    const bundleId = config?.ios?.bundleIdentifier;
    return bundleId ? { 'X-Ios-Bundle-Identifier': bundleId } : {};
  }
  if (platform === 'android') {
    const packageName = config?.android?.package;
    const sha1 = normalizeCertSha1(config?.extra?.androidCertSha1 ?? process.env.EXPO_PUBLIC_ANDROID_CERT_SHA1);
    return packageName && sha1 ? { 'X-Android-Package': packageName, 'X-Android-Cert': sha1 } : {};
  }
  return {};
}

export { SHA1_FINGERPRINT };
