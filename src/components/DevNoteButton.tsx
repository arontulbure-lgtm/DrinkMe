// Development-only floating "📝 Note" button for device test sessions. App.tsx loads it only when
// __DEV__, so a release build does not contain it. A note is saved with the current screen and time
// through the dev log bridge (src/lib/devLogBridge.ts).
import React, { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useLocalization } from '../context/LocalizationContext';
import { addDevNote, getDevLogScreen, isDevLogBridgeActive } from '../lib/devLogBridge';

const NOTE_MAX_LENGTH = 1000;
const SAVED_MESSAGE_MS = 1500;

export default function DevNoteButton() {
  const { t } = useLocalization();
  const insets = useSafeAreaInsets();
  const [isOpen, setIsOpen] = useState(false);
  const [text, setText] = useState('');
  const [showSaved, setShowSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  if (!isDevLogBridgeActive()) return null;

  const close = () => {
    setIsOpen(false);
    setText('');
  };

  const save = () => {
    addDevNote(text);
    close();
    setShowSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setShowSaved(false), SAVED_MESSAGE_MS);
  };

  return (
    <>
      <TouchableOpacity
        style={[styles.fab, { bottom: insets.bottom + 96 }]}
        onPress={() => setIsOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={t('devNote.a11y')}
      >
        <Text style={styles.fabText}>{showSaved ? t('devNote.saved') : t('devNote.button')}</Text>
      </TouchableOpacity>

      <Modal visible={isOpen} transparent animationType="fade" onRequestClose={close}>
        <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.sheet}>
            <Text style={styles.title} accessibilityRole="header">{t('devNote.title')}</Text>
            <Text style={styles.hint}>{`${t('devNote.hint')}${getDevLogScreen() ? ` (${getDevLogScreen()})` : ''}`}</Text>
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={setText}
              placeholder={t('devNote.placeholder')}
              placeholderTextColor="#6B7280"
              multiline
              autoFocus
              maxLength={NOTE_MAX_LENGTH}
              accessibilityLabel={t('devNote.title')}
            />
            <View style={styles.row}>
              <TouchableOpacity style={styles.secondary} onPress={close} accessibilityRole="button">
                <Text style={styles.secondaryText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.primary, !text.trim() && styles.disabled]}
                onPress={save}
                disabled={!text.trim()}
                accessibilityRole="button"
                accessibilityState={{ disabled: !text.trim() }}
              >
                <Text style={styles.primaryText}>{t('devNote.save')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    left: 12,
    minHeight: 44,
    paddingHorizontal: 12,
    justifyContent: 'center',
    borderRadius: 22,
    backgroundColor: 'rgba(139, 95, 191, 0.85)',
    zIndex: 1000,
    elevation: 10,
  },
  fabText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  sheet: {
    backgroundColor: '#1F2937',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#374151',
    padding: 16,
    gap: 12,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
  },
  hint: {
    color: '#9CA3AF',
    fontSize: 13,
    lineHeight: 18,
  },
  input: {
    minHeight: 120,
    maxHeight: 240,
    backgroundColor: '#0F172A',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#374151',
    color: '#FFFFFF',
    padding: 12,
    fontSize: 15,
    textAlignVertical: 'top',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
  },
  secondary: {
    minHeight: 44,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  secondaryText: {
    color: '#9CA3AF',
    fontSize: 15,
  },
  primary: {
    minHeight: 44,
    paddingHorizontal: 16,
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: '#8B5FBF',
  },
  primaryText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  disabled: {
    opacity: 0.5,
  },
});
