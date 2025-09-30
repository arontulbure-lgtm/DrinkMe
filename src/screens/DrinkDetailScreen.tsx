import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Image,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, FontAwesome5 } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { Drink, Comment } from '../types/api';
import { useAuth } from '../context/AuthContext';
import DrinkPostCard from '../components/DrinkPostCard';
import { useLocalization } from '../context/LocalizationContext';

interface Props {
  route: { params: { drinkId: number } };
  navigation: { goBack: () => void; navigate: (screen: string, params?: any) => void };
}

export default function DrinkDetailScreen({ route, navigation }: Props) {
  const { drinkId } = route.params;
  const { getJwtToken } = useAuth();
  const queryClient = useQueryClient();
  const { t } = useLocalization();
  const [commentText, setCommentText] = useState('');

  const { data: drink, isLoading } = useQuery<Drink>({
    queryKey: ['drinks.detail', drinkId],
    queryFn: () => apiFetch<Drink>(`/api/drinks/${drinkId}`),
  });

  const { data: comments = [] } = useQuery<Comment[]>({
    queryKey: ['drinks.comments', drinkId],
    queryFn: () => apiFetch<Comment[]>(`/api/drinks/${drinkId}/comments`),
  });

  const cheerMutation = useMutation({
    mutationFn: async () => {
      const token = await getJwtToken();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      return apiFetch<{ cheered: boolean; cheersCount: number }>(`/api/drinks/${drinkId}/like`, {
        method: 'POST',
        headers,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['drinks.detail', drinkId] });
      queryClient.invalidateQueries({ queryKey: ['drinks.partners'] });
      queryClient.invalidateQueries({ queryKey: ['drinks.all'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: () => Alert.alert(t('drinkDetail.title'), t('createPost.error')),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const token = await getJwtToken();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      return apiFetch<{ saved: boolean }>(`/api/drinks/${drinkId}/save`, {
        method: 'POST',
        headers,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['drinks.detail', drinkId] });
      queryClient.invalidateQueries({ queryKey: ['users.savedDrinks'] });
    },
    onError: () => Alert.alert(t('drinkDetail.title'), t('createPost.error')),
  });

  const commentMutation = useMutation({
    mutationFn: async (content: string) => {
      const token = await getJwtToken();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      return apiFetch<Comment>(`/api/drinks/${drinkId}/comments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content }),
      });
    },
    onSuccess: () => {
      setCommentText('');
      queryClient.invalidateQueries({ queryKey: ['drinks.comments', drinkId] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: () => Alert.alert(t('drinkDetail.title'), t('errors.commentFailed')),
  });

  const handleSubmitComment = () => {
    const trimmed = commentText.trim();
    if (!trimmed) return;
    commentMutation.mutate(trimmed);
  };

  const formatTimeAgo = useMemo(
    () =>
      (dateString: string) => {
        const date = new Date(dateString);
        const now = new Date();
        const diffInMinutes = Math.floor((now.getTime() - date.getTime()) / (1000 * 60));

        if (diffInMinutes < 1) return 'Just now';
        if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
        if (diffInMinutes < 1440) return `${Math.floor(diffInMinutes / 60)}h ago`;
        return `${Math.floor(diffInMinutes / 1440)}d ago`;
      },
    []
  );

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 80 : 0}
      >
        <View style={{ flex: 1 }}>
          <View style={styles.header}>
            <TouchableOpacity onPress={navigation.goBack} style={styles.headerButton}>
              <Ionicons name="chevron-back" size={22} color="#FFFFFF" />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>{t('drinkDetail.title')}</Text>
            <View style={{ width: 32 }} />
          </View>

          <ScrollView contentContainerStyle={styles.content}>
            {isLoading || !drink ? (
              <View style={styles.loadingState}>
                <Ionicons name="hourglass" size={32} color="#6B7280" />
                <Text style={styles.loadingText}>{t('drinkDetail.loading')}</Text>
              </View>
            ) : (
              <>
                <View style={styles.hero}>
                  <View style={styles.heroHeader}>
                    <Text style={styles.heroTitle}>{drink.name}</Text>
                    <View style={styles.ratingPill}>
                      <Ionicons name="star" size={16} color="#FFD700" />
                      <Text style={styles.ratingText}>{drink.rating.toFixed(1)}</Text>
                    </View>
                  </View>
                  {drink.imageUrl ? (
                    <Image source={{ uri: drink.imageUrl }} style={styles.heroImage} />
                  ) : null}
                  {drink.location && (
                    <View style={styles.locationRow}>
                      <Ionicons name="location-outline" size={16} color="#9CA3AF" />
                      <Text style={styles.locationText}>{drink.location}</Text>
                    </View>
                  )}
                  <Text style={styles.heroDescription}>{drink.description}</Text>
                  {drink.tags?.length ? (
                    <View style={styles.tagsRow}>
                      {drink.tags.map((tag) => (
                        <View key={tag} style={styles.tagChip}>
                          <Text style={styles.tagText}>{tag}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </View>

                <View style={styles.actionsRow}>
                  <TouchableOpacity
                    style={styles.primaryAction}
                    onPress={() => cheerMutation.mutate()}
                    disabled={cheerMutation.isPending}
                  >
                    <FontAwesome5 name="glass-cheers" size={18} color="#FFFFFF" />
                    <Text style={styles.primaryActionText}>{t('drinkDetail.like')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.secondaryAction}
                    onPress={() => saveMutation.mutate()}
                    disabled={saveMutation.isPending}
                  >
                    <Ionicons name="bookmark" size={20} color="#8B5FBF" />
                    <Text style={styles.secondaryActionText}>{t('drinkDetail.save')}</Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.cardWrapper}>
                  <DrinkPostCard
                    drink={drink}
                    onCheer={() => cheerMutation.mutate()}
                    onComment={() => {}}
                    onSave={() => saveMutation.mutate()}
                    isLiked={drink.isLiked}
                    isSaved={drink.isSaved}
                    cheersCount={drink.cheersCount}
                  />
                </View>

                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>{t('drinkDetail.comments')}</Text>
                  {comments.length === 0 ? (
                    <Text style={styles.emptyComments}>{t('drinkDetail.noComments')}</Text>
                  ) : (
                    comments.map((comment) => (
                      <View key={comment.id} style={styles.commentItem}>
                        <View style={styles.commentAvatar}>
                          <Text style={styles.commentAvatarText}>
                            {comment.user?.firstName?.[0]?.toUpperCase() || comment.user?.email?.[0] || '?'}
                          </Text>
                        </View>
                        <View style={styles.commentBody}>
                          <View style={styles.commentHeader}>
                            <Text style={styles.commentAuthor}>
                              {comment.user?.firstName
                                ? `${comment.user.firstName} ${comment.user.lastName || ''}`
                                : comment.user?.email}
                            </Text>
                            <Text style={styles.commentTimestamp}>{formatTimeAgo(comment.createdAt)}</Text>
                          </View>
                          <Text style={styles.commentText}>{comment.content}</Text>
                        </View>
                      </View>
                    ))
                  )}
                </View>

                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>{t('drinkDetail.next')}</Text>
                  <View style={styles.tipCard}>
                    <Ionicons name="sparkles" size={20} color="#8B5FBF" />
                    <Text style={styles.tipText}>{t('drinkDetail.tip')}</Text>
                  </View>
                  <TouchableOpacity
                    style={styles.tipButton}
                    onPress={() => navigation.navigate('Scanner')}
                  >
                    <Ionicons name="camera" size={18} color="#FFFFFF" />
                    <Text style={styles.tipButtonText}>{t('drinkDetail.scan')}</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </ScrollView>

          <View style={styles.commentInputContainer}>
            <TextInput
              style={styles.commentInput}
              placeholder={t('common.commentPlaceholder')}
              placeholderTextColor="#6B7280"
              value={commentText}
              onChangeText={setCommentText}
              multiline
            />
            <TouchableOpacity
              style={[styles.sendButton, (!commentText.trim() || commentMutation.isPending) && styles.sendButtonDisabled]}
              onPress={handleSubmitComment}
              disabled={!commentText.trim() || commentMutation.isPending}
            >
              <Ionicons name="send" size={18} color="#FFFFFF" />
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
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
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#1F2937',
  },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
  },
  content: {
    paddingBottom: 120,
  },
  loadingState: {
    alignItems: 'center',
    paddingVertical: 48,
    gap: 12,
  },
  loadingText: {
    color: '#9CA3AF',
  },
  hero: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 12,
    gap: 12,
  },
  heroHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  heroTitle: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '700',
  },
  heroDescription: {
    color: '#D1D5DB',
    fontSize: 14,
    lineHeight: 20,
  },
  heroImage: {
    width: '100%',
    height: 240,
    borderRadius: 16,
    marginTop: 12,
  },
  ratingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#1F2937',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  ratingText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  locationText: {
    color: '#9CA3AF',
    fontSize: 13,
  },
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  tagChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: '#1F2937',
  },
  tagText: {
    color: '#9CA3AF',
    fontSize: 12,
    textTransform: 'capitalize',
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  primaryAction: {
    flex: 1,
    backgroundColor: '#8B5FBF',
    borderRadius: 12,
    paddingVertical: 12,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  primaryActionText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  secondaryAction: {
    width: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#8B5FBF',
    backgroundColor: '#1F2937',
    paddingVertical: 12,
  },
  secondaryActionText: {
    color: '#8B5FBF',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 4,
    textAlign: 'center',
  },
  cardWrapper: {
    paddingHorizontal: 16,
  },
  section: {
    paddingHorizontal: 16,
    paddingVertical: 24,
    gap: 16,
  },
  sectionTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
  },
  emptyComments: {
    color: '#9CA3AF',
    fontSize: 14,
  },
  tipCard: {
    backgroundColor: '#1F2937',
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
  },
  tipText: {
    color: '#D1D5DB',
    fontSize: 14,
    lineHeight: 20,
  },
  tipButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
    paddingVertical: 12,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1F2937',
  },
  tipButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  commentItem: {
    flexDirection: 'row',
    gap: 12,
  },
  commentAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#8B5FBF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  commentAvatarText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  commentBody: {
    flex: 1,
  },
  commentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  commentAuthor: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  commentTimestamp: {
    color: '#9CA3AF',
    fontSize: 12,
  },
  commentText: {
    color: '#D1D5DB',
    fontSize: 14,
    lineHeight: 20,
  },
  commentInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#1F2937',
    backgroundColor: '#0F172A',
    gap: 12,
  },
  commentInput: {
    flex: 1,
    backgroundColor: '#1F2937',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#FFFFFF',
    fontSize: 14,
    maxHeight: 100,
  },
  sendButton: {
    backgroundColor: '#8B5FBF',
    borderRadius: 20,
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
});
