import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isCurrentAuthUser, useAuth } from '../context/AuthContext';
import { ACCOUNT_SUSPENDED_ERROR_KEY, apiFetch, isAccountSuspendedError } from '../lib/api';
import { invalidateAuthorQueries } from '../lib/drinkCache';
import { useRefreshIfSuspended } from '../lib/useRefreshIfSuspended';
import { BaseUser } from '../types/api';
import { useLocalization } from '../context/LocalizationContext';
import DeleteAccountModal from '../components/DeleteAccountModal';
import { RootStackScreenProps } from '../navigation/types';

type Props = RootStackScreenProps<'EditProfile'>;

export default function EditProfileScreen({ navigation }: Props) {
  const { profile, serverUserId, setProfile } = useAuth();
  const queryClient = useQueryClient();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [city, setCity] = useState('');
  const [bio, setBio] = useState('');
  const { t } = useLocalization();
  const refreshIfSuspended = useRefreshIfSuspended();
  const [isDeleteModalVisible, setIsDeleteModalVisible] = useState(false);
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
    onError: (error) => {
      refreshIfSuspended(error);
      Alert.alert(t('editProfile.title'), t(isAccountSuspendedError(error) ? ACCOUNT_SUSPENDED_ERROR_KEY : 'editProfile.error'));
    },
  });

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

      <DeleteAccountModal visible={isDeleteModalVisible} onClose={() => setIsDeleteModalVisible(false)} />
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
});
