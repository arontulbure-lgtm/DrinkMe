import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import AiNoticeCard from '../components/AiNoticeCard';
import { useLocalization } from '../context/LocalizationContext';
import { useAiStatus, useUpdateAiSettings } from '../lib/ai';
import type { RootStackScreenProps } from '../navigation/types';

const BASICS_MAX = 12;
const BASIC_MAX_LENGTH = 40;

/** Always-allowed basics for Smart Bar recipes, and the photo opt-in (off by default). */
export default function AiSettingsScreen({ navigation }: RootStackScreenProps<'AiSettings'>) {
  const { t, locale } = useLocalization();
  const status = useAiStatus(locale);
  const update = useUpdateAiSettings();
  const [basics, setBasics] = useState<string[]>([]);
  const [newBasic, setNewBasic] = useState('');

  useEffect(() => {
    if (status.data) setBasics(status.data.settings.basics);
  }, [status.data]);

  const save = (body: { basics?: string[] | null; photoOptIn?: boolean }) => {
    update.mutate({ ...body, language: locale }, {
      onError: () => {
        Alert.alert(t('common.errorTitle'), t('ai.settings.saveFailed'));
        if (status.data) setBasics(status.data.settings.basics);
      },
    });
  };

  const addBasic = () => {
    const value = newBasic.trim().slice(0, BASIC_MAX_LENGTH);
    if (!value) return;
    if (basics.length >= BASICS_MAX) {
      Alert.alert(t('ai.settings.basicsTitle'), t('ai.settings.basicsLimit'));
      return;
    }
    if (basics.some((b) => b.toLowerCase() === value.toLowerCase())) { setNewBasic(''); return; }
    const next = [...basics, value];
    setBasics(next);
    setNewBasic('');
    save({ basics: next });
  };

  const removeBasic = (name: string) => {
    const next = basics.filter((b) => b !== name);
    setBasics(next);
    save({ basics: next });
  };

  const photoOptIn = status.data?.settings.photoOptIn ?? false;

  return (
    <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('ai.settings.title')}</Text>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.close')}>
          <Ionicons name="close" size={26} color="#FFFFFF" />
        </TouchableOpacity>
      </View>
      {status.isLoading ? (
        <View style={styles.center}><ActivityIndicator color="#8B5FBF" /></View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.sectionTitle}>{t('ai.settings.basicsTitle')}</Text>
          <Text style={styles.muted}>{t('ai.settings.basicsHint')}</Text>
          <View style={styles.chips}>
            {basics.map((basic) => (
              <View key={basic} style={styles.chip}>
                <Text style={styles.chipText}>{basic}</Text>
                <TouchableOpacity
                  onPress={() => removeBasic(basic)}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel={t('ai.settings.remove', { name: basic })}
                >
                  <Ionicons name="close-circle" size={18} color="#9CA3AF" />
                </TouchableOpacity>
              </View>
            ))}
          </View>
          <View style={styles.addRow}>
            <TextInput
              style={styles.input}
              value={newBasic}
              onChangeText={setNewBasic}
              placeholder={t('ai.settings.addBasic')}
              placeholderTextColor="#6B7280"
              maxLength={BASIC_MAX_LENGTH}
              onSubmitEditing={addBasic}
              returnKeyType="done"
              accessibilityLabel={t('ai.settings.addBasic')}
            />
            <TouchableOpacity style={styles.addButton} onPress={addBasic} accessibilityRole="button">
              <Text style={styles.addButtonText}>{t('ai.settings.add')}</Text>
            </TouchableOpacity>
          </View>
          {status.data?.settings.basicsCustomized && (
            <TouchableOpacity onPress={() => save({ basics: null })} style={styles.linkButton} accessibilityRole="button">
              <Text style={styles.linkText}>{t('ai.settings.reset')}</Text>
            </TouchableOpacity>
          )}

          <View style={styles.optInCard}>
            <View style={styles.optInRow}>
              <Text style={styles.optInTitle}>{t('ai.settings.photoTitle')}</Text>
              <Switch
                value={photoOptIn}
                onValueChange={(value) => save({ photoOptIn: value })}
                disabled={update.isPending}
                trackColor={{ false: '#374151', true: '#8B5FBF' }}
                thumbColor="#FFFFFF"
                accessibilityLabel={t('ai.settings.photoSwitchLabel')}
              />
            </View>
            <Text style={styles.muted}>{t('ai.settings.photoBody')}</Text>
          </View>

          <AiNoticeCard />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000000' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#1F2937',
  },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 20, gap: 12, paddingBottom: 60 },
  sectionTitle: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
  muted: { color: '#9CA3AF', fontSize: 13, lineHeight: 19 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#1F2937', borderRadius: 16,
    paddingLeft: 12, paddingRight: 8, minHeight: 34, borderWidth: 1, borderColor: '#374151',
  },
  chipText: { color: '#FFFFFF', fontSize: 14 },
  addRow: { flexDirection: 'row', gap: 8 },
  input: {
    flex: 1, backgroundColor: '#1F2937', borderRadius: 10, borderWidth: 1, borderColor: '#374151', color: '#FFFFFF',
    paddingHorizontal: 12, minHeight: 44, fontSize: 15,
  },
  addButton: { backgroundColor: '#8B5FBF', borderRadius: 10, paddingHorizontal: 16, justifyContent: 'center', minHeight: 44 },
  addButtonText: { color: '#FFFFFF', fontWeight: '600' },
  linkButton: { minHeight: 44, justifyContent: 'center' },
  linkText: { color: '#8B5FBF', fontSize: 15, fontWeight: '600' },
  optInCard: { backgroundColor: '#0F172A', borderRadius: 14, padding: 16, gap: 8, borderWidth: 1, borderColor: '#1F2937', marginTop: 8 },
  optInRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  optInTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '600', flexShrink: 1 },
});
