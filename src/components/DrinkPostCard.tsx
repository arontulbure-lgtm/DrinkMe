import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image } from 'react-native';
import { Ionicons, FontAwesome5 } from '@expo/vector-icons';
import { Drink } from '../types/api';
import { getImageSource } from '../lib/api';
import { useLocalization } from '../context/LocalizationContext';
import { formatTimeAgo } from '../lib/formatTimeAgo';
import ModerationNotice from './ModerationNotice';
import OfficialBadge from './OfficialBadge';

interface DrinkPostCardProps {
  drink: Drink;
  onCheer: () => void;
  onComment?: () => void;
  onSave: () => void;
  isLiked?: boolean;
  isSaved?: boolean;
  cheersCount?: number;
  onPressAuthor?: () => void;
  onMore?: () => void;
}

export default function DrinkPostCard({
  drink,
  onCheer,
  onComment,
  onSave,
  onPressAuthor,
  onMore,
  isLiked = false,
  isSaved = false,
  cheersCount = 0,
}: DrinkPostCardProps) {
  const { t } = useLocalization();
  const displayName = drink.user?.firstName
    ? `${drink.user.firstName} ${drink.user.lastName || ''}`
    : t('common.unknownUser');

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
        <TouchableOpacity
          style={styles.userInfo}
          activeOpacity={onPressAuthor ? 0.8 : 1}
          onPress={onPressAuthor}
          disabled={!onPressAuthor}
        >
          <View style={styles.avatar}>
            {drink.user?.avatar ? (
              <Image source={getImageSource(drink.user.avatar)} style={styles.avatarImage} />
            ) : (
              <Text style={styles.avatarText}>{displayName[0]?.toUpperCase() || '?'}</Text>
            )}
          </View>
          <View style={styles.userDetails}>
            <View style={styles.nameRow}>
              <Text style={[styles.username, styles.usernameShrink]} numberOfLines={1}>{displayName}</Text>
              <OfficialBadge official={drink.user?.official} />
            </View>
            <Text style={styles.timestamp}>
              {formatTimeAgo(drink.createdAt, t)}
              {drink.editedAt ? ` · ${t('post.edited')}` : ''}
            </Text>
          </View>
        </TouchableOpacity>
        {drink.location && (
          <View style={styles.locationContainer}>
            <Ionicons name="location-outline" size={16} color="#9CA3AF" />
            <Text style={styles.location} numberOfLines={1}>{drink.location}</Text>
          </View>
        )}
        {onMore && (
          <TouchableOpacity
            style={styles.moreButton}
            onPress={onMore}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={t('post.actions')}
          >
            <Ionicons name="ellipsis-horizontal" size={20} color="#9CA3AF" />
          </TouchableOpacity>
        )}
      </View>

      {/* The server sends this flag only to the owner and admins of a post hidden after reports. */}
      {drink.hiddenPendingReview && <ModerationNotice messageKey="moderation.hiddenPost" style={styles.hiddenNotice} />}

      <View style={styles.content}>
        {drink.imageUrl ? (
          <Image source={getImageSource(drink.imageUrl)} style={styles.image} />
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
            <Text style={styles.actionText}>{t('common.comment')}</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={styles.actionButton} onPress={onSave}>
          <Ionicons
            name={isSaved ? 'bookmark' : 'bookmark-outline'}
            size={24}
            color={isSaved ? '#8B5FBF' : '#FFFFFF'}
          />
          <Text style={styles.actionText}>{isSaved ? t('common.saved') : t('common.save')}</Text>
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
    overflow: 'hidden',
  },
  avatarText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  avatarImage: {
    width: '100%',
    height: '100%',
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
    flexShrink: 1,
  },
  location: {
    fontSize: 12,
    color: '#9CA3AF',
    marginLeft: 4,
    flexShrink: 1,
  },
  content: {
    marginBottom: 16,
  },
  hiddenNotice: {
    marginBottom: 12,
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
  moreButton: {
    width: 32,
    height: 32,
    marginLeft: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  usernameShrink: {
    flexShrink: 1,
  },
});
