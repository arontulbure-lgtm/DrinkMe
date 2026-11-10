import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useLocalization } from '../context/LocalizationContext';
import { useConfirmAge } from '../lib/useConfirmAge';

interface Props {
  onDecline: () => void;
}

// Shown after the session is ready, to a user who has not confirmed. Declining is not stored, so the
// question comes back on the next launch.
export default function AgeGateScreen({ onDecline }: Props) {
  const { t } = useLocalization();
  const { confirmAge, isConfirming } = useConfirmAge();

  return (
    <SafeAreaView style={styles.container}>
      <Ionicons name="shield-checkmark-outline" size={48} color="#8B5FBF" />
      <Text style={styles.title}>{t('ageGate.title')}</Text>
      <Text style={styles.body}>{t('ageGate.body')}</Text>
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.confirmButton}
          onPress={confirmAge}
          disabled={isConfirming}
          accessibilityRole="button"
          accessibilityLabel={t('ageGate.confirm')}
        >
          {isConfirming ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.confirmText}>{t('ageGate.confirm')}</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.declineButton}
          onPress={onDecline}
          accessibilityRole="button"
          accessibilityLabel={t('ageGate.decline')}
        >
          <Text style={styles.declineText}>{t('ageGate.decline')}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: '#FFFFFF',
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    color: '#9CA3AF',
    textAlign: 'center',
    lineHeight: 20,
  },
  actions: {
    alignSelf: 'stretch',
    gap: 12,
    marginTop: 8,
  },
  confirmButton: {
    backgroundColor: '#8B5FBF',
    minHeight: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  confirmText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  declineButton: {
    backgroundColor: '#1F2937',
    minHeight: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  declineText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
});
