import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, Platform, ActivityIndicator, AccessibilityInfo,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import { GoogleAuthProvider, OAuthProvider, AuthCredential } from 'firebase/auth';
import { useAuth } from '../context/AuthContext';
import { useLocalization } from '../context/LocalizationContext';
import { getAuthErrorKey, getPasswordResetErrorKey, getSocialAuthErrorKey, isAuthCancellation } from '../lib/authErrors';
import {
  PASSWORD_RESET_COOLDOWN_MS,
  getCooldownRemainingSeconds,
  isValidEmailFormat,
  normalizeEmail,
} from '../lib/passwordReset';
import Constants from 'expo-constants';

WebBrowser.maybeCompleteAuthSession();

// ── Google OAuth discovery document ──────────────────────────────────────────
const GOOGLE_DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

// ── Email / password validators ───────────────────────────────────────────────
// Both return a translation key (auth.validation.*) or null.
const ALLOWED_EMAIL_DOMAINS = [
  'gmail.com', 'yahoo.com', 'yahoo.ro', 'yahoo.co.uk', 'yahoo.fr',
  'hotmail.com', 'hotmail.ro', 'hotmail.co.uk', 'outlook.com', 'outlook.ro',
  'icloud.com', 'me.com', 'mac.com',
  'live.com', 'live.ro', 'live.co.uk',
  'protonmail.com', 'proton.me',
  'mail.com', 'gmx.com', 'gmx.net',
  'zoho.com', 'aol.com', 'yandex.com', 'yandex.ru',
];

function validateEmail(email: string): string | null {
  const lower = email.toLowerCase().trim();
  const atIdx = lower.lastIndexOf('@');
  if (atIdx < 1 || atIdx === lower.length - 1) {
    return 'auth.validation.emailInvalid';
  }
  const domain = lower.slice(atIdx + 1);
  if (!ALLOWED_EMAIL_DOMAINS.includes(domain)) {
    return 'auth.validation.emailDomain';
  }
  return null;
}

