// Firebase App Check, app side (SEC-I; plan in docs/APP_CHECK_PLAN.md).
//
// A real App Check token needs a native attestation provider (Play Integrity on Android, App Attest on iOS),
// which only a development or store build has: Expo Go cannot provide one. So this module is a slot:
// once the dev build registers a provider (setAppCheckTokenProvider, for example from
// @react-native-firebase/app-check), and EXPO_PUBLIC_APP_CHECK_ENABLED=true, every API request carries the
// X-Firebase-AppCheck header that the server checks (APP_CHECK_MODE=monitor, later enforce).
// With the flag off, or without a provider, nothing is added and nothing changes.

type TokenProvider = () => Promise<string | null>;

export const APP_CHECK_ENABLED = process.env.EXPO_PUBLIC_APP_CHECK_ENABLED === 'true';
export const APP_CHECK_HEADER = 'X-Firebase-AppCheck';

let tokenProvider: TokenProvider | null = null;

export function setAppCheckTokenProvider(provider: TokenProvider | null): void {
  tokenProvider = provider;
}

/** The App Check header for an API request, or nothing (flag off, no provider, or the provider failed). */
export async function getAppCheckHeaders(): Promise<Record<string, string>> {
  if (!APP_CHECK_ENABLED || !tokenProvider) return {};
  try {
    const token = await tokenProvider();
    return token ? { [APP_CHECK_HEADER]: token } : {};
  } catch {
    // The server decides (monitor counts it, enforce refuses it): never block the request here.
    return {};
  }
}
