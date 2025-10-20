import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image } from 'react-native';
import { Ionicons, FontAwesome5 } from '@expo/vector-icons';
import { Drink } from '../types/api';
import { useLocalization } from '../context/LocalizationContext';

interface DrinkPostCardProps {
  drink: Drink;
  onCheer: () => void;
  onComment?: () => void;
  onSave: () => void;
  isLiked?: boolean;
  isSaved?: boolean;
  cheersCount?: number;
}

export default function DrinkPostCard({
  drink,
  onCheer,
  onComment,
  onSave,
  isLiked = false,
  isSaved = false,
  cheersCount = 0,
}: DrinkPostCardProps) {
  const { t } = useLocalization();
  const displayName = drink.user?.firstName
    ? `${drink.user.firstName} ${drink.user.lastName || ''}`
    : drink.user?.email?.split('@')[0] || 'Unknown User';

  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffInMinutes = Math.floor((now.getTime() - date.getTime()) / (1000 * 60));

    if (diffInMinutes < 1) return 'Just now';
    if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
    if (diffInMinutes < 1440) return `${Math.floor(diffInMinutes / 60)}h ago`;
    return `${Math.floor(diffInMinutes / 1440)}d ago`;
  };

  const renderStars = (rating: number) => (
    <View style={styles.starsContainer}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Ionicons
          key={star}
          name={star <= rating ? 'star' : 'star-outline'}
          size={16}
          color={star <= rating ? '#FFD700' : '#6B7280'}
        />
      ))}
    </View>
  );

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.userInfo}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{displayName[0]?.toUpperCase() || '?'}</Text>
          </View>
          <View style={styles.userDetails}>
            <Text style={styles.username}>{displayName}</Text>
            <Text style={styles.timestamp}>{formatTimeAgo(drink.createdAt)}</Text>
          </View>
        </View>
        {drink.location && (
          <View style={styles.locationContainer}>
            <Ionicons name="location-outline" size={16} color="#9CA3AF" />
            <Text style={styles.location}>{drink.location}</Text>
          </View>
        )}
      </View>

      <View style={styles.content}>
        {drink.imageUrl ? (
          <Image source={{ uri: drink.imageUrl }} style={styles.image} />
        ) : null}
        <Text style={styles.drinkName}>{drink.name}</Text>
        <View style={styles.ratingContainer}>
          {renderStars(drink.rating)}
          <Text style={styles.ratingText}>{drink.rating.toFixed(1)}</Text>
        </View>
        <Text style={styles.description}>{drink.description}</Text>
      </View>

      <View style={styles.actions}>
        <TouchableOpacity style={styles.actionButton} onPress={onCheer}>
          <FontAwesome5
            name="glass-cheers"
            size={20}
            color={isLiked ? '#FCD34D' : '#FFFFFF'}
          />
          <Text style={styles.actionText}>
            {t('common.cheersCount', { count: cheersCount ?? drink.cheersCount ?? 0 })}
          </Text>
        </TouchableOpacity>

        {onComment && (
          <TouchableOpacity style={styles.actionButton} onPress={onComment}>
            <Ionicons name="chatbubble-outline" size={24} color="#FFFFFF" />
            <Text style={styles.actionText}>Comment</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={styles.actionButton} onPress={onSave}>
          <Ionicons
            name={isSaved ? 'bookmark' : 'bookmark-outline'}
            size={24}
            color={isSaved ? '#8B5FBF' : '#FFFFFF'}
          />
          <Text style={styles.actionText}>{isSaved ? 'Saved' : 'Save'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1F2937',
    borderRadius: 12,
    marginVertical: 8,
    marginHorizontal: 16,
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  userInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#8B5FBF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  avatarText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  userDetails: {
    flex: 1,
  },
  username: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  timestamp: {
    fontSize: 12,
    color: '#9CA3AF',
    marginTop: 2,
  },
  locationContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  location: {
    fontSize: 12,
    color: '#9CA3AF',
    marginLeft: 4,
  },
  content: {
    marginBottom: 16,
  },
  image: {
    width: '100%',
    height: 220,
    borderRadius: 12,
    marginBottom: 12,
    backgroundColor: '#111827',
  },
  drinkName: {
    fontSize: 18,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  ratingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  starsContainer: {
    flexDirection: 'row',
    marginRight: 8,
  },
  ratingText: {
    fontSize: 14,
    color: '#9CA3AF',
  },
  description: {
    fontSize: 14,
    color: '#D1D5DB',
    lineHeight: 20,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    borderTopWidth: 1,
    borderTopColor: '#374151',
    paddingTop: 12,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  actionText: {
    fontSize: 14,
    color: '#FFFFFF',
  },
});