function validatePassword(password: string): string | null {
  if (password.length < 8) return 'auth.validation.passwordLength';
  if (!/[A-Z]/.test(password)) return 'auth.validation.passwordUppercase';
  if (!/[0-9]/.test(password)) return 'auth.validation.passwordDigit';
  if (!/[!@#$%^&*()\-_=+\[\]{};':",.<>/?`~\\|]/.test(password)) {
    return 'auth.validation.passwordSpecial';
  }
  return null;
}

// ── Password reset cooldown ───────────────────────────────────────────────────
// Module scope, so the cooldown survives re-renders and AuthScreen remounts (sign out, sign in
// again). It resets on app restart, which is acceptable: Firebase rate-limits on its side too.
let passwordResetCooldownUntil = 0;

// ── Detect Expo Go ────────────────────────────────────────────────────────────
// Google OAuth via browser redirect does not work in Expo Go because the
// exp:// redirect URI cannot be registered in Google Cloud Console
// (it only accepts HTTPS URIs for web clients). Works fine in standalone builds.
const IS_EXPO_GO = Constants.appOwnership === 'expo';

// ── Google auth button ────────────────────────────────────────────────────────
function GoogleAuthButton({ onCredential, disabled }: {
  onCredential: (c: AuthCredential) => void;
  disabled: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const { t } = useLocalization();
  const webClientId = Constants.expoConfig?.extra?.googleWebClientId as string | undefined;

  const redirectUri = AuthSession.makeRedirectUri({ scheme: 'drinkme' });

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: webClientId ?? '',
      scopes: ['openid', 'profile', 'email'],
      // Token (implicit) flow is deprecated by Google — use Code + PKCE
      responseType: AuthSession.ResponseType.Code,
      usePKCE: true,
      redirectUri,
    },
    GOOGLE_DISCOVERY
  );

  useEffect(() => {
    if (!response) return;
    // Never show the raw OAuth error text: one neutral, translated message.
    const showGoogleError = () => Alert.alert(t('auth.googleErrorTitle'), t('auth.errors.google'));
    if (response.type === 'success') {
      // Code + PKCE: exchange the code for tokens
      const { code } = response.params;
      if (code && request?.codeVerifier) {
        AuthSession.exchangeCodeAsync(
          {
            clientId: webClientId ?? '',
            code,
            redirectUri,
            extraParams: { code_verifier: request.codeVerifier },
          },
          GOOGLE_DISCOVERY
        ).then((tokenResponse) => {
          const accessToken = tokenResponse.accessToken;
          if (accessToken) {
            const credential = GoogleAuthProvider.credential(null, accessToken);
            onCredential(credential);
          } else {
            showGoogleError();
          }
        }).catch(() => {
          showGoogleError();
        }).finally(() => setLoading(false));
      } else {
        showGoogleError();
        setLoading(false);
      }
    } else if (response.type === 'error') {
      showGoogleError();
      setLoading(false);
    } else {
      // cancel / dismiss: the user closed the browser, nothing to show.
      setLoading(false);
    }
    // Only a new response may run this: re-running it for the same response would exchange the code twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response]);

  // In Expo Go the redirect URI is exp:// which Google Cloud Console won't
  // accept as an authorized URI → show a disabled state with an explanation.
  if (IS_EXPO_GO) {
    return (
      <TouchableOpacity style={[styles.socialButton, styles.socialButtonDisabled]} disabled>
        <Ionicons name="logo-google" size={20} color="#6B7280" />
        <Text style={[styles.socialButtonText, { color: '#6B7280' }]}>
          {t('auth.googleUnavailableExpoGo')}
        </Text>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity
      style={[styles.socialButton, (disabled || !request || loading) && styles.socialButtonDisabled]}
      onPress={() => { setLoading(true); promptAsync(); }}
      disabled={disabled || !request || loading}
      accessibilityRole="button"
      accessibilityLabel={t('auth.continueWithGoogle')}
    >
      {loading
        ? <ActivityIndicator color="#FFFFFF" size="small" />
        : <>
            <Ionicons name="logo-google" size={20} color="#FFFFFF" />
            <Text style={styles.socialButtonText}>{t('auth.continueWithGoogle')}</Text>
          </>}
    </TouchableOpacity>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────
export default function AuthScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSocialLoading, setIsSocialLoading] = useState(false);
  // Forgot password (sign-in mode only)
  const [isResetMode, setIsResetMode] = useState(false);
  const [isSendingReset, setIsSendingReset] = useState(false);
  const [resetStatus, setResetStatus] = useState<{ key: string; tone: 'success' | 'error' } | null>(null);
  const [resetCooldownUntil, setResetCooldownUntil] = useState(passwordResetCooldownUntil);
  const [now, setNow] = useState(() => Date.now());
  // Blocks a second tap in the same tick, before isSendingReset has re-rendered the button.
  const resetInFlightRef = useRef(false);
  const { signIn, signUp, signInWithSocial, sendPasswordReset } = useAuth();
  const { t, locale } = useLocalization();

  const resetCooldownSeconds = getCooldownRemainingSeconds(resetCooldownUntil, now);

  // Ticks once a second while the cooldown runs, then stops.
  useEffect(() => {
    if (resetCooldownUntil <= Date.now()) return;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= resetCooldownUntil) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [resetCooldownUntil]);

  const handleSocialCredential = async (credential: AuthCredential) => {
    setIsSocialLoading(true);
    try {
      await signInWithSocial(credential);
    } catch (e: unknown) {
      if (!isAuthCancellation(e)) {
        // handleSocialCredential serves the Google button only; Apple has its own handler below.
        Alert.alert(t('auth.signInErrorTitle'), t(getSocialAuthErrorKey(e, 'google')));
      }
    } finally {
      setIsSocialLoading(false);
    }
  };

  const handleAppleSignIn = async () => {
    setIsSocialLoading(true);
    try {
      const result = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      const { identityToken } = result;
      if (!identityToken) throw new Error('No identity token from Apple');
      const provider = new OAuthProvider('apple.com');
      const credential = provider.credential({ idToken: identityToken });
      await signInWithSocial(credential);
    } catch (e: unknown) {
      if (!isAuthCancellation(e)) {
        Alert.alert(t('auth.appleErrorTitle'), t(getSocialAuthErrorKey(e, 'apple')));
      }
    } finally {
      setIsSocialLoading(false);
    }
  };

  const handleEmailAuth = async () => {
    if (!email || !password) {
      Alert.alert(t('auth.errorTitle'), t('auth.errorMessage'));
      return;
    }

    if (isSignUp) {
      const emailError = validateEmail(email);
      if (emailError) {
        Alert.alert(t('auth.invalidEmailTitle'), t(emailError));
        return;
      }
      const passwordError = validatePassword(password);
      if (passwordError) {
        Alert.alert(t('auth.invalidPasswordTitle'), t(passwordError));
        return;
      }
    }

    setIsLoading(true);
    try {
      if (isSignUp) {
        await signUp(email, password);
      } else {
        await signIn(email, password);
      }
    } catch (error: unknown) {
      Alert.alert(t('auth.errorTitle'), t(getAuthErrorKey(error)));
    } finally {
      setIsLoading(false);
    }
  };

  const openResetMode = () => {
    setResetStatus(null);
    setIsResetMode(true);
  };

  const closeResetMode = () => {
    setResetStatus(null);
    setIsResetMode(false);
  };

  const handleSendReset = async () => {
    if (resetInFlightRef.current || getCooldownRemainingSeconds(passwordResetCooldownUntil, Date.now()) > 0) return;
    const resetEmail = normalizeEmail(email);
    if (!isValidEmailFormat(resetEmail)) {
      setResetStatus({ key: 'auth.errors.invalidEmail', tone: 'error' });
      AccessibilityInfo.announceForAccessibility(t('auth.errors.invalidEmail'));
      return;
    }

    resetInFlightRef.current = true;
    setIsSendingReset(true);
    setResetStatus(null);
    let errorKey: string | null = null;
    try {
      await sendPasswordReset(resetEmail, locale);
    } catch (error: unknown) {
      // auth/user-not-found maps to null: the same confirmation as a real send.
      errorKey = getPasswordResetErrorKey(error);
    } finally {
      resetInFlightRef.current = false;
      setIsSendingReset(false);
    }

    // Every outcome starts the cooldown except the two where nothing can have been sent: an invalid
    // email and no network. A timeout or unknown failure may still have sent an email.
    if (errorKey !== 'auth.errors.invalidEmail' && errorKey !== 'auth.errors.network') {
      const started = Date.now();
      passwordResetCooldownUntil = started + PASSWORD_RESET_COOLDOWN_MS;
      setNow(started);
      setResetCooldownUntil(passwordResetCooldownUntil);
    }
    const statusKey = errorKey ?? 'auth.forgot.sent';
    setResetStatus({ key: statusKey, tone: errorKey === null ? 'success' : 'error' });
    AccessibilityInfo.announceForAccessibility(t(statusKey));
  };

  const handleEmailChange = (value: string) => {
    setEmail(value);
    // An old error no longer applies to the edited address; the confirmation stays.
    if (resetStatus?.tone === 'error') setResetStatus(null);
  };

  const isResetButtonDisabled = isSendingReset || resetCooldownSeconds > 0;
  const resetButtonLabel = resetCooldownSeconds > 0
    ? t('auth.forgot.resendIn', { seconds: resetCooldownSeconds })
    : t('auth.forgot.send');

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.logo}>{t('auth.title')}</Text>
        <Text style={styles.subtitle}>
          {isResetMode
            ? t('auth.forgot.title')
            : isSignUp ? t('auth.subtitleSignUp') : t('auth.subtitleSignIn')}
        </Text>

        {!isResetMode && (
          <>
            {/* Social buttons */}
            <View style={styles.socialContainer}>
              {/* Google — all platforms */}
              <GoogleAuthButton
                onCredential={handleSocialCredential}
                disabled={isSocialLoading}
              />

              {/* Apple — iOS only, native Apple-styled button (required by Apple HIG).
                  Its label is drawn by iOS in the device language, not by t(). */}
              {Platform.OS === 'ios' && (
                <AppleAuthentication.AppleAuthenticationButton
                  buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                  buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE_OUTLINE}
                  cornerRadius={8}
                  style={styles.appleButton}
                  onPress={handleAppleSignIn}
                />
              )}
            </View>

            {/* Divider */}
            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>{t('auth.or')}</Text>
              <View style={styles.dividerLine} />
            </View>
          </>
        )}

        {/* Email / Password */}
        <View style={styles.form}>
          {isResetMode && <Text style={styles.resetHint}>{t('auth.forgot.hint')}</Text>}

          <TextInput
            style={styles.input}
            placeholder={t('auth.emailPlaceholder')}
            placeholderTextColor="#6B7280"
            value={email}
            onChangeText={handleEmailChange}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            returnKeyType={isResetMode ? 'send' : 'default'}
            onSubmitEditing={isResetMode ? handleSendReset : undefined}
            accessibilityLabel={t('auth.emailPlaceholder')}
          />

          {isResetMode ? (
            <>
              <TouchableOpacity
                style={[styles.button, isResetButtonDisabled && styles.buttonDisabled]}
                onPress={handleSendReset}
                disabled={isResetButtonDisabled}
                accessibilityRole="button"
                accessibilityLabel={t('auth.forgot.send')}
                accessibilityHint={resetCooldownSeconds > 0 ? resetButtonLabel : undefined}
                accessibilityState={{ disabled: isResetButtonDisabled, busy: isSendingReset }}
              >
                {isSendingReset
                  ? <ActivityIndicator color="#FFFFFF" size="small" />
                  : <Text style={styles.buttonText}>{resetButtonLabel}</Text>}
              </TouchableOpacity>

              {resetStatus && (
                <Text
                  style={[styles.resetStatus, resetStatus.tone === 'error' && styles.resetStatusError]}
                  accessibilityLiveRegion="polite"
                >
                  {t(resetStatus.key)}
                </Text>
              )}

              <TouchableOpacity
                style={styles.linkButton}
                onPress={closeResetMode}
                accessibilityRole="button"
                accessibilityLabel={t('auth.forgot.back')}
              >
                <Text style={styles.linkText}>{t('auth.forgot.back')}</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TextInput
                style={styles.input}
                placeholder={t('auth.passwordPlaceholder')}
                placeholderTextColor="#6B7280"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={t('auth.passwordPlaceholder')}
              />

              {/* Password hint shown only during sign-up */}
              {isSignUp && (
                <Text style={styles.passwordHint}>
                  {t('auth.passwordHint')}
                </Text>
              )}

              {/* Forgot password shown only during sign-in */}
              {!isSignUp && (
                <TouchableOpacity
                  style={styles.forgotButton}
                  onPress={openResetMode}
                  accessibilityRole="button"
                  accessibilityLabel={t('auth.forgot.link')}
                >
                  <Text style={styles.linkText}>{t('auth.forgot.link')}</Text>
                </TouchableOpacity>
              )}

              <TouchableOpacity
                style={[styles.button, isLoading && styles.buttonDisabled]}
                onPress={handleEmailAuth}
                disabled={isLoading}
                accessibilityRole="button"
                accessibilityLabel={isSignUp ? t('auth.signUp') : t('auth.signIn')}
                accessibilityState={{ disabled: isLoading, busy: isLoading }}
              >
                {isLoading
                  ? <ActivityIndicator color="#FFFFFF" size="small" />
                  : <Text style={styles.buttonText}>
                      {isSignUp ? t('auth.signUp') : t('auth.signIn')}
                    </Text>}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.linkButton}
                onPress={() => setIsSignUp(!isSignUp)}
                accessibilityRole="button"
                accessibilityLabel={isSignUp ? t('auth.toggleToSignIn') : t('auth.toggleToSignUp')}
              >
                <Text style={styles.linkText}>
                  {isSignUp ? t('auth.toggleToSignIn') : t('auth.toggleToSignUp')}
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000000' },
  content: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  logo: {
    fontSize: 38, fontWeight: 'bold', color: '#8B5FBF',
    textAlign: 'center', marginBottom: 8,
  },
  subtitle: {
    fontSize: 16, color: '#9CA3AF',
    textAlign: 'center', marginBottom: 32,
  },
  socialContainer: { gap: 12, marginBottom: 24 },
  socialButton: {
    backgroundColor: '#1F2937', borderRadius: 8, padding: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  socialButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  socialButtonDisabled: { opacity: 0.5 },
  appleButton: { width: '100%', height: 48 },
  dividerRow: {
    flexDirection: 'row', alignItems: 'center', marginBottom: 24, gap: 12,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#374151' },
  dividerText: { color: '#6B7280', fontSize: 14 },
  form: { gap: 16 },
  input: {
    backgroundColor: '#1F2937', borderRadius: 8,
    padding: 16, color: '#FFFFFF', fontSize: 16,
  },
  passwordHint: {
    fontSize: 12,
    color: '#6B7280',
    lineHeight: 18,
    marginTop: -8,
  },
  button: {
    backgroundColor: '#8B5FBF', borderRadius: 8,
    padding: 16, alignItems: 'center', marginTop: 8,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  linkButton: { alignItems: 'center', marginTop: 16, minHeight: 44, justifyContent: 'center' },
  linkText: { color: '#8B5FBF', fontSize: 14 },
  forgotButton: {
    alignSelf: 'flex-end', marginTop: -8,
    minHeight: 44, justifyContent: 'center', paddingHorizontal: 4,
  },
  resetHint: { color: '#9CA3AF', fontSize: 14, lineHeight: 20, textAlign: 'center' },
  resetStatus: { color: '#FFFFFF', fontSize: 14, lineHeight: 20, textAlign: 'center' },
  resetStatusError: { color: '#EF4444' },
});
