import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  Alert,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, FontAwesome5 } from '@expo/vector-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import DrinkPostCard from '../components/DrinkPostCard';
import StoriesSection from '../components/StoriesSection';
import { apiFetch } from '../lib/api';
import { Drink, Story, NotificationItem } from '../types/api';
import { useLocalization } from '../context/LocalizationContext';

export default function HomeScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);
  const [isNotificationsVisible, setNotificationsVisible] = useState(false);
  const { user, getJwtToken } = useAuth();
  const queryClient = useQueryClient();
  const { t } = useLocalization();

  const { data: partnerDrinks = [], refetch, isLoading } = useQuery<Drink[]>({
    queryKey: ['drinks.partners'],
    enabled: !!user,
    queryFn: () => apiFetch<Drink[]>('/api/drinks/partners'),
  });

  const { data: stories = [] } = useQuery<Story[]>({
    queryKey: ['stories.latest'],
    enabled: !!user,
    queryFn: () => apiFetch<Story[]>('/api/stories'),
  });

  const { data: notificationData } = useQuery<{ notifications: NotificationItem[]; unreadCount: number }>({
    queryKey: ['notifications'],
    enabled: !!user,
    queryFn: () => apiFetch<{ notifications: NotificationItem[]; unreadCount: number }>('/api/notifications'),
    refetchInterval: 60000,
  });

  const cheerMutation = useMutation({
    mutationFn: async (drinkId: number) => {
      const token = await getJwtToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      return apiFetch<{ cheered: boolean; cheersCount: number }>(`/api/drinks/${drinkId}/like`, {
        method: 'POST',
        headers,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['drinks.partners'] });
      queryClient.invalidateQueries({ queryKey: ['drinks.all'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: () => {
      Alert.alert(t('errors.cheerFailed'));
    },
  });

  const saveMutation = useMutation({
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['drinks.partners'] });
      queryClient.invalidateQueries({ queryKey: ['smartBar.inventory'] });
      queryClient.invalidateQueries({ queryKey: ['users.savedDrinks', user?.uid] });
    },
    onError: () => {
      Alert.alert(t('errors.saveFailed'));
    },
  });

  const markNotificationsRead = useMutation({
    mutationFn: () => apiFetch('/api/notifications/read', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const onRefresh = React.useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  const openNotifications = () => {
    setNotificationsVisible(true);
    if ((notificationData?.unreadCount || 0) > 0) {
      markNotificationsRead.mutate();
    }
  };

  const closeNotifications = () => setNotificationsVisible(false);

  const notifications = useMemo(
    () => notificationData?.notifications ?? [],
    [notificationData]
  );

  const unreadCount = notificationData?.unreadCount ?? 0;

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>DrinkMe</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.notificationButton} onPress={openNotifications}>
            <Ionicons name="notifications-outline" size={22} color="#FFFFFF" />
            {unreadCount > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{Math.min(unreadCount, 99)}</Text>
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.headerButton} onPress={() => navigation.navigate('CreatePost')}>
            <Ionicons name="add" size={24} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        style={styles.content}
        contentInsetAdjustmentBehavior="never"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#8B5FBF" />
        }
        contentContainerStyle={styles.contentContainer}
      >
        {stories.length > 0 && <StoriesSection stories={stories} />}

        <Text style={styles.sectionLabel}>{t('home.sections.feed')}</Text>

        <View style={styles.feed}>
          {partnerDrinks.length === 0 && !isLoading ? (
            <View style={styles.emptyState}>
              <Ionicons name="wine-outline" size={64} color="#6B7280" />
              <Text style={styles.emptyTitle}>{t('home.sections.emptyFeedTitle')}</Text>
              <Text style={styles.emptySubtitle}>{t('home.sections.emptyFeedSubtitle')}</Text>
              <TouchableOpacity
                style={styles.createButton}
                onPress={() => navigation.navigate('CreatePost')}
              >
                <Text style={styles.createButtonText}>{t('home.sections.createFirstPost')}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            partnerDrinks.map((drink) => (
              <DrinkPostCard
                key={drink.id}
                drink={drink}
                onCheer={() => cheerMutation.mutate(drink.id)}
                onComment={() => navigation.navigate('DrinkDetail', { drinkId: drink.id })}
                onSave={() => saveMutation.mutate(drink.id)}
                isLiked={drink.isLiked}
                isSaved={drink.isSaved}
                cheersCount={drink.cheersCount}
              />
            ))
          )}
        </View>
      </ScrollView>

      <Modal
        visible={isNotificationsVisible}
        transparent
        animationType="slide"
        onRequestClose={closeNotifications}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('notifications.title')}</Text>
              <TouchableOpacity onPress={closeNotifications}>
                <Ionicons name="close" size={22} color="#FFFFFF" />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.notificationList}>
              {notifications.length === 0 ? (
                <View style={styles.emptyNotifications}>
                  <Ionicons name="notifications-off" size={28} color="#6B7280" />
                  <Text style={styles.emptyNotificationsText}>{t('notifications.empty')}</Text>
                </View>
              ) : (
                notifications.map((notification) => {
                  const iconName =
                    notification.type === 'comment'
                      ? 'comment-dots'
                      : notification.type === 'partner'
                      ? 'user-friends'
                      : 'glass-cheers';
                  return (
                    <View key={notification.id} style={styles.notificationItem}>
                      <FontAwesome5 name={iconName as any} size={16} color="#8B5FBF" />
                      <View style={styles.notificationBody}>
                        <Text style={styles.notificationMessage}>{notification.message}</Text>
                        <Text style={styles.notificationTimestamp}>
                          {new Date(notification.createdAt).toLocaleString()}
                        </Text>
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
    justifyContent: 'space-between',
    alignItems: 'center',
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
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
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
