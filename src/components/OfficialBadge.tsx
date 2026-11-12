import React from 'react';
import { View, Text, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalization } from '../context/LocalizationContext';

interface OfficialBadgeProps {
  // The server's `official` flag on a user view; nothing renders unless it is exactly true.
  official?: boolean;
  size?: 'small' | 'large';
  style?: StyleProp<ViewStyle>;
}

// "Official" / "Oficial" next to the name of the official DrinkMe account (OFFICIAL_USER_IDS on the server).
// It never shrinks: put the name in a row with flexShrink 1 so the name is cut first, never the badge.
export default function OfficialBadge({ official, size = 'small', style }: OfficialBadgeProps) {
  const { t } = useLocalization();
  if (official !== true) return null;
  const isLarge = size === 'large';
  return (
    <View
      style={[styles.badge, isLarge && styles.badgeLarge, style]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={t('official.accessibilityLabel')}
    >
      <Ionicons name="checkmark-circle" size={isLarge ? 14 : 12} color="#FFFFFF" />
      <Text style={[styles.text, isLarge && styles.textLarge]} numberOfLines={1}>
        {t('official.badge')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    marginLeft: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: '#8B5FBF',
  },
  badgeLarge: {
    marginLeft: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  text: {
    marginLeft: 3,
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  textLarge: {
    fontSize: 13,
  },
});
