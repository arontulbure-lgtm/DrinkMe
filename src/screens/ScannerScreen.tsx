import React from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { useLocalization } from '../context/LocalizationContext';
import { useAiStatus } from '../lib/ai';
import AiScannerFlow from '../components/AiScannerFlow';
import { TabScreenProps } from '../navigation/types';

// ── Kill switch: the real scanner shows only while this is true AND the server says AI is available
// (GET /api/ai/status). Otherwise the "coming soon" preview below stays. Never delete the preview.
const AI_ENABLED = true;

export default function ScannerScreen({ navigation }: TabScreenProps<'Scanner'>) {
  const { locale } = useLocalization();
  const status = useAiStatus(locale, AI_ENABLED);

  if (AI_ENABLED && status.isLoading) {
    return (
      <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={[styles.container, { justifyContent: 'center' }]}>
        <ActivityIndicator color="#8B5FBF" />
      </SafeAreaView>
    );
  }
  if (AI_ENABLED && status.data?.available) {
    return <AiScannerFlow status={status.data} navigation={navigation} />;
  }
  // AI on in the app but the server has it off or the ai-service is down: the preview, with a note.
  return <ScannerPreview unavailable={AI_ENABLED && (status.isError || status.data?.available === false)} />;
}

function ScannerPreview({ unavailable }: { unavailable: boolean }) {
  const { t } = useLocalization();
  const { profile } = useAuth();
  const isAgeConfirmed = profile?.ageConfirmed === true;

  return (
    <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={{ width: 32 }} />
        <Text style={styles.headerTitle}>{t('scanner.title')}</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.betaContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Coming soon badge */}
        <View style={styles.betaBadge}>
          <Ionicons name="flask" size={14} color="#8B5FBF" />
          <Text style={styles.betaBadgeText}>{t('common.betaComingSoon')}</Text>
        </View>

        {/* Hero icon */}
        <View style={styles.heroIconWrapper}>
          <View style={styles.heroIconCircle}>
            <Ionicons name="scan" size={56} color="#8B5FBF" />
          </View>
          <View style={styles.lockBadge}>
            <Ionicons name="lock-closed" size={14} color="#FFFFFF" />
          </View>
        </View>

        <Text style={styles.betaTitle}>{t('scanner.aiTitle')}</Text>
        <Text style={styles.betaSubtitle}>
          {isAgeConfirmed
            ? t('scanner.intro')
            : t('ageGate.scannerIntro')}
        </Text>

        {/* Feature preview cards */}
        <View style={styles.featureList}>
          <View style={styles.featureCard}>
            <View style={styles.featureIconBox}>
              <Ionicons name="camera-outline" size={24} color="#8B5FBF" />
            </View>
            <View style={styles.featureText}>
              <Text style={styles.featureTitle}>{t('scanner.featureRecognitionTitle')}</Text>
              <Text style={styles.featureDesc}>
                {isAgeConfirmed
                  ? t('scanner.featureRecognition')
                  : t('ageGate.scannerRecognition')}
              </Text>
            </View>
          </View>

          <View style={styles.featureCard}>
            <View style={styles.featureIconBox}>
              <Ionicons name="flask-outline" size={24} color="#8B5FBF" />
            </View>
            <View style={styles.featureText}>
              <Text style={styles.featureTitle}>{t('scanner.featureRecipesTitle')}</Text>
              <Text style={styles.featureDesc}>
                {isAgeConfirmed
                  ? t('scanner.featureRecipes')
                  : t('ageGate.scannerRecipes')}
              </Text>
            </View>
          </View>

          <View style={styles.featureCard}>
            <View style={styles.featureIconBox}>
              <Ionicons name="star-outline" size={24} color="#8B5FBF" />
            </View>
            <View style={styles.featureText}>
              <Text style={styles.featureTitle}>{t('scanner.featureSaveTitle')}</Text>
              <Text style={styles.featureDesc}>{t('scanner.featureSave')}</Text>
            </View>
          </View>
        </View>

        <Text style={styles.betaNote}>{unavailable ? t('ai.unavailable') : t('scanner.betaNote')}</Text>
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
    alignItems: 'center',
    justifyContent: 'space-between',
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
  betaContent: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 32,
    paddingBottom: 48,
  },
  betaBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#1F2937',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    marginBottom: 32,
    borderWidth: 1,
    borderColor: '#8B5FBF44',
  },
  betaBadgeText: {
    color: '#8B5FBF',
    fontSize: 13,
    fontWeight: '600',
  },
  heroIconWrapper: {
    position: 'relative',
    marginBottom: 24,
  },
  heroIconCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#1F2937',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#8B5FBF44',
  },
  lockBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    backgroundColor: '#8B5FBF',
    borderRadius: 14,
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  betaTitle: {
    fontSize: 26,
    fontWeight: 'bold',
    color: '#FFFFFF',
    textAlign: 'center',
    marginBottom: 12,
  },
  betaSubtitle: {
    fontSize: 15,
    color: '#9CA3AF',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 36,
  },
  featureList: {
    width: '100%',
    gap: 16,
    marginBottom: 36,
  },
  featureCard: {
    backgroundColor: '#0F172A',
    borderRadius: 14,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
    borderWidth: 1,
    borderColor: '#1F2937',
  },
  featureIconBox: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#1F2937',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  featureText: {
    flex: 1,
  },
  featureTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 4,
  },
  featureDesc: {
    fontSize: 13,
    color: '#9CA3AF',
    lineHeight: 19,
  },
  betaNote: {
    fontSize: 13,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 19,
    fontStyle: 'italic',
  },
});
