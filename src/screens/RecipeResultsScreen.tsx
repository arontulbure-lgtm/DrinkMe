import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Recipe } from '../types/api';

interface Props {
  route: { params: { product: string; recipes: Recipe[] } };
  navigation: { goBack: () => void };
}

const difficultyLabels: Record<Recipe['difficulty'], string> = {
  easy: 'Ușor',
  medium: 'Medie',
  hard: 'Dificil',
  mocktail: 'Mocktail',
};

const difficultyColors: Record<Recipe['difficulty'], string> = {
  easy: '#22C55E',
  medium: '#F97316',
  hard: '#EF4444',
  mocktail: '#0EA5E9',
};

export default function RecipeResultsScreen({ route, navigation }: Props) {
  const { product, recipes } = route.params;

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
      <View style={styles.header}>
        <Ionicons name="close" size={22} color="#FFFFFF" onPress={navigation.goBack} />
        <Text style={styles.headerTitle}>Rețete pentru {product}</Text>
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
                <Text style={styles.difficultyText}>{difficultyLabels[recipe.difficulty]}</Text>
              </View>
            </View>

            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Ionicons name="list" size={16} color="#8B5FBF" />
                <Text style={styles.sectionTitle}>Ingrediente</Text>
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
                <Text style={styles.sectionTitle}>Instrucțiuni</Text>
              </View>
              <Text style={styles.instructionsText}>{recipe.instructions}</Text>
            </View>

            {recipe.garnish && (
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <Ionicons name="leaf" size={16} color="#8B5FBF" />
                  <Text style={styles.sectionTitle}>Garnish</Text>
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
