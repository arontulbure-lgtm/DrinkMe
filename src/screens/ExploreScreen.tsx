import React, { useMemo, useState, useCallback } from 'react';
import { View, Text, StyleSheet, TextInput, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../lib/api';
import { Drink, BaseUser } from '../types/api';
import DrinkPostCard from '../components/DrinkPostCard';
import { useLocalization } from '../context/LocalizationContext';

export default function ExploreScreen({ navigation }: any) {
  const [searchQuery, setSearchQuery] = useState('');
  const { serverUserId, getJwtToken, profile } = useAuth();
  const queryClient = useQueryClient();
  const { t } = useLocalization();

  const filters = useMemo(
    () => [
      { id: 'all', label: t('explore.filters.all') },
      { id: 'cocktail', label: t('explore.filters.cocktail') },
      { id: 'wine', label: t('explore.filters.wine') },
      { id: 'beer', label: t('explore.filters.beer') },
      { id: 'non-alcoholic', label: t('explore.filters.nonAlcoholic') },
    ],
    [t]
  );

  const [activeFilter, setActiveFilter] = useState('all');
  const rawQuery = searchQuery.trim();
  const isUserQuery = rawQuery.startsWith('@');
  const userQuery = isUserQuery ? rawQuery.slice(1) : '';
  const hasSearchTerm = rawQuery.length > 0;

  const { data: drinks = [] } = useQuery<Drink[]>({
    queryKey: ['drinks.all'],
    enabled: !!serverUserId,
    queryFn: () => apiFetch<Drink[]>('/api/drinks'),
  });

  const { data: partnerDrinks = [] } = useQuery<Drink[]>({
    queryKey: ['drinks.partners'],
    enabled: !!serverUserId,
    queryFn: () => apiFetch<Drink[]>('/api/drinks/partners'),
  });

  const { data: users = [] } = useQuery<BaseUser[]>({
    queryKey: ['users.search', userQuery],
    enabled: !!serverUserId && isUserQuery && userQuery.length > 0,
    queryFn: () => apiFetch<BaseUser[]>('/api/users/search', { query: { q: userQuery } }),
  });

  const { data: publicDrinks = [] } = useQuery<Drink[]>({
    queryKey: ['drinks.search', rawQuery],
    enabled: !!serverUserId && !isUserQuery && rawQuery.length > 0,
    queryFn: () =>
      rawQuery
        ? apiFetch<Drink[]>('/api/drinks', { query: { city: rawQuery } })
        : apiFetch<Drink[]>('/api/drinks'),
  });

  const applyLocalUser = useCallback(
    (drink: Drink) => {
      if (profile && serverUserId && drink.userId === serverUserId) {
        return { ...drink, user: profile };
      }
      return drink;
    },
    [profile, serverUserId]
  );

  const partnerIds = useMemo(() => new Set(partnerDrinks.map((drink) => drink.id)), [partnerDrinks]);
  const discoveryDrinks = useMemo(
    () => drinks.filter((drink) => !partnerIds.has(drink.id)).map(applyLocalUser),
    [drinks, partnerIds, applyLocalUser]
  );
  const allHydratedDrinks = useMemo(() => drinks.map(applyLocalUser), [drinks, applyLocalUser]);

  const matchesFilter = (drink: Drink, filter: string) => {
    if (filter === 'all') return true;
    const tags = drink.tags || [];
    if (filter === 'non-alcoholic') {
      return tags.includes('mocktail') || tags.includes('non-alcoholic') || drink.isAlcoholic === false;
    }
    return tags.includes(filter);
  };

  const filteredDrinks = useMemo(
    () => discoveryDrinks.filter((drink) => matchesFilter(drink, activeFilter)),
    [discoveryDrinks, activeFilter]
  );

  const matchingDrinks = useMemo(() => {
    if (!hasSearchTerm || isUserQuery) return [] as Drink[];
    const queryLower = rawQuery.toLowerCase();
    const cityMatches = publicDrinks.filter((drink) =>
      (drink.location || '').toLowerCase().includes(queryLower)
    );
    const fallbackMatches = allHydratedDrinks.filter((drink) => {
      const location = (drink.location || '').toLowerCase();
      const description = (drink.description || '').toLowerCase();
      return (
        drink.name.toLowerCase().includes(queryLower) ||
        description.includes(queryLower) ||
        location.includes(queryLower)
      );
    });
    const combined = cityMatches.length > 0 ? cityMatches : fallbackMatches;
    const seen = new Set<number>();
    return combined.filter((drink) => {
      if (seen.has(drink.id)) return false;
      seen.add(drink.id);
      return true;
    });
  }, [allHydratedDrinks, publicDrinks, hasSearchTerm, isUserQuery, rawQuery]);

  const trendingDrinks = useMemo(
    () => [...discoveryDrinks].sort((a, b) => (b.cheersCount || 0) - (a.cheersCount || 0)).slice(0, 6),
    [discoveryDrinks]
  );

  const shouldShowUserResults = isUserQuery && userQuery.length > 0;
  const shouldShowDrinkResults = !isUserQuery && rawQuery.length > 0;

  const hydrateDrinkCollections = useCallback(
    (drinkId: number, updater: (drink: Drink) => Drink) => {
      const keys: any[] = [
        ['drinks.all'],
        ['drinks.partners'],
      ];
      if (serverUserId) {
        keys.push(['drinks.byUser', serverUserId]);
        keys.push(['users.savedDrinks', serverUserId]);
      }
      keys.forEach((key) => {
        queryClient.setQueryData<Drink[]>(key, (existing) => {
          if (!existing) return existing;
          return existing.map((item) => (item.id === drinkId ? updater(item) : item));
        });
      });
      queryClient.setQueryData<Drink>(['drinks.detail', drinkId], (existing) => {
        if (!existing) return existing;
        return updater(existing);
      });
    },
    [queryClient, serverUserId]
  );

  const cheerMutation = useMutation({
    mutationFn: async (drinkId: number) => {
      const token = await getJwtToken();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      return apiFetch<{ cheered: boolean; cheersCount: number }>(`/api/drinks/${drinkId}/like`, {
        method: 'POST',
        headers,
      });
    },
    onSuccess: (result, drinkId) => {
      hydrateDrinkCollections(drinkId, (drink) => ({
        ...drink,
        isLiked: result.cheered,
        cheersCount: result.cheersCount,
      }));
    },
    onError: () => Alert.alert(t('errors.cheerFailed')),
  });

  const saveMutation = useMutation({
    mutationFn: async (drinkId: number) => {
      const token = await getJwtToken();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      return apiFetch<{ saved: boolean }>(`/api/drinks/${drinkId}/save`, {
        method: 'POST',
        headers,
      });
    },
    onSuccess: (result, drinkId) => {
      hydrateDrinkCollections(drinkId, (drink) => ({
        ...drink,
        isSaved: result.saved,
      }));
      if (serverUserId) {
        queryClient.invalidateQueries({ queryKey: ['users.savedDrinks', serverUserId] });
      }
    },
    onError: () => Alert.alert(t('errors.partnerFailed')),
  });

  const partnerMutation = useMutation({
    mutationFn: async (targetUserId: string) => {
      const token = await getJwtToken();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      return apiFetch<{ isPartner: boolean }>(`/api/drink-partners/${targetUserId}`, {
        method: 'POST',
        headers,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users.search', userQuery] });
      queryClient.invalidateQueries({ queryKey: ['drinks.partners'] });
      queryClient.invalidateQueries({ queryKey: ['friends.count'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: () => Alert.alert(t('errors.saveFailed')),
  });

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('explore.title')}</Text>
      </View>

      <View style={styles.searchContainer}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={20} color="#6B7280" />
          <TextInput
            style={styles.searchInput}
            placeholder={t('explore.searchPlaceholder')}
            placeholderTextColor="#6B7280"
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCorrect={false}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <Ionicons name="close-circle" size={18} color="#6B7280" />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <ScrollView style={styles.content}>
        {!hasSearchTerm && (
          <View style={styles.searchHints}>
            <Text style={styles.searchHint}>{t('explore.tipUsers')}</Text>
            <Text style={[styles.searchHint, styles.searchHintLast]}>{t('explore.tipPlaces')}</Text>
          </View>
        )}

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filters}>
          {filters.map((filter) => {
            const isActive = filter.id === activeFilter;
            return (
              <TouchableOpacity
                key={filter.id}
                style={[styles.filterChip, isActive && styles.filterChipActive]}
                onPress={() => setActiveFilter(filter.id)}
              >
                <Text style={[styles.filterChipText, isActive && styles.filterChipTextActive]}>
                  {filter.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {shouldShowUserResults ? (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="people-outline" size={18} color="#8B5FBF" />
              <Text style={styles.sectionTitle}>{t('explore.sections.users')}</Text>
            </View>
            {users.length === 0 ? (
              <View style={styles.emptyState}>
                <Ionicons name="people-outline" size={40} color="#6B7280" />
                <Text style={styles.emptyTitle}>{t('explore.sections.noUsersTitle')}</Text>
                <Text style={styles.emptySubtitle}>{t('explore.sections.noUsersSubtitle')}</Text>
              </View>
            ) : (
              users.map((result) => {
                const isSelf = result.id === serverUserId;
                const displayName = result.firstName
                  ? `${result.firstName} ${result.lastName || ''}`.trim()
                  : result.email;
                return (
                  <View key={result.id} style={styles.userResult}>
                    <TouchableOpacity
                      style={styles.userInfoContainer}
                      onPress={() =>
                        navigation.navigate(
                          isSelf ? 'Profile' : 'UserProfile',
                          isSelf ? undefined : { userId: result.id }
                        )
                      }
                    >
                      <View style={styles.userAvatar}>
                        <Text style={styles.userAvatarText}>
                          {displayName[0]?.toUpperCase() || '?'}
                        </Text>
                      </View>
                      <View style={styles.userInfo}>
                        <Text style={styles.userName}>{displayName}</Text>
                        {result.city && <Text style={styles.userCity}>{result.city}</Text>}
                      </View>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.partnerButton,
                        result.isPartner && styles.partnerButtonActive,
                        isSelf && styles.partnerButtonDisabled,
                      ]}
                      onPress={() => partnerMutation.mutate(result.id)}
                      disabled={isSelf}
                    >
                      <Text
                        style={[styles.partnerButtonText, result.isPartner && styles.partnerButtonTextActive]}
                      >
                        {isSelf
                          ? t('common.you')
                          : result.isPartner
                          ? t('profile.drinkPartners')
                          : t('common.addPartner')}
                      </Text>
                    </TouchableOpacity>
                  </View>
                );
              })
            )}
          </View>
        ) : shouldShowDrinkResults ? (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="search-outline" size={18} color="#8B5FBF" />
              <Text style={styles.sectionTitle}>
                {t('explore.sections.searchResults', { query: rawQuery })}
              </Text>
            </View>
            {matchingDrinks.length === 0 ? (
              <View style={styles.emptyState}>
                <Ionicons name="wine-outline" size={48} color="#6B7280" />
                <Text style={styles.emptyTitle}>{t('explore.sections.noDrinksTitle')}</Text>
                <Text style={styles.emptySubtitle}>{t('explore.sections.noDrinksSubtitle')}</Text>
              </View>
            ) : (
              matchingDrinks.map((drink) => (
                <DrinkPostCard
                  key={drink.id}
                  drink={drink}
                  onCheer={() => cheerMutation.mutate(drink.id)}
                  onComment={() => navigation.navigate('DrinkDetail', { drinkId: drink.id })}
                  onSave={() => saveMutation.mutate(drink.id)}
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
              ))
            )}
          </View>
        ) : (
          <>
            {trendingDrinks.length > 0 && (
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <Ionicons name="flame" size={18} color="#8B5FBF" />
                  <Text style={styles.sectionTitle}>{t('explore.sections.trending')}</Text>
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  {trendingDrinks.map((drink) => (
                    <TouchableOpacity
                      key={drink.id}
                      style={styles.trendingCard}
                      onPress={() => navigation.navigate('DrinkDetail', { drinkId: drink.id })}
                    >
                      <Text style={styles.trendingTitle}>{drink.name}</Text>
                      <Text style={styles.trendingMeta} numberOfLines={2}>
                        ⭐ {(drink.rating || 0).toFixed(1)} · {drink.location || t('explore.sections.unknownLocation')}
                      </Text>
                      <Text style={styles.trendingDescription} numberOfLines={3}>
                        {drink.description}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            )}

            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Ionicons name="bulb-outline" size={18} color="#8B5FBF" />
                <Text style={styles.sectionTitle}>{t('explore.sections.discover')}</Text>
              </View>
              <View style={styles.discoverCard}>
                <Ionicons name="calendar" size={24} color="#8B5FBF" />
                <View style={styles.discoverContent}>
                  <Text style={styles.discoverTitle}>{t('explore.sections.tastingTitle')}</Text>
                  <Text style={styles.discoverSubtitle}>{t('explore.sections.tastingSubtitle')}</Text>
                </View>
              </View>
              <View style={styles.discoverCard}>
                <Ionicons name="restaurant" size={24} color="#8B5FBF" />
                <View style={styles.discoverContent}>
                  <Text style={styles.discoverTitle}>{t('explore.sections.partnersTitle')}</Text>
                  <Text style={styles.discoverSubtitle}>{t('explore.sections.partnersSubtitle')}</Text>
                </View>
              </View>
            </View>

            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Ionicons name="menu" size={18} color="#8B5FBF" />
                <Text style={styles.sectionTitle}>{t('explore.sections.discover')}</Text>
              </View>
              {filteredDrinks.map((drink) => (
                <DrinkPostCard
                  key={drink.id}
                  drink={drink}
                  onCheer={() => cheerMutation.mutate(drink.id)}
                  onComment={() => navigation.navigate('DrinkDetail', { drinkId: drink.id })}
                  onSave={() => saveMutation.mutate(drink.id)}
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
            </View>
          </>
        )}
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
  searchContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1F2937',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 16,
  },
  content: {
    flex: 1,
    paddingHorizontal: 16,
  },
  searchHints: {
    marginBottom: 12,
  },
  searchHint: {
    color: '#9CA3AF',
    fontSize: 12,
    marginBottom: 4,
  },
  searchHintLast: {
    marginBottom: 0,
  },
  filters: {
    paddingTop: 8,
    paddingBottom: 4,
  },
  filterChip: {
    marginRight: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#374151',
  },
  filterChipActive: {
    backgroundColor: '#8B5FBF22',
    borderColor: '#8B5FBF',
  },
  filterChipText: {
    color: '#D1D5DB',
    fontSize: 14,
    fontWeight: '500',
  },
  filterChipTextActive: {
    color: '#FFFFFF',
  },
  section: {
    marginVertical: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  userResult: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1F2937',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    gap: 12,
  },
  userInfoContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 12,
  },
  userAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#8B5FBF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  userAvatarText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
  },
  userInfo: {
    flex: 1,
  },
  userName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  userCity: {
    fontSize: 12,
    color: '#9CA3AF',
    marginTop: 2,
  },
  partnerButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#8B5FBF',
  },
  partnerButtonActive: {
    backgroundColor: '#8B5FBF',
  },
  partnerButtonDisabled: {
    opacity: 0.5,
  },
  partnerButtonText: {
    color: '#8B5FBF',
    fontSize: 12,
    fontWeight: '600',
  },
  partnerButtonTextActive: {
    color: '#FFFFFF',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 48,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 18,
    color: '#FFFFFF',
    marginTop: 16,
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#9CA3AF',
    textAlign: 'center',
  },
  trendingCard: {
    width: 220,
    marginRight: 12,
    backgroundColor: '#1F2937',
    borderRadius: 16,
    padding: 16,
    gap: 8,
  },
  trendingTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  trendingMeta: {
    color: '#9CA3AF',
    fontSize: 12,
  },
  trendingDescription: {
    color: '#D1D5DB',
    fontSize: 12,
    lineHeight: 18,
  },
  discoverCard: {
    backgroundColor: '#1F2937',
    borderRadius: 16,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 12,
  },
  discoverContent: {
    flex: 1,
    gap: 4,
  },
  discoverTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  discoverSubtitle: {
    color: '#9CA3AF',
    fontSize: 13,
    lineHeight: 18,
  },
});
