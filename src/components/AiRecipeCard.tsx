import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useLocalization } from '../context/LocalizationContext';
import type { AiRecipe } from '../types/api';

type Props = {
  recipe: AiRecipe;
  isSaved: boolean;
  onPress: () => void;
  onToggleSave: () => void;
};

/** One AI recipe in a list: name, mocktail/alcohol badge, strength, AI label and a save toggle. */
export default function AiRecipeCard({ recipe, isSaved, onPress, onToggleSave }: Props) {
  const { t } = useLocalization();
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={t('ai.recipes.open', { name: recipe.name })}
    >
      <View style={styles.topRow}>
        <View style={[styles.badge, recipe.isAlcoholic ? styles.badgeAlcohol : styles.badgeMocktail]}>
          <Text style={styles.badgeText}>{recipe.isAlcoholic ? t('ai.recipes.alcoholic') : t('ai.recipes.mocktail')}</Text>
        </View>
        <View style={styles.aiBadge}>
          <Ionicons name="sparkles" size={11} color="#8B5FBF" />
          <Text style={styles.aiBadgeText}>{t('ai.aiGenerated')}</Text>
        </View>
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          onPress={onToggleSave}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityState={{ selected: isSaved }}
          accessibilityLabel={isSaved ? t('ai.recipes.unsaveLabel', { name: recipe.name }) : t('ai.recipes.saveLabel', { name: recipe.name })}
        >
          <Ionicons name={isSaved ? 'bookmark' : 'bookmark-outline'} size={22} color={isSaved ? '#8B5FBF' : '#9CA3AF'} />
        </TouchableOpacity>
      </View>
      <Text style={styles.name}>{recipe.name}</Text>
      {recipe.description ? <Text style={styles.description} numberOfLines={2}>{recipe.description}</Text> : null}
      <Text style={styles.meta} numberOfLines={1}>
        {recipe.ingredients.map((i) => i.name).join(' · ')}
      </Text>
      {recipe.isAlcoholic && (
        <Text style={styles.strength}>
          {t('ai.recipes.strength', { abv: String(recipe.estimatedAbv), count: String(recipe.standardDrinks) })}
        </Text>
      )}
      {recipe.warnings.length > 0 && (
        <View style={styles.warningRow}>
          <Ionicons name="warning-outline" size={14} color="#FFD700" />
          <Text style={styles.warningText} numberOfLines={1}>{t(`ai.recipes.warnings.${recipe.warnings[0]}`)}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1F2937',
    borderRadius: 14,
    padding: 14,
    gap: 6,
    borderWidth: 1,
    borderColor: '#374151',
  },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badge: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  badgeAlcohol: { backgroundColor: '#8B5FBF33' },
  badgeMocktail: { backgroundColor: '#10B98133' },
  badgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '600' },
  aiBadge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  aiBadgeText: { color: '#8B5FBF', fontSize: 11, fontWeight: '600' },
  name: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
  description: { color: '#9CA3AF', fontSize: 13, lineHeight: 18 },
  meta: { color: '#6B7280', fontSize: 12 },
  strength: { color: '#9CA3AF', fontSize: 12 },
  warningRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  warningText: { color: '#FFD700', fontSize: 12, flexShrink: 1 },
});
