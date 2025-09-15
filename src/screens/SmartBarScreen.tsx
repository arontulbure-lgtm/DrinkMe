import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';

export default function SmartBarScreen() {
  const [isAddingItem, setIsAddingItem] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [newItemQuantity, setNewItemQuantity] = useState('');
  const [activeTab, setActiveTab] = useState('inventory'); // 'inventory' or 'saved'
  const { user, getJwtToken } = useAuth();
  const queryClient = useQueryClient();

  const { data: inventory = [], isLoading } = useQuery({
    queryKey: ['/api/smart-bar'],
    enabled: !!user,
  });

  const { data: savedDrinks = [], isLoading: isSavedLoading } = useQuery({
    queryKey: [`/api/users/${user?.uid}/saved-drinks`],
    enabled: !!user,
  });

  const addItemMutation = useMutation({
    mutationFn: async (item: { name: string; quantity: string; unit: string }) => {
      const token = await getJwtToken();
      const response = await fetch(`${process.env.EXPO_PUBLIC_API_URL}/api/smart-bar`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(item),
      });
      if (!response.ok) throw new Error('Failed to add item');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/smart-bar'] });
      setNewItemName('');
      setNewItemQuantity('');
      setIsAddingItem(false);
    },
    onError: () => {
      Alert.alert('Error', 'Failed to add item to your bar');
    },
  });

  const deleteItemMutation = useMutation({
    mutationFn: async (itemId: number) => {
      const token = await getJwtToken();
      const response = await fetch(`${process.env.EXPO_PUBLIC_API_URL}/api/smart-bar/${itemId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      if (!response.ok) throw new Error('Failed to delete item');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/smart-bar'] });
    },
    onError: () => {
      Alert.alert('Error', 'Failed to remove item from your bar');
    },
  });

  const handleAddItem = () => {
    if (!newItemName.trim() || !newItemQuantity.trim()) {
      Alert.alert('Error', 'Please fill in all fields');
      return;
    }

    addItemMutation.mutate({
      name: newItemName.trim(),
      quantity: newItemQuantity.trim(),
      unit: 'bottle', // Default unit
    });
  };

  const handleDeleteItem = (itemId: number, itemName: string) => {
    Alert.alert(
      'Remove Item',
      `Remove ${itemName} from your bar?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { 
          text: 'Remove', 
          style: 'destructive',
          onPress: () => deleteItemMutation.mutate(itemId)
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Smart Bar</Text>
        <TouchableOpacity 
          style={styles.headerButton}
          onPress={() => setIsAddingItem(!isAddingItem)}
        >
          <Ionicons 
            name={isAddingItem ? "close" : "add"} 
            size={24} 
            color="#FFFFFF" 
          />
        </TouchableOpacity>
      </View>

      {isAddingItem && (
        <View style={styles.addItemContainer}>
          <Text style={styles.addItemTitle}>Add to Your Bar</Text>
          
          <TextInput
            style={styles.input}
            placeholder="Item name (e.g., Whiskey, Vodka)"
            placeholderTextColor="#6B7280"
            value={newItemName}
            onChangeText={setNewItemName}
          />
          
          <TextInput
            style={styles.input}
            placeholder="Quantity (e.g., 1, 750ml)"
            placeholderTextColor="#6B7280"
            value={newItemQuantity}
            onChangeText={setNewItemQuantity}
          />

          <TouchableOpacity
            style={[styles.addButton, addItemMutation.isPending && styles.addButtonDisabled]}
            onPress={handleAddItem}
            disabled={addItemMutation.isPending}
          >
            <Text style={styles.addButtonText}>
              {addItemMutation.isPending ? 'Adding...' : 'Add Item'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Tab Selector */}
      <View style={styles.tabContainer}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'inventory' && styles.activeTab]}
          onPress={() => setActiveTab('inventory')}
        >
          <Text style={[styles.tabText, activeTab === 'inventory' && styles.activeTabText]}>
            My Inventory
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'saved' && styles.activeTab]}
          onPress={() => setActiveTab('saved')}
        >
          <Text style={[styles.tabText, activeTab === 'saved' && styles.activeTabText]}>
            Saved Posts
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.content}>
        {activeTab === 'inventory' ? (
          inventory.length === 0 && !isLoading ? (
            <View style={styles.emptyState}>
              <Ionicons name="wine-outline" size={64} color="#6B7280" />
              <Text style={styles.emptyTitle}>Your bar is empty</Text>
              <Text style={styles.emptySubtitle}>
                Add your favorite spirits, mixers, and ingredients to get personalized recipe recommendations
              </Text>
              <TouchableOpacity
                style={styles.addFirstButton}
                onPress={() => setIsAddingItem(true)}
              >
                <Text style={styles.addFirstButtonText}>Add First Item</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.inventoryGrid}>
              {inventory.map((item: any) => (
                <View key={item.id} style={styles.inventoryItem}>
                  <View style={styles.itemHeader}>
                    <Text style={styles.itemName}>{item.name}</Text>
                    <TouchableOpacity
                      onPress={() => handleDeleteItem(item.id, item.name)}
                    >
                      <Ionicons name="trash-outline" size={20} color="#EF4444" />
                    </TouchableOpacity>
                  </View>
                  <Text style={styles.itemQuantity}>
                    {item.quantity} {item.unit}
                  </Text>
                </View>
              ))}
            </View>
          )
        ) : (
          // Saved Posts Tab
          savedDrinks.length === 0 && !isSavedLoading ? (
            <View style={styles.emptyState}>
              <Ionicons name="bookmark-outline" size={64} color="#6B7280" />
              <Text style={styles.emptyTitle}>No saved posts</Text>
              <Text style={styles.emptySubtitle}>
                Save interesting drink posts from other users to see them here
              </Text>
            </View>
          ) : (
            <View style={styles.savedPostsContainer}>
              {savedDrinks.map((drink: any) => (
                <View key={drink.id} style={styles.savedPostCard}>
                  <View style={styles.savedPostHeader}>
                    <Text style={styles.savedPostName}>{drink.name}</Text>
                    <View style={styles.savedPostMeta}>
                      <Text style={styles.savedPostUser}>
                        by {drink.displayName || drink.username}
                      </Text>
                      <View style={styles.ratingContainer}>
                        <Ionicons name="star" size={16} color="#FFD700" />
                        <Text style={styles.ratingText}>{drink.rating}</Text>
                      </View>
                    </View>
                  </View>
                  <Text style={styles.savedPostDescription} numberOfLines={2}>
                    {drink.description}
                  </Text>
                  {drink.location && (
                    <View style={styles.locationContainer}>
                      <Ionicons name="location-outline" size={14} color="#9CA3AF" />
                      <Text style={styles.locationText}>{drink.location}</Text>
                    </View>
                  )}
                </View>
              ))}
            </View>
          )
        )}

        {inventory.length > 0 && (
          <View style={styles.suggestionsSection}>
            <Text style={styles.sectionTitle}>Suggested Recipes</Text>
            <Text style={styles.sectionSubtitle}>
              Based on your current inventory
            </Text>
            
            <TouchableOpacity style={styles.suggestionCard}>
              <Ionicons name="bulb-outline" size={24} color="#8B5FBF" />
              <View style={styles.suggestionContent}>
                <Text style={styles.suggestionTitle}>Get Recipe Suggestions</Text>
                <Text style={styles.suggestionDescription}>
                  Find cocktails you can make with your current ingredients
                </Text>
              </View>
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
  addItemContainer: {
    backgroundColor: '#1F2937',
    margin: 16,
    padding: 16,
    borderRadius: 12,
  },
  addItemTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 16,
  },
  input: {
    backgroundColor: '#374151',
    borderRadius: 8,
    padding: 12,
    color: '#FFFFFF',
    fontSize: 16,
    marginBottom: 12,
  },
  addButton: {
    backgroundColor: '#8B5FBF',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
  },
  addButtonDisabled: {
    opacity: 0.5,
  },
  addButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  content: {
    flex: 1,
    padding: 16,
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
    marginBottom: 24,
    paddingHorizontal: 32,
  },
  addFirstButton: {
    backgroundColor: '#8B5FBF',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  addFirstButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  inventoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  inventoryItem: {
    backgroundColor: '#1F2937',
    borderRadius: 12,
    padding: 16,
    width: '48%',
  },
  itemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  itemName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
    flex: 1,
  },
  itemQuantity: {
    fontSize: 14,
    color: '#9CA3AF',
  },
  suggestionsSection: {
    marginTop: 32,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 4,
  },
  sectionSubtitle: {
    fontSize: 14,
    color: '#9CA3AF',
    marginBottom: 16,
  },
  suggestionCard: {
    backgroundColor: '#1F2937',
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  suggestionContent: {
    marginLeft: 12,
    flex: 1,
  },
  suggestionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 4,
  },
  suggestionDescription: {
    fontSize: 14,
    color: '#9CA3AF',
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: '#1F2937',
    marginHorizontal: 16,
    marginVertical: 8,
    borderRadius: 8,
    padding: 4,
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 6,
    alignItems: 'center',
  },
  activeTab: {
    backgroundColor: '#8B5FBF',
  },
  tabText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#9CA3AF',
  },
  activeTabText: {
    color: '#FFFFFF',
  },
  savedPostsContainer: {
    paddingHorizontal: 16,
  },
  savedPostCard: {
    backgroundColor: '#1F2937',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  savedPostHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  savedPostName: {
    fontSize: 18,
    fontWeight: '600',
    color: '#FFFFFF',
    flex: 1,
    marginRight: 8,
  },
  savedPostMeta: {
    alignItems: 'flex-end',
  },
  savedPostUser: {
    fontSize: 12,
    color: '#9CA3AF',
    marginBottom: 4,
  },
  savedPostDescription: {
    fontSize: 14,
    color: '#D1D5DB',
    lineHeight: 20,
    marginBottom: 8,
  },
});