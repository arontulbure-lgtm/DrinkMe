import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Dimensions,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { apiFetch, getCommentErrorKey, getImageSource, isAgeRequiredError, isNotFoundError, retryUnlessNotFound } from '../lib/api';
import { findCachedDrink, flattenPages, getNextCursor, removeDrinkIfNotFound } from '../lib/drinkCache';
import { Comment, Page } from '../types/api';
import { useLocalization } from '../context/LocalizationContext';
import { ActionsPanel } from './PostActionsSheet';
import ListLoadState from './ListLoadState';
import LoadMoreButton from './LoadMoreButton';
import ModerationNotice from './ModerationNotice';
import { useRefreshIfSuspended } from '../lib/useRefreshIfSuspended';

const SCREEN_HEIGHT = Dimensions.get('window').height;
const DRAWER_HEIGHT = SCREEN_HEIGHT * 0.72;

interface CommentDrawerProps {
  drinkId: number | null;
  onClose: () => void;
  onBlocked?: (userId: string) => void;
}

function formatTimeAgo(dateString: string): string {
  const now = Date.now();
  const then = new Date(dateString).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffDay > 0) return `${diffDay}d`;
  if (diffHr > 0) return `${diffHr}h`;
  if (diffMin > 0) return `${diffMin}m`;
  return 'now';
}

