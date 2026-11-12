import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Recipe } from '../types/api';
import { RootStackScreenProps } from '../navigation/types';
import { useLocalization } from '../context/LocalizationContext';

type Props = RootStackScreenProps<'RecipeResults'>;

// Translation keys for the difficulty chip (recipeResults.difficulty.*).
const difficultyLabels: Record<Recipe['difficulty'], string> = {
  easy: 'recipeResults.difficulty.easy',
  medium: 'recipeResults.difficulty.medium',
  hard: 'recipeResults.difficulty.hard',
  mocktail: 'recipeResults.difficulty.mocktail',
};

const difficultyColors: Record<Recipe['difficulty'], string> = {
  easy: '#22C55E',
  medium: '#F97316',
  hard: '#EF4444',
  mocktail: '#0EA5E9',
};

export default function RecipeResultsScreen({ route, navigation }: Props) {
  const { t } = useLocalization();
  const { product, recipes } = route.params;

  return (
    <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={navigation.goBack}
          hitSlop={11}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        >
          <Ionicons name="close" size={22} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('recipeResults.title', { product })}</Text>
        <View style={{ width: 22 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {recipes.map((recipe) => (
          <View key={recipe.title} style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>{recipe.title}</Text>
              <View
                style={[styles.difficultyChip, { backgroundColor: difficultyColors[recipe.difficulty] }]}
              >
                <Text style={styles.difficultyText}>{t(difficultyLabels[recipe.difficulty])}</Text>
              </View>
            </View>

            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Ionicons name="list" size={16} color="#8B5FBF" />
                <Text style={styles.sectionTitle}>{t('recipeResults.ingredients')}</Text>
              </View>
              {recipe.ingredients.map((ingredient) => (
                <Text key={ingredient.name} style={styles.ingredientText}>
                  {ingredient.name}: {ingredient.amount_oz.toFixed(1)} oz / {ingredient.amount_ml.toFixed(0)} ml
                </Text>
              ))}
            </View>

            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Ionicons name="construct" size={16} color="#8B5FBF" />
                <Text style={styles.sectionTitle}>{t('recipeResults.instructions')}</Text>
              </View>
              <Text style={styles.instructionsText}>{recipe.instructions}</Text>
            </View>

            {recipe.garnish && (
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <Ionicons name="leaf" size={16} color="#8B5FBF" />
                  <Text style={styles.sectionTitle}>{t('recipeResults.garnish')}</Text>
                </View>
                <Text style={styles.instructionsText}>{recipe.garnish}</Text>
              </View>
            )}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1F2937',
  },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
    textAlign: 'center',
  },
  content: {
    padding: 16,
    gap: 16,
  },
  card: {
    backgroundColor: '#111827',
    borderRadius: 16,
    padding: 16,
    gap: 16,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  cardTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
    flex: 1,
  },
  difficultyChip: {
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  difficultyText: {
    color: '#000000',
    fontWeight: '600',
    fontSize: 12,
  },
  section: {
    gap: 8,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sectionTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  ingredientText: {
    color: '#D1D5DB',
    fontSize: 13,
  },
  instructionsText: {
    color: '#D1D5DB',
    fontSize: 13,
    lineHeight: 18,
  },
});
