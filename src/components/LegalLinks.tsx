// "Legal & help" rows (legal T-01): Terms, Privacy, Community Guidelines, Moderation, Imprint, Responsible
// drinking, Account deletion, and Contact. Document rows appear only when the pages are hosted
// (EXPO_PUBLIC_LEGAL_BASE_URL, decision D-06); Contact always shows.
import React from 'react';
import { Alert, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';

import { useLocalization } from '../context/LocalizationContext';
import { CONTACT_EMAIL, getLegalUrl, type LegalDoc } from '../config/legal';

const DOCS: { doc: LegalDoc; labelKey: string }[] = [
  { doc: 'terms', labelKey: 'legal.terms' },
  { doc: 'privacy', labelKey: 'legal.privacy' },
  { doc: 'community-guidelines', labelKey: 'legal.guidelines' },
  { doc: 'content-moderation', labelKey: 'legal.moderation' },
  { doc: 'age-and-alcohol', labelKey: 'legal.responsibleDrinking' },
  { doc: 'account-deletion', labelKey: 'legal.accountDeletion' },
  { doc: 'imprint', labelKey: 'legal.imprint' },
];

/** Opens a legal page in the in-app browser; false when the pages are not hosted yet. */
export async function openLegalDoc(doc: LegalDoc, locale: string): Promise<boolean> {
  const url = getLegalUrl(doc, locale);
  if (!url) return false;
  await WebBrowser.openBrowserAsync(url);
  return true;
}

/** "By continuing you agree to the Terms and the Privacy Policy" (legal T-02); nothing until the pages are hosted. */
export function LegalAgreementLine() {
  const { t, locale } = useLocalization();
  if (!getLegalUrl('terms', locale) || !getLegalUrl('privacy', locale)) return null;
  return (
    <Text style={styles.agreement}>
      {`${t('legal.agreeIntro')} `}
      <Text style={styles.agreementLink} accessibilityRole="link" onPress={() => { void openLegalDoc('terms', locale); }}>
        {t('legal.termsShort')}
      </Text>
      {` ${t('legal.and')} `}
      <Text style={styles.agreementLink} accessibilityRole="link" onPress={() => { void openLegalDoc('privacy', locale); }}>
        {t('legal.privacyShort')}
      </Text>
      .
    </Text>
  );
}

/** "Read the full Privacy Policy" under the in-app privacy notice (legal T-02). */
export function PrivacyPolicyLink() {
  const { t, locale } = useLocalization();
  if (!getLegalUrl('privacy', locale)) return null;
  return (
    <Text style={styles.agreementLink} accessibilityRole="link" onPress={() => { void openLegalDoc('privacy', locale); }}>
      {t('legal.readFullPolicy')}
    </Text>
  );
}

export default function LegalLinks() {
  const { t, locale } = useLocalization();

  const contact = async () => {
    const url = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('DrinkMe')}`;
    try {
      if (await Linking.canOpenURL(url)) {
        await Linking.openURL(url);
        return;
      }
    } catch {
      // Falls back to showing the address.
    }
    Alert.alert(t('legal.contact'), t('legal.contactFallback', { email: CONTACT_EMAIL }));
  };

  const rows = DOCS.filter(({ doc }) => getLegalUrl(doc, locale) !== null);

  return (
    <View>
      {rows.map(({ doc, labelKey }) => (
        <TouchableOpacity
          key={doc}
          style={styles.row}
          onPress={() => { void openLegalDoc(doc, locale); }}
          accessibilityRole="link"
          accessibilityLabel={t(labelKey)}
        >
          <Text style={styles.rowText}>{t(labelKey)}</Text>
          <Ionicons name="open-outline" size={18} color="#6B7280" />
        </TouchableOpacity>
      ))}
      <TouchableOpacity style={styles.row} onPress={() => { void contact(); }} accessibilityRole="button" accessibilityLabel={t('legal.contact')}>
        <Text style={styles.rowText}>{t('legal.contact')}</Text>
        <Ionicons name="mail-outline" size={18} color="#6B7280" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1F2937',
  },
  rowText: {
    color: '#FFFFFF',
    fontSize: 15,
  },
  agreement: {
    color: '#9CA3AF',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 16,
  },
  agreementLink: {
    color: '#8B5FBF',
    textDecorationLine: 'underline',
  },
});
