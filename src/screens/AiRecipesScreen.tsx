import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import AiRecipeCard from '../components/AiRecipeCard';
import { useAuth } from '../context/AuthContext';
import { useLocalization } from '../context/LocalizationContext';
import { getAiErrorKey, itemDisplayName, streamRecipes, useSavedRecipes, useToggleSavedRecipe, type RecipeStreamHandle } from '../lib/ai';
import type { RootStackScreenProps } from '../navigation/types';
import type { AiRecipe } from '../types/api';

/**
 * AI recipe batches, either built around a scanned item (Smart Bar not used) or from the whole Smart Bar
 * (only its items + the user's basics). "Generate another batch" keeps the same input; the server remembers what
 * this session already showed and never repeats it. Recipes arrive one by one (streamed) as each passes the
 * server's checks, so the first one is on screen long before the batch is complete.
 */
const EXPECTED_PER_BATCH = 4;
export default function AiRecipesScreen({ navigation, route }: RootStackScreenProps<'AiRecipes'>) {
  const request = route.params;
  const { t, locale } = useLocalization();
  const { profile } = useAuth();
  const [batches, setBatches] = useState<AiRecipe[][]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const isMounted = useRef(true);
  const streamRef = useRef<RecipeStreamHandle | null>(null);
  // Recipes of the batch being generated right now.
  const [currentCount, setCurrentCount] = useState(0);
  const savedQuery = useSavedRecipes();
  const toggleSaved = useToggleSavedRecipe();
  const savedIds = useMemo(() => new Set((savedQuery.data ?? []).map((r) => r.id)), [savedQuery.data]);

  const load = useCallback(async (newSession: boolean) => {
    setIsLoading(true);
    setErrorKey(null);
    setCurrentCount(0);
    // A new batch starts as an empty group that fills while recipes arrive.
    setBatches((previous) => (newSession ? [[]] : [...previous, []]));
    const handle = streamRecipes(request, locale, newSession, (recipe) => {
      if (!isMounted.current) return;
      setCurrentCount((n) => n + 1);
      setBatches((previous) => {
        const next = [...previous];
        next[next.length - 1] = [...next[next.length - 1], recipe];
        return next;
      });
    });
    streamRef.current = handle;
    try {
      const result = await handle.done;
      if (!isMounted.current) return;
      if (result.exhausted || result.count === 0) setExhausted(true);
    } catch (error) {
      if (isMounted.current && (error as { code?: string })?.code !== 'cancelled') setErrorKey(getAiErrorKey(error));
    } finally {
      if (isMounted.current) {
        setIsLoading(false);
        // Drop the group again if nothing arrived (error or exhausted).
        setBatches((previous) => previous.filter((batch, i) => batch.length > 0 || i < previous.length - 1));
      }
      streamRef.current = null;
    }
  }, [locale, request]);

  useEffect(() => {
    isMounted.current = true;
    load(true);
    return () => {
      isMounted.current = false;
      streamRef.current?.cancel();
    };
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
            {Array.from({ length: Math.max(0, EXPECTED_PER_BATCH - currentCount) }, (_, i) => (
              <View key={i} style={styles.placeholder} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <View style={styles.placeholderLine} />
                <View style={[styles.placeholderLine, { width: '60%' }]} />
              </View>
            ))}
            <View style={styles.progressRow}>
              <ActivityIndicator color="#8B5FBF" />
              <Text style={styles.loadingTitle}>
                {currentCount === 0 ? t('ai.recipes.generating') : t('ai.recipes.progress', { count: String(currentCount), total: String(EXPECTED_PER_BATCH) })}
              </Text>
            </View>
            <Text style={styles.muted}>{t('ai.recipes.generatingHint')}</Text>
          </View>
        )}

        {errorKey && !isLoading && (
          <View style={styles.errorBox} accessibilityLiveRegion="polite">
            <Text style={styles.errorText}>{t(errorKey)}</Text>
            {/* A daily limit lasts until tomorrow: no retry button that can only fail again. */}
            {errorKey !== 'ai.errors.ai_daily_limit' && (
              <TouchableOpacity style={styles.retryButton} onPress={() => load(recipes.length === 0)} accessibilityRole="button">
                <Text style={styles.retryText}>{t('common.retry')}</Text>
              </TouchableOpacity>
            )}
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
  loading: { alignItems: 'stretch', gap: 10, paddingVertical: 8 },
  placeholder: { backgroundColor: '#1F2937', borderRadius: 14, padding: 14, gap: 8, opacity: 0.6 },
  placeholderLine: { height: 12, borderRadius: 6, backgroundColor: '#374151', width: '85%' },
  progressRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 6 },
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
