import { useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { isAccountSuspendedError } from './api';

// For error paths of actions a suspension refuses (posts, comments, partner requests, profile edits,
// reports): a 403 account_suspended means the profile is out of date, so it is refreshed and Home and
// Profile show the suspension banner with its date. Any other error does nothing here.
export function useRefreshIfSuspended() {
  const { refreshProfile } = useAuth();
  return useCallback((error: unknown) => {
    if (isAccountSuspendedError(error)) void refreshProfile();
  }, [refreshProfile]);
}
