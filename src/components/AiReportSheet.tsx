import React, { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useLocalization } from '../context/LocalizationContext';
import { AI_REPORT_REASONS, reportAiOutput, type AiReport, type AiReportReason } from '../lib/ai';

type ReportTarget =
  | { kind: 'recipe'; recipeId: string; recipeName: string }
  | { kind: 'scan'; category?: string; status?: string };

type Props = { target: ReportTarget | null; onClose: () => void };

/** Lets the user report an AI answer (Google Play AI-generated content policy). */
export default function AiReportSheet({ target, onClose }: Props) {
  const { t } = useLocalization();
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');

  const close = () => { setState('idle'); onClose(); };
  const send = async (reason: AiReportReason) => {
    if (!target) return;
    setState('sending');
    try {
      await reportAiOutput({ ...target, reason } as AiReport);
      setState('sent');
    } catch {
      setState('failed');
    }
  };

  return (
    <Modal visible={target !== null} transparent animationType="slide" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close} accessibilityRole="button" accessibilityLabel={t('common.cancel')} />
      <SafeAreaView edges={['bottom']} style={styles.sheet}>
        <Text style={styles.title}>{state === 'sent' ? t('ai.report.sent') : t('ai.report.title')}</Text>
        {state === 'failed' && <Text style={styles.error}>{t('ai.report.failed')}</Text>}
        {state === 'sending' && <ActivityIndicator color="#8B5FBF" style={{ marginVertical: 16 }} />}
        {(state === 'idle' || state === 'failed') && AI_REPORT_REASONS.map((reason) => (
          <TouchableOpacity key={reason} style={styles.option} onPress={() => send(reason)} accessibilityRole="button">
            <Text style={styles.optionText}>{t(`ai.report.${reason}`)}</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity style={styles.cancel} onPress={close} accessibilityRole="button">
          <Text style={styles.cancelText}>{state === 'sent' ? t('common.close') : t('common.cancel')}</Text>
        </TouchableOpacity>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000000AA' },
  sheet: { backgroundColor: '#1F2937', borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 20, gap: 8 },
  title: { color: '#FFFFFF', fontSize: 17, fontWeight: '700', marginBottom: 8 },
  error: { color: '#EF4444', fontSize: 14 },
  option: { minHeight: 48, justifyContent: 'center', borderBottomWidth: 1, borderBottomColor: '#374151' },
  optionText: { color: '#FFFFFF', fontSize: 15 },
  cancel: { minHeight: 48, justifyContent: 'center', alignItems: 'center', marginTop: 4 },
  cancelText: { color: '#9CA3AF', fontSize: 15, fontWeight: '600' },
});
