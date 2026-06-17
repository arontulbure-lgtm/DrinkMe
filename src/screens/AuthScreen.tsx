import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, Platform, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import { GoogleAuthProvider, OAuthProvider, AuthCredential } from 'firebase/auth';
import { useAuth } from '../context/AuthContext';
import { useLocalization } from '../context/LocalizationContext';
import Constants from 'expo-constants';

WebBrowser.maybeCompleteAuthSession();

// ── Google OAuth discovery document ──────────────────────────────────────────
const GOOGLE_DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

// ── Email / password validators ───────────────────────────────────────────────
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
    return 'Please enter a valid email address.';
  }
  const domain = lower.slice(atIdx + 1);
  if (!ALLOWED_EMAIL_DOMAINS.includes(domain)) {
    return 'Please use a personal email address (Gmail, Yahoo, Outlook, iCloud, etc.).';
  }
  return null;
}

function validatePassword(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters long.';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter.';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one digit.';
  if (!/[!@#$%^&*()\-_=+\[\]{};':",.<>/?`~\\|]/.test(password)) {
    return 'Password must contain at least one special character (e.g. !@#$%).';
  }
  return null;
}

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
            Alert.alert('Google Sign-In Error', 'No access token in response.');
          }
        }).catch((err) => {
          Alert.alert('Google Sign-In Error', err?.message ?? 'Token exchange failed');
        }).finally(() => setLoading(false));
      } else {
        Alert.alert('Google Sign-In Error', 'Missing code or verifier.');
        setLoading(false);
      }
    } else if (response.type === 'error') {
      Alert.alert('Google Sign-In Error', response.error?.message ?? 'Unknown error');
      setLoading(false);
    } else {
      setLoading(false);
    }
  }, [response]);

  // In Expo Go the redirect URI is exp:// which Google Cloud Console won't
  // accept as an authorized URI → show a disabled state with an explanation.
  if (IS_EXPO_GO) {
    return (
      <TouchableOpacity style={[styles.socialButton, styles.socialButtonDisabled]} disabled>
        <Ionicons name="logo-google" size={20} color="#6B7280" />
        <Text style={[styles.socialButtonText, { color: '#6B7280' }]}>
          Google Sign-In (not available in Expo Go)
        </Text>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity
      style={[styles.socialButton, (disabled || !request || loading) && styles.socialButtonDisabled]}
      onPress={() => { setLoading(true); promptAsync(); }}
      disabled={disabled || !request || loading}
    >
      {loading
        ? <ActivityIndicator color="#FFFFFF" size="small" />
        : <>
            <Ionicons name="logo-google" size={20} color="#FFFFFF" />
            <Text style={styles.socialButtonText}>Continue with Google</Text>
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
  const { signIn, signUp, signInWithSocial } = useAuth();
  const { t } = useLocalization();

  const handleSocialCredential = async (credential: AuthCredential) => {
    setIsSocialLoading(true);
    try {
      await signInWithSocial(credential);
    } catch (e: any) {
      Alert.alert('Sign-In Error', e.message);
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
    } catch (e: any) {
      if (e.code !== 'ERR_REQUEST_CANCELED') {
        Alert.alert('Apple Sign-In Error', e.message);
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
        Alert.alert('Invalid Email', emailError);
        return;
      }
      const passwordError = validatePassword(password);
      if (passwordError) {
        Alert.alert('Invalid Password', passwordError);
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
    } catch (error: any) {
      Alert.alert('Authentication Error', error.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.logo}>DrinkMe</Text>
        <Text style={styles.subtitle}>
          {isSignUp ? t('auth.subtitleSignUp') : t('auth.subtitleSignIn')}
        </Text>

        {/* Social buttons */}
        <View style={styles.socialContainer}>
          {/* Google — all platforms */}
          <GoogleAuthButton
            onCredential={handleSocialCredential}
            disabled={isSocialLoading}
          />

          {/* Apple — iOS only, native Apple-styled button (required by Apple HIG) */}
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
          <Text style={styles.dividerText}>sau</Text>
          <View style={styles.dividerLine} />
        </View>

        {/* Email / Password */}
        <View style={styles.form}>
          <TextInput
            style={styles.input}
            placeholder={t('auth.emailPlaceholder')}
            placeholderTextColor="#6B7280"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={styles.input}
            placeholder={t('auth.passwordPlaceholder')}
            placeholderTextColor="#6B7280"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />

          {/* Password hint shown only during sign-up */}
          {isSignUp && (
            <Text style={styles.passwordHint}>
              Min. 8 characters, one uppercase letter, one digit, one special character.
            </Text>
          )}

          <TouchableOpacity
            style={[styles.button, isLoading && styles.buttonDisabled]}
            onPress={handleEmailAuth}
            disabled={isLoading}
          >
            {isLoading
              ? <ActivityIndicator color="#FFFFFF" size="small" />
              : <Text style={styles.buttonText}>
                  {isSignUp ? t('auth.signUp') : t('auth.signIn')}
                </Text>}
          </TouchableOpacity>

          <TouchableOpacity style={styles.linkButton} onPress={() => setIsSignUp(!isSignUp)}>
            <Text style={styles.linkText}>
              {isSignUp ? t('auth.toggleToSignIn') : t('auth.toggleToSignUp')}
            </Text>
          </TouchableOpacity>
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
  linkButton: { alignItems: 'center', marginTop: 16 },
  linkText: { color: '#8B5FBF', fontSize: 14 },
});
