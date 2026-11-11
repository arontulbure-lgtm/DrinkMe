import { useCallback } from 'react';
import { Alert } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isCurrentAuthUser, useAuth } from '../context/AuthContext';
import { useLocalization } from '../context/LocalizationContext';
import { ACCOUNT_SUSPENDED_ERROR_KEY, apiFetch, ApiError, isAccountSuspendedError, isNotFoundError } from './api';
import { invalidateAfterPartnerChange, invalidateAfterPartnerRequest, setPartnerStatusInCaches } from './drinkCache';
import { PartnerActionResult, PartnerStatus } from '../types/api';
import { useRefreshIfSuspended } from './useRefreshIfSuspended';

// Translation key for the button that shows how the signed-in user stands with someone.
export function getPartnerLabelKey(status: PartnerStatus): string {
  if (status === 'partner') return 'profile.drinkPartners';
  if (status === 'requested') return 'partners.requested';
  if (status === 'incoming') return 'partners.accept';
  return 'common.addPartner';
}

// Translation key for a partner action that failed.
export function getPartnerErrorKey(error: unknown): string {
  if (isAccountSuspendedError(error)) return ACCOUNT_SUSPENDED_ERROR_KEY;
  if (error instanceof ApiError && error.code === 'partner_request_limit') return 'partners.requestLimit';
  if (error instanceof ApiError && error.status === 507) return 'common.serviceUnavailable';
  return 'errors.partnerFailed';
}

// The current status in a 409 from DELETE: the button was stale and the server changed nothing.
function getConflictStatus(error: unknown): PartnerStatus | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  try {
    const { status } = JSON.parse(error.message);
    return status === 'none' || status === 'requested' || status === 'incoming' || status === 'partner' ? status : null;
  } catch {
    return null;
  }
}

// POST asks, or accepts a request from the other side; DELETE removes a partner or cancels a request.
// The route is chosen from the status on the button, and the screen follows the status in the answer.
export function usePartnerAction() {
  const { serverUserId } = useAuth();
  const queryClient = useQueryClient();
  const { t } = useLocalization();
  const refreshIfSuspended = useRefreshIfSuspended();

  const { mutate, isPending, variables } = useMutation({
    mutationFn: async ({ targetId, status }: { targetId: string; status: PartnerStatus }): Promise<PartnerActionResult & { isStale?: boolean }> => {
      if (status === 'partner' || status === 'requested') {
        try {
          await apiFetch(`/api/drink-partners/${targetId}`, {
            method: 'DELETE',
            query: { expect: status === 'partner' ? 'partner' : 'request' },
          });
        } catch (error) {
          const current = getConflictStatus(error);
          if (!current) throw error;
          return { status: current, isPartner: current === 'partner', isStale: true };
        }
        return { status: 'none', isPartner: false };
      }
      return apiFetch<PartnerActionResult>(`/api/drink-partners/${targetId}`, { method: 'POST' });
    },
    onSuccess: (result, { targetId, status }) => {
      if (!isCurrentAuthUser(serverUserId)) return;
      setPartnerStatusInCaches(queryClient, targetId, result.status);
      // A stale button means a partnership may have changed without this device knowing.
      if (result.isStale || status === 'partner' || result.status === 'partner') invalidateAfterPartnerChange(queryClient, targetId);
      else invalidateAfterPartnerRequest(queryClient, targetId);
    },
    onError: (error, { targetId }) => {
      // Blocked or gone since this screen loaded: the refetch shows that.
      if (isNotFoundError(error) && isCurrentAuthUser(serverUserId)) invalidateAfterPartnerRequest(queryClient, targetId);
      refreshIfSuspended(error);
      Alert.alert(t(getPartnerErrorKey(error)));
    },
  });

  const pressPartner = useCallback((targetId: string, status: PartnerStatus) => {
    if (status !== 'partner') {
      mutate({ targetId, status });
      return;
    }
    Alert.alert(t('partners.removeConfirm'), undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('partners.remove'), style: 'destructive', onPress: () => mutate({ targetId, status }) },
    ]);
  }, [mutate, t]);

  return { pressPartner, pendingTargetId: isPending ? variables?.targetId : undefined };
}
