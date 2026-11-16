import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput,
  TouchableOpacity, View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import AiNoticeCard from './AiNoticeCard';
import BarcodeScannerModal from './BarcodeScannerModal';
import { useAuth } from '../context/AuthContext';
import { useLocalization } from '../context/LocalizationContext';
import { getAiErrorKey, itemDisplayName, lookupBarcode, scanPhoto, useAcceptAiNotice } from '../lib/ai';
import { apiFetch, ApiError } from '../lib/api';
import type { TabScreenProps } from '../navigation/types';
import { AI_CATEGORIES, type AiCategory, type AiScanItem, type AiScanResult, type AiStatus } from '../types/api';

type Phase = 'idle' | 'processing' | 'result';
type Draft = { category: AiCategory; brand: string; product: string; style: string; abv: string; volumeMl: string };

const ALCOHOLIC = new Set<AiCategory>(['spirit', 'liqueur', 'wine', 'sparkling_wine', 'beer', 'cider', 'vermouth_aperitif', 'bitters']);

const toDraft = (item: AiScanItem): Draft => ({
  category: item.category,
  brand: item.brand ?? '',
  product: item.product ?? '',
  style: item.style ?? '',
  abv: item.abv === null ? '' : String(item.abv),
  volumeMl: item.volumeMl === null ? '' : String(item.volumeMl),
});

const parseNumber = (value: string, max: number): number | null | 'invalid' => {
  const trimmed = value.trim().replace(',', '.');
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : 'invalid';
};

/** The confirmed item, built from what the user edited. Same alcohol rule as the server's taxonomy. */
const fromDraft = (draft: Draft, base: AiScanItem | null): AiScanItem | 'invalid' => {
  const abv = parseNumber(draft.abv, 100);
  const volumeMl = parseNumber(draft.volumeMl, 10_000);
  if (abv === 'invalid' || volumeMl === 'invalid') return 'invalid';
  return {
    category: draft.category,
    brand: draft.brand.trim() || null,
    product: draft.product.trim() || null,
    style: draft.style.trim() || null,
    abv,
    volumeMl,
    isAlcoholic: ALCOHOLIC.has(draft.category) && (abv === null || abv > 0.5),
    flags: draft.category === 'energy_drink' ? ['energy_drink', 'contains_caffeine'] : [],
    confidence: base?.confidence ?? 1,
  };
};

type Props = { status: AiStatus; navigation: TabScreenProps<'Scanner'>['navigation'] };

