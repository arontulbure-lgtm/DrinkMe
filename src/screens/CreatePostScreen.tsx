import React, { useEffect, useMemo, useState } from 'react';
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isCurrentAuthUser, useAuth } from '../context/AuthContext';
import {
  ACCOUNT_SUSPENDED_ERROR_KEY,
  apiFetch,
  ApiError,
  getEditPostErrorKey,
  getImageSource,
  isAccountSuspendedError,
  isNotFoundError,
  retryUnlessNotFound,
} from '../lib/api';
import {
  findCachedDrink,
  prependDrink,
  removeDrinkFromCaches,
  trimAndInvalidate,
  updateDrinkInCaches,
} from '../lib/drinkCache';
import { useRefreshIfSuspended } from '../lib/useRefreshIfSuspended';
import { useLocalization } from '../context/LocalizationContext';
import {
  ALCOHOLIC_DRINK_CATEGORIES,
  CreateDrinkRequest,
  Drink,
  DrinkCategory,
  isDrinkCategory,
  NON_ALCOHOLIC_DRINK_CATEGORIES,
  UpdateDrinkRequest,
} from '../types/api';
import LocationPickerModal from '../components/LocationPickerModal';
import ListLoadState from '../components/ListLoadState';
import { RootStackScreenProps } from '../navigation/types';

interface SelectedImage {
  uri: string;
  base64: string;
}

interface EditPostVariables {
  drinkId: number;
  payload: UpdateDrinkRequest;
}

// The post's stored category, or null. A post stores it as tags: [category]; older posts have none.
const getStoredCategory = (drink: Drink): DrinkCategory | null => drink.tags?.find(isDrinkCategory) ?? null;

// The category the form starts with: only one that matches the post's flag can be shown as selected.
// A stored category that does not match (an inconsistent older record) starts as none, so saving any
// change also sends category null and clears it: that is intended.
const getInitialCategory = (drink: Drink): DrinkCategory | null => {
  const stored = getStoredCategory(drink);
  if (!stored) return null;
  const isAlcoholicCategory = (ALCOHOLIC_DRINK_CATEGORIES as readonly string[]).includes(stored);
  return isAlcoholicCategory === (drink.isAlcoholic !== false) ? stored : null;
};

interface EditFormValues {
  drinkName: string;
  description: string;
  rating: number;
  location: string;
  isAlcoholic: boolean;
  category: DrinkCategory | null;
}

// Only the fields that differ from the post as loaded, so a missing field means unchanged on the server.
const buildEditPayload = (original: Drink, form: EditFormValues): UpdateDrinkRequest => {
  const payload: UpdateDrinkRequest = {};
  const nextName = form.drinkName.trim();
  const nextDescription = form.description.trim();
  const nextLocation = form.location.trim() || null;
  if (nextName !== original.name) payload.name = nextName;
  if (nextDescription !== original.description) payload.description = nextDescription;
  if (form.rating !== original.rating) payload.rating = form.rating;
  if (nextLocation !== (original.location || null)) payload.location = nextLocation;
  if (form.isAlcoholic !== (original.isAlcoholic !== false)) payload.isAlcoholic = form.isAlcoholic;
  // A flip of the toggle clears the category, so a stored category of the other side is sent as null.
  if (form.category !== getStoredCategory(original)) payload.category = form.category;
  return payload;
};

