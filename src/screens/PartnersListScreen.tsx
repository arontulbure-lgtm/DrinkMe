import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  TouchableOpacity,
  Image,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, getImageSource, isForbiddenError, isNotFoundError, retryUnlessNotFound } from '../lib/api';
import {
  invalidateAfterPartnerChange,
  invalidateAfterPartnerRequest,
  setPartnerStatusInCaches,
} from '../lib/drinkCache';
import { getPartnerErrorKey, usePartnerAction } from '../lib/usePartnerAction';
import { useRefreshIfSuspended } from '../lib/useRefreshIfSuspended';
import { BaseUser, PartnerActionResult, PartnerRequests } from '../types/api';
import { isCurrentAuthUser, useAuth } from '../context/AuthContext';
import { useLocalization } from '../context/LocalizationContext';
import ListLoadState from '../components/ListLoadState';

interface PartnersListScreenProps {
  navigation: any;
  route: { params?: { userId?: string } };
}

type PartnerRow = { kind: 'incoming' | 'outgoing' | 'partner'; user: BaseUser };
type PartnerSection = { key: 'requests' | 'partners'; title?: string; data: PartnerRow[] };

export default function PartnersListScreen({ navigation, route }: PartnersListScreenProps) {
  const { t } = useLocalization();
  const { serverUserId } = useAuth();
  const queryClient = useQueryClient();
  const refreshIfSuspended = useRefreshIfSuspended();
  const userId = route?.params?.userId;
  const isOwner = !userId || userId === serverUserId;

  const {
    data: partners,
    error: partnersError,
    isError: isPartnersError,
    isFetching: isPartnersFetching,
    refetch: refetchPartners,
  } = useQuery<BaseUser[]>({
    queryKey: ['drink-partners', userId],
    // A private list stays private on a second try.
    retry: (failureCount, error) => !isForbiddenError(error) && retryUnlessNotFound(failureCount, error),
    queryFn: () => {
      if (userId) {
        return apiFetch<BaseUser[]>(`/api/users/${userId}/partners`);
      }
      return apiFetch<BaseUser[]>('/api/drink-partners');
    },
  });

  // Under drink-partners, so whatever refreshes the partner list refreshes this too.
  const {
    data: requests,
    isError: isRequestsError,
    isFetching: isRequestsFetching,
    refetch: refetchRequests,
  } = useQuery<PartnerRequests>({
    queryKey: ['drink-partners', 'requests'],
    enabled: isOwner && !!serverUserId,
    staleTime: 0,
    queryFn: () => apiFetch<PartnerRequests>('/api/drink-partners/requests'),
  });

  // Also over cached data: someone who stopped being a partner must not keep seeing the list.
  const isPrivate = isForbiddenError(partnersError);
  const isGone = isNotFoundError(partnersError);

  const { pressPartner, pendingTargetId } = usePartnerAction();

  const answerMutation = useMutation({
    mutationFn: async ({ fromId, accept }: { fromId: string; accept: boolean }): Promise<PartnerActionResult> => {
      if (accept) {
        return apiFetch<PartnerActionResult>(`/api/drink-partners/requests/${fromId}/accept`, { method: 'POST' });
      }
      await apiFetch(`/api/drink-partners/requests/${fromId}`, { method: 'DELETE' });
      return { status: 'none', isPartner: false };
    },
    onSuccess: (result, { fromId }) => {
      if (!isCurrentAuthUser(serverUserId)) return;
      setPartnerStatusInCaches(queryClient, fromId, result.status);
      if (result.status === 'partner') invalidateAfterPartnerChange(queryClient, fromId);
      else invalidateAfterPartnerRequest(queryClient, fromId);
    },
    onError: (error, { fromId }) => {
      // The other side cancelled, or a block started: the refetch takes the row away.
      if (isNotFoundError(error) && isCurrentAuthUser(serverUserId)) invalidateAfterPartnerRequest(queryClient, fromId);
      refreshIfSuspended(error);
      Alert.alert(t(getPartnerErrorKey(error)));
    },
  });
  const answeringId = answerMutation.isPending ? answerMutation.variables?.fromId : undefined;

  const sections = useMemo<PartnerSection[]>(() => {
    const partnerRows: PartnerRow[] = isPrivate || isGone
      ? []
      : (partners ?? []).map((user) => ({ kind: 'partner', user }));
    if (!isOwner) return [{ key: 'partners', data: partnerRows }];
    const requestRows: PartnerRow[] = [
      ...(requests?.incoming ?? []).map((user): PartnerRow => ({ kind: 'incoming', user })),
      ...(requests?.outgoing ?? []).map((user): PartnerRow => ({ kind: 'outgoing', user })),
    ];
    return [
      { key: 'requests', title: t('partners.requests'), data: requestRows },
      { key: 'partners', title: t('profile.drinkPartners'), data: partnerRows },
    ];
  }, [isGone, isOwner, isPrivate, partners, requests, t]);

  const renderItem = ({ item }: { item: PartnerRow }) => {
    const { kind, user } = item;
    const displayName = user.firstName
      ? `${user.firstName} ${user.lastName || ''}`.trim()
      : t('common.unknownUser');

    return (
      <TouchableOpacity
        style={styles.row}
        onPress={() =>
          navigation.navigate(
            user.id === serverUserId ? 'Profile' : 'UserProfile',
            user.id === serverUserId ? undefined : { userId: user.id }
          )
        }
      >
        <View style={styles.avatar}>
          {user.avatar ? (
            <Image source={getImageSource(user.avatar)} style={styles.avatarImage} />
          ) : (
            <Text style={styles.avatarText}>{displayName[0]?.toUpperCase() || '?'}</Text>
          )}
        </View>
        <View style={styles.rowContent}>
          <Text style={styles.name} numberOfLines={1}>{displayName}</Text>
          {kind === 'outgoing' ? (
            <Text style={styles.city}>{t('partners.requested')}</Text>
          ) : user.city ? (
            <Text style={styles.city} numberOfLines={1}>{user.city}</Text>
          ) : null}
        </View>
        {kind === 'partner' && <Ionicons name="chevron-forward" size={18} color="#6B7280" />}
        {kind === 'incoming' && (
          <View style={styles.rowActions}>
            <TouchableOpacity
              style={[styles.actionButton, styles.actionButtonPrimary]}
              onPress={() => answerMutation.mutate({ fromId: user.id, accept: true })}
              disabled={answeringId === user.id}
              accessibilityRole="button"
              accessibilityLabel={t('partners.accept')}
            >
              <Text style={styles.actionText}>{t('partners.accept')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => answerMutation.mutate({ fromId: user.id, accept: false })}
              disabled={answeringId === user.id}
              accessibilityRole="button"
              accessibilityLabel={t('partners.decline')}
            >
              <Text style={styles.actionText}>{t('partners.decline')}</Text>
            </TouchableOpacity>
          </View>
        )}
        {kind === 'outgoing' && (
          <View style={styles.rowActions}>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => pressPartner(user.id, 'requested')}
              disabled={pendingTargetId === user.id}
              accessibilityRole="button"
              accessibilityLabel={t('common.cancel')}
            >
              <Text style={styles.actionText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  const renderRequestsState = () => {
    if (requests === undefined) {
      return (
        <ListLoadState
          isError={isRequestsError}
          isFetching={isRequestsFetching}
          message={t('partners.requestsLoadError')}
          onRetry={() => refetchRequests()}
        />
      );
    }
    return requests.incoming.length + requests.outgoing.length === 0
      ? <Text style={styles.sectionEmptyText}>{t('partners.noRequests')}</Text>
      : null;
  };

  const renderPartnersState = () => {
    if (isPrivate) {
      return (
        <View style={styles.emptyState}>
          <Ionicons name="lock-closed-outline" size={40} color="#6B7280" />
          <Text style={styles.emptyText}>{t('partners.private')}</Text>
        </View>
      );
    }
    if (isGone) {
      return (
        <View style={styles.emptyState}>
          <Ionicons name="person-outline" size={40} color="#6B7280" />
          <Text style={styles.emptyText}>{t('profile.notFound')}</Text>
        </View>
      );
    }
    if (partners === undefined) {
      return (
        <ListLoadState
          isError={isPartnersError}
          isFetching={isPartnersFetching}
          message={t('partners.loadError')}
          onRetry={() => refetchPartners()}
        />
      );
    }
    return partners.length === 0 ? (
      <View style={styles.emptyState}>
        <Ionicons name="people-outline" size={40} color="#6B7280" />
        <Text style={styles.emptyText}>{t('profile.noPartners')}</Text>
      </View>
    ) : null;
  };

  return (
    <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerButton}>
          <Ionicons name="chevron-back" size={22} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('profile.drinkPartners')}</Text>
        <View style={styles.headerButton} />
      </View>

      {isPartnersFetching && partners !== undefined && !isPrivate && (
        <ActivityIndicator size="small" color="#8B5FBF" style={styles.refreshIndicator} />
      )}

      <SectionList<PartnerRow, PartnerSection>
        sections={sections}
        keyExtractor={(item) => `${item.kind}-${item.user.id}`}
        renderItem={renderItem}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) =>
          section.title ? <Text style={styles.sectionTitle}>{section.title}</Text> : null
        }
        renderSectionFooter={({ section }) =>
          section.key === 'requests' ? renderRequestsState() : renderPartnersState()
        }
      />
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
    borderBottomWidth: 1,
    borderBottomColor: '#1F2937',
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#4B5563',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
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
  rowContent: {
    flex: 1,
    gap: 2,
  },
  name: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '500',
  },
  city: {
    color: '#9CA3AF',
    fontSize: 13,
  },
  emptyState: {
    alignItems: 'center',
    gap: 12,
    paddingVertical: 48,
    paddingHorizontal: 16,
  },
  emptyText: {
    color: '#9CA3AF',
    textAlign: 'center',
  },
  refreshIndicator: {
    marginTop: 8,
  },
  sectionTitle: {
    color: '#9CA3AF',
    fontSize: 14,
    fontWeight: '600',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  sectionEmptyText: {
    color: '#6B7280',
    fontSize: 14,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  rowActions: {
    flexDirection: 'row',
    gap: 8,
    marginLeft: 8,
  },
  actionButton: {
    minHeight: 44,
    paddingHorizontal: 12,
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#374151',
  },
  actionButtonPrimary: {
    backgroundColor: '#8B5FBF',
    borderColor: '#8B5FBF',
  },
  actionText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
});
