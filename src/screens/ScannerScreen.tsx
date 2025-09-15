import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Camera } from 'expo-camera';
import { BarCodeScanner } from 'expo-barcode-scanner';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';

export default function ScannerScreen({ navigation }: any) {
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [scanned, setScanned] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [detectedProduct, setDetectedProduct] = useState<string | null>(null);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const { getJwtToken } = useAuth();

  useEffect(() => {
    getCameraPermissions();
  }, []);

  const getCameraPermissions = async () => {
    const { status } = await Camera.requestCameraPermissionsAsync();
    setHasPermission(status === 'granted');
  };

  const handleBarCodeScanned = async ({ type, data }: { type: string; data: string }) => {
    if (scanned) return;
    
    setScanned(true);
    console.log('Barcode scanned:', data);

    // Validate EAN barcode format
    if (!/^\d{8,13}$/.test(data)) {
      Alert.alert('Invalid Barcode', 'Please scan a valid product barcode (8-13 digits)');
      setScanned(false);
      return;
    }

    try {
      // First try Open Food Facts API
      const response = await fetch(`https://world.openfoodfacts.org/api/v0/product/${data}.json`);
      const productData = await response.json();
      
      if (productData.status === 1 && productData.product) {
        const product = productData.product;
        const productName = product.product_name || product.product_name_en || 'Unknown Product';
        const brand = product.brands || '';
        const fullName = brand ? `${brand} ${productName}` : productName;
        
        setDetectedProduct(fullName);
        setShowConfirmation(true);
      } else {
        // If not found in Open Food Facts, try AI detection
        await detectWithAI(data);
      }
    } catch (error) {
      console.error('Barcode lookup error:', error);
      Alert.alert('Lookup Failed', 'Could not identify product. Try scanning again.');
      setScanned(false);
    }
  };

  const detectWithAI = async (barcode: string) => {
    try {
      setIsLoading(true);
      const token = await getJwtToken();
      
      const response = await fetch(`${process.env.EXPO_PUBLIC_API_URL}/api/detect-product`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ barcode }),
      });

      if (response.ok) {
        const { productName } = await response.json();
        setDetectedProduct(productName);
        setShowConfirmation(true);
      } else {
        Alert.alert('Detection Failed', 'Could not identify product. Try manual entry.');
        setScanned(false);
      }
    } catch (error) {
      console.error('AI detection error:', error);
      Alert.alert('Detection Failed', 'Network error. Please try again.');
      setScanned(false);
    } finally {
      setIsLoading(false);
    }
  };

  const generateRecipes = async () => {
    if (!detectedProduct) return;

    try {
      setIsLoading(true);
      const token = await getJwtToken();
      
      const response = await fetch(`${process.env.EXPO_PUBLIC_API_URL}/api/generate-recipes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ 
          productName: detectedProduct,
          count: 3 
        }),
      });

      if (response.ok) {
        const { recipes } = await response.json();
        navigation.navigate('RecipeResults', { 
          product: detectedProduct,
          recipes 
        });
      } else {
        Alert.alert('Generation Failed', 'Could not generate recipes. Please try again.');
      }
    } catch (error) {
      console.error('Recipe generation error:', error);
      Alert.alert('Generation Failed', 'Network error. Please try again.');
    } finally {
      setIsLoading(false);
      setShowConfirmation(false);
      setScanned(false);
      setDetectedProduct(null);
    }
  };

  const resetScanner = () => {
    setScanned(false);
    setDetectedProduct(null);
    setShowConfirmation(false);
  };

  if (hasPermission === null) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.text}>Requesting camera permission...</Text>
      </SafeAreaView>
    );
  }

  if (hasPermission === false) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.permissionContainer}>
          <Ionicons name="camera-outline" size={64} color="#6B7280" />
          <Text style={styles.permissionTitle}>Camera Permission Required</Text>
          <Text style={styles.permissionText}>
            DrinkMe needs camera access to scan bottle barcodes and detect products.
          </Text>
          <TouchableOpacity style={styles.permissionButton} onPress={getCameraPermissions}>
            <Text style={styles.permissionButtonText}>Grant Permission</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Scan Bottle</Text>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Ionicons name="close" size={24} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      <View style={styles.cameraContainer}>
        <BarCodeScanner
          onBarCodeScanned={scanned ? undefined : handleBarCodeScanned}
          style={styles.camera}
        />
        
        <View style={styles.overlay}>
          <View style={styles.scanFrame} />
          <Text style={styles.scanText}>
            {isLoading 
              ? 'Detecting product...' 
              : 'Point camera at bottle barcode'}
          </Text>
        </View>
      </View>

      <View style={styles.controls}>
        <TouchableOpacity
          style={styles.resetButton}
          onPress={resetScanner}
          disabled={isLoading}
        >
          <Text style={styles.resetButtonText}>Reset Scanner</Text>
        </TouchableOpacity>
      </View>

      <Modal
        visible={showConfirmation}
        transparent
        animationType="slide"
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>Product Detected</Text>
            <Text style={styles.modalProduct}>{detectedProduct}</Text>
            <Text style={styles.modalText}>
              Generate recipes for this product?
            </Text>
            
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonSecondary]}
                onPress={resetScanner}
              >
                <Text style={styles.modalButtonTextSecondary}>Cancel</Text>
              </TouchableOpacity>
              
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonPrimary]}
                onPress={generateRecipes}
                disabled={isLoading}
              >
                <Text style={styles.modalButtonTextPrimary}>
                  {isLoading ? 'Generating...' : 'Generate Recipes'}
                </Text>
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