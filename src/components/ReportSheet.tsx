import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useLocalization } from '../context/LocalizationContext';
import { ReportReason, ReportTargetType } from '../types/api';

const REPORT_REASONS: ReportReason[] = ['spam', 'harassment', 'underage', 'dangerous_drinking', 'mislabeled_alcohol', 'other'];

interface ReportSheetProps {
  targetType: ReportTargetType;
  isPending: boolean;
  pendingReason?: ReportReason;
  errorMessage?: string;
  isDone: boolean;
  onSelect: (reason: ReportReason) => void;
  onClose: () => void;
}

// A list of reasons, because Android's Alert holds too few buttons. No Modal of its own: it always
// opens from inside another one (PostActionsSheet, or CommentDrawer), and iOS shows only one at a time.
export default function ReportSheet({ targetType, isPending, pendingReason, errorMessage, isDone, onSelect, onClose }: ReportSheetProps) {
  const { t } = useLocalization();

  if (isDone) {
    return (
      <>
        <Text style={styles.message}>{t('report.success')}</Text>
        <TouchableOpacity
          style={styles.closeButton}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        >
          <Text style={styles.closeButtonText}>{t('common.close')}</Text>
        </TouchableOpacity>
      </>
    );
  }

  // Only a post carries the flag this reason is about.
  const reasons = targetType === 'drink' ? REPORT_REASONS : REPORT_REASONS.filter((reason) => reason !== 'mislabeled_alcohol');

  return (
    <>
      <Text style={styles.title}>{t('report.title')}</Text>
      {!!errorMessage && <Text style={styles.errorText}>{errorMessage}</Text>}
      {reasons.map((reason) => (
        <TouchableOpacity
          key={reason}
          style={[styles.reasonRow, isPending && styles.rowDisabled]}
          onPress={() => onSelect(reason)}
          disabled={isPending}
          accessibilityRole="button"
          accessibilityLabel={t(`report.reason.${reason}`)}
        >
          <Text style={styles.reasonText}>{t(`report.reason.${reason}`)}</Text>
          {isPending && pendingReason === reason && <ActivityIndicator size="small" color="#FFFFFF" />}
        </TouchableOpacity>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  title: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  message: {
    color: '#FFFFFF',
    fontSize: 16,
    lineHeight: 22,
  },
  errorText: {
    color: '#EF4444',
    fontSize: 14,
    lineHeight: 20,
  },
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  rowDisabled: {
    opacity: 0.5,
  },
  reasonText: {
    color: '#FFFFFF',
    fontSize: 16,
  },
  closeButton: {
    backgroundColor: '#8B5FBF',
    borderRadius: 12,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
