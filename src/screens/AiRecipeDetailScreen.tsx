import React, { useMemo } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { useLocalization } from '../context/LocalizationContext';
import { formatAmount, getAiErrorKey, useSavedRecipes, useToggleSavedRecipe } from '../lib/ai';
import type { RootStackScreenProps } from '../navigation/types';

export default function AiRecipeDetailScreen({ navigation, route }: RootStackScreenProps<'AiRecipeDetail'>) {
  const { recipe } = route.params;
  const { t } = useLocalization();
  const savedQuery = useSavedRecipes();
  const toggleSaved = useToggleSavedRecipe();
  const isSaved = useMemo(() => (savedQuery.data ?? []).some((r) => r.id === recipe.id), [recipe.id, savedQuery.data]);

  const handleToggle = () => {
    toggleSaved.mutate(
      { recipe, save: !isSaved },
      { onError: (error) => Alert.alert(t('common.errorTitle'), t(getAiErrorKey(error) === 'ai.errors.recipe_limit' ? 'ai.errors.recipe_limit' : 'ai.recipes.saveFailed')) },
    );
  };

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.back')}>
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          onPress={handleToggle}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityState={{ selected: isSaved }}
          accessibilityLabel={isSaved ? t('ai.recipes.unsaveLabel', { name: recipe.name }) : t('ai.recipes.saveLabel', { name: recipe.name })}
        >
          <Ionicons name={isSaved ? 'bookmark' : 'bookmark-outline'} size={24} color={isSaved ? '#8B5FBF' : '#FFFFFF'} />
        </TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.badgeRow}>
          <View style={[styles.badge, recipe.isAlcoholic ? styles.badgeAlcohol : styles.badgeMocktail]}>
            <Text style={styles.badgeText}>{recipe.isAlcoholic ? t('ai.recipes.alcoholic') : t('ai.recipes.mocktail')}</Text>
          </View>
          <View style={styles.aiBadge}>
            <Ionicons name="sparkles" size={12} color="#8B5FBF" />
            <Text style={styles.aiBadgeText}>{t('ai.aiGenerated')}</Text>
          </View>
        </View>
        <Text style={styles.name}>{recipe.name}</Text>
        {recipe.description ? <Text style={styles.description}>{recipe.description}</Text> : null}
        {recipe.isAlcoholic && (
          <Text style={styles.strength}>
            {t('ai.recipes.strength', { abv: String(recipe.estimatedAbv), count: String(recipe.standardDrinks) })}
          </Text>
        )}

        {recipe.warnings.map((warning) => (
          <View key={warning} style={styles.warning} accessibilityRole="alert">
            <Ionicons name="warning-outline" size={18} color="#FFD700" />
            <Text style={styles.warningText}>{t(`ai.recipes.warnings.${warning}`)}</Text>
          </View>
        ))}

        <View style={styles.facts}>
          <Fact label={t('ai.recipes.glass')} value={recipe.glass} />
          <Fact label={t('ai.recipes.method')} value={t(`ai.recipes.methods.${recipe.method}`)} />
          {recipe.garnish ? <Fact label={t('ai.recipes.garnish')} value={recipe.garnish} /> : null}
        </View>

        <Text style={styles.sectionTitle}>{t('ai.recipes.ingredients')}</Text>
        <View style={styles.card}>
          {recipe.ingredients.map((ingredient, index) => (
            <View key={`${ingredient.name}-${index}`} style={styles.ingredientRow}>
              <Text style={styles.amount}>{formatAmount(ingredient.amount, ingredient.unit, t('ai.recipes.piece'))}</Text>
              <Text style={styles.ingredientName}>
                {ingredient.name}
                {ingredient.optional ? ` (${t('ai.recipes.optional')})` : ''}
              </Text>
            </View>
          ))}
        </View>

        {recipe.youWillAlsoNeed.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>{t('ai.recipes.youWillAlsoNeed')}</Text>
            <View style={styles.chips}>
              {recipe.youWillAlsoNeed.map((name) => (
                <View key={name} style={styles.chip}><Text style={styles.chipText}>{name}</Text></View>
              ))}
            </View>
          </>
        )}

        <Text style={styles.sectionTitle}>{t('ai.recipes.steps')}</Text>
        <View style={styles.card}>
          {recipe.steps.map((step, index) => (
            <View key={index} style={styles.stepRow}>
              <View style={styles.stepNumber}><Text style={styles.stepNumberText}>{index + 1}</Text></View>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}
        </View>

        {recipe.responsibleNote ? <Text style={styles.responsible}>{recipe.responsibleNote}</Text> : null}
        <Text style={styles.disclaimer}>{t('ai.recipes.disclaimer')}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000000' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#1F2937' },
  content: { padding: 20, gap: 12, paddingBottom: 60 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  badge: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 3 },
  badgeAlcohol: { backgroundColor: '#8B5FBF55' },
  badgeMocktail: { backgroundColor: '#10B98144' },
  badgeText: { color: '#FFFFFF', fontSize: 12, fontWeight: '600' },
  aiBadge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  aiBadgeText: { color: '#8B5FBF', fontSize: 12, fontWeight: '600' },
  name: { color: '#FFFFFF', fontSize: 26, fontWeight: '700' },
  description: { color: '#9CA3AF', fontSize: 15, lineHeight: 21 },
  strength: { color: '#9CA3AF', fontSize: 13 },
  warning: { flexDirection: 'row', gap: 8, backgroundColor: '#FFD70022', borderRadius: 10, padding: 12, alignItems: 'flex-start' },
  warningText: { color: '#FFFFFF', fontSize: 14, lineHeight: 19, flexShrink: 1 },
  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  fact: { backgroundColor: '#1F2937', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, minWidth: 96 },
  factLabel: { color: '#6B7280', fontSize: 11, fontWeight: '600', textTransform: 'uppercase' },
  factValue: { color: '#FFFFFF', fontSize: 14, marginTop: 2 },
  sectionTitle: { color: '#FFFFFF', fontSize: 17, fontWeight: '700', marginTop: 8 },
  card: { backgroundColor: '#0F172A', borderRadius: 12, padding: 14, gap: 10, borderWidth: 1, borderColor: '#1F2937' },
  ingredientRow: { flexDirection: 'row', gap: 12 },
  amount: { color: '#8B5FBF', fontSize: 15, fontWeight: '600', minWidth: 72 },
  ingredientName: { color: '#FFFFFF', fontSize: 15, flexShrink: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: '#1F2937', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: '#374151' },
  chipText: { color: '#FFFFFF', fontSize: 13 },
  stepRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  stepNumber: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#8B5FBF', alignItems: 'center', justifyContent: 'center' },
  stepNumberText: { color: '#FFFFFF', fontWeight: '700', fontSize: 13 },
  stepText: { color: '#FFFFFF', fontSize: 15, lineHeight: 21, flexShrink: 1 },
  responsible: { color: '#FFD700', fontSize: 13, lineHeight: 19, marginTop: 8 },
  disclaimer: { color: '#6B7280', fontSize: 12, lineHeight: 17 },
});