export default function CommentDrawer({ drinkId, onClose, onBlocked }: CommentDrawerProps) {
  const insets = useSafeAreaInsets();
  const { profile, serverUserId, getJwtToken } = useAuth();
  const queryClient = useQueryClient();
  const { t } = useLocalization();
  const refreshIfSuspended = useRefreshIfSuspended();

  const [text, setText] = useState('');
  const [actionsComment, setActionsComment] = useState<Comment | null>(null);
  const actionsCloseRef = useRef<() => void>(() => setActionsComment(null));
  // Read when the panel opens: a block removes that user's posts from the cache before the panel reports back.
  const actionsPostOwnerRef = useRef<string | undefined>(undefined);
  const translateY = useRef(new Animated.Value(DRAWER_HEIGHT)).current;
  const isVisible = drinkId !== null;

  useEffect(() => {
    if (isVisible) {
      setText('');
      setActionsComment(null);
      Animated.spring(translateY, {
        toValue: 0,
        damping: 20,
        stiffness: 200,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(translateY, {
        toValue: DRAWER_HEIGHT,
        duration: 220,
        useNativeDriver: true,
      }).start();
    }
  }, [isVisible, translateY]);

  const {
    data: commentPages,
    refetch,
    error: commentsError,
    isError,
    isFetching,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['drinks.comments', drinkId],
    enabled: isVisible && drinkId !== null,
    retry: retryUnlessNotFound,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      apiFetch<Page<Comment>>(`/api/drinks/${drinkId}/comments`, { query: { before: pageParam } }),
    getNextPageParam: getNextCursor,
  });
  const comments = flattenPages(commentPages);

  const addCommentMutation = useMutation({
    mutationFn: async (content: string) => {
      const token = await getJwtToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      return apiFetch<Comment>(`/api/drinks/${drinkId}/comments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['drinks.comments', drinkId] });
      queryClient.invalidateQueries({ queryKey: ['drinks.detail', drinkId] });
      setText('');
    },
    onError: (error) => {
      if (drinkId !== null && removeDrinkIfNotFound(queryClient, error, drinkId, serverUserId)) {
        Alert.alert(t('drinkDetail.title'), t('post.notFound'));
        handleClose();
        return;
      }
      refreshIfSuspended(error);
      Alert.alert(t('drinkDetail.title'), t(getCommentErrorKey(error)));
    },
  });

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || addCommentMutation.isPending) return;
    addCommentMutation.mutate(trimmed);
  };

  const handleClose = () => {
    Animated.timing(translateY, {
      toValue: DRAWER_HEIGHT,
      duration: 220,
      useNativeDriver: true,
    }).start(() => {
      onClose();
    });
  };

  return (
    <Modal
      visible={isVisible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={() => (actionsComment ? actionsCloseRef.current() : handleClose())}
    >
      <TouchableWithoutFeedback onPress={handleClose}>
        <View style={styles.backdrop} />
      </TouchableWithoutFeedback>

      <Animated.View style={[styles.drawer, { transform: [{ translateY }] }]}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          {/* Handle */}
          <View style={styles.handle} />
          <View style={styles.titleRow}>
            <Text style={styles.title}>{t('drinkDetail.comments')}</Text>
            <TouchableOpacity onPress={handleClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color="#9CA3AF" />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
          >
            {isNotFoundError(commentsError) ? (
              <View style={styles.centered}>
                <Ionicons name="alert-circle-outline" size={36} color="#374151" />
                <Text style={styles.emptyText}>{t('post.notFound')}</Text>
              </View>
            ) : isAgeRequiredError(commentsError) ? (
              <View style={styles.centered}>
                <Ionicons name="lock-closed-outline" size={36} color="#374151" />
                <Text style={styles.emptyText}>{t('ageGate.required')}</Text>
              </View>
            ) : commentPages === undefined ? (
              <ListLoadState
                isError={isError}
                isFetching={isFetching}
                message={t('drinkDetail.commentsLoadError')}
                onRetry={() => refetch()}
              />
            ) : comments.length === 0 ? (
              <View style={styles.centered}>
                <Ionicons name="chatbubble-outline" size={36} color="#374151" />
                <Text style={styles.emptyText}>{t('drinkDetail.noComments')}</Text>
              </View>
            ) : (
              comments.map((comment) => {
                const commentUser = comment.userId === serverUserId && profile ? profile : comment.user;
                const avatarUri = commentUser?.avatar ?? null;
                const displayName = commentUser?.firstName
                  ? `${commentUser.firstName} ${commentUser.lastName || ''}`.trim()
                  : t('common.unknownUser');
                const initial = displayName[0]?.toUpperCase() ?? '?';

                return (
                  <View key={comment.id} style={styles.commentRow}>
                    <View style={styles.avatarWrap}>
                      {avatarUri ? (
                        <Image source={getImageSource(avatarUri)} style={styles.avatarImg} />
                      ) : (
                        <View style={styles.avatarFallback}>
                          <Text style={styles.avatarInitial}>{initial}</Text>
                        </View>
                      )}
                    </View>
                    <View style={styles.commentBody}>
                      <View style={styles.commentMeta}>
                        <Text style={styles.commentAuthor}>{displayName}</Text>
                        <Text style={styles.commentTime}>{formatTimeAgo(comment.createdAt)}</Text>
                        <TouchableOpacity
                          style={styles.commentMoreButton}
                          onPress={() => {
                            Keyboard.dismiss();
                            actionsPostOwnerRef.current = findCachedDrink(queryClient, comment.drinkId)?.userId;
                            setActionsComment(comment);
                          }}
                          hitSlop={6}
                          accessibilityRole="button"
                          accessibilityLabel={t('comment.actions')}
                        >
                          <Ionicons name="ellipsis-horizontal" size={16} color="#9CA3AF" />
                        </TouchableOpacity>
                      </View>
                      <Text style={styles.commentContent}>{comment.content}</Text>
                      {/* Only the author and admins receive a comment hidden after reports. */}
                      {comment.hiddenPendingReview && (
                        <ModerationNotice messageKey="moderation.hiddenComment" style={styles.hiddenNotice} />
                      )}
                    </View>
                  </View>
                );
              })
            )}
            {hasNextPage && <LoadMoreButton onPress={() => fetchNextPage()} isLoading={isFetchingNextPage} />}
          </ScrollView>

          {/* Input area */}
          <View style={[styles.inputArea, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            {profile?.avatar ? (
              <Image source={getImageSource(profile.avatar)} style={styles.inputAvatar} />
            ) : (
              <View style={[styles.inputAvatar, styles.inputAvatarFallback]}>
                <Text style={styles.inputAvatarInitial}>
                  {(profile?.firstName ?? profile?.email ?? 'U')[0]?.toUpperCase() ?? 'U'}
                </Text>
              </View>
            )}
            <TextInput
              style={styles.input}
              placeholder={t('common.commentPlaceholder')}
              placeholderTextColor="#6B7280"
              value={text}
              onChangeText={setText}
              multiline
              maxLength={500}
              returnKeyType="send"
              onSubmitEditing={handleSend}
            />
            <TouchableOpacity
              style={[styles.sendButton, (!text.trim() || addCommentMutation.isPending) && styles.sendButtonDisabled]}
              onPress={handleSend}
              disabled={!text.trim() || addCommentMutation.isPending}
            >
              <Ionicons name="send" size={18} color="#FFFFFF" />
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Animated.View>

      {/* Inside this Modal, not a second one: iOS shows only one at a time. */}
      {actionsComment && (
        <View style={StyleSheet.absoluteFill}>
          <ActionsPanel
            target={{ type: 'comment', comment: actionsComment }}
            onClose={() => setActionsComment(null)}
            onBlocked={(blockedUserId) => {
              if (blockedUserId === actionsPostOwnerRef.current) handleClose();
              onBlocked?.(blockedUserId);
            }}
            closeRef={actionsCloseRef}
          />
        </View>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  drawer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: DRAWER_HEIGHT,
    backgroundColor: '#0F172A',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: 'hidden',
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#374151',
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 4,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1F2937',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingVertical: 12, gap: 20, flexGrow: 1 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    gap: 12,
  },
  emptyText: {
    color: '#6B7280',
    fontSize: 14,
    marginTop: 8,
  },
  commentRow: {
    flexDirection: 'row',
    gap: 12,
  },
  avatarWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    overflow: 'hidden',
  },
  avatarImg: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  avatarFallback: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#8B5FBF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  commentBody: { flex: 1 },
  commentMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  commentAuthor: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  commentTime: {
    color: '#6B7280',
    fontSize: 12,
  },
  commentMoreButton: {
    width: 32,
    height: 32,
    marginLeft: 'auto',
    alignItems: 'center',
    justifyContent: 'center',
  },
  commentContent: {
    color: '#D1D5DB',
    fontSize: 14,
    lineHeight: 20,
  },
  hiddenNotice: {
    marginTop: 6,
  },
  inputArea: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 10,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: '#1F2937',
    backgroundColor: '#0F172A',
  },
  inputAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    marginBottom: 4,
  },
  inputAvatarFallback: {
    backgroundColor: '#8B5FBF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputAvatarInitial: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  input: {
    flex: 1,
    backgroundColor: '#1F2937',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    color: '#FFFFFF',
    fontSize: 14,
    maxHeight: 100,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#8B5FBF',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  sendButtonDisabled: {
    backgroundColor: '#374151',
  },
});
