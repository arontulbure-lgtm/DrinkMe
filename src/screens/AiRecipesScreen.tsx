import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import AiRecipeCard from '../components/AiRecipeCard';
import { useAuth } from '../context/AuthContext';
import { useLocalization } from '../context/LocalizationContext';
import { generateRecipes, getAiErrorKey, itemDisplayName, useSavedRecipes, useToggleSavedRecipe } from '../lib/ai';
import type { RootStackScreenProps } from '../navigation/types';
import type { AiRecipe } from '../types/api';

/**
 * AI recipe batches, either built around a scanned item (Smart Bar not used) or from the whole Smart Bar
 * (only its items + the user's basics). "Generate another batch" keeps the same input; the server remembers what
 * this session already showed and never repeats it.
 */
export default function AiRecipesScreen({ navigation, route }: RootStackScreenProps<'AiRecipes'>) {
  const request = route.params;
  const { t, locale } = useLocalization();
  const { profile } = useAuth();
  const [batches, setBatches] = useState<AiRecipe[][]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const isMounted = useRef(true);
  const savedQuery = useSavedRecipes();
  const toggleSaved = useToggleSavedRecipe();
  const savedIds = useMemo(() => new Set((savedQuery.data ?? []).map((r) => r.id)), [savedQuery.data]);

  const load = useCallback(async (newSession: boolean) => {
    setIsLoading(true);
    setErrorKey(null);
    try {
      const batch = await generateRecipes(request, locale, newSession);
      if (!isMounted.current) return;
      if (batch.exhausted || batch.recipes.length === 0) setExhausted(true);
      else setBatches((previous) => (newSession ? [batch.recipes] : [...previous, batch.recipes]));
    } catch (error) {
      if (isMounted.current) setErrorKey(getAiErrorKey(error));
    } finally {
      if (isMounted.current) setIsLoading(false);
    }
  }, [locale, request]);

  useEffect(() => {
    isMounted.current = true;
    load(true);
    return () => { isMounted.current = false; };
    // Only once per opening: "another batch" calls load(false) itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleSave = (recipe: AiRecipe) => {
    toggleSaved.mutate(
      { recipe, save: !savedIds.has(recipe.id) },
      { onError: (error) => Alert.alert(t('common.errorTitle'), t(getAiErrorKey(error) === 'ai.errors.recipe_limit' ? 'ai.errors.recipe_limit' : 'ai.recipes.saveFailed')) },
    );
  };

  const subtitle = request.mode === 'scan'
    ? t('ai.recipes.fromItem', { name: itemDisplayName(request.item, t(`ai.categories.${request.item.category}`)) })
    : t('ai.recipes.fromBar');
  const recipes = batches.flat();

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.back')}>
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('ai.recipes.title')}</Text>
        <View style={{ width: 24 }} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.subtitle}>{subtitle}</Text>
        <View style={styles.disclaimer}>
          <Ionicons name="sparkles" size={14} color="#8B5FBF" />
          <Text style={styles.disclaimerText}>{t('ai.recipes.disclaimer')}</Text>
        </View>
        {profile?.ageConfirmed !== true && <Text style={styles.muted}>{t('ai.recipes.mocktailsOnly')}</Text>}

        {batches.map((batch, index) => (
          <View key={index} style={styles.batch}>
            {index > 0 && <View style={styles.divider} />}
            {batch.map((recipe) => (
              <AiRecipeCard
                key={recipe.id}
                recipe={recipe}
                isSaved={savedIds.has(recipe.id)}
                onPress={() => navigation.navigate('AiRecipeDetail', { recipe })}
                onToggleSave={() => handleToggleSave(recipe)}
              />
            ))}
          </View>
        ))}

        {isLoading && (
          <View style={styles.loading} accessibilityLiveRegion="polite">
            <ActivityIndicator size="large" color="#8B5FBF" />
            <Text style={styles.loadingTitle}>{t('ai.recipes.generating')}</Text>
            <Text style={styles.muted}>{t('ai.recipes.generatingHint')}</Text>
          </View>
        )}

        {errorKey && !isLoading && (
          <View style={styles.errorBox} accessibilityLiveRegion="polite">
            <Text style={styles.errorText}>{t(errorKey)}</Text>
            <TouchableOpacity style={styles.retryButton} onPress={() => load(recipes.length === 0)} accessibilityRole="button">
              <Text style={styles.retryText}>{t('common.retry')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {exhausted && !isLoading && <Text style={styles.exhausted}>{t('ai.recipes.exhausted')}</Text>}

        {recipes.length > 0 && !isLoading && !exhausted && (
          <TouchableOpacity style={styles.anotherButton} onPress={() => load(false)} accessibilityRole="button">
            <Ionicons name="refresh" size={18} color="#FFFFFF" />
            <Text style={styles.anotherText}>{t('ai.recipes.another')}</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000000' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#1F2937',
  },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '600' },
  content: { padding: 16, gap: 12, paddingBottom: 60 },
  subtitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  disclaimer: { flexDirection: 'row', gap: 8, backgroundColor: '#0F172A', borderRadius: 10, padding: 10, alignItems: 'flex-start' },
  disclaimerText: { color: '#9CA3AF', fontSize: 12, lineHeight: 17, flexShrink: 1 },
  muted: { color: '#9CA3AF', fontSize: 13, textAlign: 'center' },
  batch: { gap: 12 },
  divider: { height: 1, backgroundColor: '#1F2937', marginVertical: 4 },
  loading: { alignItems: 'center', gap: 8, paddingVertical: 32 },
  loadingTitle: { color: '#FFFFFF', fontSize: 17, fontWeight: '600' },
  errorBox: { backgroundColor: '#EF444422', borderRadius: 12, padding: 14, gap: 10, alignItems: 'center' },
  errorText: { color: '#FFFFFF', fontSize: 15, textAlign: 'center' },
  retryButton: { backgroundColor: '#8B5FBF', borderRadius: 10, paddingHorizontal: 18, minHeight: 44, justifyContent: 'center' },
  retryText: { color: '#FFFFFF', fontWeight: '600' },
  exhausted: { color: '#9CA3AF', fontSize: 14, textAlign: 'center', paddingVertical: 12 },
  anotherButton: {
    flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1F2937',
    borderRadius: 12, minHeight: 48, borderWidth: 1, borderColor: '#8B5FBF',
  },
  anotherText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
});
