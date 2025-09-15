import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, RefreshControl, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import DrinkPostCard from '../components/DrinkPostCard';
import StoriesSection from '../components/StoriesSection';

export default function HomeScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);
  const { user, getJwtToken } = useAuth();
  const queryClient = useQueryClient();

  const { data: drinks = [], refetch, isLoading } = useQuery({
    queryKey: ['/api/drinks/partners'],
    enabled: !!user,
  });

  const { data: stories = [] } = useQuery({
    queryKey: ['/api/stories'],
    enabled: !!user,
  });

  const likeMutation = useMutation({
    mutationFn: async (drinkId: number) => {
      const token = await getJwtToken();
      const response = await fetch(`${process.env.EXPO_PUBLIC_API_URL}/api/drinks/${drinkId}/like`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      if (!response.ok) throw new Error('Failed to like post');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/drinks/partners'] });
    },
    onError: () => {
      Alert.alert('Error', 'Failed to like post');
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (drinkId: number) => {
      const token = await getJwtToken();
      const response = await fetch(`${process.env.EXPO_PUBLIC_API_URL}/api/drinks/${drinkId}/save`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      if (!response.ok) throw new Error('Failed to save post');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/drinks/partners'] });
      queryClient.invalidateQueries({ queryKey: ['/api/smart-bar'] });
    },
    onError: () => {
      Alert.alert('Error', 'Failed to save post');
    },
  });

  const onRefresh = React.useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>DrinkMe</Text>
        <TouchableOpacity 
          style={styles.headerButton}
          onPress={() => navigation.navigate('CreatePost')}
        >
          <Ionicons name="add" size={24} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#8B5FBF"
          />
        }
      >
        {stories.length > 0 && (
          <StoriesSection stories={stories} />
        )}

        <View style={styles.feed}>
          {drinks.length === 0 && !isLoading ? (
            <View style={styles.emptyState}>
              <Ionicons name="wine-outline" size={64} color="#6B7280" />
              <Text style={styles.emptyTitle}>No drinks yet</Text>
              <Text style={styles.emptySubtitle}>
                Follow friends or create your first post to see content here
              </Text>
              <TouchableOpacity
                style={styles.createButton}
                onPress={() => navigation.navigate('CreatePost')}
              >
                <Text style={styles.createButtonText}>Create First Post</Text>
              </TouchableOpacity>
            </View>
          ) : (
            drinks.map((drink: any) => (
              <DrinkPostCard
                key={drink.id}
                drink={drink}
                onLike={() => likeMutation.mutate(drink.id)}
                onComment={() => navigation.navigate('DrinkDetail', { drinkId: drink.id })}
                onSave={() => saveMutation.mutate(drink.id)}
                isLiked={drink.isLiked}
                isSaved={drink.isSaved}
                likesCount={drink.likesCount}
              />
            ))
          )}
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
  headerButton: {
    padding: 8,
  },
  content: {
    flex: 1,
  },
  feed: {
    paddingBottom: 100,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 64,
    paddingHorizontal: 32,
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
    marginBottom: 24,
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
});