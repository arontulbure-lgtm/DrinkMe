import { useCallback } from 'react';
import { Alert } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isCurrentAuthUser, useAuth } from '../context/AuthContext';
import { useLocalization } from '../context/LocalizationContext';
import { apiFetch } from './api';
import { invalidateDrinkQueries } from './drinkCache';
import { BaseUser } from '../types/api';

// The answer is stored on the server. A logout during the request leaves the next user's data alone.
export function useConfirmAge() {
  const { serverUserId, setProfile } = useAuth();
  const queryClient = useQueryClient();
  const { t } = useLocalization();

  const { mutate, isPending } = useMutation({
    mutationFn: async () => {
      if (!serverUserId) throw new Error('Missing user id');
      return apiFetch<BaseUser>(`/api/users/${serverUserId}/acknowledgements`, {
        method: 'POST',
        body: JSON.stringify({ type: 'age', confirmed: true }),
      });
    },
    onSuccess: (updated) => {
      if (!serverUserId || !isCurrentAuthUser(serverUserId)) return;
      setProfile({ ...updated, id: serverUserId });
      // A fetch already on its way would otherwise put the unconfirmed answer back.
      void queryClient.cancelQueries({ queryKey: ['users.detail', serverUserId] });
      queryClient.setQueryData<BaseUser>(['users.detail', serverUserId], updated);
      invalidateDrinkQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: () => {
      Alert.alert(t('ageGate.title'), t('ageGate.confirmFailed'));
    },
  });

  const confirmAge = useCallback(() => mutate(), [mutate]);

  // For a late confirmation: the user sees the same question as on the gate before answering.
  const promptConfirmAge = useCallback(() => {
    Alert.alert(t('ageGate.title'), t('ageGate.body'), [
      { text: t('ageGate.decline'), style: 'cancel' },
      { text: t('ageGate.confirm'), onPress: () => mutate() },
    ]);
  }, [mutate, t]);

  return { confirmAge, promptConfirmAge, isConfirming: isPending };
}
