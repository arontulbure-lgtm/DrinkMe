import React, { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isCurrentAuthUser, useAuth } from '../context/AuthContext';
import { useLocalization } from '../context/LocalizationContext';
import { ACCOUNT_SUSPENDED_ERROR_KEY, apiFetch, isAccountSuspendedError, isNameReservedError } from '../lib/api';
import { useRefreshIfSuspended } from '../lib/useRefreshIfSuspended';
import { invalidateAuthorQueries } from '../lib/drinkCache';
import { BaseUser } from '../types/api';

// Same number as PRIVACY_NOTICE_VERSION in server/server.js. Raise both when the notice text changes
// in substance, and re-check the text whenever the public read rules or PARTNER_CONSENT_REQUIRED do.
// The partner sentence is untrue with PARTNER_CONSENT_REQUIRED=false, an emergency rollback only:
// anyone can then add themselves and read the list.
// Rollout: deploy the server first, then release the client. The server accepts any version from 1 up to
// its own and stores the highest, so older builds still answering their own notice are never stranded.
// Version 2: nothing is visible without signing in, or before the 18+ confirmation, the 90-day audit log, and the reported version kept when a reported post is edited.
export const PRIVACY_NOTICE_VERSION = 2;

const NAME_MAX_LENGTH = 120;

interface Props {
  onLater: () => void;
}

