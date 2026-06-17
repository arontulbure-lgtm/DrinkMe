import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../lib/api';
import { BaseUser, Drink } from '../types/api';
import { useLocalization } from '../context/LocalizationContext';
import DrinkPostCard from '../components/DrinkPostCard';
import CommentDrawer from '../components/CommentDrawer';

interface ProfileScreenProps {
  navigation: any;
  route: { params?: { userId?: string } };
}

export default function ProfileScreen({ navigation, route }: ProfileScreenProps) {
  const queryClient = useQueryClient();
  const { profile, serverUserId, logout, getJwtToken, setProfile, refreshProfile, user: firebaseUser } = useAuth();
  const { t } = useLocalization();

  const viewedUserId = route?.params?.userId ?? serverUserId;
  const isSelf = !route?.params?.userId || route.params.userId === serverUserId;

  const [activeTab, setActiveTab] = useState<'posts' | 'saved'>('posts');
  const [commentDrinkId, setCommentDrinkId] = useState<number | null>(null);

  const { data: profileData } = useQuery<BaseUser>({
    queryKey: ['users.detail', viewedUserId],
    enabled: !!viewedUserId,
    queryFn: () => apiFetch<BaseUser>(`/api/users/${viewedUserId}`),
  });

  useEffect(() => {
    if (profileData && isSelf && viewedUserId) {
      const normalizedEmail = (
        profileData.email ?? firebaseUser?.email ?? `user+${viewedUserId}@drinkme.app`
      ) as string;
      const nextProfile: BaseUser = {
        id: viewedUserId,
        email: normalizedEmail,
        firstName: profileData.firstName,
        lastName: profileData.lastName,
        city: profileData.city,
        bio: profileData.bio,
        avatar: profileData.avatar ?? null,
        isPartner: profileData.isPartner,
      };
      setProfile(nextProfile);
    }
  }, [firebaseUser?.email, isSelf, profileData, setProfile, viewedUserId]);

  const { data: userDrinks = [] } = useQuery<Drink[]>({
    queryKey: ['drinks.byUser', viewedUserId],
    enabled: !!viewedUserId,
    queryFn: () => apiFetch<Drink[]>(`/api/drinks/user/${viewedUserId}`),
  });

  const { data: savedDrinks = [] } = useQuery<Drink[]>({
    queryKey: ['users.savedDrinks', viewedUserId],
    enabled: isSelf && !!viewedUserId,
    queryFn: () => apiFetch<Drink[]>(`/api/users/${viewedUserId}/saved-drinks`),
  });

  const { data: friendsCount = 0 } = useQuery<number>({
    queryKey: ['friends.count'],
    enabled: isSelf,
    queryFn: () => apiFetch<number>('/api/friends/count'),
  });

  const { data: myPartners = [] } = useQuery<BaseUser[]>({
    queryKey: ['drink-partners'],
    enabled: !!serverUserId,
    queryFn: () => apiFetch<BaseUser[]>('/api/drink-partners'),
  });

  const isCurrentPartner = useMemo(() => {
    if (isSelf || !viewedUserId) return false;
    return myPartners.some((partner) => partner.id === viewedUserId);
  }, [isSelf, myPartners, viewedUserId]);

  const displayName = useMemo(() => {
    const source = profileData || profile;
    if (source?.firstName) {
      return `${source.firstName} ${source.lastName || ''}`.trim();
    }
    return source?.email || firebaseUser?.email || 'User';
  }, [firebaseUser?.email, profile, profileData]);

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

  const avatarSource = profileData?.avatar || profile?.avatar;

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
      if (viewedUserId) {
        queryClient.setQueryData<BaseUser>(['users.detail', viewedUserId], updated);
        queryClient.invalidateQueries({ queryKey: ['drinks.byUser', viewedUserId] });
      }
      queryClient.invalidateQueries({ queryKey: ['drinks.all'] });
      queryClient.invalidateQueries({ queryKey: ['drinks.partners'] });
      queryClient.invalidateQueries({
        predicate: ({ queryKey }) => Array.isArray(queryKey) && queryKey[0] === 'users.search',
      });
      if (isSelf) {
        setProfile(updated);
      }
    },
    onError: () => Alert.alert(t('profile.title'), t('createPost.error')),
  });

  const togglePartnerMutation = useMutation({
    mutationFn: async () => {
      if (!viewedUserId) throw new Error('Missing user id');
      return apiFetch<{ isPartner: boolean }>(`/api/drink-partners/${viewedUserId}`, {
        method: 'POST',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['drink-partners'] });
      queryClient.invalidateQueries({ queryKey: ['friends.count'] });
      if (viewedUserId) {
        queryClient.invalidateQueries({ queryKey: ['users.detail', viewedUserId] });
      }
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: () => Alert.alert(t('profile.title'), t('createPost.error')),
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
      queryClient.invalidateQueries({ queryKey: ['users.savedDrinks', viewedUserId] });
      queryClient.setQueryData<Drink[]>(['drinks.byUser', viewedUserId], (existing) => {
        if (!existing) return existing;
        return existing.map((d) => d.id === drinkId ? { ...d, isSaved: result.saved } : d);
      });
    },
  });

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
      quality: 0.8,
      mediaTypes: 'images',
    });

    if (!result.canceled && result.assets?.[0]) {
      uploadAvatarMutation.mutate(result.assets[0]);
    }
  };

  const partnerLabel = useMemo(() => {
    if (isSelf) {
      return t('profile.drinkPartners');
    }
    return isCurrentPartner ? t('profile.drinkPartners') : t('common.addPartner');
  }, [isCurrentPartner, isSelf, t]);

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
              >
                <Ionicons name="settings-outline" size={22} color="#8B5FBF" />
              </TouchableOpacity>
              <TouchableOpacity onPress={handleLogout} style={styles.headerIconButton}>
                <Ionicons name="log-out-outline" size={24} color="#EF4444" />
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerIconButton}>
              <Ionicons name="close" size={22} color="#FFFFFF" />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <ScrollView style={styles.content}>
        <View style={styles.profileSection}>
          <TouchableOpacity
            style={styles.avatar}
            onPress={handlePickAvatar}
            disabled={!isSelf || uploadAvatarMutation.isPending}
          >
            {avatarSource ? (
              <Image source={{ uri: avatarSource }} style={styles.avatarImage} />
            ) : (
              <Text style={styles.avatarText}>{displayName[0]?.toUpperCase() || '?'}</Text>
            )}
            {isSelf && (
              <View style={styles.avatarBadge}>
                <Ionicons name="camera" size={14} color="#FFFFFF" />
              </View>
            )}
          </TouchableOpacity>

          <Text style={styles.displayName}>{displayName}</Text>
          <Text style={styles.email}>{profileData?.email || profile?.email || firebaseUser?.email}</Text>
          {profileData?.city ? <Text style={styles.meta}>{profileData.city}</Text> : null}
          {profileData?.bio ? <Text style={styles.bio}>{profileData.bio}</Text> : null}

          <View style={styles.statsContainer}>
            <View style={styles.statItem}>
              <Text style={styles.statNumber}>{userDrinks.length}</Text>
              <Text style={styles.statLabel}>{t('profile.posts')}</Text>
            </View>
            <TouchableOpacity
              style={[styles.statItemTouchable, friendsCount === 0 && styles.statItemDisabled]}
              onPress={() =>
                navigation.navigate('PartnersList', {
                  userId: viewedUserId,
                })
              }
              disabled={friendsCount === 0}
            >
              <Text style={styles.statNumber}>{friendsCount}</Text>
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
          ) : (
            <TouchableOpacity
              style={[styles.partnerToggleButton, isCurrentPartner && styles.partnerToggleButtonActive]}
              onPress={() => togglePartnerMutation.mutate()}
            >
              <Text style={[styles.partnerToggleText, isCurrentPartner && styles.partnerToggleTextActive]}>
                {partnerLabel}
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
            {userDrinks.length === 0 ? (
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
                {userDrinks.map((drink) => (
                  <DrinkPostCard
                    key={drink.id}
                    drink={drink}
                    onCheer={() => {}}
                    onComment={() => setCommentDrinkId(drink.id)}
                    onSave={() => saveMutation.mutate(drink.id)}
                    isLiked={drink.isLiked}
                    isSaved={drink.isSaved}
                    cheersCount={drink.cheersCount}
                    onPressAuthor={() => {}}
                  />
                ))}
              </View>
            )}
          </View>
        )}

        {/* Saved tab — self only */}
        {activeTab === 'saved' && isSelf && (
          <View style={styles.section}>
            {savedDrinks.length === 0 ? (
              <View style={styles.emptyDrinks}>
                <Ionicons name="bookmark-outline" size={48} color="#6B7280" />
                <Text style={styles.emptyDrinksText}>{t('smartBar.savedEmptyTitle')}</Text>
                <Text style={[styles.emptyDrinksText, { fontSize: 13, marginTop: 4 }]}>
                  {t('smartBar.savedEmptySubtitle')}
                </Text>
              </View>
            ) : (
              <View style={{ gap: 16 }}>
                {savedDrinks.map((drink) => (
                  <DrinkPostCard
                    key={drink.id}
                    drink={drink}
                    onCheer={() => {}}
                    onComment={() => setCommentDrinkId(drink.id)}
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
            )}
          </View>
        )}
      </ScrollView>

      <CommentDrawer drinkId={commentDrinkId} onClose={() => setCommentDrinkId(null)} />
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
});
