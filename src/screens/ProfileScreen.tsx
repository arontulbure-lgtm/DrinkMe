import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../lib/api';
import { BaseUser, Drink } from '../types/api';
import { useLocalization } from '../context/LocalizationContext';

export default function ProfileScreen({ navigation }: any) {
  const { user, logout, serverUserId } = useAuth();
  const { t, locale, availableLocales } = useLocalization();

  const { data: profileData } = useQuery<BaseUser>({
    queryKey: ['users.detail', serverUserId],
    enabled: !!serverUserId,
    queryFn: () => apiFetch<BaseUser>(`/api/users/${serverUserId}`),
  });

  const { data: userDrinks = [] } = useQuery<Drink[]>({
    queryKey: ['drinks.byUser', serverUserId],
    enabled: !!serverUserId,
    queryFn: () => apiFetch<Drink[]>(`/api/drinks/user/${serverUserId}`),
  });

  const { data: friendsCount = 0 } = useQuery<number>({
    queryKey: ['friends.count'],
    enabled: !!serverUserId,
    queryFn: () => apiFetch<number>('/api/friends/count'),
  });

  const currentLanguage = useMemo(
    () => availableLocales.find((item) => item.code === locale)?.label ?? locale.toUpperCase(),
    [availableLocales, locale]
  );

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

  const displayName = profileData?.firstName 
    ? `${profileData.firstName} ${profileData.lastName || ''}`
    : profileData?.email || user?.email || 'User';

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('profile.title')}</Text>
        <TouchableOpacity onPress={handleLogout}>
          <Ionicons name="log-out-outline" size={24} color="#EF4444" />
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.content}>
        <View style={styles.profileSection}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {displayName[0]?.toUpperCase() || '?'}
            </Text>
          </View>
          
          <Text style={styles.displayName}>{displayName}</Text>
          <Text style={styles.email}>{profileData?.email || user?.email}</Text>
          {profileData?.bio ? (
            <Text style={styles.bio}>{profileData.bio}</Text>
          ) : null}

          <View style={styles.statsContainer}>
            <View style={styles.statItem}>
              <Text style={styles.statNumber}>{userDrinks.length}</Text>
              <Text style={styles.statLabel}>{t('profile.posts')}</Text>
            </View>
            <View style={styles.statItem}>
              <Text style={styles.statNumber}>{friendsCount}</Text>
              <Text style={styles.statLabel}>{t('profile.drinkPartners')}</Text>
            </View>
            <View style={styles.statItem}>
              <Text style={styles.statNumber}>0</Text>
              <Text style={styles.statLabel}>{t('profile.following')}</Text>
            </View>
          </View>

          <TouchableOpacity
            style={styles.editButton}
            onPress={() => navigation.navigate('EditProfile')}
          >
            <Text style={styles.editButtonText}>{t('profile.edit')}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('profile.posts')}</Text>
          
          {userDrinks.length === 0 ? (
            <View style={styles.emptyDrinks}>
              <Ionicons name="wine-outline" size={48} color="#6B7280" />
              <Text style={styles.emptyDrinksText}>{t('profile.emptyDrinks')}</Text>
              <TouchableOpacity
                style={styles.createPostButton}
                onPress={() => navigation.navigate('CreatePost')}
              >
                <Text style={styles.createPostButtonText}>{t('profile.createFirstPost')}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.drinksGrid}>
              {userDrinks.map((drink: any) => (
                <TouchableOpacity
                  key={drink.id}
                  style={styles.drinkCard}
                  onPress={() => navigation.navigate('DrinkDetail', { drinkId: drink.id })}
                >
                  <Text style={styles.drinkName}>{drink.name}</Text>
                  <Text style={styles.drinkRating}>
                    ⭐ {drink.rating?.toFixed(1) || 'N/A'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('profile.settings')}</Text>

          <TouchableOpacity style={styles.settingItem}>
            <Ionicons name="person-outline" size={24} color="#FFFFFF" />
            <Text style={styles.settingText}>Account settings</Text>
            <Ionicons name="chevron-forward" size={20} color="#6B7280" />
          </TouchableOpacity>

          <TouchableOpacity style={styles.settingItem}>
            <Ionicons name="notifications-outline" size={24} color="#FFFFFF" />
            <Text style={styles.settingText}>Notifications</Text>
            <Ionicons name="chevron-forward" size={20} color="#6B7280" />
          </TouchableOpacity>

          <TouchableOpacity style={styles.settingItem}>
            <Ionicons name="shield-outline" size={24} color="#FFFFFF" />
            <Text style={styles.settingText}>Privacy</Text>
            <Ionicons name="chevron-forward" size={20} color="#6B7280" />
          </TouchableOpacity>

          <TouchableOpacity style={styles.settingItem}>
            <Ionicons name="help-circle-outline" size={24} color="#FFFFFF" />
            <Text style={styles.settingText}>Help & support</Text>
            <Ionicons name="chevron-forward" size={20} color="#6B7280" />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.settingItem}
            onPress={() => navigation.navigate('LanguageSettings')}
          >
            <Ionicons name="globe-outline" size={24} color="#FFFFFF" />
            <Text style={styles.settingText}>{t('profile.language')}</Text>
            <Text style={styles.settingValue}>{currentLanguage}</Text>
          </TouchableOpacity>
        </View>
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
  content: {
    flex: 1,
  },
  profileSection: {
    alignItems: 'center',
    paddingVertical: 32,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1F2937',
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#8B5FBF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  avatarText: {
    color: '#FFFFFF',
    fontSize: 32,
    fontWeight: '600',
  },
  displayName: {
    fontSize: 24,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 4,
  },
  email: {
    fontSize: 16,
    color: '#9CA3AF',
    marginBottom: 24,
  },
  bio: {
    fontSize: 14,
    color: '#D1D5DB',
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
    fontSize: 16,
    fontWeight: '500',
  },
  section: {
    padding: 16,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 16,
  },
  emptyDrinks: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  emptyDrinksText: {
    fontSize: 16,
    color: '#9CA3AF',
    marginTop: 12,
    marginBottom: 16,
  },
  createPostButton: {
    backgroundColor: '#8B5FBF',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  createPostButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '500',
  },
  drinksGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  drinkCard: {
    backgroundColor: '#1F2937',
    borderRadius: 12,
    padding: 16,
    width: '48%',
  },
  drinkName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  drinkRating: {
    fontSize: 14,
    color: '#9CA3AF',
  },
  settingItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1F2937',
  },
  settingText: {
    fontSize: 16,
    color: '#FFFFFF',
    marginLeft: 16,
    flex: 1,
  },
  settingValue: {
    fontSize: 14,
    color: '#9CA3AF',
    marginRight: 8,
  },
});