export default function AiScannerFlow({ status, navigation }: Props) {
  const { t, locale } = useLocalization();
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const acceptNotice = useAcceptAiNotice();
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<AiScanResult | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [barcodeOpen, setBarcodeOpen] = useState(false);
  const [isLooking, setIsLooking] = useState(false);
  const [addedName, setAddedName] = useState<string | null>(null);
  // A cancelled scan may still answer later; its answer is then ignored.
  const scanToken = useRef(0);

  const showResult = useCallback((scan: AiScanResult) => {
    setResult(scan);
    setDraft(scan.item ? toDraft(scan.item) : null);
    setAddedName(null);
    setErrorKey(null);
    setPhase('result');
  }, []);

  const runPhotoScan = useCallback(async (base64: string) => {
    const token = ++scanToken.current;
    setPhase('processing');
    setErrorKey(null);
    try {
      const scan = await scanPhoto(base64, locale);
      if (token === scanToken.current) showResult(scan);
    } catch (error) {
      if (token !== scanToken.current) return;
      setErrorKey(getAiErrorKey(error));
      setPhase('idle');
    }
  }, [locale, showResult]);

  const pickPhoto = useCallback(async (source: 'camera' | 'gallery') => {
    const permission = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (permission.status !== 'granted') {
      Alert.alert(t('scanner.title'), source === 'camera' ? t('ai.scan.permissionCamera') : t('ai.scan.permissionGallery'));
      return;
    }
    const options: ImagePicker.ImagePickerOptions = { quality: 0.6, base64: true, mediaTypes: 'images', exif: false };
    const picked = source === 'camera'
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
    const base64 = !picked.canceled ? picked.assets?.[0]?.base64 : null;
    if (base64) runPhotoScan(base64);
  }, [runPhotoScan, t]);

  const cancelScan = () => {
    scanToken.current += 1;
    setPhase('idle');
  };

  const handleBarcode = useCallback(async (ean: string) => {
    setIsLooking(true);
    try {
      const scan = await lookupBarcode(ean, locale);
      setBarcodeOpen(false);
      showResult(scan);
    } catch (error) {
      setBarcodeOpen(false);
      setErrorKey(getAiErrorKey(error));
      setPhase(result ? 'result' : 'idle');
    } finally {
      setIsLooking(false);
    }
  }, [locale, result, showResult]);

  const addToBar = useMutation({
    mutationFn: (body: { name: string; quantity: string; unit: string }) =>
      apiFetch('/api/smart-bar', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (_data, body) => {
      queryClient.invalidateQueries({ queryKey: ['smartBar.inventory'] });
      setAddedName(body.name);
    },
    onError: (error) => {
      const key = error instanceof ApiError && error.code === 'smart_bar_limit' ? 'smartBar.itemLimit' : 'ai.scan.addFailed';
      Alert.alert(t('common.errorTitle'), t(key));
    },
  });

  const confirmedItem = (): AiScanItem | null => {
    if (!draft) return null;
    const item = fromDraft(draft, result?.item ?? null);
    if (item === 'invalid') {
      Alert.alert(t('common.errorTitle'), t('ai.scan.invalidNumber'));
      return null;
    }
    if (!item.brand && !item.product && !item.style) {
      Alert.alert(t('common.errorTitle'), t('ai.scan.nameRequired'));
      return null;
    }
    return item;
  };

  const handleAdd = () => {
    const item = confirmedItem();
    if (!item) return;
    const name = itemDisplayName(item, t(`ai.categories.${item.category}`)).slice(0, 120);
    addToBar.mutate({ name, quantity: item.volumeMl ? `${item.volumeMl} ml` : '1', unit: 'bottle' });
  };

  const handleMakeSomething = () => {
    const item = confirmedItem();
    if (item) navigation.navigate('AiRecipes', { mode: 'scan', item });
  };

  const reset = () => {
    setPhase('idle');
    setResult(null);
    setDraft(null);
    setErrorKey(null);
    setAddedName(null);
  };

  const header = (
    <View style={styles.header}>
      <View style={styles.headerSide} />
      <Text style={styles.headerTitle}>{t('scanner.title')}</Text>
      <TouchableOpacity
        style={styles.headerSide}
        onPress={() => navigation.navigate('AiSettings')}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={t('ai.settingsLabel')}
      >
        <Ionicons name="settings-outline" size={22} color="#FFFFFF" />
      </TouchableOpacity>
    </View>
  );

  const errorBox = errorKey ? (
    <View style={styles.errorBox} accessibilityLiveRegion="polite">
      <Ionicons name="alert-circle-outline" size={18} color="#EF4444" />
      <Text style={styles.errorText}>{t(errorKey)}</Text>
    </View>
  ) : null;

  // ── Notice first ──────────────────────────────────────────────
  if (!status.noticeAccepted) {
    return (
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
        {header}
        <ScrollView contentContainerStyle={styles.content}>
          <AiNoticeCard
            onAccept={() => acceptNotice.mutate()}
            isAccepting={acceptNotice.isPending}
            errorText={acceptNotice.isError ? t(getAiErrorKey(acceptNotice.error)) : null}
          />
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Processing ────────────────────────────────────────────────
  if (phase === 'processing') {
    return (
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
        {header}
        <View style={styles.center} accessibilityLiveRegion="polite">
          <ActivityIndicator size="large" color="#8B5FBF" />
          <Text style={styles.processingTitle}>{t('ai.scan.processing')}</Text>
          <Text style={styles.muted}>{t('ai.scan.processingHint')}</Text>
          <TouchableOpacity style={styles.secondaryButton} onPress={cancelScan} accessibilityRole="button">
            <Text style={styles.secondaryButtonText}>{t('ai.scan.cancel')}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const barcodeModal = (
    <BarcodeScannerModal
      visible={barcodeOpen}
      isLooking={isLooking}
      onScanned={handleBarcode}
      onClose={() => setBarcodeOpen(false)}
    />
  );

  // ── Idle: take or choose a photo ──────────────────────────────
  if (phase === 'idle' || !result) {
    return (
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
        {header}
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.hero}>
            <View style={styles.heroCircle}>
              <Ionicons name="scan" size={52} color="#8B5FBF" />
            </View>
          </View>
          <Text style={styles.intro}>{t('ai.scan.intro')}</Text>
          {errorBox}
          <TouchableOpacity style={styles.primaryButton} onPress={() => pickPhoto('camera')} accessibilityRole="button">
            <Ionicons name="camera" size={20} color="#FFFFFF" />
            <Text style={styles.primaryButtonText}>{t('ai.scan.takePhoto')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryButton} onPress={() => pickPhoto('gallery')} accessibilityRole="button">
            <Ionicons name="images-outline" size={18} color="#FFFFFF" />
            <Text style={styles.secondaryButtonText}>{t('ai.scan.chooseFromGallery')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.linkButton} onPress={() => setBarcodeOpen(true)} accessibilityRole="button">
            <Ionicons name="barcode-outline" size={18} color="#8B5FBF" />
            <Text style={styles.linkText}>{t('ai.scan.scanBarcode')}</Text>
          </TouchableOpacity>
          <Text style={styles.aiNote}>{t('ai.aiGenerated')} · {t('ai.recipes.disclaimer')}</Text>
        </ScrollView>
        {barcodeModal}
      </SafeAreaView>
    );
  }

  // ── Result ────────────────────────────────────────────────────
  const message = {
    low_confidence: t('ai.scan.lowConfidence'),
    unclear: t('ai.scan.unclear'),
    not_ingredient: t('ai.scan.notIngredient'),
    water: t('ai.scan.water'),
    recognized: null,
  }[result.status];
  const canEdit = draft !== null && (result.status === 'recognized' || result.status === 'low_confidence');
  const draftAlcoholic = draft ? ALCOHOLIC.has(draft.category) && !(Number(draft.abv.replace(',', '.')) <= 0.5 && draft.abv.trim() !== '') : false;
  const isWater = result.status === 'water' || draft?.category === 'water';
  const field = (key: keyof Omit<Draft, 'category'>, label: string, numeric = false) => (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={draft?.[key] ?? ''}
        onChangeText={(value) => setDraft((d) => (d ? { ...d, [key]: value } : d))}
        keyboardType={numeric ? 'decimal-pad' : 'default'}
        placeholderTextColor="#6B7280"
        accessibilityLabel={label}
        maxLength={numeric ? 8 : 120}
      />
    </View>
  );

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
      {header}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.sourceRow}>
            <Ionicons name={result.source === 'barcode' ? 'barcode-outline' : 'sparkles'} size={14} color="#8B5FBF" />
            <Text style={styles.sourceText}>
              {result.source === 'barcode' ? t('ai.scan.sourceBarcode') : `${t('ai.scan.sourcePhoto')} · ${t('ai.aiGenerated')}`}
            </Text>
          </View>
          {message ? (
            <View style={[styles.messageBox, result.status === 'water' && styles.messageWater]} accessibilityLiveRegion="polite">
              <Ionicons name={result.status === 'water' ? 'water-outline' : 'information-circle-outline'} size={20} color="#FFFFFF" />
              <Text style={styles.messageText}>{message}</Text>
            </View>
          ) : null}
          {errorBox}

          {canEdit && draft && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{t('ai.scan.confirmTitle')}</Text>
              <Text style={styles.muted}>{t('ai.scan.confirmHint')}</Text>
              <Text style={styles.fieldLabel}>{t('ai.scan.category')}</Text>
              <View style={styles.chips}>
                {AI_CATEGORIES.map((category) => {
                  const selected = draft.category === category;
                  return (
                    <TouchableOpacity
                      key={category}
                      style={[styles.chip, selected && styles.chipSelected]}
                      onPress={() => setDraft((d) => (d ? { ...d, category } : d))}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                    >
                      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{t(`ai.categories.${category}`)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {field('brand', t('ai.scan.brand'))}
              {field('product', t('ai.scan.product'))}
              {field('style', t('ai.scan.style'))}
              <View style={styles.row}>
                <View style={{ flex: 1 }}>{field('abv', t('ai.scan.abv'), true)}</View>
                <View style={{ flex: 1 }}>{field('volumeMl', t('ai.scan.volume'), true)}</View>
              </View>
              <View style={styles.badgeRow}>
                <View style={[styles.badge, draftAlcoholic ? styles.badgeAlcohol : styles.badgeSoft]}>
                  <Text style={styles.badgeText}>{draftAlcoholic ? t('ai.scan.alcoholic') : t('ai.scan.nonAlcoholic')}</Text>
                </View>
                {result.item && result.source === 'photo' && (
                  <Text style={styles.muted}>{t('ai.scan.confidence', { percent: String(Math.round(result.item.confidence * 100)) })}</Text>
                )}
              </View>
              {draft.category === 'energy_drink' && (
                <View style={styles.warningRow}>
                  <Ionicons name="warning-outline" size={16} color="#FFD700" />
                  <Text style={styles.warningText}>{t('ai.scan.energyFlag')}</Text>
                </View>
              )}
              {addedName ? (
                <View style={styles.addedRow} accessibilityLiveRegion="polite">
                  <Ionicons name="checkmark-circle" size={18} color="#10B981" />
                  <Text style={styles.addedText}>{t('ai.scan.added')}</Text>
                </View>
              ) : (
                <TouchableOpacity
                  style={[styles.secondaryButton, addToBar.isPending && styles.disabled]}
                  onPress={handleAdd}
                  disabled={addToBar.isPending}
                  accessibilityRole="button"
                >
                  {addToBar.isPending ? <ActivityIndicator color="#FFFFFF" size="small" /> : <Ionicons name="add-circle-outline" size={18} color="#FFFFFF" />}
                  <Text style={styles.secondaryButtonText}>{t('ai.scan.addToBar')}</Text>
                </TouchableOpacity>
              )}
              {!isWater && (
                <TouchableOpacity style={styles.primaryButton} onPress={handleMakeSomething} accessibilityRole="button">
                  <Ionicons name="flask" size={18} color="#FFFFFF" />
                  <Text style={styles.primaryButtonText}>{t('ai.scan.makeSomething')}</Text>
                </TouchableOpacity>
              )}
              {profile?.ageConfirmed !== true && <Text style={styles.muted}>{t('ai.recipes.mocktailsOnly')}</Text>}
            </View>
          )}

          {(result.suggestBarcode || result.status === 'not_ingredient') && (
            <TouchableOpacity style={styles.secondaryButton} onPress={() => setBarcodeOpen(true)} accessibilityRole="button">
              <Ionicons name="barcode-outline" size={18} color="#FFFFFF" />
              <Text style={styles.secondaryButtonText}>{t('ai.scan.scanBarcode')}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.linkButton} onPress={reset} accessibilityRole="button">
            <Ionicons name="refresh" size={18} color="#8B5FBF" />
            <Text style={styles.linkText}>{t('ai.scan.scanAnother')}</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
      {barcodeModal}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000000' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#1F2937',
  },
  headerSide: { width: 32, alignItems: 'flex-end' },
  headerTitle: { fontSize: 18, fontWeight: '600', color: '#FFFFFF' },
  content: { padding: 20, gap: 14, paddingBottom: 120 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  hero: { alignItems: 'center', marginTop: 12 },
  heroCircle: {
    width: 112, height: 112, borderRadius: 56, backgroundColor: '#1F2937', alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: '#8B5FBF44',
  },
  intro: { color: '#9CA3AF', fontSize: 15, lineHeight: 22, textAlign: 'center' },
  processingTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '600' },
  muted: { color: '#9CA3AF', fontSize: 13, lineHeight: 18 },
  aiNote: { color: '#6B7280', fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 8 },
  primaryButton: {
    flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#8B5FBF',
    borderRadius: 12, minHeight: 48, paddingHorizontal: 16,
  },
  primaryButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  secondaryButton: {
    flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1F2937',
    borderRadius: 12, minHeight: 46, paddingHorizontal: 16, borderWidth: 1, borderColor: '#374151',
  },
  secondaryButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  linkButton: { flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', minHeight: 44 },
  linkText: { color: '#8B5FBF', fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.6 },
  errorBox: {
    flexDirection: 'row', gap: 8, alignItems: 'center', backgroundColor: '#EF444422', borderRadius: 10, padding: 12,
  },
  errorText: { color: '#FFFFFF', fontSize: 14, flexShrink: 1 },
  sourceRow: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  sourceText: { color: '#8B5FBF', fontSize: 13, fontWeight: '600' },
  messageBox: { flexDirection: 'row', gap: 10, backgroundColor: '#1F2937', borderRadius: 12, padding: 14, alignItems: 'flex-start' },
  messageWater: { backgroundColor: '#0EA5E933' },
  messageText: { color: '#FFFFFF', fontSize: 15, lineHeight: 21, flexShrink: 1 },
  card: { backgroundColor: '#0F172A', borderRadius: 14, padding: 16, gap: 10, borderWidth: 1, borderColor: '#1F2937' },
  cardTitle: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
  field: { gap: 4 },
  fieldLabel: { color: '#9CA3AF', fontSize: 13, fontWeight: '600' },
  input: {
    backgroundColor: '#1F2937', borderRadius: 10, borderWidth: 1, borderColor: '#374151', color: '#FFFFFF',
    paddingHorizontal: 12, minHeight: 44, fontSize: 15,
  },
  row: { flexDirection: 'row', gap: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderRadius: 16, borderWidth: 1, borderColor: '#374151', paddingHorizontal: 10, paddingVertical: 6, minHeight: 32 },
  chipSelected: { backgroundColor: '#8B5FBF', borderColor: '#8B5FBF' },
  chipText: { color: '#9CA3AF', fontSize: 12 },
  chipTextSelected: { color: '#FFFFFF', fontWeight: '600' },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  badge: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 3 },
  badgeAlcohol: { backgroundColor: '#8B5FBF55' },
  badgeSoft: { backgroundColor: '#10B98144' },
  badgeText: { color: '#FFFFFF', fontSize: 12, fontWeight: '600' },
  warningRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  warningText: { color: '#FFD700', fontSize: 13, lineHeight: 18, flexShrink: 1 },
  addedRow: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', minHeight: 46 },
  addedText: { color: '#10B981', fontSize: 15, fontWeight: '600' },
});
