import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { flattenPages, getNextCursor } from '../lib/drinkCache';
import { useDrinkToggles } from '../lib/useDrinkToggles';
import LoadMoreButton from '../components/LoadMoreButton';
import PostActionsSheet from '../components/PostActionsSheet';
import { TabScreenProps } from '../navigation/types';

import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, FontAwesome5 } from '@expo/vector-icons';
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { apiFetch, ApiError } from '../lib/api';
import { Drink, Page, SmartBarItem } from '../types/api';
import { getAiErrorKey, useAcceptAiNotice, useAiStatus, useSavedRecipes, useToggleSavedRecipe } from '../lib/ai';
import AiNoticeCard from '../components/AiNoticeCard';
import AiRecipeCard from '../components/AiRecipeCard';
import { useLocalization } from '../context/LocalizationContext';
import DrinkPostCard from '../components/DrinkPostCard';
import CommentDrawer from '../components/CommentDrawer';

// ── Kill switch: real AI recipes only while this is true AND GET /api/ai/status says available; otherwise the
// "coming soon" preview stays. Never delete the preview.
const AI_RECIPES_ENABLED = true;

type Tab = 'inventory' | 'recipes' | 'saved';
type SavedSection = 'posts' | 'recipes';

export default function SmartBarScreen({ navigation }: TabScreenProps<'SmartBar'>) {
  const [isAddingItem, setIsAddingItem] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [newItemQuantity, setNewItemQuantity] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('inventory');
  const [savedSection, setSavedSection] = useState<SavedSection>('posts');
  const [commentDrinkId, setCommentDrinkId] = useState<number | null>(null);
  const [actionsDrink, setActionsDrink] = useState<Drink | null>(null);

  const { serverUserId, getJwtToken, profile } = useAuth();
  const isAgeConfirmed = profile?.ageConfirmed === true;
  const queryClient = useQueryClient();
  const { t, locale } = useLocalization();
  const insets = useSafeAreaInsets();
  const aiStatus = useAiStatus(locale, AI_RECIPES_ENABLED);
  const acceptNotice = useAcceptAiNotice();
  const isAiAvailable = AI_RECIPES_ENABLED && aiStatus.data?.available === true;
  const savedRecipesQuery = useSavedRecipes(activeTab === 'saved' && savedSection === 'recipes');
  const savedRecipes = useMemo(() => savedRecipesQuery.data ?? [], [savedRecipesQuery.data]);
  const toggleSavedRecipe = useToggleSavedRecipe();
  const extraScrollInset = useMemo(() => insets.bottom + 120, [insets.bottom]);

  const { data: inventory = [], isLoading } = useQuery<SmartBarItem[]>({
    queryKey: ['smartBar.inventory'],
    enabled: !!serverUserId,
    queryFn: () => apiFetch<SmartBarItem[]>('/api/smart-bar'),
  });

  const {
    data: savedDrinkPages,
    isLoading: isSavedLoading,
    hasNextPage: hasMoreSaved,
    fetchNextPage: fetchMoreSaved,
    isFetchingNextPage: isFetchingMoreSaved,
  } = useInfiniteQuery({
    queryKey: ['users.savedDrinks', serverUserId],
    enabled: !!serverUserId,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      apiFetch<Page<Drink>>(`/api/users/${serverUserId}/saved-drinks`, { query: { before: pageParam } }),
    getNextPageParam: getNextCursor,
  });
  const savedDrinks = useMemo(() => flattenPages(savedDrinkPages), [savedDrinkPages]);

  const applyLocalUser = useCallback(
    (drink: Drink) => {
      if (profile && serverUserId && drink.userId === serverUserId) {
        return { ...drink, user: profile };
      }
      return drink;
    },
    [profile, serverUserId]
  );

  const addItemMutation = useMutation({
    mutationFn: async (item: { name: string; quantity: string; unit: string }) => {
      const token = await getJwtToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      return apiFetch('/api/smart-bar', {
        method: 'POST',
        headers,
        body: JSON.stringify(item),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['smartBar.inventory'] });
      setNewItemName('');
      setNewItemQuantity('');
      setIsAddingItem(false);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'smart_bar_limit') {
        Alert.alert(t('smartBar.addItemTitle'), t('smartBar.itemLimit'));
        return;
      }
      const isStorageFull = error instanceof ApiError && error.status === 507;
      Alert.alert(t('common.errorTitle'), isStorageFull ? t('common.serviceUnavailable') : t('smartBar.addFailed'));
    },
  });

  const deleteItemMutation = useMutation({
    mutationFn: async (itemId: number) => {
      const token = await getJwtToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      await apiFetch(`/api/smart-bar/${itemId}`, {
        method: 'DELETE',
        headers,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['smartBar.inventory'] });
    },
    onError: () => {
      Alert.alert(t('common.errorTitle'), t('smartBar.removeFailed'));
    },
  });

  const handleAddItem = () => {
    if (!newItemName.trim() || !newItemQuantity.trim()) {
      Alert.alert(t('common.errorTitle'), t('smartBar.fillAllFields'));
      return;
    }
    addItemMutation.mutate({
      name: newItemName.trim(),
      quantity: newItemQuantity.trim(),
      unit: 'bottle',
    });
  };

  const handleDeleteItem = useCallback(
    (itemId: number, itemName: string) => {
      Alert.alert(
        t('smartBar.removeTitle'),
        t('smartBar.removeConfirm', { name: itemName }),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('common.remove'),
            style: 'destructive',
            onPress: () => deleteItemMutation.mutate(itemId),
          },
        ]
      );
    },
    [deleteItemMutation, t]
  );

  const handleToggleSavedRecipe = useCallback((recipe: (typeof savedRecipes)[number]) => {
    toggleSavedRecipe.mutate({ recipe, save: false }, {
      onError: (error) => Alert.alert(t('common.errorTitle'), t(getAiErrorKey(error) === 'ai.errors.generic' ? 'ai.recipes.saveFailed' : getAiErrorKey(error))),
    });
  }, [t, toggleSavedRecipe]);

  const { toggleCheer, toggleSave } = useDrinkToggles();

  // ── Inventory tab ──────────────────────────────────────────────
  const inventoryContent = useMemo(() => {
    if (isLoading) {
      return (
        <View style={styles.loadingState}>
          <Ionicons name="hourglass" size={32} color="#6B7280" />
          <Text style={styles.loadingText}>{t('smartBar.inventoryEmptySubtitle')}</Text>
        </View>
      );
    }

    if (inventory.length === 0) {
      return (
        <View style={styles.emptyState}>
          <FontAwesome5 name="glass-martini" size={40} color="#6B7280" />
          <Text style={styles.emptyTitle}>{t('smartBar.inventoryEmptyTitle')}</Text>
          <Text style={styles.emptySubtitle}>{t('smartBar.inventoryEmptySubtitle')}</Text>
          <TouchableOpacity style={styles.addButton} onPress={() => setIsAddingItem(true)}>
            <Ionicons name="add" size={20} color="#FFFFFF" />
            <Text style={styles.addButtonText}>{t('smartBar.addFirst')}</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <View style={styles.inventoryList}>
        {inventory.map((item) => (
          <View key={item.id} style={styles.inventoryItem}>
            <View style={styles.itemLeft}>
              <View style={styles.itemIcon}>
                <Ionicons name="wine-outline" size={20} color="#8B5FBF" />
              </View>
              <View>
                <Text style={styles.itemName}>{item.name}</Text>
                <Text style={styles.itemQuantity}>{item.quantity}</Text>
              </View>
            </View>
            <TouchableOpacity
              style={styles.deleteButton}
              onPress={() => handleDeleteItem(item.id, item.name)}
              hitSlop={7}
              accessibilityRole="button"
              accessibilityLabel={t('smartBar.removeItemLabel', { name: item.name })}
            >
              <Ionicons name="trash-outline" size={18} color="#EF4444" />
            </TouchableOpacity>
          </View>
        ))}
      </View>
    );
  }, [handleDeleteItem, inventory, isLoading, t]);

  // ── Recipes tab ────────────────────────────────────────────────
  const recipesContent = useMemo(() => {
    if (isLoading) {
      return (
        <View style={styles.loadingState}>
          <ActivityIndicator color="#8B5FBF" />
        </View>
      );
    }

    if (inventory.length === 0) {
      return (
        <View style={styles.emptyState}>
          <Ionicons name="flask-outline" size={40} color="#6B7280" />
          <Text style={styles.emptyTitle}>{t('smartBar.inventoryEmptyTitle')}</Text>
          <Text style={styles.emptySubtitle}>{t('smartBar.selectIngredientsHint')}</Text>
          <TouchableOpacity
            style={styles.addButton}
            onPress={() => {
              setActiveTab('inventory');
              setIsAddingItem(true);
            }}
          >
            <Ionicons name="add" size={20} color="#FFFFFF" />
            <Text style={styles.addButtonText}>{t('smartBar.addFirst')}</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (!isAiAvailable) {
      return (
        <View style={styles.betaContainer}>
          {/* Coming soon badge */}
          <View style={styles.betaBadge}>
            <Ionicons name="flask" size={13} color="#8B5FBF" />
            <Text style={styles.betaBadgeText}>{t('common.betaComingSoon')}</Text>
          </View>

          {/* Hero */}
          <View style={styles.betaHeroWrapper}>
            <View style={styles.betaHeroCircle}>
              <Ionicons name="flask" size={44} color="#8B5FBF" />
            </View>
            <View style={styles.betaLockBadge}>
              <Ionicons name="lock-closed" size={12} color="#FFFFFF" />
            </View>
          </View>

          <Text style={styles.betaTitle}>{t('smartBar.aiTitle')}</Text>
          <Text style={styles.betaDesc}>
            {isAgeConfirmed
              ? t('smartBar.recipesIntro')
              : t('ageGate.recipesIntro')}
          </Text>

          {/* Feature cards */}
          <View style={styles.betaFeatureList}>
            <View style={styles.betaFeatureRow}>
              <Ionicons name="checkmark-circle" size={18} color="#8B5FBF" />
              <Text style={styles.betaFeatureText}>{t('smartBar.featurePick')}</Text>
            </View>
            <View style={styles.betaFeatureRow}>
              <Ionicons name="checkmark-circle" size={18} color="#8B5FBF" />
              <Text style={styles.betaFeatureText}>
                {isAgeConfirmed ? t('smartBar.featureRecipes') : t('ageGate.recipesFeature')}
              </Text>
            </View>
            <View style={styles.betaFeatureRow}>
              <Ionicons name="checkmark-circle" size={18} color="#8B5FBF" />
              <Text style={styles.betaFeatureText}>{t('smartBar.featureSave')}</Text>
            </View>
          </View>

          <Text style={styles.betaNote}>
            {AI_RECIPES_ENABLED && (aiStatus.isError || aiStatus.data?.available === false) ? t('ai.unavailable') : t('smartBar.betaNote')}
          </Text>
        </View>
      );
    }

    if (!aiStatus.data?.noticeAccepted) {
      return (
        <AiNoticeCard
          onAccept={() => acceptNotice.mutate()}
          isAccepting={acceptNotice.isPending}
          errorText={acceptNotice.isError ? t(getAiErrorKey(acceptNotice.error)) : null}
        />
      );
    }

    // Option (b): only the Smart Bar items plus the user's basics. The server enforces it (rule S10).
    return (
      <View style={styles.aiGenerateCard}>
        <View style={styles.aiGenerateTitleRow}>
          <Ionicons name="flask" size={20} color="#8B5FBF" />
          <Text style={styles.aiGenerateTitle}>{t('ai.recipes.generateTitle')}</Text>
        </View>
        <Text style={styles.betaDesc}>{t('ai.recipes.generateIntro')}</Text>
        <Text style={styles.aiBasicsLabel}>{t('ai.recipes.basics')}</Text>
        <View style={styles.aiBasicsRow}>
          {aiStatus.data.settings.basics.map((basic) => (
            <View key={basic} style={styles.aiBasicChip}>
              <Text style={styles.aiBasicChipText}>{basic}</Text>
            </View>
          ))}
          <TouchableOpacity
            onPress={() => navigation.navigate('AiSettings')}
            style={styles.aiEditBasics}
            hitSlop={8}
            accessibilityRole="button"
          >
            <Ionicons name="create-outline" size={14} color="#8B5FBF" />
            <Text style={styles.aiEditBasicsText}>{t('ai.recipes.editBasics')}</Text>
          </TouchableOpacity>
        </View>
        {!isAgeConfirmed && <Text style={styles.betaNote}>{t('ai.recipes.mocktailsOnly')}</Text>}
        <TouchableOpacity
          style={styles.generateButton}
          onPress={() => navigation.navigate('AiRecipes', { mode: 'smart_bar' })}
          accessibilityRole="button"
        >
          <Ionicons name="sparkles" size={20} color="#FFFFFF" />
          <Text style={styles.generateButtonText}>{t('ai.recipes.generate')}</Text>
        </TouchableOpacity>
        <Text style={styles.betaNote}>{t('ai.recipes.disclaimer')}</Text>
      </View>
    );
  }, [
    acceptNotice,
    aiStatus.data,
    aiStatus.isError,
    inventory.length,
    isAgeConfirmed,
    isAiAvailable,
    isLoading,
    navigation,
    t,
  ]);

  // ── Saved tab: saved posts, and (AI v1) saved recipes ─────────
  const savedRecipesContent = useMemo(() => {
    if (savedRecipesQuery.isLoading) {
      return (
        <View style={styles.loadingState}>
          <ActivityIndicator color="#8B5FBF" />
        </View>
      );
    }
    if (savedRecipesQuery.isError) {
      return (
        <View style={styles.emptyState}>
          <Text style={styles.emptySubtitle}>{t(getAiErrorKey(savedRecipesQuery.error))}</Text>
          <TouchableOpacity style={styles.addButton} onPress={() => savedRecipesQuery.refetch()} accessibilityRole="button">
            <Text style={styles.addButtonText}>{t('common.retry')}</Text>
          </TouchableOpacity>
        </View>
      );
    }
    if (savedRecipes.length === 0) {
      return (
        <View style={styles.emptyState}>
          <Ionicons name="flask-outline" size={40} color="#6B7280" />
          <Text style={styles.emptyTitle}>{t('ai.saved.recipesEmptyTitle')}</Text>
          <Text style={styles.emptySubtitle}>{t('ai.saved.recipesEmptySubtitle')}</Text>
        </View>
      );
    }
    return (
      <View style={{ gap: 12 }}>
        {savedRecipes.map((recipe) => (
          <AiRecipeCard
            key={recipe.id}
            recipe={recipe}
            isSaved
            onPress={() => navigation.navigate('AiRecipeDetail', { recipe })}
            onToggleSave={() => handleToggleSavedRecipe(recipe)}
          />
        ))}
      </View>
    );
  }, [handleToggleSavedRecipe, navigation, savedRecipes, savedRecipesQuery, t]);

  const savedPostsContent = useMemo(() => {
    if (isSavedLoading) {
      return (
        <View style={styles.loadingState}>
          <Ionicons name="bookmark-outline" size={32} color="#6B7280" />
          <Text style={styles.loadingText}>{t('smartBar.savedEmptySubtitle')}</Text>
        </View>
      );
    }

    if (savedDrinks.length === 0) {
      return (
        <View style={styles.emptyState}>
          <Ionicons name="bookmark-outline" size={40} color="#6B7280" />
          <Text style={styles.emptyTitle}>{t('smartBar.savedEmptyTitle')}</Text>
          <Text style={styles.emptySubtitle}>{t('smartBar.savedEmptySubtitle')}</Text>
        </View>
      );
    }

    return (
      <View style={{ gap: 16 }}>
        {savedDrinks.map((drink) => (
          <DrinkPostCard
            key={drink.id}
            drink={applyLocalUser(drink)}
            onCheer={() => toggleCheer(drink)}
            onComment={() => setCommentDrinkId(drink.id)}
            onSave={() => toggleSave(drink)}
            onMore={() => setActionsDrink(drink)}
            onPress={() => navigation.navigate('DrinkDetail', { drinkId: drink.id })}
            isLiked={drink.isLiked}
            isSaved={drink.isSaved}
            cheersCount={drink.cheersCount}
            onPressAuthor={() =>
              drink.userId === serverUserId
                ? navigation.navigate('Profile')
                : navigation.navigate('UserProfile', { userId: drink.userId })
            }
          />
        ))}
        {hasMoreSaved && <LoadMoreButton onPress={() => fetchMoreSaved()} isLoading={isFetchingMoreSaved} />}
      </View>
    );
  }, [applyLocalUser, fetchMoreSaved, hasMoreSaved, isFetchingMoreSaved, isSavedLoading, navigation, savedDrinks, serverUserId, t, toggleCheer, toggleSave]);

  const savedContent = (
    <View style={{ gap: 16 }}>
      <View style={styles.segment} accessibilityRole="tablist">
        {(['posts', 'recipes'] as const).map((section) => {
          const selected = savedSection === section;
          return (
            <TouchableOpacity
              key={section}
              style={[styles.segmentItem, selected && styles.segmentItemActive]}
              onPress={() => setSavedSection(section)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
            >
              <Text style={[styles.segmentText, selected && styles.segmentTextActive]}>{t(`ai.saved.${section}`)}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {savedSection === 'posts' ? savedPostsContent : savedRecipesContent}
    </View>
  );

  return (
    <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('smartBar.title')}</Text>
        <TouchableOpacity
          style={styles.headerAction}
          onPress={() => setIsAddingItem(true)}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel={t('smartBar.addItemTitle')}
        >
          <Ionicons name="add" size={20} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      {/* Tab bar */}
      <View style={styles.tabContainer}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'inventory' && styles.activeTab]}
          onPress={() => setActiveTab('inventory')}
        >
          <Text style={[styles.tabText, activeTab === 'inventory' && styles.activeTabText]}>
            {t('smartBar.tabs.inventory')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'recipes' && styles.activeTab]}
          onPress={() => setActiveTab('recipes')}
        >
          <Text style={[styles.tabText, activeTab === 'recipes' && styles.activeTabText]}>
            {t('smartBar.tabs.recipes')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'saved' && styles.activeTab]}
          onPress={() => setActiveTab('saved')}
        >
          <Text style={[styles.tabText, activeTab === 'saved' && styles.activeTabText]}>
            {t('smartBar.tabs.saved')}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentContainer}
        keyboardShouldPersistTaps="handled"
        contentInset={{ bottom: extraScrollInset }}
        scrollIndicatorInsets={{ bottom: extraScrollInset }}
      >
        {activeTab === 'inventory' && inventoryContent}
        {activeTab === 'recipes' && recipesContent}
        {activeTab === 'saved' && savedContent}

        {activeTab === 'inventory' && (
          <View style={styles.suggestionsSection}>
            <Text style={styles.sectionTitle}>{t('explore.sections.discover')}</Text>
            <Text style={styles.sectionSubtitle}>{t('smartBar.addItemTitle')}</Text>
            <TouchableOpacity
              style={styles.suggestionCard}
              onPress={() => navigation.navigate('Scanner')}
            >
              <Ionicons name="scan-outline" size={24} color="#8B5FBF" />
              <View style={styles.suggestionContent}>
                <Text style={styles.suggestionTitle}>{t('scanner.title')}</Text>
                <Text style={styles.suggestionDescription}>{t('drinkDetail.tip')}</Text>
              </View>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {/* Add item modal */}
      {isAddingItem && (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? insets.bottom + 16 : 0}
          style={styles.addItemModal}
        >
          <View style={styles.addItemContent}>
            <Text style={styles.modalTitle}>{t('smartBar.addItemTitle')}</Text>
            <TextInput
              style={styles.modalInput}
              placeholder={t(isAgeConfirmed ? 'smartBar.itemNamePlaceholder' : 'ageGate.itemNamePlaceholder')}
              placeholderTextColor="#6B7280"
              value={newItemName}
              onChangeText={setNewItemName}
            />
            <TextInput
              style={styles.modalInput}
              placeholder={t('smartBar.quantityPlaceholder')}
              placeholderTextColor="#6B7280"
              value={newItemQuantity}
              onChangeText={setNewItemQuantity}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalButtonSecondary} onPress={() => setIsAddingItem(false)}>
                <Text style={styles.modalButtonSecondaryText}>{t('profile.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalButtonPrimary} onPress={handleAddItem}>
                <Text style={styles.modalButtonPrimaryText}>{t('smartBar.addItem')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      )}

      <CommentDrawer drinkId={commentDrinkId} onClose={() => setCommentDrinkId(null)} />
      <PostActionsSheet drink={actionsDrink} onClose={() => setActionsDrink(null)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  aiGenerateCard: {
    backgroundColor: '#0F172A',
    borderRadius: 14,
    padding: 16,
    gap: 12,
    borderWidth: 1,
    borderColor: '#8B5FBF44',
  },
  aiGenerateTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  aiGenerateTitle: { color: '#FFFFFF', fontSize: 17, fontWeight: '700', flexShrink: 1 },
  aiBasicsLabel: { color: '#9CA3AF', fontSize: 13, fontWeight: '600' },
  aiBasicsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  aiBasicChip: { backgroundColor: '#1F2937', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: '#374151' },
  aiBasicChipText: { color: '#FFFFFF', fontSize: 12 },
  aiEditBasics: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, minHeight: 28 },
  aiEditBasicsText: { color: '#8B5FBF', fontSize: 13, fontWeight: '600' },
  segment: { flexDirection: 'row', backgroundColor: '#1F2937', borderRadius: 10, padding: 3 },
  segmentItem: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 38, borderRadius: 8 },
  segmentItemActive: { backgroundColor: '#8B5FBF' },
  segmentText: { color: '#9CA3AF', fontSize: 14, fontWeight: '600' },
  segmentTextActive: { color: '#FFFFFF' },
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1F2937',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  headerAction: {
    padding: 8,
    backgroundColor: '#8B5FBF',
    borderRadius: 20,
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: '#1F2937',
    marginHorizontal: 16,
    marginVertical: 8,
    borderRadius: 8,
    padding: 4,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 6,
    alignItems: 'center',
  },
  activeTab: {
    backgroundColor: '#8B5FBF',
  },
  tabText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#9CA3AF',
  },
  activeTabText: {
    color: '#FFFFFF',
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    paddingBottom: 32,
    paddingHorizontal: 16,
  },
  loadingState: {
    alignItems: 'center',
    paddingVertical: 48,
    gap: 12,
  },
  loadingText: {
    color: '#9CA3AF',
    fontSize: 14,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 48,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  emptySubtitle: {
    color: '#9CA3AF',
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  addButton: {
    marginTop: 16,
    backgroundColor: '#8B5FBF',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  addButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  inventoryList: {
    gap: 12,
  },
  inventoryItem: {
    backgroundColor: '#0F172A',
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  itemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  itemIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#1F2937',
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemName: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  itemQuantity: {
    color: '#9CA3AF',
    fontSize: 14,
  },
  deleteButton: {
    padding: 6,
  },
  // Recipes tab
  recipesHint: {
    color: '#9CA3AF',
    fontSize: 13,
    marginBottom: 12,
    marginTop: 4,
    lineHeight: 18,
  },
  selectAllRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: '#1F2937',
    borderRadius: 10,
    marginBottom: 8,
  },
  selectAllText: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  selectedCount: {
    color: '#8B5FBF',
    fontSize: 13,
    fontWeight: '600',
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#374151',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: '#8B5FBF',
    borderColor: '#8B5FBF',
  },
  ingredientList: {
    gap: 8,
    marginBottom: 20,
  },
  ingredientRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: '#0F172A',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  ingredientRowChecked: {
    borderColor: '#8B5FBF33',
    backgroundColor: '#8B5FBF0D',
  },
  ingredientInfo: {
    flex: 1,
  },
  ingredientName: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '500',
  },
  ingredientQty: {
    color: '#6B7280',
    fontSize: 12,
    marginTop: 2,
  },
  generateButton: {
    backgroundColor: '#8B5FBF',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 8,
  },
  generateButtonDisabled: {
    backgroundColor: '#374151',
  },
  generateButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  // Suggestions (inventory tab footer)
  suggestionsSection: {
    marginTop: 32,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 4,
  },
  sectionSubtitle: {
    fontSize: 14,
    color: '#9CA3AF',
    marginBottom: 16,
  },
  suggestionCard: {
    backgroundColor: '#1F2937',
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  suggestionContent: {
    marginLeft: 12,
    flex: 1,
  },
  suggestionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 4,
  },
  suggestionDescription: {
    fontSize: 14,
    color: '#9CA3AF',
  },
  // Beta preview (recipes tab)
  betaContainer: {
    alignItems: 'center',
    paddingTop: 24,
    paddingBottom: 32,
  },
  betaBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#1F2937',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
    marginBottom: 28,
    borderWidth: 1,
    borderColor: '#8B5FBF44',
  },
  betaBadgeText: {
    color: '#8B5FBF',
    fontSize: 12,
    fontWeight: '600',
  },
  betaHeroWrapper: {
    position: 'relative',
    marginBottom: 20,
  },
  betaHeroCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#1F2937',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#8B5FBF44',
  },
  betaLockBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    backgroundColor: '#8B5FBF',
    borderRadius: 12,
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  betaTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#FFFFFF',
    textAlign: 'center',
    marginBottom: 10,
  },
  betaDesc: {
    fontSize: 14,
    color: '#9CA3AF',
    textAlign: 'center',
    lineHeight: 21,
    marginBottom: 28,
    paddingHorizontal: 8,
  },
  betaFeatureList: {
    width: '100%',
    gap: 12,
    marginBottom: 28,
  },
  betaFeatureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#0F172A',
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 10,
  },
  betaFeatureText: {
    color: '#E5E7EB',
    fontSize: 14,
  },
  betaNote: {
    fontSize: 12,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 18,
    fontStyle: 'italic',
  },
  // Add item modal
  addItemModal: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#111827',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 16,
  },
  addItemContent: {
    gap: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  modalInput: {
    backgroundColor: '#1F2937',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#FFFFFF',
    fontSize: 16,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 12,
    marginTop: 8,
  },
  modalButtonSecondary: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 8,
    backgroundColor: '#1F2937',
  },
  modalButtonSecondaryText: {
    color: '#9CA3AF',
    fontSize: 14,
    fontWeight: '500',
  },
  modalButtonPrimary: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 8,
    backgroundColor: '#8B5FBF',
  },
  modalButtonPrimaryText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
});
