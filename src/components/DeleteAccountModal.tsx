import React, { useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { isCurrentAuthUser, useAuth } from '../context/AuthContext';
import { useLocalization } from '../context/LocalizationContext';
import { DeletionOutcomeUnknownError, getDeleteAccountErrorKey, isStaleJwtError } from '../lib/api';

interface Props {
  visible: boolean;
  onClose: () => void;
}

// The account deletion confirmation, shared by Edit Profile and the age gate. It calls
// POST /api/users/:id/delete-account, which the server allows before the 18+ confirmation.
export default function DeleteAccountModal({ visible, onClose }: Props) {
  const { serverUserId, user, logout, deleteAccount, retrySession } = useAuth();
  const { t } = useLocalization();
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteErrorKey, setDeleteErrorKey] = useState<string | null>(null);
  // A Google or Apple account has no password to ask for, and proves itself with a fresh token only.
  const isPasswordAccount = user?.providerData.some((provider) => provider.providerId === 'password') === true;

  const deleteAccountMutation = useMutation({
    mutationFn: () => deleteAccount(isPasswordAccount ? deletePassword : null),
    onMutate: () => setDeleteErrorKey(null),
    onSuccess: (result) => {
      // Said even if Firebase has already ended the session, because it is about this account.
      Alert.alert(t('deleteAccount.action'), t(result.firebaseDeleted ? 'deleteAccount.done' : 'deleteAccount.partial'));
      // Never signs out an account that was signed in since. logout() clears the cached data.
      if (isCurrentAuthUser(serverUserId)) void logout().catch((error) => console.warn('Failed to sign out:', error));
    },
    onError: (error) => {
      if (!isCurrentAuthUser(serverUserId)) return;
      // It may have worked, so "failed" would be untrue. Sign-in answers 410 if so, which ends in the
      // notice and a sign-out, or gives back a working session if not.
      if (error instanceof DeletionOutcomeUnknownError) {
        Alert.alert(t('deleteAccount.action'), t('deleteAccount.checking'));
        retrySession();
        return;
      }
      setDeleteErrorKey(getDeleteAccountErrorKey(error));
      // apiFetch already started rebuilding the session, which replaces this screen, so the message
      // cannot stay in the modal.
      if (isStaleJwtError(error)) Alert.alert(t('deleteAccount.action'), t('deleteAccount.failed'));
    },
  });

  const close = () => {
    if (deleteAccountMutation.isPending) return;
    setDeleteConfirmText('');
    setDeletePassword('');
    setDeleteErrorKey(null);
    onClose();
  };

  const isDeleteDisabled =
    deleteAccountMutation.isPending ||
    deleteConfirmText.trim().toUpperCase().replace(/[ȘŞ]/g, 'S') !== t('deleteAccount.confirmWord') ||
    (isPasswordAccount && !deletePassword);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <Text style={styles.title}>{t('deleteAccount.action')}</Text>
            <Text style={styles.warning}>{t('deleteAccount.warning')}</Text>

            <Text style={styles.label}>{t('deleteAccount.typePrompt')}</Text>
            <TextInput
              style={styles.input}
              value={deleteConfirmText}
              onChangeText={setDeleteConfirmText}
              autoCapitalize="characters"
              autoCorrect={false}
              editable={!deleteAccountMutation.isPending}
              accessibilityLabel={t('deleteAccount.typePrompt')}
            />

            {isPasswordAccount ? (
              <>
                <Text style={styles.label}>{t('deleteAccount.passwordPrompt')}</Text>
                <TextInput
                  style={styles.input}
                  value={deletePassword}
                  onChangeText={setDeletePassword}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!deleteAccountMutation.isPending}
                  accessibilityLabel={t('deleteAccount.passwordPrompt')}
                />
              </>
            ) : null}

            {deleteErrorKey ? <Text style={styles.error}>{t(deleteErrorKey)}</Text> : null}

            <TouchableOpacity
              style={[styles.deleteButton, isDeleteDisabled && styles.disabled]}
              onPress={() => deleteAccountMutation.mutate()}
              disabled={isDeleteDisabled}
              accessibilityRole="button"
              accessibilityLabel={t('deleteAccount.action')}
              accessibilityState={{ disabled: isDeleteDisabled }}
            >
              {deleteAccountMutation.isPending ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.deleteButtonText}>{t('deleteAccount.action')}</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={close}
              disabled={deleteAccountMutation.isPending}
              accessibilityRole="button"
              accessibilityLabel={t('common.cancel')}
            >
              <Text style={styles.cancelText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 16,
  },
  card: {
    backgroundColor: '#0F172A',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#374151',
    padding: 16,
    gap: 12,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
  },
  warning: {
    color: '#9CA3AF',
    fontSize: 14,
    lineHeight: 20,
  },
  label: {
    color: '#D1D5DB',
    fontSize: 14,
    fontWeight: '500',
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
  deleteButton: {
    backgroundColor: '#EF4444',
    borderRadius: 12,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: 0.6,
  },
  deleteButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  cancelButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: {
    color: '#FFFFFF',
    fontSize: 16,
  },
});
