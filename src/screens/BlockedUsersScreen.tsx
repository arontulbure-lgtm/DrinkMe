import React from 'react';
import { ActivityIndicator, Alert, FlatList, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isCurrentAuthUser, useAuth } from '../context/AuthContext';
import { useLocalization } from '../context/LocalizationContext';
import { apiFetch, getImageSource } from '../lib/api';
import { invalidateAfterUnblock } from '../lib/drinkCache';
import { BaseUser } from '../types/api';
import ListLoadState from '../components/ListLoadState';
import { RootStackScreenProps } from '../navigation/types';

type Props = RootStackScreenProps<'BlockedUsers'>;

export default function BlockedUsersScreen({ navigation }: Props) {
  const { serverUserId } = useAuth();
  const queryClient = useQueryClient();
  const { t } = useLocalization();

  const { data: blockedUsers, isError, isFetching, refetch } = useQuery<BaseUser[]>({
    queryKey: ['blocks'],
    enabled: !!serverUserId,
    queryFn: () => apiFetch<BaseUser[]>('/api/blocks'),
  });

  const unblockMutation = useMutation({
    mutationFn: (userId: string) => apiFetch<void>(`/api/blocks/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
    onSuccess: (_result, userId) => {
      if (!isCurrentAuthUser(serverUserId)) return;
      queryClient.setQueryData<BaseUser[]>(['blocks'], (existing) => existing?.filter((item) => item.id !== userId));
      invalidateAfterUnblock(queryClient, userId);
    },
    onError: () => Alert.alert(t('block.listTitle'), t('block.failed')),
  });

  const renderItem = ({ item }: { item: BaseUser }) => {
    const displayName = item.firstName
      ? `${item.firstName} ${item.lastName || ''}`.trim()
      : t('common.unknownUser');
    const isUnblocking = unblockMutation.isPending && unblockMutation.variables === item.id;

    return (
      <View style={styles.row}>
        <View style={styles.avatar}>
          {item.avatar ? (
            <Image source={getImageSource(item.avatar)} style={styles.avatarImage} />
          ) : (
            <Text style={styles.avatarText}>{displayName[0]?.toUpperCase() || '?'}</Text>
          )}
        </View>
        <Text style={styles.name} numberOfLines={1}>{displayName}</Text>
        <TouchableOpacity
          style={[styles.unblockButton, unblockMutation.isPending && styles.buttonDisabled]}
          onPress={() => unblockMutation.mutate(item.id)}
          disabled={unblockMutation.isPending}
          accessibilityRole="button"
          accessibilityLabel={`${t('block.unblock')} ${displayName}`}
        >
          {isUnblocking ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={styles.unblockText}>{t('block.unblock')}</Text>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={navigation.goBack}
          style={styles.headerButton}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
        >
          <Ionicons name="chevron-back" size={22} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('block.listTitle')}</Text>
        <View style={styles.headerButton} />
      </View>

      {blockedUsers === undefined ? (
        <ListLoadState
          isError={isError}
          isFetching={isFetching}
          message={t('block.loadError')}
          onRetry={() => refetch()}
        />
      ) : (
        <FlatList
          data={blockedUsers}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={blockedUsers.length === 0 ? styles.emptyContainer : undefined}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="ban-outline" size={40} color="#6B7280" />
              <Text style={styles.emptyText}>{t('block.empty')}</Text>
            </View>
          }
        />
      )}
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
  headerButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1F2937',
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#374151',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
  },
  avatarImage: {
    width: '100%',
    height: '100%',
  },
  name: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '500',
  },
  unblockButton: {
    backgroundColor: '#1F2937',
    borderRadius: 12,
    minHeight: 44,
    minWidth: 96,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unblockText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  emptyContainer: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  emptyState: {
    alignItems: 'center',
    gap: 12,
  },
  emptyText: {
    color: '#9CA3AF',
  },
});
