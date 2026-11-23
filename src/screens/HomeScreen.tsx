import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  Modal,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, FontAwesome5 } from '@expo/vector-icons';
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { isCurrentAuthUser, useAuth } from '../context/AuthContext';
import DrinkPostCard from '../components/DrinkPostCard';
import StoriesSection from '../components/StoriesSection';
import CommentDrawer from '../components/CommentDrawer';
import PostActionsSheet from '../components/PostActionsSheet';
import LoadMoreButton from '../components/LoadMoreButton';
import { SuspensionBanner } from '../components/ModerationNotice';
import { apiFetch } from '../lib/api';
import { flattenPages, getNextCursor, invalidateAfterPartnerChange, invalidateAfterPartnerRequest, trimToFirstPage } from '../lib/drinkCache';
import { useDrinkToggles } from '../lib/useDrinkToggles';
import { Drink, Page, Story, NotificationItem } from '../types/api';
import { useLocalization } from '../context/LocalizationContext';
import { TabScreenProps } from '../navigation/types';

// Stories are decorative for now — hide until the feature is implemented
const STORIES_ENABLED = false;

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

// Types the app can write in the reader's language. Anything else shows the server's stored text.
const LOCALIZED_NOTIFICATION_TYPES = new Set(['cheer', 'comment', 'partner', 'partner_request']);

// The server sends the names (params), the app writes the sentence. Entries from before params existed,
// and types this version does not know, keep the server's English text.
function getNotificationText(item: NotificationItem, t: TranslateFn): string {
  const params = item.params;
  if (!params || !LOCALIZED_NOTIFICATION_TYPES.has(item.type)) return item.message;
  if (typeof params.actorName !== 'string' || !params.actorName) return item.message;
  // The server's fallback name; a real user called "Someone" reads the same either way.
  const actor = params.actorName === 'Someone' ? t('notifications.someone') : params.actorName;
  if (item.type === 'cheer' || item.type === 'comment') {
    return params.drinkName
      ? t(`notifications.${item.type}`, { actor, drink: params.drinkName })
      : t(`notifications.${item.type}WithoutPost`, { actor });
  }
  if (item.type === 'partner' && params.variant === 'added') return t('notifications.partnerAdded', { actor });
  return t(`notifications.${item.type}`, { actor });
}