// Two steps, each shown only if needed: the notice, which cannot be skipped, then the name.
// AppNavigator removes the screen once the profile says nothing is left to ask.
export default function OnboardingScreen({ onLater }: Props) {
  const { profile, serverUserId, setProfile, logout } = useAuth();
  const { t } = useLocalization();
  const refreshIfSuspended = useRefreshIfSuspended();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const isNoticeStep = (profile?.privacyNoticeVersion ?? 0) < PRIVACY_NOTICE_VERSION;

  const applyUpdatedProfile = (updated: BaseUser) => {
    if (!serverUserId) return;
    setProfile({ ...updated, id: serverUserId });
    // A fetch already on its way would otherwise put the old answer back.
    void queryClient.cancelQueries({ queryKey: ['users.detail', serverUserId] });
    queryClient.setQueryData<BaseUser>(['users.detail', serverUserId], updated);
  };

  // A suspended user cannot set a name (PUT /api/users/:id is refused); "Later" still lets them in.
  const handleSaveError = (error: unknown) => {
    if (!isCurrentAuthUser(serverUserId)) return;
    refreshIfSuspended(error);
    // name_reserved comes only from the name prompt: the brand name is kept for the official account.
    setErrorKey(isAccountSuspendedError(error)
      ? ACCOUNT_SUSPENDED_ERROR_KEY
      : isNameReservedError(error) ? 'editProfile.nameReserved' : 'onboarding.saveFailed');
    // A 401 on the JWT in use already makes apiFetch rebuild the session, which brings this screen back.
  };

  const acknowledgeMutation = useMutation({
    mutationFn: async () => {
      if (!serverUserId) throw new Error('Missing user id');
      return apiFetch<BaseUser>(`/api/users/${serverUserId}/acknowledgements`, {
        method: 'POST',
        body: JSON.stringify({ type: 'privacy', version: PRIVACY_NOTICE_VERSION }),
      });
    },
    onMutate: () => setErrorKey(null),
    onSuccess: (updated) => {
      if (isCurrentAuthUser(serverUserId)) applyUpdatedProfile(updated);
    },
    onError: handleSaveError,
  });

  const nameMutation = useMutation({
    mutationFn: async (firstName: string) => {
      if (!serverUserId) throw new Error('Missing user id');
      return apiFetch<BaseUser>(`/api/users/${serverUserId}`, {
        method: 'PUT',
        body: JSON.stringify({ firstName, nameChosen: true }),
      });
    },
    onMutate: () => setErrorKey(null),
    onSuccess: (updated) => {
      if (!isCurrentAuthUser(serverUserId)) return;
      applyUpdatedProfile(updated);
      invalidateAuthorQueries(queryClient);
      // The server removes control characters, so what looked like a name can end up empty.
      if (updated.needsName === true) setErrorKey('onboarding.nameInvalid');
    },
    onError: handleSaveError,
  });

  const handleSaveName = () => {
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName.length > NAME_MAX_LENGTH || trimmedName.includes('@')) {
      setErrorKey('onboarding.nameInvalid');
      return;
    }
    nameMutation.mutate(trimmedName);
  };

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await logout();
    } catch (error) {
      console.error('Failed to log out:', error);
      setIsLoggingOut(false);
    }
  };

  const logoutButton = (
    // Stays usable during a save: apiFetch has no timeout, and this must never be a dead end.
    <TouchableOpacity
      style={styles.logoutButton}
      onPress={handleLogout}
      disabled={isLoggingOut}
      accessibilityRole="button"
      accessibilityLabel={t('profile.logout')}
    >
      {isLoggingOut ? (
        <ActivityIndicator color="#9CA3AF" />
      ) : (
        <Text style={styles.logoutText}>{t('profile.logout')}</Text>
      )}
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior="padding" style={styles.keyboardArea}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {isNoticeStep ? (
            <>
              <Ionicons name="eye-outline" size={48} color="#8B5FBF" style={styles.icon} />
              <Text style={styles.title} accessibilityRole="header">{t('onboarding.privacyTitle')}</Text>
              <Text style={styles.body}>{t('onboarding.privacyPublic')}</Text>
              <Text style={styles.body}>{t('onboarding.privacyAlcoholic')}</Text>
              <Text style={styles.body}>{t('onboarding.privacyActivity')}</Text>
              <Text style={styles.body}>{t('onboarding.privacyPartners')}</Text>
              <Text style={styles.body}>{t('onboarding.privacyPartnersOfPartners')}</Text>
              <Text style={styles.body}>{t('onboarding.privacyModerators')}</Text>
              <Text style={styles.body}>{t('onboarding.privacyModeration')}</Text>
              <Text style={styles.body}>{t('onboarding.privacyBackups')}</Text>
              <Text style={styles.body}>{t('onboarding.privacyPrivate')}</Text>
              {errorKey ? <Text style={styles.error} accessibilityLiveRegion="polite">{t(errorKey)}</Text> : null}
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={() => acknowledgeMutation.mutate()}
                disabled={acknowledgeMutation.isPending || isLoggingOut}
                accessibilityRole="button"
                accessibilityLabel={t('onboarding.privacyAccept')}
              >
                {acknowledgeMutation.isPending ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.primaryText}>{t('onboarding.privacyAccept')}</Text>
                )}
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Ionicons name="person-circle-outline" size={48} color="#8B5FBF" style={styles.icon} />
              <Text style={styles.title} accessibilityRole="header">{t('onboarding.nameTitle')}</Text>
              <Text style={styles.body}>{t('onboarding.nameHint')}</Text>
              {profile?.nameReservedAtSignIn ? (
                <Text style={styles.body}>{t('onboarding.nameReservedAtSignIn')}</Text>
              ) : null}
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={(text) => {
                  setName(text);
                  setErrorKey(null);
                }}
                onSubmitEditing={handleSaveName}
                maxLength={NAME_MAX_LENGTH}
                autoCapitalize="words"
                autoCorrect={false}
                returnKeyType="done"
                editable={!nameMutation.isPending}
                accessibilityLabel={t('onboarding.nameTitle')}
              />
              {errorKey ? <Text style={styles.error} accessibilityLiveRegion="polite">{t(errorKey)}</Text> : null}
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={handleSaveName}
                disabled={nameMutation.isPending || isLoggingOut}
                accessibilityRole="button"
                accessibilityLabel={t('editProfile.save')}
              >
                {nameMutation.isPending ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.primaryText}>{t('editProfile.save')}</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={onLater}
                disabled={isLoggingOut}
                accessibilityRole="button"
                accessibilityLabel={t('onboarding.later')}
              >
                <Text style={styles.secondaryText}>{t('onboarding.later')}</Text>
              </TouchableOpacity>
            </>
          )}
          {logoutButton}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  keyboardArea: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingVertical: 24,
    gap: 16,
  },
  icon: {
    alignSelf: 'center',
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: '#FFFFFF',
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    color: '#9CA3AF',
    lineHeight: 20,
  },
  input: {
    backgroundColor: '#1F2937',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: '#FFFFFF',
    fontSize: 16,
  },
  error: {
    color: '#EF4444',
    fontSize: 14,
    textAlign: 'center',
  },
  primaryButton: {
    backgroundColor: '#8B5FBF',
    minHeight: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  primaryText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  secondaryButton: {
    backgroundColor: '#1F2937',
    minHeight: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  secondaryText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  logoutButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoutText: {
    color: '#9CA3AF',
    fontSize: 14,
    fontWeight: '600',
  },
});
