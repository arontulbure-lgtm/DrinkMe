import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useMutation } from '@tanstack/react-query';
import { isCurrentAuthUser, useAuth } from '../context/AuthContext';
import { useLocalization } from '../context/LocalizationContext';
import { ApiError, DeletionOutcomeUnknownError, getDeleteAccountErrorKey } from '../lib/api';

const RESEND_COOLDOWN_MS = 60000;
// After a send, reopening the app sends nothing automatically for this long. Resend still works.
const AUTO_SEND_WINDOW_MS = 60 * 60 * 1000;
const SEND_RECORD_STORAGE_KEY = 'drinkme.verifyEmailSend';

// Outside the component: this screen unmounts whenever the session is re-run, and coming back must not
// send a second automatic email or restart the cooldown. AsyncStorage carries it across an app restart.
const sendRecord: { uid: string | null; cooldownUntil: number } = { uid: null, cooldownUntil: 0 };

const secondsLeft = () => Math.max(0, Math.ceil((sendRecord.cooldownUntil - Date.now()) / 1000));

const saveSendRecord = (uid: string, cooldownUntil: number) => {
  AsyncStorage.setItem(SEND_RECORD_STORAGE_KEY, JSON.stringify({ uid, cooldownUntil })).catch(() => undefined);
};

const clearSendRecord = () => {
  sendRecord.uid = null;
  sendRecord.cooldownUntil = 0;
  AsyncStorage.removeItem(SEND_RECORD_STORAGE_KEY).catch(() => undefined);
};

// A missing, unreadable or foreign record counts as no send.
const readStoredCooldown = async (uid: string): Promise<number | null> => {
  try {
    const parsed = JSON.parse((await AsyncStorage.getItem(SEND_RECORD_STORAGE_KEY)) ?? 'null');
    return parsed?.uid === uid && typeof parsed.cooldownUntil === 'number' ? parsed.cooldownUntil : null;
  } catch {
    return null;
  }
};

