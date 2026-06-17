import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Image,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { BaseUser } from '../types/api';
import { useLocalization } from '../context/LocalizationContext';

interface PartnersListScreenProps {
  navigation: any;
  route: { params?: { userId?: string } };
}

export default function PartnersListScreen({ navigation, route }: PartnersListScreenProps) {
  const { t } = useLocalization();
  const userId = route?.params?.userId;

  const { data: partners = [], isLoading } = useQuery<BaseUser[]>({
    queryKey: ['drink-partners', userId],
    queryFn: () => {
      if (userId) {
        return apiFetch<BaseUser[]>(`/api/users/${userId}/partners`);
      }
      return apiFetch<BaseUser[]>('/api/drink-partners');
    },
  });

  const renderItem = ({ item }: { item: BaseUser }) => {
    const displayName = item.firstName
      ? `${item.firstName} ${item.lastName || ''}`.trim()
      : item.email;

    return (
      <TouchableOpacity
        style={styles.row}
        onPress={() => navigation.navigate('UserProfile', { userId: item.id })}
      >
        <View style={styles.avatar}>
          {item.avatar ? (
            <Image source={{ uri: item.avatar }} style={styles.avatarImage} />
          ) : (
            <Text style={styles.avatarText}>{displayName[0]?.toUpperCase() || '?'}</Text>
          )}
        </View>
        <View style={styles.rowContent}>
          <Text style={styles.name}>{displayName}</Text>
          {item.city ? <Text style={styles.city}>{item.city}</Text> : null}
        </View>
        <Ionicons name="chevron-forward" size={18} color="#6B7280" />
      </TouchableOpacity>
    );
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

      {isLoading ? (
        <View style={styles.loaderContainer}>
          <ActivityIndicator size="small" color="#8B5FBF" />
        </View>
      ) : (
        <FlatList
          data={partners}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={partners.length === 0 ? styles.emptyContainer : undefined}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="people-outline" size={40} color="#6B7280" />
              <Text style={styles.emptyText}>{t('profile.noPartners')}</Text>
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
  loaderContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
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

