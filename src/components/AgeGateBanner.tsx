import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { useLocalization } from '../context/LocalizationContext';
import { useConfirmAge } from '../lib/useConfirmAge';

// Tells an unconfirmed user why alcoholic posts are missing, and how to change that.
export default function AgeGateBanner() {
  const { profile } = useAuth();
  const { t } = useLocalization();
  const { promptConfirmAge, isConfirming } = useConfirmAge();

  if (!profile || profile.ageConfirmed === true) return null;

  return (
    <View style={styles.banner}>
      <Ionicons name="leaf-outline" size={18} color="#8B5FBF" />
      <Text style={styles.text}>{t('ageGate.banner')}</Text>
      <TouchableOpacity
        style={styles.action}
        onPress={promptConfirmAge}
        disabled={isConfirming}
        accessibilityRole="button"
        accessibilityLabel={t('ageGate.bannerAction')}
      >
        {isConfirming ? (
          <ActivityIndicator size="small" color="#FFFFFF" />
        ) : (
          <Text style={styles.actionText}>{t('ageGate.bannerAction')}</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#1F2937',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  text: {
    flex: 1,
    color: '#D1D5DB',
    fontSize: 13,
    lineHeight: 18,
  },
  action: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#8B5FBF',
  },
  actionText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
});
