import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import { isCurrentAuthUser, useAuth } from '../context/AuthContext';
import {
  ACCOUNT_SUSPENDED_ERROR_KEY,
  apiFetch,
  ApiError,
  isAccountSuspendedError,
  isNotFoundError,
  retryUnlessNotFound,
} from '../lib/api';
import { flattenPages, getNextCursor, trimAndInvalidate } from '../lib/drinkCache';
import { getPartnerLabelKey, usePartnerAction } from '../lib/usePartnerAction';
import { useRefreshIfSuspended } from '../lib/useRefreshIfSuspended';
import { useDrinkToggles } from '../lib/useDrinkToggles';
import { BaseUser, Drink, Page } from '../types/api';
import { useLocalization } from '../context/LocalizationContext';
import DrinkPostCard from '../components/DrinkPostCard';
import CommentDrawer from '../components/CommentDrawer';
import PostActionsSheet from '../components/PostActionsSheet';
import ListLoadState from '../components/ListLoadState';
import LoadMoreButton from '../components/LoadMoreButton';
import ModerationNotice, { SuspensionBanner } from '../components/ModerationNotice';
import OfficialBadge from '../components/OfficialBadge';
import type { NavigationProp } from '@react-navigation/native';
import { RootStackParamList, RootStackScreenProps, TabScreenProps } from '../navigation/types';
import MediaImage from '../components/MediaImage';

// Mounted twice: as the Profile tab (own profile) and as the UserProfile stack screen. navigation is the
// part both mounts share (a union of the two cannot be called), so only navigate, goBack and isFocused
// are available. Tabs are reached through 'Main', which works from both mounts.
interface ProfileScreenProps {
  navigation: NavigationProp<RootStackParamList>;
  route: TabScreenProps<'Profile'>['route'] | RootStackScreenProps<'UserProfile'>['route'];
}

