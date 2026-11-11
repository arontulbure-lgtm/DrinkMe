import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TextInput, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../lib/api';
import { flattenPages, getNextCursor } from '../lib/drinkCache';
import { getPartnerLabelKey, usePartnerAction } from '../lib/usePartnerAction';
import { useDrinkToggles } from '../lib/useDrinkToggles';
import {
  ALCOHOLIC_DRINK_CATEGORIES,
  BaseUser,
  Drink,
  DrinkCategory,
  NON_ALCOHOLIC_DRINK_CATEGORIES,
  Page,
} from '../types/api';
import DrinkPostCard from '../components/DrinkPostCard';
import CommentDrawer from '../components/CommentDrawer';
import PostActionsSheet from '../components/PostActionsSheet';
import ListLoadState from '../components/ListLoadState';
import LoadMoreButton from '../components/LoadMoreButton';
import { useLocalization } from '../context/LocalizationContext';
import { TabScreenProps } from '../navigation/types';

const TRENDING_LIMIT = 6;
const SEARCH_MIN_LENGTH = 2;

// 'all' and 'non-alcoholic' as before; every other chip is a post category the server filters on.
type ExploreFilterId = 'all' | 'non-alcoholic' | DrinkCategory;

export default function ExploreScreen({ navigation }: TabScreenProps<'Explore'>) {
  const [searchQuery, setSearchQuery] = useState('');
  const [commentDrinkId, setCommentDrinkId] = useState<number | null>(null);
  const [actionsDrink, setActionsDrink] = useState<Drink | null>(null);
  const { serverUserId, profile } = useAuth();
  const { t } = useLocalization();
  const isAgeConfirmed = profile?.ageConfirmed === true;

  const filters = useMemo(
    (): { id: ExploreFilterId; label: string }[] => [
      { id: 'all', label: t('explore.filters.all') },
      ...(isAgeConfirmed
        ? ALCOHOLIC_DRINK_CATEGORIES.map((id) => ({ id, label: t(`categories.${id}`) }))
        : []),
      { id: 'non-alcoholic', label: t('explore.filters.nonAlcoholic') },
      ...NON_ALCOHOLIC_DRINK_CATEGORIES.map((id) => ({ id, label: t(`categories.${id}`) })),
    ],
    [isAgeConfirmed, t]
  );

  const [activeFilter, setActiveFilter] = useState<ExploreFilterId>('all');

  // Debounce search query by 300ms to avoid firing on every keystroke
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 300);
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
  }, [searchQuery]);

  const rawQuery = debouncedQuery;
  const isUserQuery = rawQuery.startsWith('@');
  const userQuery = isUserQuery ? rawQuery.replace(/^@+/, '').trim() : '';
  const hasSearchTerm = rawQuery.length > 0;
  // Lowercase, so "Gin" and "gin" share one cached result: the server matches either way.
  const drinkSearchTerm = rawQuery.toLowerCase();
  const isDrinkSearch = !isUserQuery && rawQuery.length >= SEARCH_MIN_LENGTH;

  // The server filters before paging, so a match on a later page is found. Each chip has its own cache.
  // Posts without a category (tags: []) show only under All, and Non-alcoholic when isAlcoholic is false.
  const isNonAlcoholicFilter = activeFilter === 'non-alcoholic';
  const categoryFilter: DrinkCategory | undefined =
    activeFilter === 'all' || activeFilter === 'non-alcoholic' ? undefined : activeFilter;
  const {
    data: discoverPages,
    refetch: refetchDiscover,
    isError: isDiscoverError,
    isFetching: isDiscoverFetching,
    hasNextPage: hasMoreDiscover,
    fetchNextPage: fetchMoreDiscover,
    isFetchingNextPage: isFetchingMoreDiscover,
  } = useInfiniteQuery({
    queryKey: ['drinks.all', activeFilter],
    enabled: !!serverUserId,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      apiFetch<Page<Drink>>('/api/drinks', {
        query: {
          scope: 'discover',
          alcoholic: isNonAlcoholicFilter ? 'false' : undefined,
          category: categoryFilter,
          before: pageParam,
        },
      }),
    getNextPageParam: getNextCursor,
  });

  const { data: trendingPage } = useQuery<Page<Drink>>({
    queryKey: ['drinks.trending'],
    enabled: !!serverUserId,
    queryFn: () =>
      apiFetch<Page<Drink>>('/api/drinks', { query: { scope: 'discover', sort: 'trending', limit: TRENDING_LIMIT } }),
  });

  const { data: users = [] } = useQuery<BaseUser[]>({
    queryKey: ['users.search', userQuery],
    enabled: !!serverUserId && isUserQuery && userQuery.length >= 2,
    queryFn: () => apiFetch<BaseUser[]>('/api/users/search', { query: { q: userQuery } }),
  });

  const {
    data: searchPages,
    refetch: refetchSearch,
    isError: isSearchError,
    isFetching: isSearchFetching,
    hasNextPage: hasMoreSearch,
    fetchNextPage: fetchMoreSearch,
    isFetchingNextPage: isFetchingMoreSearch,
  } = useInfiniteQuery({
    queryKey: ['drinks.search', drinkSearchTerm],
    enabled: !!serverUserId && isDrinkSearch,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => apiFetch<Page<Drink>>('/api/drinks', { query: { q: drinkSearchTerm, before: pageParam } }),
    getNextPageParam: getNextCursor,
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

  const discoveryDrinks = useMemo(
    () => flattenPages(discoverPages).map(applyLocalUser),
    [discoverPages, applyLocalUser]
  );

  const matchingDrinks = useMemo(() => {
    if (!isDrinkSearch) return [] as Drink[];
    return flattenPages(searchPages).map(applyLocalUser);
  }, [applyLocalUser, searchPages, isDrinkSearch]);

  const trendingDrinks = trendingPage?.items ?? [];

  const shouldShowUserResults = isUserQuery && userQuery.length >= 2;
  const shouldShowUserMinChars = hasSearchTerm && (isUserQuery ? userQuery.length < 2 : !isDrinkSearch);
  const shouldShowDrinkResults = isDrinkSearch;

  const { toggleCheer, toggleSave } = useDrinkToggles();

  const { pressPartner, pendingTargetId } = usePartnerAction();

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

        {shouldShowUserMinChars && (
          <View style={styles.searchHints}>
            <Text style={[styles.searchHint, styles.searchHintLast]}>{t('explore.searchMinChars')}</Text>
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
                accessibilityRole="button"
                accessibilityLabel={filter.label}
                accessibilityState={{ selected: isActive }}
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
                const partnerStatus = result.partnerStatus ?? 'none';
                const isPartnerFilled = partnerStatus === 'partner' || partnerStatus === 'incoming';
                const displayName = result.firstName
                  ? `${result.firstName} ${result.lastName || ''}`.trim()
                  : t('common.unknownUser');
                return (
                  <View key={result.id} style={styles.userResult}>
                    <TouchableOpacity
                      style={styles.userInfoContainer}
                      onPress={() =>
                        isSelf
                          ? navigation.navigate('Profile')
                          : navigation.navigate('UserProfile', { userId: result.id })
                      }
                    >
                      <View style={styles.userAvatar}>
                        <Text style={styles.userAvatarText}>
                          {displayName[0]?.toUpperCase() || '?'}
                        </Text>
                      </View>
                      <View style={styles.userInfo}>
                        <Text style={styles.userName} numberOfLines={1}>{displayName}</Text>
                        {result.city ? <Text style={styles.userCity} numberOfLines={1}>{result.city}</Text> : null}
                      </View>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.partnerButton,
                        isPartnerFilled && styles.partnerButtonActive,
                        partnerStatus === 'requested' && styles.partnerButtonRequested,
                        isSelf && styles.partnerButtonDisabled,
                      ]}
                      onPress={() => pressPartner(result.id, partnerStatus)}
                      disabled={isSelf || pendingTargetId === result.id}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={isSelf ? t('common.you') : t(getPartnerLabelKey(partnerStatus))}
                    >
                      <Text
                        style={[
                          styles.partnerButtonText,
                          isPartnerFilled && styles.partnerButtonTextActive,
                          partnerStatus === 'requested' && styles.partnerButtonTextRequested,
                        ]}
                      >
                        {isSelf ? t('common.you') : t(getPartnerLabelKey(partnerStatus))}
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
            {searchPages === undefined ? (
              <ListLoadState
                isError={isSearchError}
                isFetching={isSearchFetching}
                message={t('explore.loadError')}
                onRetry={() => refetchSearch()}
              />
            ) : matchingDrinks.length === 0 ? (
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
                  onCheer={() => toggleCheer(drink)}
                  onComment={() => setCommentDrinkId(drink.id)}
                  onSave={() => toggleSave(drink)}
                  onMore={() => setActionsDrink(drink)}
                  isLiked={drink.isLiked}
                  isSaved={drink.isSaved}
                  cheersCount={drink.cheersCount}
                  onPressAuthor={() =>
                    drink.userId === serverUserId
                      ? navigation.navigate('Profile')
                      : navigation.navigate('UserProfile', { userId: drink.userId })
                  }
                />
              ))
            )}
            {hasMoreSearch && <LoadMoreButton onPress={() => fetchMoreSearch()} isLoading={isFetchingMoreSearch} />}
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
              {discoverPages === undefined ? (
                <ListLoadState
                  isError={isDiscoverError}
                  isFetching={isDiscoverFetching}
                  message={t('explore.loadError')}
                  onRetry={() => refetchDiscover()}
                />
              ) : discoveryDrinks.length === 0 ? (
                <View style={styles.emptyState}>
                  <Ionicons name="wine-outline" size={48} color="#6B7280" />
                  <Text style={styles.emptyTitle}>{t('explore.sections.noDrinksTitle')}</Text>
                  <Text style={styles.emptySubtitle}>{t('explore.sections.noDrinksSubtitle')}</Text>
                </View>
              ) : null}
              {discoveryDrinks.map((drink) => (
                <DrinkPostCard
                  key={drink.id}
                  drink={drink}
                  onCheer={() => toggleCheer(drink)}
                  onComment={() => setCommentDrinkId(drink.id)}
                  onSave={() => toggleSave(drink)}
                  onMore={() => setActionsDrink(drink)}
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
              {hasMoreDiscover && (
                <LoadMoreButton onPress={() => fetchMoreDiscover()} isLoading={isFetchingMoreDiscover} />
              )}
            </View>
          </>
        )}
      </ScrollView>

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
  partnerButtonRequested: {
    borderColor: '#374151',
  },
  partnerButtonTextRequested: {
    color: '#9CA3AF',
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