export default function HomeScreen({ navigation }: TabScreenProps<'Home'>) {
  const [refreshing, setRefreshing] = useState(false);
  const [isNotificationsVisible, setNotificationsVisible] = useState(false);
  const [commentDrinkId, setCommentDrinkId] = useState<number | null>(null);
  const [actionsDrink, setActionsDrink] = useState<Drink | null>(null);
  const { serverUserId, profile } = useAuth();
  const queryClient = useQueryClient();
  const { t, locale } = useLocalization();
  const dateLocale = locale === 'ro' ? 'ro-RO' : 'en-GB';

  const {
    data: partnerDrinksData,
    refetch,
    isLoading,
    isError,
    isFetching,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['drinks.partners'],
    enabled: !!serverUserId,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => apiFetch<Page<Drink>>('/api/drinks/partners', { query: { before: pageParam } }),
    getNextPageParam: getNextCursor,
  });

  const { data: stories = [] } = useQuery<Story[]>({
    queryKey: ['stories.latest'],
    enabled: !!serverUserId,
    queryFn: () => apiFetch<Story[]>('/api/stories'),
  });

  const { data: notificationData, refetch: refetchNotifications } = useQuery<{ notifications: NotificationItem[]; unreadCount: number }>({
    queryKey: ['notifications'],
    enabled: !!serverUserId,
    queryFn: () => apiFetch<{ notifications: NotificationItem[]; unreadCount: number }>('/api/notifications'),
    refetchInterval: 60000,
  });

  // The other side of a partnership acted, and this device only learns it from the poll. The first answer
  // for a user is the baseline: the lists were just fetched too. A request changes no feed, so only a
  // partner notice refetches them.
  const partnerNoticeSeenRef = useRef<{ userId: string | null; partnerId: number; requestId: number } | null>(null);
  useEffect(() => {
    if (!notificationData) return;
    const newestIdOf = (type: string) => notificationData.notifications
      .filter((item) => item.type === type)
      .reduce((newest, item) => Math.max(newest, item.id), 0);
    const partnerId = newestIdOf('partner');
    const requestId = newestIdOf('partner_request');
    const seen = partnerNoticeSeenRef.current?.userId === serverUserId ? partnerNoticeSeenRef.current : null;
    partnerNoticeSeenRef.current = {
      userId: serverUserId,
      partnerId: Math.max(partnerId, seen?.partnerId ?? 0),
      requestId: Math.max(requestId, seen?.requestId ?? 0),
    };
    if (!seen || !isCurrentAuthUser(serverUserId)) return;
    if (partnerId > seen.partnerId) invalidateAfterPartnerChange(queryClient);
    else if (requestId > seen.requestId) invalidateAfterPartnerRequest(queryClient);
  }, [notificationData, queryClient, serverUserId]);

  const applyLocalUser = useCallback(
    (drink: Drink) => {
      if (profile && serverUserId && drink.userId === serverUserId) {
        return { ...drink, user: { ...profile } };
      }
      return drink;
    },
    [profile, serverUserId]
  );

  const { toggleCheer, toggleSave } = useDrinkToggles();

  const markNotificationsRead = useMutation({
    mutationFn: () => apiFetch('/api/notifications/read', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      trimToFirstPage(queryClient, { queryKey: ['drinks.partners'] });
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }, [queryClient, refetch]);

  const notifications = notificationData?.notifications ?? [];
  const unreadCount = notificationData?.unreadCount ?? 0;
  const drinks = useMemo(() => flattenPages(partnerDrinksData).map(applyLocalUser), [applyLocalUser, partnerDrinksData]);

  const openNotifications = () => {
    setNotificationsVisible(true);
    // The 60 s poll can be behind: opening the drawer fetches the latest list.
    void refetchNotifications();
    if (unreadCount > 0) {
      markNotificationsRead.mutate();
    }
  };

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <FontAwesome5 name="wine-glass" size={20} color="#8B5FBF" />
          <View>
            <Text style={styles.headerTitle}>DrinkMe</Text>
            <Text style={styles.headerSubtitle}>{t('home.sections.feed')}</Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <TouchableOpacity
            style={styles.headerButton}
            onPress={() => navigation.navigate('CreatePost')}
            hitSlop={2}
            accessibilityRole="button"
            accessibilityLabel={t('createPost.title')}
          >
            <Ionicons name="add-circle-outline" size={24} color="#8B5FBF" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.notificationButton}
            onPress={openNotifications}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel={t('notifications.title')}
            accessibilityHint={unreadCount > 0 ? t('notifications.unreadCount', { count: unreadCount }) : undefined}
          >
            <Ionicons name="notifications-outline" size={24} color="#FFFFFF" />
            {unreadCount > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{unreadCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentContainer}
        refreshControl={<RefreshControl tintColor="#8B5FBF" refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <SuspensionBanner />
        {STORIES_ENABLED && <StoriesSection stories={stories} isLoading={isLoading} />}

        <Text style={styles.sectionLabel}>{t('home.sections.feed')}</Text>
        {partnerDrinksData === undefined ? (
          isError && !isFetching ? (
            <View style={styles.emptyState}>
              <Ionicons name="cloud-offline-outline" size={48} color="#6B7280" />
              <Text style={styles.emptySubtitle}>{t('home.sections.feedError')}</Text>
              <TouchableOpacity
                style={styles.createButton}
                onPress={() => refetch()}
                accessibilityRole="button"
                accessibilityLabel={t('common.retry')}
              >
                <Text style={styles.createButtonText}>{t('common.retry')}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.emptyState}>
              <ActivityIndicator size="large" color="#8B5FBF" />
            </View>
          )
        ) : drinks.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="people-outline" size={48} color="#6B7280" />
            <Text style={styles.emptyTitle}>{t('home.sections.emptyFeedTitle')}</Text>
            <Text style={styles.emptySubtitle}>{t('home.sections.emptyFeedSubtitle')}</Text>
            <TouchableOpacity
              style={styles.createButton}
              onPress={() => navigation.navigate('CreatePost')}
              accessibilityRole="button"
            >
              <Text style={styles.createButtonText}>{t('home.sections.createFirstPost')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.feed}>
            {drinks.map((drink) => (
              <DrinkPostCard
                key={drink.id}
                drink={drink}
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
            {hasNextPage && <LoadMoreButton onPress={() => fetchNextPage()} isLoading={isFetchingNextPage} />}
          </View>
        )}
      </ScrollView>

      <CommentDrawer drinkId={commentDrinkId} onClose={() => setCommentDrinkId(null)} />
      <PostActionsSheet drink={actionsDrink} onClose={() => setActionsDrink(null)} />

      <Modal visible={isNotificationsVisible} transparent animationType="slide" onRequestClose={() => setNotificationsVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('notifications.title')}</Text>
              <TouchableOpacity
                onPress={() => setNotificationsVisible(false)}
                hitSlop={11}
                accessibilityRole="button"
                accessibilityLabel={t('common.close')}
              >
                <Ionicons name="close" size={22} color="#FFFFFF" />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.notificationList}>
              {notifications.length === 0 ? (
                <View style={styles.emptyNotifications}>
                  <Ionicons name="notifications-off-outline" size={36} color="#6B7280" />
                  <Text style={styles.emptyNotificationsText}>{t('notifications.empty')}</Text>
                </View>
              ) : (
                notifications.map((item) => {
                  const iconName: React.ComponentProps<typeof Ionicons>['name'] =
                    item.type === 'comment'
                      ? 'chatbubble-outline'
                      : item.type === 'partner'
                      ? 'people-outline'
                      : item.type === 'partner_request'
                      ? 'person-add-outline'
                      : 'wine-outline';
                  const iconColor =
                    item.type === 'comment'
                      ? '#60A5FA'
                      : item.type === 'partner'
                      ? '#34D399'
                      : '#8B5FBF';
                  return (
                    <View key={item.id} style={[styles.notificationItem, !item.read && styles.notificationUnread]}>
                      <View style={[styles.notificationIcon, { backgroundColor: iconColor + '22' }]}>
                        <Ionicons name={iconName} size={18} color={iconColor} />
                      </View>
                      <View style={styles.notificationBody}>
                        <Text style={styles.notificationMessage}>{getNotificationText(item, t)}</Text>
                        <Text style={styles.notificationTimestamp}>{new Date(item.createdAt).toLocaleString(dateLocale)}</Text>
                      </View>
                    </View>
                  );
                })
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
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
  headerSubtitle: {
    fontSize: 12,
    color: '#9CA3AF',
    marginTop: 2,
  },
  headerButton: {
    padding: 8,
  },
  notificationButton: {
    padding: 6,
    position: 'relative',
  },
  badge: {
    position: 'absolute',
    top: 0,
    right: 0,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#F97316',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '600',
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    paddingBottom: 120,
  },
  sectionLabel: {
    color: '#9CA3AF',
    fontSize: 14,
    fontWeight: '500',
    paddingHorizontal: 16,
    paddingVertical: 12,
    textTransform: 'uppercase',
  },
  feed: {
    paddingBottom: 100,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 64,
    paddingHorizontal: 32,
    gap: 16,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#9CA3AF',
    textAlign: 'center',
    lineHeight: 20,
  },
  createButton: {
    backgroundColor: '#8B5FBF',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  createButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#0F172A',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 16,
    maxHeight: '70%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  modalTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
  },
  notificationList: {
    paddingBottom: 24,
  },
  notificationItem: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1F2937',
    alignItems: 'flex-start',
  },
  notificationUnread: {
    backgroundColor: '#8B5FBF0A',
    marginHorizontal: -4,
    paddingHorizontal: 4,
    borderRadius: 8,
  },
  notificationIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  notificationBody: {
    flex: 1,
  },
  notificationMessage: {
    color: '#FFFFFF',
    fontSize: 14,
    lineHeight: 18,
  },
  notificationTimestamp: {
    color: '#6B7280',
    fontSize: 12,
    marginTop: 4,
  },
  emptyNotifications: {
    alignItems: 'center',
    gap: 12,
    paddingVertical: 32,
  },
  emptyNotificationsText: {
    color: '#9CA3AF',
    fontSize: 14,
  },
});
