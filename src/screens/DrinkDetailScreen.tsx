import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Image,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, FontAwesome5 } from '@expo/vector-icons';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, getCommentErrorKey, getImageSource, isAgeRequiredError, isNotFoundError, isStorageFullError, retryUnlessNotFound } from '../lib/api';
import { flattenPages, getNextCursor, removeDrinkIfNotFound } from '../lib/drinkCache';
import { Drink, Comment, Page, isDrinkCategory } from '../types/api';
import ListLoadState from '../components/ListLoadState';
import LoadMoreButton from '../components/LoadMoreButton';
import ModerationNotice from '../components/ModerationNotice';
import PostActionsSheet from '../components/PostActionsSheet';
import { useConfirmAge } from '../lib/useConfirmAge';
import { useDrinkToggles } from '../lib/useDrinkToggles';
import { useRefreshIfSuspended } from '../lib/useRefreshIfSuspended';
import { isCurrentAuthUser, useAuth } from '../context/AuthContext';
import { useLocalization } from '../context/LocalizationContext';
import { RootStackScreenProps } from '../navigation/types';

type Props = RootStackScreenProps<'DrinkDetail'>;

export default function DrinkDetailScreen({ route, navigation }: Props) {
  const { drinkId } = route.params;
  const { getJwtToken, profile, serverUserId } = useAuth();
  const queryClient = useQueryClient();
  const { t } = useLocalization();
  const refreshIfSuspended = useRefreshIfSuspended();
  const [commentText, setCommentText] = useState('');
  const [actionsDrink, setActionsDrink] = useState<Drink | null>(null);
  const [actionsComment, setActionsComment] = useState<Comment | null>(null);
  const { promptConfirmAge, isConfirming } = useConfirmAge();

  const {
    data: drink,
    error: drinkError,
    isError: isDrinkError,
    isFetching: isDrinkFetching,
    refetch: refetchDrink,
  } = useQuery<Drink>({
    queryKey: ['drinks.detail', drinkId],
    queryFn: () => apiFetch<Drink>(`/api/drinks/${drinkId}`),
    retry: retryUnlessNotFound,
  });
  // Also over cached data: a post held in the cache can have been deleted since.
  const isDrinkGone = isNotFoundError(drinkError);
  const isAgeRequired = isAgeRequiredError(drinkError);

  const {
    data: commentPages,
    refetch: refetchComments,
    isError: isCommentsError,
    isFetching: isCommentsFetching,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['drinks.comments', drinkId],
    enabled: !isDrinkGone && !isAgeRequired,
    retry: retryUnlessNotFound,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      apiFetch<Page<Comment>>(`/api/drinks/${drinkId}/comments`, { query: { before: pageParam } }),
    getNextPageParam: getNextCursor,
  });
  const comments = flattenPages(commentPages);

  // Mutation callbacks still run after this screen is gone, and goBack pops whichever route is focused.
  const leaveScreen = () => {
    if (navigation.isFocused()) navigation.goBack();
  };

  const getDrinkActionErrorKey = (error: unknown) => {
    if (isAgeRequiredError(error)) return 'ageGate.required';
    return isStorageFullError(error) ? 'common.serviceUnavailable' : 'createPost.error';
  };

  // The screen has nothing left to show once a cheer, save or comment finds the post gone.
  const leaveIfDrinkGone = (error: unknown) => {
    if (!removeDrinkIfNotFound(queryClient, error, drinkId, serverUserId)) return false;
    Alert.alert(t('drinkDetail.title'), t('post.notFound'));
    leaveScreen();
    return true;
  };

  // Same alerts as before: this screen leaves when the post is gone.
  const { toggleCheer, toggleSave } = useDrinkToggles({
    onError: (error) => {
      if (leaveIfDrinkGone(error)) return;
      Alert.alert(t('drinkDetail.title'), t(getDrinkActionErrorKey(error)));
    },
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
      if (!isCurrentAuthUser(serverUserId)) return;
      setCommentText('');
      queryClient.invalidateQueries({ queryKey: ['drinks.comments', drinkId] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (error) => {
      if (leaveIfDrinkGone(error)) return;
      refreshIfSuspended(error);
      Alert.alert(t('drinkDetail.title'), t(getCommentErrorKey(error)));
    },
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
            {drink && !isDrinkGone && !isAgeRequired ? (
              <TouchableOpacity
                onPress={() => setActionsDrink(drink)}
                style={styles.headerButton}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={t('post.actions')}
              >
                <Ionicons name="ellipsis-horizontal" size={20} color="#FFFFFF" />
              </TouchableOpacity>
            ) : (
              <View style={{ width: 32 }} />
            )}
          </View>

          <ScrollView contentContainerStyle={styles.content}>
            {isDrinkGone ? (
              <View style={styles.loadingState}>
                <Ionicons name="alert-circle-outline" size={32} color="#6B7280" />
                <Text style={styles.loadingText}>{t('post.notFound')}</Text>
              </View>
            ) : isAgeRequired ? (
              // Defence in depth: the hard age gate means an unconfirmed user never reaches this screen.
              <View style={styles.loadingState}>
                <Ionicons name="lock-closed-outline" size={32} color="#6B7280" />
                <Text style={styles.loadingText}>{t('ageGate.required')}</Text>
                <TouchableOpacity
                  style={styles.ageConfirmButton}
                  onPress={promptConfirmAge}
                  disabled={isConfirming}
                  accessibilityRole="button"
                  accessibilityLabel={t('ageGate.bannerAction')}
                >
                  {isConfirming ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <Text style={styles.primaryActionText}>{t('ageGate.bannerAction')}</Text>
                  )}
                </TouchableOpacity>
              </View>
            ) : !drink && isDrinkError ? (
              <ListLoadState
                isError={isDrinkError}
                isFetching={isDrinkFetching}
                message={t('post.loadError')}
                onRetry={() => refetchDrink()}
              />
            ) : !drink ? (
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
                    <Image source={getImageSource(drink.imageUrl)} style={styles.heroImage} />
                  ) : null}
                  {drink.location && (
                    <View style={styles.locationRow}>
                      <Ionicons name="location-outline" size={16} color="#9CA3AF" />
                      <Text style={styles.locationText}>{drink.location}</Text>
                    </View>
                  )}
                  <Text style={styles.heroDescription}>{drink.description}</Text>
                  {drink.editedAt ? <Text style={styles.editedLabel}>{t('post.editedLabel')}</Text> : null}
                  {drink.hiddenPendingReview && (
                    <ModerationNotice messageKey="moderation.hiddenPost" style={styles.hiddenPostNotice} />
                  )}
                  {drink.tags?.length ? (
                    <View style={styles.tagsRow}>
                      {drink.tags.map((tag) => (
                        <View key={tag} style={styles.tagChip}>
                          {/* A known category shows its label; any other stored tag shows as it is. */}
                          <Text style={styles.tagText}>{isDrinkCategory(tag) ? t(`categories.${tag}`) : tag}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </View>

                <View style={styles.actionsRow}>
                  <TouchableOpacity
                    style={styles.primaryAction}
                    onPress={() => toggleCheer(drink)}
                  >
                    <FontAwesome5 name="glass-cheers" size={18} color="#FFFFFF" />
                    <Text style={styles.primaryActionText}>{t('drinkDetail.like')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.secondaryAction}
                    onPress={() => toggleSave(drink)}
                  >
                    <Ionicons name="bookmark" size={20} color="#8B5FBF" />
                    <Text style={styles.secondaryActionText}>{t('drinkDetail.save')}</Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>{t('drinkDetail.comments')}</Text>
                  {commentPages === undefined ? (
                    <ListLoadState
                      isError={isCommentsError}
                      isFetching={isCommentsFetching}
                      message={t('drinkDetail.commentsLoadError')}
                      onRetry={() => refetchComments()}
                    />
                  ) : comments.length === 0 ? (
                    <Text style={styles.emptyComments}>{t('drinkDetail.noComments')}</Text>
                  ) : (
                    comments.map((comment) => {
                      const commentUser = comment.userId === serverUserId && profile ? profile : comment.user;
                      return (
                        <View key={comment.id} style={styles.commentItem}>
                          <View style={styles.commentAvatar}>
                            {commentUser?.avatar ? (
                              <Image source={getImageSource(commentUser.avatar)} style={styles.commentAvatarImage} />
                            ) : (
                              <Text style={styles.commentAvatarText}>
                                {commentUser?.firstName?.[0]?.toUpperCase() || '?'}
                              </Text>
                            )}
                          </View>
                          <View style={styles.commentBody}>
                            <View style={styles.commentHeader}>
                              <Text style={styles.commentAuthor}>
                                {commentUser?.firstName
                                  ? `${commentUser.firstName} ${commentUser.lastName || ''}`
                                  : t('common.unknownUser')}
                              </Text>
                              <View style={styles.commentHeaderEnd}>
                                <Text style={styles.commentTimestamp}>{formatTimeAgo(comment.createdAt)}</Text>
                                <TouchableOpacity
                                  style={styles.commentMoreButton}
                                  onPress={() => setActionsComment(comment)}
                                  hitSlop={6}
                                  accessibilityRole="button"
                                  accessibilityLabel={t('comment.actions')}
                                >
                                  <Ionicons name="ellipsis-horizontal" size={16} color="#9CA3AF" />
                                </TouchableOpacity>
                              </View>
                            </View>
                            <Text style={styles.commentText}>{comment.content}</Text>
                            {comment.hiddenPendingReview && (
                              <ModerationNotice messageKey="moderation.hiddenComment" style={styles.hiddenCommentNotice} />
                            )}
                          </View>
                        </View>
                      );
                    })
                  )}
                  {hasNextPage && <LoadMoreButton onPress={() => fetchNextPage()} isLoading={isFetchingNextPage} />}
                </View>

                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>{t('drinkDetail.next')}</Text>
                  <View style={styles.tipCard}>
                    <Ionicons name="sparkles" size={20} color="#8B5FBF" />
                    <Text style={styles.tipText}>{t('drinkDetail.tip')}</Text>
                  </View>
                  <TouchableOpacity
                    style={styles.tipButton}
                    onPress={() => navigation.navigate('Main', { screen: 'Scanner' })}
                  >
                    <Ionicons name="camera" size={18} color="#FFFFFF" />
                    <Text style={styles.tipButtonText}>{t('drinkDetail.scan')}</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </ScrollView>

          {drink && !isDrinkGone && !isAgeRequired && (
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
          )}
        </View>
      </KeyboardAvoidingView>
      <PostActionsSheet
        drink={actionsDrink}
        comment={actionsComment}
        onClose={() => {
          setActionsDrink(null);
          setActionsComment(null);
        }}
        onDeleted={leaveScreen}
        onBlocked={(blockedUserId) => {
          if (blockedUserId === drink?.userId) leaveScreen();
        }}
      />
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
  commentAvatarImage: {
    width: 36,
    height: 36,
    borderRadius: 18,
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
  hiddenCommentNotice: {
    marginTop: 6,
  },
  hiddenPostNotice: {
    marginTop: 12,
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
  commentHeaderEnd: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  commentMoreButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ageConfirmButton: {
    backgroundColor: '#8B5FBF',
    minHeight: 44,
    borderRadius: 12,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editedLabel: {
    color: '#6B7280',
    fontSize: 12,
    fontStyle: 'italic',
  },
});
