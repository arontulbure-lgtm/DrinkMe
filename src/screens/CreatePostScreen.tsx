import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ScrollView,
  Image,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isCurrentAuthUser, useAuth } from '../context/AuthContext';
import { ACCOUNT_SUSPENDED_ERROR_KEY, apiFetch, ApiError, isAccountSuspendedError } from '../lib/api';
import { prependDrink } from '../lib/drinkCache';
import { useRefreshIfSuspended } from '../lib/useRefreshIfSuspended';
import { useLocalization } from '../context/LocalizationContext';
import { Drink } from '../types/api';
import LocationPickerModal from '../components/LocationPickerModal';
import { RootStackScreenProps } from '../navigation/types';

interface SelectedImage {
  uri: string;
  base64: string;
}

interface CreateDrinkPayload {
  name: string;
  description: string;
  rating: number;
  location: string | null;
  isAlcoholic: boolean;
  imageData: string;
}

export default function CreatePostScreen({ navigation }: RootStackScreenProps<'CreatePost'>) {
  const [drinkName, setDrinkName] = useState('');
  const [description, setDescription] = useState('');
  const [rating, setRating] = useState(5);
  const [location, setLocation] = useState('');
  const [photo, setPhoto] = useState<SelectedImage | null>(null);
  const [isLocationPickerVisible, setLocationPickerVisible] = useState(false);
  const { getJwtToken, profile, serverUserId, user: firebaseUser, refreshProfile } = useAuth();
  const isAgeConfirmed = profile?.ageConfirmed === true;
  const [isAlcoholic, setIsAlcoholic] = useState(isAgeConfirmed);
  const queryClient = useQueryClient();
  const { t } = useLocalization();
  const refreshIfSuspended = useRefreshIfSuspended();
  const insets = useSafeAreaInsets();
  const extraScrollInset = useMemo(() => insets.bottom + 120, [insets.bottom]);

  const currentUser = useMemo(() => {
    if (profile) return profile;
    if (firebaseUser && serverUserId) {
      const displayName = firebaseUser.displayName?.trim() ?? '';
      const parts = displayName.split(' ');
      return {
        id: serverUserId,
        email: firebaseUser.email || `user+${serverUserId}@drinkme.app`,
        firstName: parts[0] || undefined,
        lastName: parts.slice(1).join(' ') || undefined,
        avatar: firebaseUser.photoURL || null,
      };
    }
    return null;
  }, [firebaseUser, profile, serverUserId]);

  const createPostMutation = useMutation<Drink, unknown, CreateDrinkPayload>({
    mutationFn: async (payload) => {
      const token = await getJwtToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      return apiFetch<Drink>('/api/drinks', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    },
    onSuccess: async (createdDrink) => {
      if (!isCurrentAuthUser(serverUserId)) return;

      if (!profile && refreshProfile) {
        await refreshProfile();
      }

      const author = currentUser ?? createdDrink.user;
      const hydratedDrink: Drink = {
        ...createdDrink,
        user: author ?? createdDrink.user,
      };

      // refreshProfile above can outlive a logout.
      if (serverUserId && isCurrentAuthUser(serverUserId)) {
        prependDrink(queryClient, hydratedDrink, serverUserId);
      }

      setDrinkName('');
      setDescription('');
      setLocation('');
      setRating(5);
      setIsAlcoholic(isAgeConfirmed);
      setPhoto(null);

      Alert.alert(t('createPost.title'), t('createPost.success'), [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    },
    onError: (error) => {
      const status = error instanceof ApiError ? error.status : undefined;
      const code = error instanceof ApiError ? error.code : undefined;
      let message = t('createPost.error');
      if (status === 413) message = t('createPost.imageTooLarge');
      if (status === 400) message = t('createPost.imageInvalidFormat');
      if (status === 429) message = t(code === 'daily_post_limit' ? 'createPost.dailyLimit' : 'common.tooManyRequests');
      if (status === 507) message = t(code === 'user_image_quota' ? 'common.imageQuotaReached' : 'common.serviceUnavailable');
      if (code === 'age_required') message = t('ageGate.required');
      if (isAccountSuspendedError(error)) message = t(ACCOUNT_SUSPENDED_ERROR_KEY);
      refreshIfSuspended(error);
      Alert.alert(t('createPost.title'), message);
    },
  });

  const handlePickPhoto = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(t('createPost.title'), t('scanner.permissionLibrary'));
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: true,
      quality: 0.8,
      base64: true,
      mediaTypes: 'images',
    });

    if (!result.canceled && result.assets?.[0]?.uri && result.assets[0].base64) {
      setPhoto({ uri: result.assets[0].uri, base64: result.assets[0].base64 });
    }
  };

  const handleTakePhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(t('createPost.title'), t('scanner.permissionCamera'));
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      quality: 0.8,
      base64: true,
      mediaTypes: 'images',
    });

    if (!result.canceled && result.assets?.[0]?.uri && result.assets[0].base64) {
      setPhoto({ uri: result.assets[0].uri, base64: result.assets[0].base64 });
    }
  };

  const handleCreatePost = () => {
    if (!drinkName.trim() || !description.trim()) {
      Alert.alert(t('createPost.title'), t('createPost.fieldsError'));
      return;
    }

    if (!photo?.base64) {
      Alert.alert(t('createPost.title'), t('createPost.photoRequired'));
      return;
    }

    createPostMutation.mutate({
      name: drinkName.trim(),
      description: description.trim(),
      rating,
      location: location.trim() || null,
      isAlcoholic,
      imageData: photo.base64,
    });
  };

  const renderStarRating = () => (
    <View style={styles.ratingContainer}>
      <Text style={styles.ratingLabel}>{t('createPost.rating')}</Text>
      <View style={styles.starsContainer}>
        {[1, 2, 3, 4, 5].map((star) => (
          <TouchableOpacity key={star} onPress={() => setRating(star)} style={styles.starButton}>
            <Ionicons
              name={star <= rating ? 'star' : 'star-outline'}
              size={32}
              color={star <= rating ? '#FFD700' : '#6B7280'}
            />
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.ratingText}>{`${rating}/5`}</Text>
    </View>
  );

  return (
    <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.container}>
      <KeyboardAvoidingView
        style={styles.keyboardAvoider}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
      >
        <View style={{ flex: 1 }}>
          <View style={styles.header}>
            <TouchableOpacity onPress={() => navigation.goBack()}>
              <Text style={styles.cancelButton}>{t('createPost.cancel')}</Text>
            </TouchableOpacity>
            <Text style={styles.headerTitle}>{t('createPost.title')}</Text>
            <TouchableOpacity onPress={handleCreatePost} disabled={createPostMutation.isPending}>
              <Text
                style={[styles.postButton, createPostMutation.isPending && styles.postButtonDisabled]}
              >
                {createPostMutation.isPending ? t('createPost.submitting') : t('createPost.submit')}
              </Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.content}
            contentContainerStyle={styles.contentContainer}
            keyboardShouldPersistTaps="handled"
            contentInset={{ bottom: extraScrollInset }}
            scrollIndicatorInsets={{ bottom: extraScrollInset }}
          >
            <View style={styles.section}>
              <Text style={styles.label}>{t('createPost.nameLabel')}</Text>
              <TextInput
                style={styles.input}
                placeholder={t('createPost.namePlaceholder')}
                placeholderTextColor="#6B7280"
                value={drinkName}
                onChangeText={setDrinkName}
              />
            </View>

            <View style={styles.section}>
              <Text style={styles.label}>{t('createPost.descriptionLabel')}</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                placeholder={t('createPost.descriptionPlaceholder')}
                placeholderTextColor="#6B7280"
                value={description}
                onChangeText={setDescription}
                multiline
                numberOfLines={4}
                textAlignVertical="top"
              />
              <Text style={styles.helpText}>{t('createPost.helperText')}</Text>
            </View>

            {renderStarRating()}

            {/* Alcoholic toggle */}
            <View style={styles.toggleSection}>
              <Text style={styles.label}>Type</Text>
              <View style={styles.toggleRow}>
                <TouchableOpacity
                  style={[styles.toggleOption, isAlcoholic && styles.toggleOptionActive, !isAgeConfirmed && styles.toggleOptionLocked]}
                  onPress={() => setIsAlcoholic(true)}
                  disabled={!isAgeConfirmed}
                  accessibilityState={{ disabled: !isAgeConfirmed, selected: isAlcoholic }}
                >
                  <Ionicons name="wine" size={16} color={isAlcoholic ? '#FFFFFF' : '#6B7280'} />
                  <Text style={[styles.toggleOptionText, isAlcoholic && styles.toggleOptionTextActive]}>
                    Alcoholic
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.toggleOption, !isAlcoholic && styles.toggleOptionActive]}
                  onPress={() => setIsAlcoholic(false)}
                >
                  <Ionicons name="leaf" size={16} color={!isAlcoholic ? '#FFFFFF' : '#6B7280'} />
                  <Text style={[styles.toggleOptionText, !isAlcoholic && styles.toggleOptionTextActive]}>
                    Non-alcoholic
                  </Text>
                </TouchableOpacity>
              </View>
              {/* Defence in depth: the hard age gate means an unconfirmed user never reaches this screen. */}
              {!isAgeConfirmed && <Text style={styles.toggleHint}>{t('ageGate.banner')}</Text>}
            </View>

            <View style={styles.photoSection}>
              <TouchableOpacity style={styles.photoButton} onPress={handlePickPhoto}>
                <Ionicons name="image-outline" size={20} color="#8B5FBF" />
                <Text style={styles.photoButtonText}>
                  {photo ? t('createPost.changePhoto') : t('createPost.addPhoto')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.photoButton} onPress={handleTakePhoto}>
                <Ionicons name="camera-outline" size={20} color="#8B5FBF" />
                <Text style={styles.photoButtonText}>{t('scanner.takePhoto')}</Text>
              </TouchableOpacity>
              {photo && <Image source={{ uri: photo.uri }} style={styles.preview} />}
            </View>

            <View style={styles.section}>
              <Text style={styles.label}>{t('createPost.location')}</Text>
              <TouchableOpacity
                style={styles.locationSelector}
                onPress={() => setLocationPickerVisible(true)}
              >
                <Ionicons name="location-outline" size={20} color="#8B5FBF" />
                <Text style={styles.locationSelectorText}>
                  {location || t('createPost.locationPlaceholder')}
                </Text>
                <Ionicons name="chevron-forward" size={18} color="#6B7280" />
              </TouchableOpacity>
            </View>

            <View style={styles.bottomActions}>
              <TouchableOpacity style={styles.actionButton} onPress={() => navigation.navigate('Main', { screen: 'Scanner' })}>
                <Ionicons name="scan-outline" size={22} color="#8B5FBF" />
                <Text style={styles.actionText}>{t('scanner.title')}</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>

      <LocationPickerModal
        visible={isLocationPickerVisible}
        onClose={() => setLocationPickerVisible(false)}
        initialValue={location}
        onSelect={({ description }) => setLocation(description)}
      />
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
  cancelButton: {
    fontSize: 16,
    color: '#EF4444',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  postButton: {
    fontSize: 16,
    fontWeight: '600',
    color: '#8B5FBF',
  },
  postButtonDisabled: {
    opacity: 0.5,
  },
  keyboardAvoider: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  section: {
    marginBottom: 24,
  },
  label: {
    fontSize: 16,
    fontWeight: '500',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#1F2937',
    borderRadius: 8,
    padding: 16,
    color: '#FFFFFF',
    fontSize: 16,
  },
  textArea: {
    height: 120,
    textAlignVertical: 'top',
  },
  ratingContainer: {
    marginBottom: 24,
  },
  ratingLabel: {
    fontSize: 16,
    fontWeight: '500',
    color: '#FFFFFF',
    marginBottom: 12,
  },
  starsContainer: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  starButton: {
    padding: 4,
  },
  ratingText: {
    fontSize: 14,
    color: '#9CA3AF',
  },
  helpText: {
    fontSize: 14,
    color: '#9CA3AF',
    lineHeight: 20,
    fontStyle: 'italic',
  },
  toggleSection: {
    marginBottom: 24,
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 8,
  },
  toggleOption: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: 8,
    backgroundColor: '#1F2937',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  toggleOptionActive: {
    backgroundColor: '#8B5FBF',
    borderColor: '#8B5FBF',
  },
  toggleHint: {
    fontSize: 13,
    color: '#9CA3AF',
    marginTop: 8,
  },
  toggleOptionLocked: {
    opacity: 0.5,
  },
  toggleOptionText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#6B7280',
  },
  toggleOptionTextActive: {
    color: '#FFFFFF',
  },
  photoSection: {
    marginBottom: 24,
    gap: 12,
  },
  photoButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#1F2937',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  photoButtonText: {
    color: '#8B5FBF',
    fontSize: 16,
    fontWeight: '500',
  },
  preview: {
    width: '100%',
    height: 220,
    borderRadius: 12,
    backgroundColor: '#111827',
  },
  bottomActions: {
    paddingVertical: 24,
    alignItems: 'flex-start',
  },
  actionButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  actionText: {
    fontSize: 12,
    color: '#8B5FBF',
    marginTop: 4,
    textAlign: 'center',
  },
  locationSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#1F2937',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
  },
  locationSelectorText: {
    color: '#E5E7EB',
    flex: 1,
    fontSize: 14,
  },
});
