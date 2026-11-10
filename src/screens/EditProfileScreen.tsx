import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert, ScrollView, Modal, KeyboardAvoidingView, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isCurrentAuthUser, useAuth } from '../context/AuthContext';
import { DeletionOutcomeUnknownError, apiFetch, getDeleteAccountErrorKey, isStaleJwtError } from '../lib/api';
import { invalidateAuthorQueries } from '../lib/drinkCache';
import { BaseUser } from '../types/api';
import { useLocalization } from '../context/LocalizationContext';

interface Props {
  navigation: { goBack: () => void; navigate: (screen: string) => void };
}

export default function EditProfileScreen({ navigation }: Props) {
  const { profile, serverUserId, setProfile, user, logout, deleteAccount, retrySession } = useAuth();
  const queryClient = useQueryClient();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [city, setCity] = useState('');
  const [bio, setBio] = useState('');
  const { t } = useLocalization();
  const [isDeleteModalVisible, setIsDeleteModalVisible] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteErrorKey, setDeleteErrorKey] = useState<string | null>(null);
  // A Google or Apple account has no password to ask for, and proves itself with a fresh token only.
  const isPasswordAccount = user?.providerData.some((provider) => provider.providerId === 'password') === true;

  const { data: profileData, isLoading, isError } = useQuery<BaseUser>({
    queryKey: ['users.detail', serverUserId],
    // profile is set after the token exchange, so the owner never caches the public view.
    enabled: !!serverUserId && !!profile,
    queryFn: () => apiFetch<BaseUser>(`/api/users/${serverUserId}`),
  });

  useEffect(() => {
    if (profileData) {
      setFirstName(profileData.firstName || '');
      setLastName(profileData.lastName || '');
      setCity(profileData.city || '');
      setBio(profileData.bio || '');
    }
  }, [profileData]);

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!serverUserId) return;
      return apiFetch<BaseUser>(`/api/users/${serverUserId}`, {
        method: 'PUT',
        body: JSON.stringify({ firstName, lastName, city, bio }),
      });
    },
    onSuccess: (updated) => {
      if (!updated || !isCurrentAuthUser(serverUserId)) return;
      setProfile(updated);
      queryClient.setQueryData<BaseUser>(['users.detail', serverUserId], updated);
      invalidateAuthorQueries(queryClient);
      Alert.alert(t('editProfile.title'), t('editProfile.success'));
      navigation.goBack();
    },
    onError: () => {
      Alert.alert(t('editProfile.title'), t('editProfile.error'));
    },
  });

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
      // The retry replaces this screen, so the message cannot stay in the modal.
      if (isStaleJwtError(error)) {
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

  // Saving before the profile has loaded would send an empty form and wipe the stored fields.
  const isSaveDisabled = updateMutation.isPending || isLoading || !profileData;

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={navigation.goBack} style={styles.headerButton}>
          <Ionicons name="chevron-back" size={22} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('editProfile.title')}</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.inputGroup}>
          <Text style={styles.label}>{t('editProfile.firstName')}</Text>
          <TextInput
            style={styles.input}
            placeholder={t('editProfile.firstName')}
            placeholderTextColor="#6B7280"
            value={firstName}
            onChangeText={setFirstName}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>{t('editProfile.lastName')}</Text>
          <TextInput
            style={styles.input}
            placeholder={t('editProfile.lastName')}
            placeholderTextColor="#6B7280"
            value={lastName}
            onChangeText={setLastName}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>{t('editProfile.city')}</Text>
          <TextInput
            style={styles.input}
            placeholder="București"
            placeholderTextColor="#6B7280"
            value={city}
            onChangeText={setCity}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>{t('editProfile.bio')}</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            placeholder={t('editProfile.bio')}
            placeholderTextColor="#6B7280"
            value={bio}
            onChangeText={setBio}
            multiline
          />
        </View>

        {isError && !profileData ? <Text style={styles.loadError}>{t('profile.loadError')}</Text> : null}

        <TouchableOpacity
          style={[styles.saveButton, isSaveDisabled && styles.saveButtonDisabled]}
          onPress={() => updateMutation.mutate()}
          disabled={isSaveDisabled}
        >
          <Text style={styles.saveButtonText}>
            {updateMutation.isPending ? t('editProfile.saving') : t('editProfile.save')}
          </Text>
        </TouchableOpacity>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>{t('block.accountSection')}</Text>
          <TouchableOpacity
            style={styles.accountRow}
            onPress={() => navigation.navigate('BlockedUsers')}
            accessibilityRole="button"
            accessibilityLabel={t('block.listTitle')}
          >
            <Text style={styles.accountRowText}>{t('block.listTitle')}</Text>
            <Ionicons name="chevron-forward" size={18} color="#6B7280" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.accountRow}
            onPress={() => setIsDeleteModalVisible(true)}
            accessibilityRole="button"
            accessibilityLabel={t('deleteAccount.action')}
          >
            <Text style={styles.deleteRowText}>{t('deleteAccount.action')}</Text>
            <Ionicons name="chevron-forward" size={18} color="#EF4444" />
          </TouchableOpacity>
        </View>
      </ScrollView>

      <Modal visible={isDeleteModalVisible} transparent animationType="fade" onRequestClose={closeDeleteModal}>
        <KeyboardAvoidingView behavior="padding" style={styles.deleteBackdrop}>
          <ScrollView contentContainerStyle={styles.deleteScrollContent} keyboardShouldPersistTaps="handled">
            <View style={styles.deleteCard}>
              <Text style={styles.headerTitle}>{t('deleteAccount.action')}</Text>
              <Text style={styles.deleteWarning}>{t('deleteAccount.warning')}</Text>

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

              {deleteErrorKey ? <Text style={styles.loadError}>{t(deleteErrorKey)}</Text> : null}

              <TouchableOpacity
                style={[styles.deleteButton, isDeleteDisabled && styles.saveButtonDisabled]}
                onPress={() => deleteAccountMutation.mutate()}
                disabled={isDeleteDisabled}
                accessibilityRole="button"
                accessibilityLabel={t('deleteAccount.action')}
                accessibilityState={{ disabled: isDeleteDisabled }}
              >
                {deleteAccountMutation.isPending ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.saveButtonText}>{t('deleteAccount.action')}</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.deleteCancelButton}
                onPress={closeDeleteModal}
                disabled={deleteAccountMutation.isPending}
                accessibilityRole="button"
                accessibilityLabel={t('common.cancel')}
              >
                <Text style={styles.accountRowText}>{t('common.cancel')}</Text>
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
    backgroundColor: '#1F2937',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
  },
  content: {
    padding: 16,
    gap: 20,
  },
  inputGroup: {
    gap: 8,
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
  textArea: {
    height: 120,
    textAlignVertical: 'top',
  },
  saveButton: {
    backgroundColor: '#8B5FBF',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  saveButtonDisabled: {
    opacity: 0.6,
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  loadError: {
    color: '#EF4444',
    fontSize: 14,
    textAlign: 'center',
  },
  accountRow: {
    backgroundColor: '#1F2937',
    borderRadius: 12,
    paddingHorizontal: 16,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  accountRowText: {
    color: '#FFFFFF',
    fontSize: 16,
  },
  deleteRowText: {
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
    padding: 16,
  },
  deleteCard: {
    backgroundColor: '#0F172A',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#374151',
    padding: 16,
    gap: 12,
  },
  deleteWarning: {
    color: '#9CA3AF',
    fontSize: 14,
    lineHeight: 20,
  },
  deleteButton: {
    backgroundColor: '#EF4444',
    borderRadius: 12,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteCancelButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
