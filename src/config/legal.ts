// Links to the public legal pages (legal T-01/T-02, docs/legal/CODE_GAPS_PLAN.md).
//
// The pages are the static site in docs/public (built by scripts/build-public-pages.mjs), served at
// <EXPO_PUBLIC_LEGAL_BASE_URL>/{en,ro}/<doc>.html. Where they are hosted is decision D-06: until the base URL
// is set, getLegalUrl returns null and the app hides the document links (Contact still shows).
import Constants from 'expo-constants';

export type LegalDoc =
  | 'terms'
  | 'privacy'
  | 'community-guidelines'
  | 'content-moderation'
  | 'imprint'
  | 'age-and-alcohol'
  | 'account-deletion';

// Decision D-15 (default): one Gmail contact address for now, here only.
export const CONTACT_EMAIL = 'drinkmesocialapp@gmail.com';

const rawBase: unknown = (Constants.expoConfig?.extra as { legalBaseUrl?: unknown } | undefined)?.legalBaseUrl
  ?? process.env.EXPO_PUBLIC_LEGAL_BASE_URL;

/** https only, no trailing slash; anything else counts as not configured. */
export function normalizeLegalBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  return /^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(trimmed) ? trimmed : null;
}

export const LEGAL_BASE_URL = normalizeLegalBaseUrl(rawBase);

export function getLegalUrl(doc: LegalDoc, locale: string, base: string | null = LEGAL_BASE_URL): string | null {
  if (!base) return null;
  return `${base}/${locale === 'ro' ? 'ro' : 'en'}/${doc}.html`;
}
