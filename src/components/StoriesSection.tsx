import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Story } from '../types/api';

interface StoriesSectionProps {
  stories: Story[];
}

export default function StoriesSection({ stories }: StoriesSectionProps) {
  const getDisplayName = (user?: Story['user']) => {
    if (!user) return 'Unknown';
    return user.firstName 
      ? `${user.firstName} ${user.lastName || ''}`
      : user.email?.split('@')[0] || 'User';
  };

  const isRecentStory = (createdAt: string) => {
    const storyTime = new Date(createdAt).getTime();
    const now = new Date().getTime();
    const hoursDiff = (now - storyTime) / (1000 * 60 * 60);
    return hoursDiff <= 24; // Stories are visible for 24 hours
  };

  const activeStories = stories.filter(story => isRecentStory(story.createdAt));

  if (activeStories.length === 0) {
    return null;
  }

  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>Stories</Text>
      <ScrollView 
        horizontal 
        showsHorizontalScrollIndicator={false}
        style={styles.storiesContainer}
        contentContainerStyle={styles.storiesContent}
      >
        {activeStories.map((story) => (
          <TouchableOpacity key={story.id} style={styles.storyItem}>
            <View style={styles.storyRing}>
              <View style={styles.storyAvatar}>
                <Text style={styles.storyAvatarText}>
                  {getDisplayName(story.user)[0]?.toUpperCase() || '?'}
                </Text>
              </View>
            </View>
            <Text style={styles.storyUsername} numberOfLines={1}>
              {getDisplayName(story.user)}
            </Text>
          </TouchableOpacity>
        ))}
        
        {/* Add Story Button */}
        <TouchableOpacity style={styles.addStoryItem}>
          <View style={styles.addStoryRing}>
            <View style={styles.addStoryAvatar}>
              <Ionicons name="add" size={24} color="#FFFFFF" />
            </View>
          </View>
          <Text style={styles.addStoryText}>Your Story</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1F2937',
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 12,
    paddingHorizontal: 16,
  },
  storiesContainer: {
    paddingHorizontal: 8,
  },
  storiesContent: {
    paddingHorizontal: 8,
  },
  storyItem: {
    alignItems: 'center',
    marginHorizontal: 8,
    width: 70,
  },
  storyRing: {
    width: 66,
    height: 66,
    borderRadius: 33,
    borderWidth: 3,
    borderColor: '#8B5FBF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  storyAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#374151',
    justifyContent: 'center',
    alignItems: 'center',
  },
  storyAvatarText: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '600',
  },
  storyUsername: {
    fontSize: 12,
    color: '#D1D5DB',
    textAlign: 'center',
  },
  addStoryItem: {
    alignItems: 'center',
    marginHorizontal: 8,
    width: 70,
  },
  addStoryRing: {
    width: 66,
    height: 66,
    borderRadius: 33,
    borderWidth: 3,
    borderColor: '#6B7280',
    borderStyle: 'dashed',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  addStoryAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#1F2937',
    justifyContent: 'center',
    alignItems: 'center',
  },
  addStoryText: {
    fontSize: 12,
    color: '#9CA3AF',
    textAlign: 'center',
  },
});
