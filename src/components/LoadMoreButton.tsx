import React from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useLocalization } from '../context/LocalizationContext';

interface LoadMoreButtonProps {
  // fetchNextPage fits this: it resolves with the query state instead of rejecting.
  onPress: () => Promise<{ isError: boolean }>;
  isLoading: boolean;
}

export default function LoadMoreButton({ onPress, isLoading }: LoadMoreButtonProps) {
  const { t } = useLocalization();
  const handlePress = async () => {
    const { isError } = await onPress();
    if (isError) Alert.alert(t('common.loadMoreError'));
  };
  return (
    <TouchableOpacity
      style={styles.button}
      onPress={handlePress}
      disabled={isLoading}
      accessibilityRole="button"
      accessibilityLabel={t('common.loadMore')}
    >
      {isLoading ? (
        <ActivityIndicator size="small" color="#8B5FBF" />
      ) : (
        <Text style={styles.text}>{t('common.loadMore')}</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    alignSelf: 'center',
    minHeight: 44,
    minWidth: 140,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    marginVertical: 12,
    borderRadius: 20,
    backgroundColor: '#1F2937',
  },
  text: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '500',
  },
});