export default function CreatePostScreen({ navigation, route }: RootStackScreenProps<'CreatePost'>) {
  const queryClient = useQueryClient();
  // Edit mode (Task F): the owner changes an existing post. The image cannot be changed.
  const editDrinkId = route.params?.drinkId;
  const isEditMode = editDrinkId !== undefined;
  // A cached copy fills the form at once; the post is still fetched below, so a stale copy is refreshed.
  const [cachedEditDrink] = useState(() => (
    editDrinkId !== undefined ? findCachedDrink(queryClient, editDrinkId) : undefined
  ));
  // The post as it was when the form was filled: the edit sends only the fields that differ from it.
  const [originalDrink, setOriginalDrink] = useState<Drink | null>(cachedEditDrink ?? null);
  const [drinkName, setDrinkName] = useState(cachedEditDrink?.name ?? '');
  const [description, setDescription] = useState(cachedEditDrink?.description ?? '');
  const [rating, setRating] = useState(cachedEditDrink?.rating ?? 5);
  const [location, setLocation] = useState(cachedEditDrink?.location ?? '');
  const [photo, setPhoto] = useState<SelectedImage | null>(null);
  const [isLocationPickerVisible, setLocationPickerVisible] = useState(false);
  const { getJwtToken, profile, serverUserId, user: firebaseUser, refreshProfile } = useAuth();
  const isAgeConfirmed = profile?.ageConfirmed === true;
  const [isAlcoholic, setIsAlcoholic] = useState(
    cachedEditDrink ? cachedEditDrink.isAlcoholic !== false : isAgeConfirmed
  );
  // Optional, single choice, and always one of the categories that match the Alcoholic toggle.
  const [category, setCategory] = useState<DrinkCategory | null>(
    cachedEditDrink ? getInitialCategory(cachedEditDrink) : null
  );
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

  const editDrinkQuery = useQuery<Drink>({
    queryKey: ['drinks.detail', editDrinkId],
    queryFn: () => apiFetch<Drink>(`/api/drinks/${editDrinkId}`),
    enabled: isEditMode,
    retry: retryUnlessNotFound,
  });
  const fetchedEditDrink = editDrinkQuery.data;
  const formValues: EditFormValues = { drinkName, description, rating, location, isAlcoholic, category };
  const isFormUnchanged = !originalDrink || Object.keys(buildEditPayload(originalDrink, formValues)).length === 0;

  // Fills the form from the fetched post: the first time, and again when a fresher copy arrives while the
  // user has not changed anything yet. Once they have, the form and the post it is compared with stay.
  useEffect(() => {
    if (!fetchedEditDrink || fetchedEditDrink === originalDrink) return;
    if (originalDrink && !isFormUnchanged) return;
    setOriginalDrink(fetchedEditDrink);
    setDrinkName(fetchedEditDrink.name);
    setDescription(fetchedEditDrink.description);
    setRating(fetchedEditDrink.rating);
    setLocation(fetchedEditDrink.location ?? '');
    setIsAlcoholic(fetchedEditDrink.isAlcoholic !== false);
    setCategory(getInitialCategory(fetchedEditDrink));
  }, [fetchedEditDrink, originalDrink, isFormUnchanged]);

  const isOwnPost = !!originalDrink && originalDrink.userId === serverUserId;
  const isEditFormReady = isEditMode && isOwnPost;

  const editPostMutation = useMutation<Drink, unknown, EditPostVariables>({
    mutationFn: ({ drinkId, payload }) => apiFetch<Drink>(`/api/drinks/${drinkId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
    onSuccess: (updatedDrink, { drinkId }) => {
      if (!isCurrentAuthUser(serverUserId)) return;
      updateDrinkInCaches(queryClient, drinkId, (existing) => ({ ...existing, ...updatedDrink }));
      // Search results may no longer match the new text. Explore's category lists (drinks.all, discover
      // scope) never hold the user's own posts, so they need nothing.
      trimAndInvalidate(queryClient, { queryKey: ['drinks.search'] });
      setOriginalDrink(updatedDrink);
      Alert.alert(t('editPost.title'), t('editPost.success'), [
        { text: t('common.ok'), onPress: () => navigation.goBack() },
      ]);
    },
    // The form keeps what the user typed on every error, so a retry (after going back online) resends it.
    onError: (error, { drinkId }) => {
      refreshIfSuspended(error);
      if (isNotFoundError(error)) {
        if (isCurrentAuthUser(serverUserId)) removeDrinkFromCaches(queryClient, drinkId);
        Alert.alert(t('editPost.title'), t('post.notFound'), [
          { text: t('common.ok'), onPress: () => navigation.goBack() },
        ]);
        return;
      }
      if (error instanceof ApiError && error.code === 'hidden_pending_review' && isCurrentAuthUser(serverUserId)) {
        updateDrinkInCaches(queryClient, drinkId, (existing) => ({ ...existing, hiddenPendingReview: true }));
      }
      Alert.alert(t('editPost.title'), t(getEditPostErrorKey(error)));
    },
  });

  const createPostMutation = useMutation<Drink, unknown, CreateDrinkRequest>({
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
      setCategory(null);
      setPhoto(null);

      Alert.alert(t('createPost.title'), t('createPost.success'), [
        { text: t('common.ok'), onPress: () => navigation.goBack() },
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

  // The server refuses a category that does not match the toggle, so a flip clears the choice.
  const selectAlcoholic = (value: boolean) => {
    if (value === isAlcoholic) return;
    setIsAlcoholic(value);
    setCategory(null);
  };

  const visibleCategories: readonly DrinkCategory[] = isAlcoholic
    ? ALCOHOLIC_DRINK_CATEGORIES
    : NON_ALCOHOLIC_DRINK_CATEGORIES;

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
      Alert.alert(isEditMode ? t('editPost.title') : t('createPost.title'), t('createPost.fieldsError'));
      return;
    }

    if (isEditMode) {
      if (!originalDrink || !isOwnPost || editDrinkId === undefined) return;
      const payload = buildEditPayload(originalDrink, formValues);
      if (Object.keys(payload).length === 0) {
        navigation.goBack();
        return;
      }
      editPostMutation.mutate({ drinkId: editDrinkId, payload });
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
      ...(category && { category }),
    });
  };

  const isSubmitPending = createPostMutation.isPending || editPostMutation.isPending;
  const isSubmitDisabled = isSubmitPending || (isEditMode && !isEditFormReady);

  const renderStarRating = () => (
    <View style={styles.ratingContainer}>
      <Text style={styles.ratingLabel}>{t('createPost.rating')}</Text>
      <View style={styles.starsContainer}>
        {[1, 2, 3, 4, 5].map((star) => (
          <TouchableOpacity
            key={star}
            onPress={() => setRating(star)}
            style={styles.starButton}
            hitSlop={2}
            accessibilityRole="button"
            accessibilityLabel={t('createPost.rateStars', { count: star })}
            accessibilityState={{ selected: star === rating }}
          >
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
            <Text style={styles.headerTitle}>{isEditMode ? t('editPost.title') : t('createPost.title')}</Text>
            <TouchableOpacity
              onPress={handleCreatePost}
              disabled={isSubmitDisabled}
              accessibilityRole="button"
              accessibilityState={{ disabled: isSubmitDisabled }}
            >
              <Text
                style={[styles.postButton, isSubmitDisabled && styles.postButtonDisabled]}
              >
                {isEditMode
                  ? (editPostMutation.isPending ? t('editPost.submitting') : t('editPost.submit'))
                  : (createPostMutation.isPending ? t('createPost.submitting') : t('createPost.submit'))}
              </Text>
            </TouchableOpacity>
          </View>

          {isEditMode && !isEditFormReady ? (
            originalDrink ? (
              <View style={styles.editStateContainer}>
                <Ionicons name="lock-closed-outline" size={32} color="#6B7280" />
                <Text style={styles.editStateText}>{t('editPost.notOwner')}</Text>
              </View>
            ) : isNotFoundError(editDrinkQuery.error) ? (
              <View style={styles.editStateContainer}>
                <Ionicons name="alert-circle-outline" size={32} color="#6B7280" />
                <Text style={styles.editStateText}>{t('post.notFound')}</Text>
              </View>
            ) : (
              <ListLoadState
                isError={editDrinkQuery.isError}
                isFetching={editDrinkQuery.isFetching}
                message={t('post.loadError')}
                onRetry={() => editDrinkQuery.refetch()}
              />
            )
          ) : (

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
              <Text style={styles.label}>{t('createPost.typeLabel')}</Text>
              <View style={styles.toggleRow}>
                <TouchableOpacity
                  style={[styles.toggleOption, isAlcoholic && styles.toggleOptionActive, !isAgeConfirmed && styles.toggleOptionLocked]}
                  onPress={() => selectAlcoholic(true)}
                  disabled={!isAgeConfirmed}
                  accessibilityState={{ disabled: !isAgeConfirmed, selected: isAlcoholic }}
                >
                  <Ionicons name="wine" size={16} color={isAlcoholic ? '#FFFFFF' : '#6B7280'} />
                  <Text style={[styles.toggleOptionText, isAlcoholic && styles.toggleOptionTextActive]}>
                    {t('createPost.alcoholic')}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.toggleOption, !isAlcoholic && styles.toggleOptionActive]}
                  onPress={() => selectAlcoholic(false)}
                >
                  <Ionicons name="leaf" size={16} color={!isAlcoholic ? '#FFFFFF' : '#6B7280'} />
                  <Text style={[styles.toggleOptionText, !isAlcoholic && styles.toggleOptionTextActive]}>
                    {t('createPost.nonAlcoholic')}
                  </Text>
                </TouchableOpacity>
              </View>
              {/* Defence in depth: the hard age gate means an unconfirmed user never reaches this screen. */}
              {!isAgeConfirmed && <Text style={styles.toggleHint}>{t('ageGate.banner')}</Text>}
            </View>

            <View style={styles.toggleSection}>
              <Text style={styles.label}>{t('createPost.categoryLabel')}</Text>
              <View style={styles.categoryRow}>
                {visibleCategories.map((option) => {
                  const isSelected = option === category;
                  const label = t(`categories.${option}`);
                  return (
                    <TouchableOpacity
                      key={option}
                      style={[styles.categoryChip, isSelected && styles.categoryChipActive]}
                      onPress={() => setCategory(isSelected ? null : option)}
                      accessibilityRole="button"
                      accessibilityLabel={label}
                      accessibilityState={{ selected: isSelected }}
                    >
                      <Text style={[styles.categoryChipText, isSelected && styles.categoryChipTextActive]}>
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <Text style={styles.toggleHint}>{t('createPost.categoryHint')}</Text>
            </View>

            {isEditMode ? (
              <View style={styles.photoSection}>
                {originalDrink?.imageUrl ? (
                  <Image
                    source={getImageSource(originalDrink.imageUrl)}
                    style={styles.preview}
                    accessibilityLabel={t('editPost.photoLocked')}
                  />
                ) : null}
                <Text style={styles.toggleHint}>{t('editPost.photoLocked')}</Text>
              </View>
            ) : (
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
            )}

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

            {!isEditMode && (
              <View style={styles.bottomActions}>
                <TouchableOpacity style={styles.actionButton} onPress={() => navigation.navigate('Main', { screen: 'Scanner' })}>
                  <Ionicons name="scan-outline" size={22} color="#8B5FBF" />
                  <Text style={styles.actionText}>{t('scanner.title')}</Text>
                </TouchableOpacity>
              </View>
            )}
          </ScrollView>
          )}
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
  categoryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  categoryChip: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#374151',
    backgroundColor: '#1F2937',
  },
  categoryChipActive: {
    backgroundColor: '#8B5FBF',
    borderColor: '#8B5FBF',
  },
  categoryChipText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#9CA3AF',
  },
  categoryChipTextActive: {
    color: '#FFFFFF',
  },
  editStateContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 24,
  },
  editStateText: {
    color: '#9CA3AF',
    fontSize: 16,
    textAlign: 'center',
  },
});