export default function ProfileScreen({ navigation, route }: ProfileScreenProps) {
  const queryClient = useQueryClient();
  const { profile, serverUserId, logout, getJwtToken, setProfile, user: firebaseUser } = useAuth();
  const { t } = useLocalization();
  const refreshIfSuspended = useRefreshIfSuspended();

  const viewedUserId = route?.params?.userId ?? serverUserId;
  const isSelf = !route?.params?.userId || route.params.userId === serverUserId;

  const [activeTab, setActiveTab] = useState<'posts' | 'saved'>('posts');
  const [commentDrinkId, setCommentDrinkId] = useState<number | null>(null);
  const [actionsDrink, setActionsDrink] = useState<Drink | null>(null);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);

  const {
    data: profileData,
    error: profileError,
    isLoading: isProfileLoading,
    isError: isProfileError,
    refetch: refetchProfile,
  } = useQuery<BaseUser>({
    queryKey: ['users.detail', viewedUserId],
    // For the owner, profile is set after the token exchange, so the public view is never cached.
    enabled: !!viewedUserId && (!isSelf || !!profile),
    retry: retryUnlessNotFound,
    queryFn: () => apiFetch<BaseUser>(`/api/users/${viewedUserId}`),
  });

  useEffect(() => {
    if (profileData && isSelf && viewedUserId) {
      const normalizedEmail = (
        profileData.email ?? firebaseUser?.email ?? `user+${viewedUserId}@drinkme.app`
      ) as string;
      const nextProfile: BaseUser = { ...profileData, id: viewedUserId, email: normalizedEmail };
      setProfile(nextProfile);
    }
  }, [firebaseUser?.email, isSelf, profileData, setProfile, viewedUserId]);

  const {
    data: userDrinkPages,
    refetch: refetchUserDrinks,
    isError: isUserDrinksError,
    isFetching: isUserDrinksFetching,
    hasNextPage: hasMoreUserDrinks,
    fetchNextPage: fetchMoreUserDrinks,
    isFetchingNextPage: isFetchingMoreUserDrinks,
  } = useInfiniteQuery({
    queryKey: ['drinks.byUser', viewedUserId],
    enabled: !!viewedUserId,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      apiFetch<Page<Drink>>(`/api/drinks/user/${viewedUserId}`, { query: { before: pageParam } }),
    getNextPageParam: getNextCursor,
  });
  const userDrinks = flattenPages(userDrinkPages);
  const userDrinksTotal = userDrinkPages?.pages[0]?.total;

  const {
    data: savedDrinkPages,
    refetch: refetchSaved,
    isError: isSavedError,
    isFetching: isSavedFetching,
    hasNextPage: hasMoreSaved,
    fetchNextPage: fetchMoreSaved,
    isFetchingNextPage: isFetchingMoreSaved,
  } = useInfiniteQuery({
    queryKey: ['users.savedDrinks', viewedUserId],
    enabled: isSelf && !!viewedUserId,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      apiFetch<Page<Drink>>(`/api/users/${viewedUserId}/saved-drinks`, { query: { before: pageParam } }),
    getNextPageParam: getNextCursor,
  });
  const savedDrinks = flattenPages(savedDrinkPages);

  // By post author, not isSelf: the Saved tab also holds other users' posts.
  const applyLocalUser = (drink: Drink) => {
    if (profile && serverUserId && drink.userId === serverUserId) {
      return { ...drink, user: { ...profile } };
    }
    return drink;
  };

  const { data: friendsCount } = useQuery<number>({
    queryKey: ['friends.count'],
    enabled: isSelf,
    queryFn: () => apiFetch<number>('/api/friends/count'),
  });

  // friends.count is always the signed-in user's own, so it is never shown on another user's profile.
  const shownPartnerCount = isSelf ? friendsCount : profileData?.partnerCount;
  const canOpenPartners = isSelf || shownPartnerCount !== undefined;

  const partnerStatus = profileData?.partnerStatus ?? 'none';
  const { pressPartner, pendingTargetId } = usePartnerAction();

  // Another user's profile must never fall back to the viewer's own data.
  const shownUser = isSelf ? profileData || profile : profileData;

  const displayName = useMemo(() => {
    const source = shownUser;
    if (source?.firstName) {
      return `${source.firstName} ${source.lastName || ''}`.trim();
    }
    if (!isSelf) {
      // Blank until loaded. A masked first name can still leave a public last name.
      if (!profileData) return '';
      return profileData.lastName || t('common.unknownUser');
    }
    return source?.email || firebaseUser?.email || t('common.unknownUser');
  }, [firebaseUser?.email, isSelf, profileData, shownUser, t]);

  const handleLogout = () => {
    Alert.alert(
      t('profile.logout'),
      t('profile.logoutConfirm'),
      [
        { text: t('profile.cancel'), style: 'cancel' },
        {
          text: t('profile.logout'),
          style: 'destructive',
          onPress: logout,
        },
      ]
    );
  };

  const avatarSource = isSelf ? profileData?.avatar || profile?.avatar : profileData?.avatar;
  // Also over cached data: the account can be gone, or a block can have started since.
  const isProfileGone = !isSelf && isNotFoundError(profileError);
  const isOtherProfileMissing = !isSelf && (!profileData || isProfileGone);

  // Mutation callbacks still run after this screen is gone, and goBack pops whichever route is focused.
  const leaveIfUserBlocked = (blockedUserId: string) => {
    if (!isSelf && blockedUserId === viewedUserId && navigation.isFocused()) navigation.goBack();
  };

  const uploadAvatarMutation = useMutation({
    mutationFn: async (asset: ImagePicker.ImagePickerAsset) => {
      if (!viewedUserId) throw new Error('Missing user id');
      const token = await getJwtToken();
      const formData = new FormData();
      const mimeType = asset.mimeType || (asset.uri?.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg');
      formData.append('avatar', {
        uri: asset.uri,
        name: `avatar-${viewedUserId}.jpg`,
        type: mimeType,
      } as any);

      return apiFetch<BaseUser>(`/api/users/${viewedUserId}/avatar`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
    },
    onSuccess: (updated) => {
      if (!isCurrentAuthUser(serverUserId)) return;
      if (viewedUserId) {
        queryClient.setQueryData<BaseUser>(['users.detail', viewedUserId], updated);
        trimAndInvalidate(queryClient, { queryKey: ['drinks.byUser', viewedUserId] });
      }
      trimAndInvalidate(queryClient, { queryKey: ['drinks.partners'] });
      queryClient.invalidateQueries({
        predicate: ({ queryKey }) => Array.isArray(queryKey) && queryKey[0] === 'users.search',
      });
      if (isSelf) {
        setProfile(updated);
      }
    },
    onError: (error) => {
      const status = error instanceof ApiError ? error.status : undefined;
      const code = error instanceof ApiError ? error.code : undefined;
      let message = t('profile.avatarUploadError');
      if (status === 413) message = t('profile.avatarTooLarge');
      if (status === 400) message = t('profile.avatarInvalidFormat');
      if (status === 507) message = t(code === 'user_image_quota' ? 'common.imageQuotaReached' : 'common.serviceUnavailable');
      if (isAccountSuspendedError(error)) message = t(ACCOUNT_SUSPENDED_ERROR_KEY);
      refreshIfSuspended(error);
      Alert.alert(t('profile.title'), message);
    },
  });

  const { toggleCheer, toggleSave } = useDrinkToggles({ alertTitleKey: 'profile.title' });

  const handlePickAvatar = async () => {
    if (!isSelf || !viewedUserId) return;
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(t('profile.title'), t('scanner.permissionLibrary'));
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.5,
      mediaTypes: 'images',
    });

    if (!result.canceled && result.assets?.[0]) {
      uploadAvatarMutation.mutate(result.assets[0]);
    }
  };

  const isPartnerOutlined = partnerStatus === 'partner' || partnerStatus === 'requested';

  return (
    <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('profile.title')}</Text>
        <View style={styles.headerActions}>
          {isSelf ? (
            <>
              <TouchableOpacity
                onPress={() => navigation.navigate('LanguageSettings')}
                style={styles.headerIconButton}
                hitSlop={7}
                accessibilityRole="button"
                accessibilityLabel={t('profile.language')}
              >
                <Ionicons name="settings-outline" size={22} color="#8B5FBF" />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleLogout}
                style={styles.headerIconButton}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={t('profile.logout')}
              >
                <Ionicons name="log-out-outline" size={24} color="#EF4444" />
              </TouchableOpacity>
            </>
          ) : (
            <>
              {!isOtherProfileMissing && (
                <TouchableOpacity
                  onPress={() => setIsUserMenuOpen(true)}
                  style={styles.headerIconButton}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('common.moreOptions')}
                >
                  <Ionicons name="ellipsis-horizontal" size={22} color="#FFFFFF" />
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={() => navigation.goBack()}
                style={styles.headerIconButton}
                hitSlop={7}
                accessibilityRole="button"
                accessibilityLabel={t('common.close')}
              >
                <Ionicons name="close" size={22} color="#FFFFFF" />
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>

      {isProfileGone ? (
        <View style={styles.profileGone}>
          <Ionicons name="person-outline" size={48} color="#6B7280" />
          <Text style={styles.emptyDrinksText}>{t('profile.notFound')}</Text>
        </View>
      ) : (
      <ScrollView style={styles.content}>
        {isSelf && <SuspensionBanner />}
        {isSelf && profileData?.hiddenPendingReview && (
          <ModerationNotice messageKey="moderation.hiddenProfile" style={styles.hiddenProfileNotice} />
        )}
        <View style={styles.profileSection}>
          <TouchableOpacity
            style={styles.avatar}
            onPress={handlePickAvatar}
            disabled={!isSelf || uploadAvatarMutation.isPending}
          >
            {avatarSource ? (
              <MediaImage uri={avatarSource} style={styles.avatarImage} />
            ) : (
              <Text style={styles.avatarText}>{displayName[0]?.toUpperCase() || '?'}</Text>
            )}
            {isSelf && (
              <View style={styles.avatarBadge}>
                <Ionicons name="camera" size={14} color="#FFFFFF" />
              </View>
            )}
          </TouchableOpacity>

          {isOtherProfileMissing ? (
            isProfileError ? (
              <View style={styles.profileLoadError}>
                <Text style={styles.profileLoadErrorText}>{t('profile.loadError')}</Text>
                <TouchableOpacity
                  style={styles.profileRetryButton}
                  onPress={() => refetchProfile()}
                  accessibilityRole="button"
                  accessibilityLabel={t('profile.retry')}
                >
                  <Text style={styles.editButtonText}>{t('profile.retry')}</Text>
                </TouchableOpacity>
              </View>
            ) : isProfileLoading ? (
              <ActivityIndicator color="#8B5FBF" style={styles.profileLoading} />
            ) : null
          ) : (
            <View style={styles.displayNameRow}>
              <Text style={[styles.displayName, styles.displayNameShrink]} numberOfLines={2}>{displayName}</Text>
              <OfficialBadge official={shownUser?.official} size="large" />
            </View>
          )}
          {isSelf ? (
            <Text style={styles.email}>{profileData?.email || profile?.email || firebaseUser?.email}</Text>
          ) : null}
          {profileData?.city ? <Text style={styles.meta}>{profileData.city}</Text> : null}
          {profileData?.bio ? <Text style={styles.bio}>{profileData.bio}</Text> : null}

          <View style={styles.statsContainer}>
            <View style={styles.statItem}>
              <Text style={styles.statNumber}>{userDrinksTotal ?? '–'}</Text>
              <Text style={styles.statLabel}>{t('profile.posts')}</Text>
            </View>
            <TouchableOpacity
              style={[styles.statItemTouchable, !canOpenPartners && styles.statItemDisabled]}
              onPress={() =>
                navigation.navigate('PartnersList', {
                  userId: viewedUserId,
                })
              }
              disabled={!canOpenPartners}
            >
              <Text style={styles.statNumber}>{shownPartnerCount ?? '-'}</Text>
              <Text style={styles.statLabel}>{t('profile.drinkPartners')}</Text>
            </TouchableOpacity>
          </View>

          {isSelf ? (
            <TouchableOpacity
              style={styles.editButton}
              onPress={() => navigation.navigate('EditProfile')}
            >
              <Text style={styles.editButtonText}>{t('profile.edit')}</Text>
            </TouchableOpacity>
          ) : isOtherProfileMissing ? null : (
            <TouchableOpacity
              style={[
                styles.partnerToggleButton,
                isPartnerOutlined && styles.partnerToggleButtonActive,
                partnerStatus === 'requested' && styles.partnerToggleButtonRequested,
              ]}
              onPress={() => viewedUserId && pressPartner(viewedUserId, partnerStatus)}
              disabled={pendingTargetId === viewedUserId}
              accessibilityRole="button"
              accessibilityLabel={t(getPartnerLabelKey(partnerStatus))}
            >
              <Text
                style={[
                  styles.partnerToggleText,
                  isPartnerOutlined && styles.partnerToggleTextActive,
                  partnerStatus === 'requested' && styles.partnerToggleTextRequested,
                ]}
              >
                {t(getPartnerLabelKey(partnerStatus))}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Tab bar — Saved only visible to self */}
        <View style={styles.tabBar}>
          <TouchableOpacity
            style={[styles.tabItem, activeTab === 'posts' && styles.tabItemActive]}
            onPress={() => setActiveTab('posts')}
          >
            <Ionicons
              name="grid-outline"
              size={18}
              color={activeTab === 'posts' ? '#8B5FBF' : '#6B7280'}
            />
            <Text style={[styles.tabLabel, activeTab === 'posts' && styles.tabLabelActive]}>
              {t('profile.posts')}
            </Text>
          </TouchableOpacity>

          {isSelf && (
            <TouchableOpacity
              style={[styles.tabItem, activeTab === 'saved' && styles.tabItemActive]}
              onPress={() => setActiveTab('saved')}
            >
              <Ionicons
                name="bookmark-outline"
                size={18}
                color={activeTab === 'saved' ? '#8B5FBF' : '#6B7280'}
              />
              <Text style={[styles.tabLabel, activeTab === 'saved' && styles.tabLabelActive]}>
                {t('profile.saved')}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Posts tab */}
        {activeTab === 'posts' && (
          <View style={styles.section}>
            {userDrinkPages === undefined ? (
              <ListLoadState
                isError={isUserDrinksError}
                isFetching={isUserDrinksFetching}
                message={t('profile.postsLoadError')}
                onRetry={() => refetchUserDrinks()}
              />
            ) : userDrinks.length === 0 ? (
              <View style={styles.emptyDrinks}>
                <Ionicons name="wine-outline" size={48} color="#6B7280" />
                <Text style={styles.emptyDrinksText}>{t('profile.emptyDrinks')}</Text>
                {isSelf && (
                  <TouchableOpacity
                    style={styles.createPostButton}
                    onPress={() => navigation.navigate('CreatePost')}
                  >
                    <Text style={styles.createPostButtonText}>{t('profile.createFirstPost')}</Text>
                  </TouchableOpacity>
                )}
              </View>
            ) : (
              <View style={{ gap: 16 }}>
                {userDrinks.map(applyLocalUser).map((drink) => (
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
                    onPressAuthor={() => {}}
                  />
                ))}
                {hasMoreUserDrinks && (
                  <LoadMoreButton onPress={() => fetchMoreUserDrinks()} isLoading={isFetchingMoreUserDrinks} />
                )}
              </View>
            )}
          </View>
        )}

        {/* Saved tab — self only */}
        {activeTab === 'saved' && isSelf && (
          <View style={styles.section}>
            {savedDrinkPages === undefined ? (
              <ListLoadState
                isError={isSavedError}
                isFetching={isSavedFetching}
                message={t('profile.postsLoadError')}
                onRetry={() => refetchSaved()}
              />
            ) : savedDrinks.length === 0 ? (
              <View style={styles.emptyDrinks}>
                <Ionicons name="bookmark-outline" size={48} color="#6B7280" />
                <Text style={styles.emptyDrinksText}>{t('smartBar.savedEmptyTitle')}</Text>
                <Text style={[styles.emptyDrinksText, { fontSize: 13, marginTop: 4 }]}>
                  {t('smartBar.savedEmptySubtitle')}
                </Text>
              </View>
            ) : (
              <View style={{ gap: 16 }}>
                {savedDrinks.map(applyLocalUser).map((drink) => (
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
                        ? navigation.navigate('Main', { screen: 'Profile' })
                        : navigation.navigate('UserProfile', { userId: drink.userId })
                    }
                  />
                ))}
                {hasMoreSaved && <LoadMoreButton onPress={() => fetchMoreSaved()} isLoading={isFetchingMoreSaved} />}
              </View>
            )}
          </View>
        )}
      </ScrollView>
      )}

      <CommentDrawer drinkId={commentDrinkId} onClose={() => setCommentDrinkId(null)} onBlocked={leaveIfUserBlocked} />
      <PostActionsSheet
        drink={actionsDrink}
        userId={isUserMenuOpen ? viewedUserId : null}
        onClose={() => {
          setActionsDrink(null);
          setIsUserMenuOpen(false);
        }}
        onBlocked={leaveIfUserBlocked}
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
  headerIconButton: {
    padding: 4,
  },
  content: {
    flex: 1,
  },
  profileSection: {
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 24,
  },
  avatar: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: '#1F2937',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    position: 'relative',
    overflow: 'hidden',
  },
  avatarImage: {
    width: '100%',
    height: '100%',
  },
  avatarText: {
    color: '#FFFFFF',
    fontSize: 32,
    fontWeight: '700',
  },
  avatarBadge: {
    position: 'absolute',
    right: 4,
    bottom: 4,
    backgroundColor: '#8B5FBF',
    borderRadius: 12,
    padding: 4,
  },
  displayName: {
    fontSize: 22,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  email: {
    fontSize: 14,
    color: '#9CA3AF',
    marginTop: 4,
  },
  meta: {
    fontSize: 14,
    color: '#9CA3AF',
    marginTop: 4,
  },
  bio: {
    fontSize: 14,
    color: '#D1D5DB',
    marginTop: 12,
    marginBottom: 16,
    textAlign: 'center',
    lineHeight: 20,
  },
  statsContainer: {
    flexDirection: 'row',
    gap: 32,
    marginBottom: 24,
  },
  statItem: {
    alignItems: 'center',
  },
  statItemTouchable: {
    alignItems: 'center',
  },
  statItemDisabled: {
    opacity: 0.4,
  },
  statNumber: {
    fontSize: 20,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  statLabel: {
    fontSize: 14,
    color: '#9CA3AF',
    marginTop: 4,
  },
  editButton: {
    backgroundColor: '#1F2937',
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 20,
  },
  editButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '500',
  },
  partnerToggleButton: {
    backgroundColor: '#8B5FBF',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#8B5FBF',
  },
  partnerToggleButtonActive: {
    backgroundColor: 'transparent',
  },
  partnerToggleText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  partnerToggleTextActive: {
    color: '#8B5FBF',
  },
  partnerToggleButtonRequested: {
    borderColor: '#374151',
  },
  partnerToggleTextRequested: {
    color: '#9CA3AF',
  },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#1F2937',
  },
  tabItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 14,
  },
  tabItemActive: {
    borderBottomWidth: 2,
    borderBottomColor: '#8B5FBF',
  },
  tabLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#6B7280',
  },
  tabLabelActive: {
    color: '#8B5FBF',
    fontWeight: '600',
  },
  section: {
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 16,
  },
  emptyDrinks: {
    alignItems: 'center',
    paddingVertical: 48,
    gap: 12,
  },
  emptyDrinksText: {
    color: '#9CA3AF',
    fontSize: 14,
    textAlign: 'center',
  },
  createPostButton: {
    marginTop: 12,
    backgroundColor: '#8B5FBF',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
  },
  createPostButtonText: {
    color: '#000000',
    fontSize: 14,
    fontWeight: '600',
  },
  hiddenProfileNotice: {
    marginHorizontal: 16,
    marginTop: 12,
  },
  profileGone: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 16,
  },
  profileLoading: {
    marginVertical: 16,
  },
  profileLoadError: {
    alignItems: 'center',
    gap: 12,
    marginBottom: 24,
  },
  profileLoadErrorText: {
    color: '#EF4444',
    fontSize: 14,
    textAlign: 'center',
  },
  profileRetryButton: {
    backgroundColor: '#1F2937',
    paddingHorizontal: 24,
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 20,
  },
  displayNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    maxWidth: '100%',
    paddingHorizontal: 16,
  },
  displayNameShrink: {
    flexShrink: 1,
    textAlign: 'center',
  },
});
