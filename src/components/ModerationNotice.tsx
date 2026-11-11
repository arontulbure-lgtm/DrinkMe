import React from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { useLocalization } from '../context/LocalizationContext';

interface ModerationNoticeProps {
  // moderation.hiddenPost, moderation.hiddenComment or moderation.hiddenProfile.
  messageKey: string;
  style?: StyleProp<ViewStyle>;
}

// A small notice the owner sees on their own content while it is hidden from others after reports.
export default function ModerationNotice({ messageKey, style }: ModerationNoticeProps) {
  const { t } = useLocalization();
  return (
    <View style={[styles.notice, style]} accessibilityRole="text">
      <Ionicons name="eye-off-outline" size={14} color="#FFD700" />
      <Text style={styles.noticeText}>{t(messageKey)}</Text>
    </View>
  );
}

// Shown on Home and on the own Profile while the account is suspended. The server sends the end date
// only to the owner (suspendedUntil, null when permanent).
export function SuspensionBanner() {
  const { profile } = useAuth();
  const { t, locale } = useLocalization();
  const isPermanent = profile?.suspendedPermanently === true;
  const until = profile?.suspendedUntil;
  if (!isPermanent && !until) return null;
  // A lapsed date means the suspension has ended; the next profile refresh drops the fields.
  if (!isPermanent && until && new Date(until).getTime() <= Date.now()) return null;

  const message = isPermanent
    ? t('moderation.suspendedPermanent')
    : t('moderation.suspendedUntil', {
        date: new Date(until as string).toLocaleString(locale === 'ro' ? 'ro-RO' : 'en-GB', {
          dateStyle: 'medium',
          timeStyle: 'short',
        }),
      });

  return (
    <View style={styles.banner} accessibilityRole="alert">
      <Ionicons name="alert-circle-outline" size={20} color="#EF4444" />
      <View style={styles.bannerBody}>
        <Text style={styles.bannerTitle}>{t('moderation.suspendedTitle')}</Text>
        <Text style={styles.bannerText}>{message}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#374151',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  noticeText: {
    flex: 1,
    color: '#9CA3AF',
    fontSize: 12,
    lineHeight: 16,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: '#1F2937',
    borderWidth: 1,
    borderColor: '#EF4444',
    borderRadius: 12,
    marginHorizontal: 16,
    marginTop: 12,
    padding: 12,
  },
  bannerBody: {
    flex: 1,
  },
  bannerTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  bannerText: {
    color: '#9CA3AF',
    fontSize: 13,
    lineHeight: 18,
  },
});
