import React, { useRef } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { useLocalization } from '../context/LocalizationContext';

type Props = {
  visible: boolean;
  isLooking: boolean;
  onScanned: (ean: string) => void;
  onClose: () => void;
};

const EAN_PATTERN = /^(?:\d{8}|\d{12}|\d{13})$/;

/** Barcode fallback (expo-camera, works in Expo Go). Reports the first EAN-8/UPC-A/EAN-13 it reads. */
export default function BarcodeScannerModal({ visible, isLooking, onScanned, onClose }: Props) {
  const { t } = useLocalization();
  const [permission, requestPermission] = useCameraPermissions();
  // The camera reports the same code many times a second; only the first one per opening counts.
  const handled = useRef(false);

  const handleScan = ({ data }: BarcodeScanningResult) => {
    if (handled.current || isLooking || !EAN_PATTERN.test(data)) return;
    handled.current = true;
    onScanned(data);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      onShow={() => { handled.current = false; }}
    >
      <SafeAreaView style={styles.container} edges={['top', 'bottom', 'left', 'right']}>
        <View style={styles.header}>
          <Text style={styles.title}>{t('ai.barcode.title')}</Text>
          <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('ai.barcode.close')}>
            <Ionicons name="close" size={26} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
        {!permission ? (
          <View style={styles.center}><ActivityIndicator color="#8B5FBF" /></View>
        ) : !permission.granted ? (
          <View style={styles.center}>
            <Ionicons name="camera-outline" size={40} color="#6B7280" />
            <Text style={styles.text}>{t('ai.barcode.permission')}</Text>
            <TouchableOpacity style={styles.button} onPress={requestPermission} accessibilityRole="button">
              <Text style={styles.buttonText}>{t('ai.barcode.grant')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.cameraWrap}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'upc_a'] }}
              onBarcodeScanned={isLooking ? undefined : handleScan}
            />
            <View style={styles.frame} pointerEvents="none" />
            <View style={styles.footer}>
              {isLooking ? (
                <View style={styles.lookingRow}>
                  <ActivityIndicator color="#FFFFFF" />
                  <Text style={styles.footerText}>{t('ai.barcode.looking')}</Text>
                </View>
              ) : (
                <Text style={styles.footerText}>{t('ai.barcode.hint')}</Text>
              )}
            </View>
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000000' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#1F2937',
  },
  title: { color: '#FFFFFF', fontSize: 18, fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  text: { color: '#9CA3AF', fontSize: 15, textAlign: 'center' },
  button: { backgroundColor: '#8B5FBF', borderRadius: 12, paddingHorizontal: 20, minHeight: 44, justifyContent: 'center' },
  buttonText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },
  cameraWrap: { flex: 1 },
  frame: {
    position: 'absolute', left: '10%', right: '10%', top: '35%', height: '20%',
    borderWidth: 2, borderColor: '#8B5FBF', borderRadius: 12,
  },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 20, backgroundColor: '#000000AA' },
  lookingRow: { flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'center' },
  footerText: { color: '#FFFFFF', fontSize: 15, textAlign: 'center' },
});
