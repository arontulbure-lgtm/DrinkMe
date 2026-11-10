import React, { MutableRefObject, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isCurrentAuthUser, useAuth } from '../context/AuthContext';
import { useLocalization } from '../context/LocalizationContext';
import { apiFetch, getBlockErrorKey, getReportErrorKey, isNotFoundError } from '../lib/api';
import {
  findCachedDrink,
  removeCommentFromCache,
  removeDrinkFromCaches,
  removeDrinkIfNotFound,
  removeUserFromCaches,
} from '../lib/drinkCache';
import { Comment, Drink, ReportReason } from '../types/api';
import ReportSheet from './ReportSheet';

export type ActionsTarget =
  | { type: 'drink'; drink: Drink }
  | { type: 'comment'; comment: Comment }
  | { type: 'user'; userId: string };

type ActionsStep = 'menu' | 'confirmDelete' | 'confirmBlock' | 'report' | 'reported';

interface ActionsPanelProps {
  target: ActionsTarget;
  onClose: () => void;
  // The post left the caches: it was deleted, or this user reported it.
  onDeleted?: () => void;
  onBlocked?: (userId: string) => void;
  // Set to the panel's own close, for the Modal around it: Android's back button must follow the same rules.
  closeRef?: MutableRefObject<() => void>;
}

// The panel holds no Modal, so CommentDrawer can show it inside its own: iOS shows only one Modal at a time.
// The confirmations stay inside too: an Alert opened while a Modal closes can vanish on iOS.
export function ActionsPanel({ target, onClose, onDeleted, onBlocked, closeRef }: ActionsPanelProps) {
  const insets = useSafeAreaInsets();
  const { serverUserId } = useAuth();
  const queryClient = useQueryClient();
  const { t } = useLocalization();
  const [step, setStep] = useState<ActionsStep>('menu');
  // Closing does not cancel a request, so its callbacks must not close whatever opened since.
  const isClosedRef = useRef(false);

  const ownerId = target.type === 'drink'
    ? target.drink.userId
    : target.type === 'comment'
      ? target.comment.userId
      : target.userId;
  const isOwnContent = ownerId === serverUserId;
  const isOwnersComment = target.type === 'comment'
    && findCachedDrink(queryClient, target.comment.drinkId)?.userId === serverUserId;
  const canDelete = target.type !== 'user' && (isOwnContent || isOwnersComment);
  const deleteLabel = t(target.type === 'comment' ? 'comment.delete' : 'post.delete');

  const closeOnce = () => {
    if (isClosedRef.current) return;
    isClosedRef.current = true;
    onClose();
  };

  // After a deletion. After a report too, which hides it from this user only, until the next fetch.
  const removeTargetFromCaches = (options?: { refetchGaps: boolean }) => {
    if (target.type === 'drink') removeDrinkFromCaches(queryClient, target.drink.id, options);
    if (target.type === 'comment') removeCommentFromCache(queryClient, target.comment.drinkId, target.comment.id);
  };

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const path = target.type === 'comment'
        ? `/api/drinks/${target.comment.drinkId}/comments/${target.comment.id}`
        : target.type === 'drink'
          ? `/api/drinks/${target.drink.id}`
          : null;
      if (!path) return;
      try {
        await apiFetch<void>(path, { method: 'DELETE' });
      } catch (error) {
        // Already gone, for example from another device: that is what the user asked for.
        if (!isNotFoundError(error)) throw error;
      }
    },
    onSuccess: () => {
      if (!isCurrentAuthUser(serverUserId)) return;
      removeTargetFromCaches();
      closeOnce();
      if (target.type === 'drink') onDeleted?.();
    },
  });

  const blockMutation = useMutation({
    mutationFn: () => apiFetch<{ blocked: boolean }>(`/api/blocks/${encodeURIComponent(ownerId)}`, { method: 'POST' }),
    onSuccess: () => {
      if (!isCurrentAuthUser(serverUserId)) return;
      removeUserFromCaches(queryClient, ownerId);
      closeOnce();
      onBlocked?.(ownerId);
    },
  });

  const reportMutation = useMutation({
    mutationFn: (reason: ReportReason) => apiFetch<{ id: number }>('/api/reports', {
      method: 'POST',
      body: JSON.stringify({
        targetType: target.type,
        targetId: target.type === 'drink' ? target.drink.id : target.type === 'comment' ? target.comment.id : target.userId,
        reason,
      }),
    }),
    onSuccess: () => {
      if (!isCurrentAuthUser(serverUserId)) return;
      removeTargetFromCaches({ refetchGaps: false });
      setStep('reported');
      // Closed while this was on its way, so handleClose below cannot leave the screen any more.
      if (isClosedRef.current && target.type === 'drink') onDeleted?.();
    },
    onError: (error) => {
      if (target.type === 'drink') removeDrinkIfNotFound(queryClient, error, target.drink.id, serverUserId);
      if (target.type === 'comment' && isNotFoundError(error) && isCurrentAuthUser(serverUserId)) {
        removeCommentFromCache(queryClient, target.comment.drinkId, target.comment.id);
      }
    },
  });

  // A request that hangs must not trap the user, so closing is always allowed.
  const handleClose = () => {
    closeOnce();
    // The post on screen was reported, so a screen showing only that post has nothing left.
    if (step === 'reported' && target.type === 'drink') onDeleted?.();
  };

  useEffect(() => {
    if (closeRef) closeRef.current = handleClose;
  });

  return (
    <>
      <TouchableWithoutFeedback onPress={handleClose}>
        <View style={styles.backdrop} />
      </TouchableWithoutFeedback>

      <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
        {step === 'report' || step === 'reported' ? (
          <ReportSheet
            targetType={target.type}
            isPending={reportMutation.isPending}
            pendingReason={reportMutation.variables}
            errorMessage={reportMutation.isError ? t(getReportErrorKey(reportMutation.error)) : undefined}
            isDone={step === 'reported'}
            onSelect={(reason) => reportMutation.mutate(reason)}
            onClose={handleClose}
          />
        ) : step === 'confirmDelete' ? (
          <>
            {target.type === 'drink' && <Text style={styles.message}>{t('post.deleteConfirm')}</Text>}
            {deleteMutation.isError && (
              <Text style={styles.errorText}>{t(target.type === 'comment' ? 'comment.deleteFailed' : 'post.deleteFailed')}</Text>
            )}
            <TouchableOpacity
              style={[styles.confirmButton, deleteMutation.isPending && styles.buttonDisabled]}
              onPress={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              accessibilityRole="button"
              accessibilityLabel={deleteLabel}
            >
              {deleteMutation.isPending ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.confirmButtonText}>{deleteLabel}</Text>
              )}
            </TouchableOpacity>
          </>
        ) : step === 'confirmBlock' ? (
          <>
            <Text style={styles.message}>{t('block.confirm')}</Text>
            {blockMutation.isError && <Text style={styles.errorText}>{t(getBlockErrorKey(blockMutation.error))}</Text>}
            <TouchableOpacity
              style={[styles.confirmButton, blockMutation.isPending && styles.buttonDisabled]}
              onPress={() => blockMutation.mutate()}
              disabled={blockMutation.isPending}
              accessibilityRole="button"
              accessibilityLabel={t('block.action')}
            >
              {blockMutation.isPending ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.confirmButtonText}>{t('block.action')}</Text>
              )}
            </TouchableOpacity>
          </>
        ) : (
          <>
            {canDelete && (
              <TouchableOpacity
                style={styles.actionRow}
                onPress={() => setStep('confirmDelete')}
                accessibilityRole="button"
                accessibilityLabel={deleteLabel}
              >
                <Ionicons name="trash-outline" size={22} color="#EF4444" />
                <Text style={styles.deleteText}>{deleteLabel}</Text>
              </TouchableOpacity>
            )}
            {!isOwnContent && (
              <>
                <TouchableOpacity
                  style={styles.actionRow}
                  onPress={() => setStep('report')}
                  accessibilityRole="button"
                  accessibilityLabel={t('report.action')}
                >
                  <Ionicons name="flag-outline" size={22} color="#FFFFFF" />
                  <Text style={styles.actionText}>{t('report.action')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.actionRow}
                  onPress={() => setStep('confirmBlock')}
                  accessibilityRole="button"
                  accessibilityLabel={t('block.action')}
                >
                  <Ionicons name="ban-outline" size={22} color="#EF4444" />
                  <Text style={styles.deleteText}>{t('block.action')}</Text>
                </TouchableOpacity>
              </>
            )}
          </>
        )}
        {step !== 'reported' && (
          <TouchableOpacity
            style={styles.cancelButton}
            onPress={handleClose}
            accessibilityRole="button"
            accessibilityLabel={t('common.cancel')}
          >
            <Text style={styles.cancelButtonText}>{t('common.cancel')}</Text>
          </TouchableOpacity>
        )}
      </View>
    </>
  );
}

