import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalization } from '../context/LocalizationContext';
import { devHooks } from '../lib/devHooks';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  // Runs before the children remount, e.g. to drop cached data that may have caused the crash.
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  // Changing the key remounts the children from scratch on "Try again".
  resetKey: number;
}

// Catches render errors below it so a crash shows a recovery screen instead of a blank app.
// Must sit inside LocalizationProvider: the fallback uses useLocalization.
export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, resetKey: 0 };

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Only the error name and the component stack: the message can hold user data. Nothing leaves the device.
    console.error('[ErrorBoundary]', error?.name ?? 'Error', info.componentStack ?? '');
    // Development only: the device test log (devLogBridge.ts) gets the message and stack, redacted.
    if (__DEV__) devHooks.boundaryError?.(error, info.componentStack);
  }

  handleReset = () => {
    this.props.onReset?.();
    this.setState((prev) => ({ hasError: false, resetKey: prev.resetKey + 1 }));
  };

  render() {
    if (this.state.hasError) {
      return <ErrorFallback onReset={this.handleReset} />;
    }
    return <React.Fragment key={this.state.resetKey}>{this.props.children}</React.Fragment>;
  }
}

function ErrorFallback({ onReset }: { onReset: () => void }) {
  const { t } = useLocalization();
  return (
    <View style={styles.container}>
      <Ionicons name="warning-outline" size={48} color="#9CA3AF" />
      <Text style={styles.title}>{t('errorBoundary.title')}</Text>
      <Text style={styles.message}>{t('errorBoundary.message')}</Text>
      <TouchableOpacity
        style={styles.button}
        onPress={onReset}
        accessibilityRole="button"
        accessibilityLabel={t('common.retry')}
      >
        <Text style={styles.buttonText}>{t('common.retry')}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 16,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
  },
  message: {
    color: '#9CA3AF',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  button: {
    backgroundColor: '#8B5FBF',
    paddingHorizontal: 24,
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 8,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
