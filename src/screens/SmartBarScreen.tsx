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
import { flattenPages, getNextCursor, removeDrinkIfNotFound, syncSavedList, updateDrinkInCaches } from '../lib/drinkCache';
import LoadMoreButton from '../components/LoadMoreButton';
import PostActionsSheet from '../components/PostActionsSheet';

// ── Beta flag — set to false to re-enable AI recipe generation ────────────────
const AI_RECIPES_ENABLED = false;
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, FontAwesome5 } from '@expo/vector-icons';
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { isCurrentAuthUser, useAuth } from '../context/AuthContext';
import { apiFetch, ApiError } from '../lib/api';
import { Drink, Page, SmartBarItem, Recipe } from '../types/api';
import { useLocalization } from '../context/LocalizationContext';
import DrinkPostCard from '../components/DrinkPostCard';
import CommentDrawer from '../components/CommentDrawer';

type Tab = 'inventory' | 'recipes' | 'saved';

export default function SmartBarScreen({ navigation }: any) {
  const [isAddingItem, setIsAddingItem] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [newItemQuantity, setNewItemQuantity] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('inventory');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [commentDrinkId, setCommentDrinkId] = useState<number | null>(null);
  const [actionsDrink, setActionsDrink] = useState<Drink | null>(null);

  const { serverUserId, getJwtToken, profile } = useAuth();
  const isAgeConfirmed = profile?.ageConfirmed === true;
  const queryClient = useQueryClient();
  const { t } = useLocalization();
  const insets = useSafeAreaInsets();
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
      Alert.alert('Error', isStorageFull ? t('common.serviceUnavailable') : 'Failed to add item to your bar');
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
      Alert.alert('Error', 'Failed to remove item from your bar');
    },
  });

  const generateRecipesMutation = useMutation({
    mutationFn: async (ingredients: string[]) => {
      const token = await getJwtToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      return apiFetch<Recipe[]>('/api/smart-bar/generate-recipes', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ingredients, nonAlcoholicOnly: profile?.ageConfirmed !== true }),
      });
    },
    onSuccess: (recipes, ingredients) => {
      navigation.navigate('RecipeResults', {
        product: ingredients.join(', '),
        recipes,
        isAlcoholic: null,
      });
    },
    onError: () => {
      Alert.alert('Error', t('scanner.error'));
    },
  });

  const handleAddItem = () => {
    if (!newItemName.trim() || !newItemQuantity.trim()) {
      Alert.alert('Error', 'Please fill in all fields');
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
        'Remove Item',
        `Remove ${itemName} from your bar?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: () => {
              deleteItemMutation.mutate(itemId);
              setSelectedIds((prev) => {
                const next = new Set(prev);
                next.delete(itemId);
                return next;
              });
            },
          },
        ]
      );
    },
    [deleteItemMutation]
  );

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const allSelected = inventory.length > 0 && inventory.every((item) => selectedIds.has(item.id));

  const handleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(inventory.map((item) => item.id)));
    }
  };

  const handleGenerateRecipes = () => {
    const selectedItems = inventory.filter((item) => selectedIds.has(item.id));
    if (selectedItems.length === 0) {
      Alert.alert(t('smartBar.generateRecipes'), t('smartBar.selectIngredientsHint'));
      return;
    }
    const ingredientNames = selectedItems.map((item) => item.name);
    generateRecipesMutation.mutate(ingredientNames);
  };

  const unsaveMutation = useMutation({
    mutationFn: async (drinkId: number) => {
      const token = await getJwtToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      return apiFetch<{ saved: boolean }>(`/api/drinks/${drinkId}/save`, {
        method: 'POST',
        headers,
      });
    },
    onSuccess: (result, drinkId) => {
      if (!serverUserId || !isCurrentAuthUser(serverUserId)) return;
      updateDrinkInCaches(queryClient, drinkId, (drink) => ({
        ...drink,
        isSaved: result.saved,
      }));
      syncSavedList(queryClient, serverUserId, drinkId, result.saved);
    },
    onError: (error, drinkId) => {
      if (removeDrinkIfNotFound(queryClient, error, drinkId, serverUserId)) {
        Alert.alert(t('post.notFound'));
        return;
      }
      Alert.alert('Error', 'Failed to update saved state');
    },
  });

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

    if (!AI_RECIPES_ENABLED) {
      return (
        <View style={styles.betaContainer}>
          {/* Coming soon badge */}
          <View style={styles.betaBadge}>
            <Ionicons name="flask" size={13} color="#8B5FBF" />
            <Text style={styles.betaBadgeText}>Beta — Coming Soon</Text>
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

          <Text style={styles.betaTitle}>AI Recipe Generator</Text>
          <Text style={styles.betaDesc}>
            {isAgeConfirmed
              ? 'Select ingredients from your bar, tap Generate, and our AI will craft personalised cocktail recipes matched to exactly what you have on hand.'
              : t('ageGate.recipesIntro')}
          </Text>

          {/* Feature cards */}
          <View style={styles.betaFeatureList}>
            <View style={styles.betaFeatureRow}>
              <Ionicons name="checkmark-circle" size={18} color="#8B5FBF" />
              <Text style={styles.betaFeatureText}>Pick ingredients with one tap</Text>
            </View>
            <View style={styles.betaFeatureRow}>
              <Ionicons name="checkmark-circle" size={18} color="#8B5FBF" />
              <Text style={styles.betaFeatureText}>
                {isAgeConfirmed ? 'Get 5 tailored cocktail recipes instantly' : t('ageGate.recipesFeature')}
              </Text>
            </View>
            <View style={styles.betaFeatureRow}>
              <Ionicons name="checkmark-circle" size={18} color="#8B5FBF" />
              <Text style={styles.betaFeatureText}>Save favourites directly to your bar</Text>
            </View>
          </View>

          <Text style={styles.betaNote}>
            This feature is being perfected and will be unlocked in the next update.
          </Text>
        </View>
      );
    }

    return (
      <View>
        <Text style={styles.recipesHint}>{t('smartBar.selectIngredients')}</Text>

        {/* Select All */}
        <TouchableOpacity style={styles.selectAllRow} onPress={handleSelectAll}>
          <View style={[styles.checkbox, allSelected && styles.checkboxChecked]}>
            {allSelected && <Ionicons name="checkmark" size={14} color="#FFFFFF" />}
          </View>
          <Text style={styles.selectAllText}>{t('smartBar.selectAll')}</Text>
          <Text style={styles.selectedCount}>
            {selectedIds.size}/{inventory.length}
          </Text>
        </TouchableOpacity>

        {/* Ingredient checkboxes */}
        <View style={styles.ingredientList}>
          {inventory.map((item) => {
            const checked = selectedIds.has(item.id);
            return (
              <TouchableOpacity
                key={item.id}
                style={[styles.ingredientRow, checked && styles.ingredientRowChecked]}
                onPress={() => toggleSelect(item.id)}
                activeOpacity={0.7}
              >
                <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                  {checked && <Ionicons name="checkmark" size={14} color="#FFFFFF" />}
                </View>
                <View style={styles.ingredientInfo}>
                  <Text style={styles.ingredientName}>{item.name}</Text>
                  <Text style={styles.ingredientQty}>{item.quantity}</Text>
                </View>
                <Ionicons
                  name="wine-outline"
                  size={18}
                  color={checked ? '#8B5FBF' : '#374151'}
                />
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Generate button */}
        <TouchableOpacity
          style={[
            styles.generateButton,
            (selectedIds.size === 0 || generateRecipesMutation.isPending) && styles.generateButtonDisabled,
          ]}
          onPress={handleGenerateRecipes}
          disabled={selectedIds.size === 0 || generateRecipesMutation.isPending}
        >
          {generateRecipesMutation.isPending ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <Ionicons name="flask" size={20} color="#FFFFFF" />
          )}
          <Text style={styles.generateButtonText}>
            {generateRecipesMutation.isPending ? t('scanner.detecting') : t('smartBar.generateRecipes')}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }, [
    allSelected,
    generateRecipesMutation.isPending,
    handleGenerateRecipes,
    handleSelectAll,
    inventory,
    isAgeConfirmed,
    isLoading,
    selectedIds,
    t,
    toggleSelect,
  ]);

  // ── Saved tab ──────────────────────────────────────────────────
  const savedContent = useMemo(() => {
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
            onCheer={() => {}}
            onComment={() => setCommentDrinkId(drink.id)}
            onSave={() => unsaveMutation.mutate(drink.id)}
            onMore={() => setActionsDrink(drink)}
            isLiked={drink.isLiked}
            isSaved={drink.isSaved}
            cheersCount={drink.cheersCount}
            onPressAuthor={() =>
              navigation.navigate(
                drink.userId === serverUserId ? 'Profile' : 'UserProfile',
                drink.userId === serverUserId ? undefined : { userId: drink.userId }
              )
            }
          />
        ))}
        {hasMoreSaved && <LoadMoreButton onPress={() => fetchMoreSaved()} isLoading={isFetchingMoreSaved} />}
      </View>
    );
  }, [applyLocalUser, fetchMoreSaved, hasMoreSaved, isFetchingMoreSaved, isSavedLoading, navigation, savedDrinks, serverUserId, t, unsaveMutation]);

  return (
    <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('smartBar.title')}</Text>
        <TouchableOpacity style={styles.headerAction} onPress={() => setIsAddingItem(true)}>
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