interface PostActionsSheetProps {
  drink?: Drink | null;
  comment?: Comment | null;
  userId?: string | null;
  onClose: () => void;
  onDeleted?: () => void;
  onBlocked?: (userId: string) => void;
}

export default function PostActionsSheet({ drink, comment, userId, onClose, onDeleted, onBlocked }: PostActionsSheetProps) {
  const closeRef = useRef<() => void>(onClose);
  const target: ActionsTarget | null = drink
    ? { type: 'drink', drink }
    : comment
      ? { type: 'comment', comment }
      : userId
        ? { type: 'user', userId }
        : null;

  return (
    <Modal visible={!!target} transparent animationType="slide" onRequestClose={() => closeRef.current()}>
      {target && <ActionsPanel target={target} onClose={onClose} onDeleted={onDeleted} onBlocked={onBlocked} closeRef={closeRef} />}
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sheet: {
    backgroundColor: '#1F2937',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderTopColor: '#374151',
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 12,
  },
  message: {
    color: '#FFFFFF',
    fontSize: 16,
    lineHeight: 22,
  },
  errorText: {
    color: '#EF4444',
    fontSize: 14,
    lineHeight: 20,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 44,
  },
  actionText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  deleteText: {
    color: '#EF4444',
    fontSize: 16,
    fontWeight: '600',
  },
  confirmButton: {
    backgroundColor: '#EF4444',
    borderRadius: 12,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  cancelButton: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#374151',
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
});
