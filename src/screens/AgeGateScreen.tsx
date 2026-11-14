import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { useLocalization } from '../context/LocalizationContext';
import { useConfirmAge } from '../lib/useConfirmAge';
import DeleteAccountModal from '../components/DeleteAccountModal';

// A hard gate: shown after the session is ready to every user who has not confirmed 18+, and nothing
// else in the app opens before that, because the server refuses every other route. The only ways out
// are logging out and deleting the account, both of which the server allows before the confirmation.
export default function AgeGateScreen() {
  const { t } = useLocalization();
  const { logout } = useAuth();
  const { confirmAge, isConfirming } = useConfirmAge();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isDeleteModalVisible, setIsDeleteModalVisible] = useState(false);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await logout();
    } catch (error) {
      console.error('Failed to log out:', error);
      setIsLoggingOut(false);
    }
  };

  const isBusy = isConfirming || isLoggingOut;

  return (
    <SafeAreaView style={styles.container}>
      <Ionicons name="shield-checkmark-outline" size={48} color="#8B5FBF" />
      <Text style={styles.title} accessibilityRole="header">{t('ageGate.title')}</Text>
      <Text style={styles.body}>{t('ageGate.body')}</Text>
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.confirmButton}
          onPress={confirmAge}
          disabled={isBusy}
          accessibilityRole="button"
          accessibilityLabel={t('ageGate.confirm')}
        >
          {isConfirming ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.confirmText}>{t('ageGate.confirm')}</Text>
          )}
        </TouchableOpacity>
        <Text style={styles.hint}>{t('ageGate.leaveHint')}</Text>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={handleLogout}
          disabled={isBusy}
          accessibilityRole="button"
          accessibilityLabel={t('ageGate.logout')}
        >
          {isLoggingOut ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.secondaryText}>{t('ageGate.logout')}</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.deleteButton}
          onPress={() => setIsDeleteModalVisible(true)}
          disabled={isBusy}
          accessibilityRole="button"
          accessibilityLabel={t('ageGate.deleteAccount')}
        >
          <Text style={styles.deleteText}>{t('ageGate.deleteAccount')}</Text>
        </TouchableOpacity>
      </View>
      <DeleteAccountModal visible={isDeleteModalVisible} onClose={() => setIsDeleteModalVisible(false)} />
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
  confirmText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  hint: {
    fontSize: 13,
    color: '#6B7280',
    textAlign: 'center',
    marginTop: 8,
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
  secondaryText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  deleteButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteText: {
    color: '#EF4444',
    fontSize: 14,
    fontWeight: '600',
  },
});
