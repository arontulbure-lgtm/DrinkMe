import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';

export default function ExploreScreen({ navigation }: any) {
  const [searchQuery, setSearchQuery] = useState('');
  const { user } = useAuth();

  const { data: drinks = [], isLoading } = useQuery({
    queryKey: ['/api/drinks'],
    enabled: !!user,
  });

  const { data: users = [] } = useQuery({
    queryKey: ['/api/users/search', searchQuery],
    enabled: !!user && searchQuery.length > 2,
  });

  const filteredDrinks = drinks.filter((drink: any) =>
    drink.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    drink.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Explore</Text>
      </View>

      <View style={styles.searchContainer}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={20} color="#6B7280" />
          <TextInput
            style={styles.searchInput}
            placeholder="Search drinks, users..."
            placeholderTextColor="#6B7280"
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
      </View>

      <ScrollView style={styles.content}>
        {searchQuery.length > 0 ? (
          <View>
            {users.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Users</Text>
                {users.map((user: any) => (
                  <TouchableOpacity
                    key={user.id}
                    style={styles.userItem}
                    onPress={() => navigation.navigate('Profile', { userId: user.id })}
                  >
                    <View style={styles.userAvatar}>
                      <Text style={styles.userAvatarText}>
                        {user.firstName?.[0] || user.email?.[0] || '?'}
                      </Text>
                    </View>
                    <View style={styles.userInfo}>
                      <Text style={styles.userName}>
                        {user.firstName ? `${user.firstName} ${user.lastName || ''}` : user.email}
                      </Text>
                      <Text style={styles.userEmail}>{user.email}</Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {filteredDrinks.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Drinks</Text>
                {filteredDrinks.map((drink: any) => (
                  <TouchableOpacity
                    key={drink.id}
                    style={styles.drinkItem}
                    onPress={() => navigation.navigate('DrinkDetail', { drinkId: drink.id })}
                  >
                    <Text style={styles.drinkName}>{drink.name}</Text>
                    <Text style={styles.drinkDescription} numberOfLines={2}>
                      {drink.description}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {searchQuery.length > 2 && users.length === 0 && filteredDrinks.length === 0 && (
              <View style={styles.emptyState}>
                <Ionicons name="search-outline" size={64} color="#6B7280" />
                <Text style={styles.emptyTitle}>No results found</Text>
                <Text style={styles.emptySubtitle}>
                  Try searching for different keywords
                </Text>
              </View>
            )}
          </View>
        ) : (
          <View style={styles.discoverSection}>
            <Text style={styles.sectionTitle}>Discover</Text>
            
            <TouchableOpacity style={styles.discoverCard}>
              <Ionicons name="trending-up" size={24} color="#8B5FBF" />
              <Text style={styles.discoverTitle}>Trending Cocktails</Text>
              <Text style={styles.discoverSubtitle}>
                See what's popular right now
              </Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.discoverCard}>
              <Ionicons name="star" size={24} color="#8B5FBF" />
              <Text style={styles.discoverTitle}>Top Rated</Text>
              <Text style={styles.discoverSubtitle}>
                Highest rated drinks this week
              </Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.discoverCard}>
              <Ionicons name="location" size={24} color="#8B5FBF" />
              <Text style={styles.discoverTitle}>Near You</Text>
              <Text style={styles.discoverSubtitle}>
                Drinks from your area
              </Text>
            </TouchableOpacity>
          </View>
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
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 12,
  },
  userItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1F2937',
  },
  userAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#8B5FBF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  userAvatarText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  userInfo: {
    flex: 1,
  },
  userName: {
    fontSize: 16,
    fontWeight: '500',
    color: '#FFFFFF',
  },
  userEmail: {
    fontSize: 14,
    color: '#9CA3AF',
  },
  drinkItem: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1F2937',
  },
  drinkName: {
    fontSize: 16,
    fontWeight: '500',
    color: '#FFFFFF',
    marginBottom: 4,
  },
  drinkDescription: {
    fontSize: 14,
    color: '#9CA3AF',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 64,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#FFFFFF',
    marginTop: 16,
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#9CA3AF',
    textAlign: 'center',
  },
  discoverSection: {
    paddingTop: 8,
  },
  discoverCard: {
    backgroundColor: '#1F2937',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  discoverTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
    marginLeft: 12,
    flex: 1,
  },
  discoverSubtitle: {
    fontSize: 12,
    color: '#9CA3AF',
    marginLeft: 12,
    flex: 2,
  },
});