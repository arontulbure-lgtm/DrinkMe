import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useLocalization } from '../context/LocalizationContext';

type Props = {
  // Without onAccept the card is read-only (AI settings shows it as information).
  onAccept?: () => void;
  isAccepting?: boolean;
  errorText?: string | null;
};

/** The AI transparency notice: what the scanner does with the photo, AI recipes can be wrong, 18+. */
export default function AiNoticeCard({ onAccept, isAccepting = false, errorText }: Props) {
  const { t } = useLocalization();
  return (
    <View style={styles.card} accessibilityRole="summary">
      <View style={styles.titleRow}>
        <Ionicons name="sparkles" size={18} color="#8B5FBF" />
        <Text style={styles.title}>{onAccept ? t('ai.notice.title') : t('ai.settings.noticeTitle')}</Text>
      </View>
      <Text style={styles.body}>{t('ai.notice.body')}</Text>
      {errorText ? <Text style={styles.error}>{errorText}</Text> : null}
      {onAccept && (
        <TouchableOpacity
          style={[styles.button, isAccepting && styles.buttonDisabled]}
          onPress={onAccept}
          disabled={isAccepting}
          accessibilityRole="button"
          accessibilityLabel={t('ai.notice.accept')}
        >
          {isAccepting ? <ActivityIndicator color="#FFFFFF" size="small" /> : <Text style={styles.buttonText}>{t('ai.notice.accept')}</Text>}
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#0F172A',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#8B5FBF44',
    gap: 10,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: '#FFFFFF', fontSize: 16, fontWeight: '600', flexShrink: 1 },
  body: { color: '#9CA3AF', fontSize: 14, lineHeight: 20 },
  error: { color: '#EF4444', fontSize: 13 },
  button: {
    backgroundColor: '#8B5FBF',
    borderRadius: 12,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
});
