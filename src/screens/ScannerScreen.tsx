import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, Modal, Image, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import * as ImagePicker from 'expo-image-picker';
import { apiFetch } from '../lib/api';
import { Recipe } from '../types/api';
import { useLocalization } from '../context/LocalizationContext';

export default function ScannerScreen({ navigation }: any) {
  const { getJwtToken } = useAuth();
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [detectedProduct, setDetectedProduct] = useState<string | null>(null);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const { t } = useLocalization();

  const pickFromLibrary = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(t('scanner.title'), t('scanner.permissionLibrary'));
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ allowsEditing: true, quality: 0.8, mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (!result.canceled && result.assets?.[0]?.uri) {
      setImageUri(result.assets[0].uri);
      await detectFromImage(result.assets[0].uri);
    }
  };

  const takePhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(t('scanner.title'), t('scanner.permissionCamera'));
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ allowsEditing: true, quality: 0.8 });
    if (!result.canceled && result.assets?.[0]?.uri) {
      setImageUri(result.assets[0].uri);
      await detectFromImage(result.assets[0].uri);
    }
  };

  const detectFromImage = async (uri: string) => {
    try {
      setIsLoading(true);
      const token = await getJwtToken();
      const form = new FormData();
      form.append('file', {
        // @ts-ignore RN FormData file
        uri,
        name: 'photo.jpg',
        type: 'image/jpeg',
      } as any);

      const headers: Record<string, string> = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const data = await apiFetch<{ productName?: string; error?: string }>(
        '/api/detect-product',
        {
          method: 'POST',
          headers,
          body: form,
        }
      );

      if (data?.productName) {
        setDetectedProduct(data.productName);
        setShowConfirmation(true);
      } else if (data?.error) {
        Alert.alert(t('scanner.modalTitle'), data.error);
      } else {
        Alert.alert(t('scanner.modalTitle'), t('explore.sections.noDrinksTitle'));
      }
    } catch (error) {
      console.error('AI detection error:', error);
      Alert.alert(t('scanner.modalTitle'), t('createPost.error'));
    } finally {
      setIsLoading(false);
    }
  };

  const generateRecipes = async () => {
    if (!detectedProduct) return;

    try {
      setIsLoading(true);
      const token = await getJwtToken();
      
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const { recipes } = await apiFetch<{ recipes: Recipe[] }>('/api/generate-recipes', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          productName: detectedProduct,
          count: 3,
        }),
      });
      navigation.navigate('RecipeResults', {
        product: detectedProduct,
        recipes,
      });
    } catch (error) {
      console.error('Recipe generation error:', error);
      Alert.alert(t('scanner.modalTitle'), t('createPost.error'));
    } finally {
      setIsLoading(false);
      setShowConfirmation(false);
      setDetectedProduct(null);
    }
  };

  const resetScanner = () => {
    setImageUri(null);
    setDetectedProduct(null);
    setShowConfirmation(false);
  };

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('scanner.title')}</Text>
        <TouchableOpacity onPress={() => navigation.navigate('Home')}>
          <Ionicons name="close" size={24} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      <View style={styles.cameraContainer}>
        {imageUri ? (
          <Image source={{ uri: imageUri }} style={styles.camera} />
        ) : (
          <View style={[styles.overlay, { paddingHorizontal: 24 }]}>
            <View style={styles.scanFrame} />
            <Text style={styles.scanText}>
              {isLoading ? t('scanner.detecting') : t('scanner.instruction')}
            </Text>
            <View style={{ flexDirection: 'row', gap: 12, marginTop: 16 }}>
              <TouchableOpacity style={styles.permissionButton} onPress={pickFromLibrary} disabled={isLoading}>
                <Text style={styles.permissionButtonText}>{t('scanner.choosePhoto')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.permissionButton} onPress={takePhoto} disabled={isLoading}>
                <Text style={styles.permissionButtonText}>{t('scanner.takePhoto')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>

      <View style={styles.controls}>
        <TouchableOpacity
          style={styles.resetButton}
          onPress={resetScanner}
          disabled={isLoading}
        >
          <Text style={styles.resetButtonText}>{t('scanner.reset')}</Text>
        </TouchableOpacity>
      </View>

      <Modal
        visible={showConfirmation}
        transparent
        animationType="slide"
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>{t('scanner.modalTitle')}</Text>
            <Text style={styles.modalProduct}>{detectedProduct}</Text>
            <Text style={styles.modalText}>{t('scanner.modalQuestion')}</Text>
            
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonSecondary]}
                onPress={resetScanner}
              >
                <Text style={styles.modalButtonTextSecondary}>{t('scanner.cancel')}</Text>
              </TouchableOpacity>
              
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonPrimary]}
                onPress={generateRecipes}
                disabled={isLoading}
              >
                {isLoading ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.modalButtonTextPrimary}>{t('scanner.generate')}</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
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
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1F2937',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  text: {
    color: '#FFFFFF',
    textAlign: 'center',
    fontSize: 16,
  },
  permissionContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  permissionTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#FFFFFF',
    marginTop: 16,
    marginBottom: 8,
  },
  permissionText: {
    fontSize: 14,
    color: '#9CA3AF',
    textAlign: 'center',
    marginBottom: 24,
  },
  permissionButton: {
    backgroundColor: '#8B5FBF',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  permissionButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  cameraContainer: {
    flex: 1,
    position: 'relative',
  },
  camera: {
    flex: 1,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scanFrame: {
    width: 250,
    height: 120,
    borderWidth: 2,
    borderColor: '#8B5FBF',
    borderRadius: 8,
    backgroundColor: 'transparent',
  },
  scanText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '500',
    marginTop: 24,
    textAlign: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  controls: {
    padding: 16,
  },
  resetButton: {
    backgroundColor: '#374151',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  resetButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '500',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  modal: {
    backgroundColor: '#1F2937',
    borderRadius: 12,
    padding: 24,
    width: '100%',
    maxWidth: 400,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#FFFFFF',
    textAlign: 'center',
    marginBottom: 8,
  },
  modalProduct: {
    fontSize: 16,
    color: '#8B5FBF',
    textAlign: 'center',
    fontWeight: '500',
    marginBottom: 16,
  },
  modalText: {
    fontSize: 14,
    color: '#9CA3AF',
    textAlign: 'center',
    marginBottom: 24,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  modalButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  modalButtonSecondary: {
    backgroundColor: '#374151',
  },
  modalButtonPrimary: {
    backgroundColor: '#8B5FBF',
  },
  modalButtonTextSecondary: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '500',
  },
  modalButtonTextPrimary: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
