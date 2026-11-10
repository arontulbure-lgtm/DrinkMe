import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalization } from '../context/LocalizationContext';

interface ListLoadStateProps {
  isError: boolean;
  isFetching: boolean;
  message: string;
  onRetry: () => void;
}

// For a list with no data yet: a spinner, or the error with a retry, so a failure never looks empty.
export default function ListLoadState({ isError, isFetching, message, onRetry }: ListLoadStateProps) {
  const { t } = useLocalization();
  if (!isError || isFetching) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#8B5FBF" />
      </View>
    );
  }
  return (
    <View style={styles.container}>
      <Ionicons name="cloud-offline-outline" size={48} color="#6B7280" />
      <Text style={styles.message}>{message}</Text>
      <TouchableOpacity
        style={styles.retryButton}
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel={t('common.retry')}
      >
        <Text style={styles.retryText}>{t('common.retry')}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: 48,
    paddingHorizontal: 16,
    gap: 16,
  },
  message: {
    fontSize: 14,
    color: '#9CA3AF',
    textAlign: 'center',
    lineHeight: 20,
  },
  retryButton: {
    backgroundColor: '#8B5FBF',
    paddingHorizontal: 24,
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 8,
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
