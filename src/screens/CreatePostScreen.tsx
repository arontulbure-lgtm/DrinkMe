import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert, ScrollView, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../lib/api';
import { useLocalization } from '../context/LocalizationContext';

interface SelectedImage {
  uri: string;
  base64: string;
}

export default function CreatePostScreen({ navigation }: any) {
  const [drinkName, setDrinkName] = useState('');
  const [description, setDescription] = useState('');
  const [rating, setRating] = useState(5);
  const [location, setLocation] = useState('');
  const [photo, setPhoto] = useState<SelectedImage | null>(null);
  const { getJwtToken } = useAuth();
  const queryClient = useQueryClient();
  const { t } = useLocalization();

  const createPostMutation = useMutation({
    mutationFn: async (postData: any) => {
      const token = await getJwtToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      return apiFetch('/api/drinks', {
        method: 'POST',
        headers,
        body: JSON.stringify(postData),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['drinks.all'] });
      queryClient.invalidateQueries({ queryKey: ['drinks.partners'] });
      setDrinkName('');
      setDescription('');
      setLocation('');
      setRating(5);
      setPhoto(null);
      Alert.alert(t('createPost.title'), t('createPost.success'), [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    },
    onError: () => {
      Alert.alert(t('createPost.title'), t('createPost.error'));
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
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
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
      isAlcoholic: true,
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
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
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

      <ScrollView style={styles.content}>
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
        </View>

        {renderStarRating()}

        <View style={styles.section}>
          <Text style={styles.label}>{t('createPost.location')}</Text>
          <TextInput
            style={styles.input}
            placeholder={t('createPost.locationPlaceholder')}
            placeholderTextColor="#6B7280"
            value={location}
            onChangeText={setLocation}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.helpText}>{t('createPost.helperText')}</Text>
        </View>

        <View style={styles.photoSection}>
          <TouchableOpacity style={styles.photoButton} onPress={handlePickPhoto}>
            <Ionicons name="camera" size={20} color="#8B5FBF" />
            <Text style={styles.photoButtonText}>
              {photo ? t('createPost.changePhoto') : t('createPost.addPhoto')}
            </Text>
          </TouchableOpacity>
          {photo?.uri && <Image source={{ uri: photo.uri }} style={styles.preview} />}
        </View>

        <View style={styles.bottomActions}>
          <TouchableOpacity style={styles.actionButton}>
            <Ionicons name="location-outline" size={24} color="#8B5FBF" />
            <Text style={styles.actionText}>{t('createPost.addLocation')}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.actionButton}>
            <Ionicons name="pricetag-outline" size={24} color="#8B5FBF" />
            <Text style={styles.actionText}>{t('createPost.addTags')}</Text>
          </TouchableOpacity>
        </View>
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
    justifyContent: 'space-between',
    alignItems: 'center',
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
  content: {
    flex: 1,
    padding: 16,
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
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 24,
  },
  actionButton: {
    alignItems: 'center',
    flex: 1,
  },
  actionText: {
    fontSize: 12,
    color: '#8B5FBF',
    marginTop: 4,
    textAlign: 'center',
  },
});