// Shown when the server refuses a sign-in with email_not_verified, which needs REQUIRE_VERIFIED_EMAIL on.
export default function VerifyEmailScreen() {
  const { user, logout, retrySession, sendVerificationEmail, confirmEmailVerified, deleteUnverifiedAccount } = useAuth();
  const { t } = useLocalization();
  const uid = user?.uid ?? null;
  const [cooldownSeconds, setCooldownSeconds] = useState(secondsLeft);
  const [isSending, setIsSending] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [noticeKey, setNoticeKey] = useState<string | null>(null);
  const [isDeleteModalVisible, setIsDeleteModalVisible] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteErrorKey, setDeleteErrorKey] = useState<string | null>(null);
  // A Google or Apple account has no password to ask for, and proves itself with a fresh token only.
  const isPasswordAccount = user?.providerData.some((provider) => provider.providerId === 'password') === true;

  const send = async () => {
    if (!uid) return;
    // Set before the wait, so a second tap cannot send again.
    sendRecord.cooldownUntil = Date.now() + RESEND_COOLDOWN_MS;
    saveSendRecord(uid, sendRecord.cooldownUntil);
    setCooldownSeconds(secondsLeft());
    setIsSending(true);
    setNoticeKey(null);
    try {
      await sendVerificationEmail();
    } catch (error) {
      if (!isCurrentAuthUser(uid)) return;
      // Only the code: the error object can name the address.
      const code = (error as { code?: unknown } | null)?.code;
      console.warn('Failed to send the verification email:', typeof code === 'string' ? code : 'unknown');
      // Firebase is throttling, so the cooldown stays. Any other failure can be tried again at once.
      if (code !== 'auth/too-many-requests') {
        sendRecord.cooldownUntil = 0;
        AsyncStorage.removeItem(SEND_RECORD_STORAGE_KEY).catch(() => undefined);
        setCooldownSeconds(0);
      }
      setNoticeKey('verifyEmail.sendFailed');
    } finally {
      setIsSending(false);
    }
  };

  useEffect(() => {
    if (!uid || sendRecord.uid === uid) return;
    sendRecord.uid = uid;
    sendRecord.cooldownUntil = 0;
    void (async () => {
      const storedCooldownUntil = await readStoredCooldown(uid);
      if (!isCurrentAuthUser(uid) || sendRecord.uid !== uid) return;
      // Resend was tapped during the read.
      if (sendRecord.cooldownUntil > Date.now()) return;
      if (storedCooldownUntil !== null && Date.now() < storedCooldownUntil + AUTO_SEND_WINDOW_MS) {
        sendRecord.cooldownUntil = storedCooldownUntil;
        setCooldownSeconds(secondsLeft());
        return;
      }
      await send();
    })();
    // Once per account: send changes on every render, and sendRecord is what guards this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  useEffect(() => {
    if (cooldownSeconds === 0) return;
    const timer = setInterval(() => setCooldownSeconds(secondsLeft()), 1000);
    return () => clearInterval(timer);
  }, [cooldownSeconds === 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleConfirm = async () => {
    setIsChecking(true);
    setNoticeKey(null);
    try {
      // When this is true the session re-runs, which replaces this screen.
      const isVerified = await confirmEmailVerified();
      if (!isVerified && isCurrentAuthUser(uid)) setNoticeKey('verifyEmail.notYet');
    } catch (error) {
      if (!isCurrentAuthUser(uid)) return;
      const code = (error as { code?: unknown } | null)?.code;
      console.warn('Failed to check the email status:', typeof code === 'string' ? code : 'unknown');
      setNoticeKey('session.errorBody');
    } finally {
      setIsChecking(false);
    }
  };

  // Stays available during a send or a check, so nothing here can trap the user.
  const handleLogout = async () => {
    setIsLoggingOut(true);
    clearSendRecord();
    try {
      await logout();
    } catch (error) {
      console.error('Failed to log out:', error);
      setIsLoggingOut(false);
    }
  };

  const deleteAccountMutation = useMutation({
    mutationFn: () => deleteUnverifiedAccount(isPasswordAccount ? deletePassword : null),
    onMutate: () => setDeleteErrorKey(null),
    onSuccess: (result) => {
      // Said even if Firebase has already ended the session, because it is about this account.
      Alert.alert(t('deleteAccount.action'), t(result.firebaseDeleted ? 'deleteAccount.done' : 'deleteAccount.partial'));
      clearSendRecord();
      // Never signs out an account that was signed in since.
      if (isCurrentAuthUser(uid)) void logout().catch((error) => console.warn('Failed to sign out:', error));
    },
    onError: (error) => {
      if (!isCurrentAuthUser(uid)) return;
      // It may have worked, so "failed" would be untrue. Sign-in answers 410 if so, which ends in the
      // notice and a sign-out, or brings this screen back if not.
      if (error instanceof DeletionOutcomeUnknownError) {
        Alert.alert(t('deleteAccount.action'), t('deleteAccount.checking'));
        retrySession();
        return;
      }
      const code = error instanceof ApiError ? error.code : undefined;
      // Already deleted: the same sign-in check gives the notice.
      if (code === 'account_deleted') {
        retrySession();
        return;
      }
      setDeleteErrorKey(getDeleteAccountErrorKey(error));
      // Confirmed in the meantime: the session opens, and Edit Profile has the delete action.
      if (code === 'email_already_verified') {
        Alert.alert(t('deleteAccount.action'), t('deleteAccount.failed'));
        retrySession();
      }
    },
  });

  const closeDeleteModal = () => {
    if (deleteAccountMutation.isPending) return;
    setIsDeleteModalVisible(false);
    setDeleteConfirmText('');
    setDeletePassword('');
    setDeleteErrorKey(null);
  };

  const isDeleteDisabled =
    deleteAccountMutation.isPending ||
    deleteConfirmText.trim().toUpperCase().replace(/[ȘŞ]/g, 'S') !== t('deleteAccount.confirmWord') ||
    (isPasswordAccount && !deletePassword);

  const canResend = cooldownSeconds === 0 && !isSending && !isLoggingOut;
  const resendLabel = cooldownSeconds > 0 ? `${t('verifyEmail.resend')} (${cooldownSeconds})` : t('verifyEmail.resend');

  return (
    <SafeAreaView style={styles.container}>
      <Ionicons name="mail-outline" size={48} color="#6B7280" />
      <Text style={styles.title}>{t('verifyEmail.title')}</Text>
      <Text style={styles.body}>{t('verifyEmail.body', { email: user?.email ?? '' })}</Text>
      {noticeKey ? (
        <Text style={styles.notice} accessibilityLiveRegion="polite">{t(noticeKey)}</Text>
      ) : null}
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.confirmButton}
          onPress={handleConfirm}
          disabled={isChecking || isLoggingOut}
          accessibilityRole="button"
          accessibilityLabel={t('verifyEmail.confirmed')}
        >
          {isChecking ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.buttonText}>{t('verifyEmail.confirmed')}</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.secondaryButton, !canResend && styles.buttonDisabled]}
          onPress={send}
          disabled={!canResend}
          accessibilityRole="button"
          accessibilityLabel={t('verifyEmail.resend')}
          accessibilityState={{ disabled: !canResend }}
        >
          {isSending ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.buttonText}>{resendLabel}</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={handleLogout}
          disabled={isLoggingOut}
          accessibilityRole="button"
          accessibilityLabel={t('profile.logout')}
        >
          {isLoggingOut ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.buttonText}>{t('profile.logout')}</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.textButton}
          onPress={() => setIsDeleteModalVisible(true)}
          disabled={isLoggingOut}
          accessibilityRole="button"
          accessibilityLabel={t('deleteAccount.action')}
        >
          <Text style={styles.deleteText}>{t('deleteAccount.action')}</Text>
        </TouchableOpacity>
      </View>

      <Modal visible={isDeleteModalVisible} transparent animationType="fade" onRequestClose={closeDeleteModal}>
        <KeyboardAvoidingView behavior="padding" style={styles.deleteBackdrop}>
          <ScrollView contentContainerStyle={styles.deleteScrollContent} keyboardShouldPersistTaps="handled">
            <View style={styles.deleteCard}>
              <Text style={styles.title}>{t('deleteAccount.action')}</Text>
              <Text style={styles.body}>{t('deleteAccount.warning')}</Text>

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

              {deleteErrorKey ? <Text style={styles.deleteError}>{t(deleteErrorKey)}</Text> : null}

              <TouchableOpacity
                style={[styles.deleteButton, isDeleteDisabled && styles.buttonDisabled]}
                onPress={() => deleteAccountMutation.mutate()}
                disabled={isDeleteDisabled}
                accessibilityRole="button"
                accessibilityLabel={t('deleteAccount.action')}
                accessibilityState={{ disabled: isDeleteDisabled }}
              >
                {deleteAccountMutation.isPending ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.buttonText}>{t('deleteAccount.action')}</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.textButton}
                onPress={closeDeleteModal}
                disabled={deleteAccountMutation.isPending}
                accessibilityRole="button"
                accessibilityLabel={t('common.cancel')}
              >
                <Text style={styles.buttonText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 16,
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
    textAlign: 'center',
    lineHeight: 20,
  },
  notice: {
    fontSize: 14,
    color: '#FFD700',
    textAlign: 'center',
    lineHeight: 20,
  },
  actions: {
    alignSelf: 'stretch',
    gap: 12,
    marginTop: 8,
  },
  confirmButton: {
    backgroundColor: '#8B5FBF',
    minHeight: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 12,
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
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  textButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteText: {
    color: '#EF4444',
    fontSize: 16,
  },
  deleteBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
  },
  deleteScrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 20,
  },
  deleteCard: {
    backgroundColor: '#0F172A',
    borderRadius: 12,
    padding: 20,
    gap: 12,
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
  deleteError: {
    color: '#EF4444',
    fontSize: 14,
    textAlign: 'center',
  },
  deleteButton: {
    backgroundColor: '#EF4444',
    minHeight: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
  },
});
