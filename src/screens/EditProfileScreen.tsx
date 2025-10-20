import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../lib/api';
import { BaseUser } from '../types/api';
import { useLocalization } from '../context/LocalizationContext';

interface Props {
  navigation: { goBack: () => void };
}

export default function EditProfileScreen({ navigation }: Props) {
  const { serverUserId } = useAuth();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [city, setCity] = useState('');
  const [bio, setBio] = useState('');
  const { t } = useLocalization();

  const { data: profileData, isLoading } = useQuery<BaseUser>({
    queryKey: ['users.detail', serverUserId],
    enabled: !!serverUserId,
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
    onSuccess: () => {
      Alert.alert(t('editProfile.title'), t('editProfile.success'));
      navigation.goBack();
    },
    onError: () => {
      Alert.alert(t('editProfile.title'), t('editProfile.error'));
    },
  });

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

        <TouchableOpacity
          style={[styles.saveButton, (updateMutation.isPending || isLoading) && styles.saveButtonDisabled]}
          onPress={() => updateMutation.mutate()}
          disabled={updateMutation.isPending || isLoading}
        >
          <Text style={styles.saveButtonText}>
            {updateMutation.isPending ? t('editProfile.saving') : t('editProfile.save')}
          </Text>
        </TouchableOpacity>
      </ScrollView>
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
});
