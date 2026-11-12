import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { User, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, signInWithCredential, AuthCredential, EmailAuthProvider, reauthenticateWithCredential, sendEmailVerification, sendPasswordResetEmail } from 'firebase/auth';
import { auth } from '../config/firebase';
import { ApiError, DeletionOutcomeUnknownError, apiFetch, getApiToken, getSessionErrorKey, setApiToken, setStaleTokenHandler } from '../lib/api';
import { resetDrinkToggles } from '../lib/drinkToggleChains';
import * as SecureStore from 'expo-secure-store';
import { BaseUser, DeleteAccountResponse } from '../types/api';

// 'ready' also covers signed out. 'loading' and 'error' only happen with a Firebase user or at cold start.
// 'verification_required' only comes from the server's email_not_verified, so never with its flag off.
export type SessionStatus = 'loading' | 'ready' | 'error' | 'verification_required';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  // A Firebase user exists. Only sessionStatus 'ready' means the API session works too.
  isAuthenticated: boolean;
  sessionStatus: SessionStatus;
  sessionErrorKey: string;
  retrySession: () => void;
  sendVerificationEmail: () => Promise<void>;
  // Resolves to false while Firebase still reports the address as unconfirmed.
  confirmEmailVerified: () => Promise<boolean>;
  serverUserId: string | null;
  profile: BaseUser | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signInWithSocial: (credential: AuthCredential) => Promise<void>;
  // Rejects with the Firebase error; the caller decides what the user sees (never whether the account exists).
  sendPasswordReset: (email: string, languageCode?: string) => Promise<void>;
  logout: () => Promise<void>;
  // password is null for accounts with no password, such as Google.
  deleteAccount: (password: string | null) => Promise<DeleteAccountResponse>;
  // The same for an account refused with email_not_verified, which has no JWT.
  deleteUnverifiedAccount: (password: string | null) => Promise<DeleteAccountResponse>;
  // The email is confirmed, but the server needs a new sign-in. Shown once by AppNavigator.
  signInAgainNotice: boolean;
  clearSignInAgainNotice: () => void;
  // Sign-in was refused because this account was deleted. Shown once by AppNavigator.
  accountDeletedNotice: boolean;
  clearAccountDeletedNotice: () => void;
  getJwtToken: () => Promise<string | null>;
  refreshProfile: () => Promise<void>;
  setProfile: (profile: BaseUser | null) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Mutation callbacks outlive a logout and cancelQueries does not stop them. A callback that writes
// to the query cache calls this first, with the serverUserId it was created for.
export function isCurrentAuthUser(uid: string | null): boolean {
  return uid !== null && auth.currentUser?.uid === uid;
}

// apiFetch has no timeout. Without this a hung server would hold the spinner, where there is no Log out.
const SESSION_STEP_TIMEOUT_MS = 15000;
const DELETE_ACCOUNT_TIMEOUT_MS = 30000;
const STALE_TOKEN_REBUILD_INTERVAL_MS = 30000;

function withSessionTimeout<T>(promise: Promise<T>, timeoutMs = SESSION_STEP_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Session step timed out')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isAuthRefusal(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

function isAccountDeletedError(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'account_deleted';
}

function isEmailNotVerifiedError(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'email_not_verified';
}

function isSignInAgainError(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'sign_in_again';
}

// Firebase no longer accepts this session, for example after the account was deleted on another device.
// There is nothing to retry, so these sign out instead of showing the session error screen.
const ENDED_FIREBASE_SESSION_CODES = new Set(['auth/user-token-expired', 'auth/user-not-found']);

function isEndedFirebaseSession(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && ENDED_FIREBASE_SESSION_CODES.has(code);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('loading');
  const [sessionErrorKey, setSessionErrorKey] = useState('session.errorBody');
  const [serverUserId, setServerUserId] = useState<string | null>(null);
  const [profile, setProfileState] = useState<BaseUser | null>(null);
  const [accountDeletedNotice, setAccountDeletedNotice] = useState(false);
  const [signInAgainNotice, setSignInAgainNotice] = useState(false);
  const queryClient = useQueryClient();
  // undefined until the first auth event, so a session restored on cold start clears nothing.
  const lastUidRef = useRef<string | null | undefined>(undefined);
  // Each auth event or retry gets a new number, and older runs then change nothing.
  const generationRef = useRef(0);
  // Every SecureStore token operation runs through this chain, so a write and a later delete cannot reorder.
  const tokenStoreQueueRef = useRef<Promise<unknown>>(Promise.resolve());

  // A response that started before a confirmation, a notice or a saved name cannot undo it, and any of
  // those would otherwise bring a gate back in front of the user. needsName can truly return, when a
  // name is cleared in Edit Profile: that waits for the next launch rather than taking over the screen.
  const setProfile = useCallback((next: BaseUser | null) => {
    setProfileState((current) => {
      if (!next || !current || current.id !== next.id) return next;
      return {
        ...next,
        ageConfirmed: current.ageConfirmed === true ? true : next.ageConfirmed,
        needsName: current.needsName === false ? false : next.needsName,
        privacyNoticeVersion: Math.max(current.privacyNoticeVersion ?? 0, next.privacyNoticeVersion ?? 0) || null,
      };
    });
  }, []);

  // Timed out twice: the inner one frees the chain from a hung operation, the outer one frees a caller
  // waiting behind it. A timed-out operation can still finish later, out of order.
  const enqueueTokenStoreOperation = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const result = tokenStoreQueueRef.current.then(() => withSessionTimeout(operation()));
    tokenStoreQueueRef.current = result.catch(() => undefined);
    return withSessionTimeout(result);
  }, []);

  const deleteStoredToken = useCallback(async (): Promise<void> => {
    await enqueueTokenStoreOperation(() => SecureStore.deleteItemAsync('jwt_token')).catch((error) => {
      console.error('Failed to delete stored JWT:', error);
    });
  }, [enqueueTokenStoreOperation]);

  // SEC-5: fiecare user folosește propriul Firebase UID ca serverUserId.
  // Mappingul anterior (email prefix → demo ID) a fost eliminat — era un risc de securitate.
  const resolveServerUid = (firebaseUser: User): string => firebaseUser.uid;

  const exchangeFirebaseToken = async (firebaseUser: User, serverUid: string): Promise<string> => {
    const requestToken = async (forceRefresh: boolean): Promise<string> => {
      const idToken = await firebaseUser.getIdToken(forceRefresh);
      const { token } = await apiFetch<{ token: string }>('/api/auth/mobile', {
        method: 'POST',
        body: JSON.stringify({
          idToken,
          uid: serverUid,
          email: firebaseUser.email,
          displayName: firebaseUser.displayName,
          photoURL: firebaseUser.photoURL,
        }),
      });
      if (!token) throw new Error('Sign-in response had no token');
      return token;
    };
    try {
      return await requestToken(false);
    } catch (error) {
      if (!isEmailNotVerifiedError(error)) throw error;
      // A cached token can be older than the opened link, and that user should not see the verify screen.
      // A failed check keeps the server's answer, which is the one that decides.
      await firebaseUser.reload().catch(() => undefined);
      if (!firebaseUser.emailVerified) throw error;
      return requestToken(true);
    }
  };

  // serverUserId and profile are set only at the end, so no authenticated query runs without a JWT.
  const startSession = useCallback(
    async (firebaseUser: User, generation: number) => {
      const isStale = () => generation !== generationRef.current;
      const serverUid = resolveServerUid(firebaseUser);

      // A failed or timed-out read counts as no stored token.
      const storedToken = await enqueueTokenStoreOperation(() => SecureStore.getItemAsync('jwt_token')).catch(() => null);
      if (isStale()) return;

      try {
        try {
          const token = await withSessionTimeout(exchangeFirebaseToken(firebaseUser, serverUid));
          if (isStale()) return;
          // Stochează JWT-ul semnat returnat de server (nu UID-ul brut)
          setApiToken(token); // injectează în apiFetch pentru toate request-urile viitoare
          await enqueueTokenStoreOperation(() => SecureStore.setItemAsync('jwt_token', token)).catch((error) => {
            console.error('Failed to store JWT:', error);
          });
        } catch (exchangeError) {
          if (isStale()) return;
          // The auth event from signOut ends the loading state. A failed signOut goes to the catch below.
          if (isAccountDeletedError(exchangeError) || isEndedFirebaseSession(exchangeError) || isSignInAgainError(exchangeError)) {
            await deleteStoredToken();
            if (isStale()) return;
            if (isAccountDeletedError(exchangeError)) setAccountDeletedNotice(true);
            if (isSignInAgainError(exchangeError)) setSignInAgainNotice(true);
            await signOut(auth);
            return;
          }
          if (isEmailNotVerifiedError(exchangeError)) {
            await deleteStoredToken();
            if (isStale()) return;
            setApiToken(null);
            setSessionStatus('verification_required');
            return;
          }
          // The server refused this Firebase user. The JWT goes too, so a later network failure cannot
          // use the fallback below to let them in.
          if (isAuthRefusal(exchangeError)) {
            await deleteStoredToken();
            throw exchangeError;
          }
          if (!storedToken) throw exchangeError;
          console.warn('Failed to exchange Firebase token for JWT, trying the stored one:', exchangeError);
          // The profile route, which the server allows before the 18+ confirmation for the account's own
          // id only. It requires a valid JWT, and only the owner's answer holds ageConfirmed, so that field
          // shows the JWT is this user's. The header is explicit so the token becomes global only after it has passed.
          try {
            const ownProfile = await withSessionTimeout(
              apiFetch<BaseUser>(`/api/users/${serverUid}`, {
                headers: { Authorization: `Bearer ${storedToken}` },
              })
            );
            if (typeof ownProfile?.ageConfirmed !== 'boolean') throw new ApiError('Stored JWT belongs to another user', 401);
          } catch (storedTokenError) {
            if (!isAuthRefusal(storedTokenError)) throw storedTokenError;
            if (!isStale()) await deleteStoredToken();
            // The rejected JWT is only a side effect; the exchange failure is the real cause.
            throw exchangeError;
          }
          if (isStale()) return;
          setApiToken(storedToken);
        }
        if (isStale()) return;

        const data = await withSessionTimeout(apiFetch<BaseUser>(`/api/users/${serverUid}`));
        if (isStale()) return;
        setProfile({ ...data, id: serverUid });
        setServerUserId(serverUid);
        setSessionStatus('ready');
      } catch (error) {
        if (isStale()) return;
        console.error('Failed to start session:', error);
        setApiToken(null);
        setSessionErrorKey(getSessionErrorKey(error));
        setSessionStatus('error');
      }
    },
    [deleteStoredToken, enqueueTokenStoreOperation, setProfile]
  );

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      const nextUid = firebaseUser ? resolveServerUid(firebaseUser) : null;
      if (lastUidRef.current !== undefined && lastUidRef.current !== nextUid) {
        // Same tick as the state updates below, so no screen renders or fetches between them.
        // Not awaited: cancelQueries rejects each fetch before it returns, so a late response is
        // dropped, and an await here would let a later auth event overtake this one.
        setApiToken(null);
        void (async () => queryClient.cancelQueries())().catch(() => undefined);
        resetDrinkToggles();
        queryClient.clear();
      }
      lastUidRef.current = nextUid;
      generationRef.current += 1;

      setUser(firebaseUser);
      setServerUserId(null);
      setProfile(null);

      if (firebaseUser) {
        setSessionStatus('loading');
        await startSession(firebaseUser, generationRef.current);
      } else {
        setSessionStatus('ready');
        setApiToken(null); // curăță token-ul din apiFetch
        await deleteStoredToken();
      }
    });

    return unsubscribe;
  }, [deleteStoredToken, queryClient, setProfile, startSession]);

  const retrySession = useCallback(() => {
    if (!auth.currentUser) return;
    generationRef.current += 1;
    setApiToken(null);
    setSessionStatus('loading');
    void startSession(auth.currentUser, generationRef.current);
  }, [startSession]);

  // A 401 on the JWT in use while the app is open: its session generation was logged out by a verified
  // sign-in elsewhere, the account is gone, or it expired. The new exchange gives a fresh JWT to the owner
  // and ends on the sign-in screen (sign_in_again) or the session error screen otherwise. Only a ready
  // session is rebuilt: a failure while one starts already ends on the error screen. At most one rebuild
  // per STALE_TOKEN_REBUILD_INTERVAL_MS, so a server that keeps answering 401 cannot start a loop.
  const sessionStatusRef = useRef<SessionStatus>(sessionStatus);
  const lastStaleRebuildAtRef = useRef(0);
  useEffect(() => {
    sessionStatusRef.current = sessionStatus;
  }, [sessionStatus]);
  useEffect(() => {
    setStaleTokenHandler(() => {
      if (sessionStatusRef.current !== 'ready' || !auth.currentUser) return false;
      const now = Date.now();
      if (now - lastStaleRebuildAtRef.current < STALE_TOKEN_REBUILD_INTERVAL_MS) return false;
      lastStaleRebuildAtRef.current = now;
      // Also blocks a second call in the same tick, before the status effect has run.
      sessionStatusRef.current = 'loading';
      retrySession();
      return true;
    });
    return () => setStaleTokenHandler(null);
  }, [retrySession]);

  const sendVerificationEmail = useCallback(async (): Promise<void> => {
    if (!auth.currentUser) throw new Error('No active session');
    await withSessionTimeout(sendEmailVerification(auth.currentUser));
  }, []);

  // reload and getIdToken keep the same uid, so neither causes an auth event; retrySession does the rest.
  const confirmEmailVerified = useCallback(async (): Promise<boolean> => {
    const firebaseUser = auth.currentUser;
    if (!firebaseUser) return false;
    try {
      await withSessionTimeout(firebaseUser.reload());
      if (!firebaseUser.emailVerified) return false;
      await withSessionTimeout(firebaseUser.getIdToken(true));
    } catch (error) {
      if (!isEndedFirebaseSession(error)) throw error;
      if (isCurrentAuthUser(firebaseUser.uid)) await signOut(auth);
      return true;
    }
    if (isCurrentAuthUser(firebaseUser.uid)) retrySession();
    return true;
  }, [retrySession]);

  const signIn = async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password);
  };

  const signUp = async (email: string, password: string) => {
    await createUserWithEmailAndPassword(auth, email, password);
  };

  const signInWithSocial = async (credential: AuthCredential) => {
    await signInWithCredential(auth, credential);
  };

  // languageCode makes Firebase send the reset email in the app language. Timed out like the session
  // steps, so a hung request cannot keep the button spinning.
  const sendPasswordReset = async (email: string, languageCode?: string) => {
    // On purpose this also sets the language of later Firebase emails (e.g. verification).
    if (languageCode) auth.languageCode = languageCode;
    await withSessionTimeout(sendPasswordResetEmail(auth, email));
  };

  const logout = async () => {
    await signOut(auth);
  };

  const clearAccountDeletedNotice = useCallback(() => setAccountDeletedNotice(false), []);
  const clearSignInAgainNotice = useCallback(() => setSignInAgainNotice(false), []);

  // The fresh token is what the server asks for, so a stolen JWT alone cannot delete an account.
  const requestAccountDeletion = async (firebaseUser: User, path: string, password: string | null): Promise<DeleteAccountResponse> => {
    if (password !== null) {
      await reauthenticateWithCredential(firebaseUser, EmailAuthProvider.credential(firebaseUser.email ?? '', password));
    }
    const idToken = await firebaseUser.getIdToken(true);
    // From here a failure with no answer from the server, or a timeout, says nothing about what happened.
    try {
      return await withSessionTimeout(
        apiFetch<DeleteAccountResponse>(path, {
          method: 'POST',
          body: JSON.stringify({ idToken }),
        }),
        DELETE_ACCOUNT_TIMEOUT_MS
      );
    } catch (error) {
      if (!(error instanceof ApiError) || error.code === 'account_deletion_incomplete') {
        throw new DeletionOutcomeUnknownError();
      }
      throw error;
    }
  };

  const deleteAccount = async (password: string | null): Promise<DeleteAccountResponse> => {
    const firebaseUser = auth.currentUser;
    if (!firebaseUser || !serverUserId || firebaseUser.uid !== serverUserId) throw new Error('No active session');
    return requestAccountDeletion(firebaseUser, `/api/users/${serverUserId}/delete-account`, password);
  };

  const deleteUnverifiedAccount = async (password: string | null): Promise<DeleteAccountResponse> => {
    const firebaseUser = auth.currentUser;
    if (!firebaseUser) throw new Error('No active session');
    return requestAccountDeletion(firebaseUser, '/api/account/delete-unverified', password);
  };

  const getJwtToken = async (): Promise<string | null> => {
    // The token in use, not the stored copy, which can be older or belong to the previous session.
    return getApiToken();
  };

  // A failed refresh keeps the current profile.
  const refreshProfile = useCallback(async () => {
    if (!serverUserId) return;
    const generation = generationRef.current;
    try {
      const data = await apiFetch<BaseUser>(`/api/users/${serverUserId}`);
      if (generation === generationRef.current) setProfile({ ...data, id: serverUserId });
    } catch (error) {
      console.warn('Failed to refresh profile:', error);
    }
  }, [serverUserId, setProfile]);

  return (
    <AuthContext.Provider value={{
      user,
      isLoading: sessionStatus === 'loading',
      isAuthenticated: !!user,
      sessionStatus,
      sessionErrorKey,
      retrySession,
      sendVerificationEmail,
      confirmEmailVerified,
      serverUserId,
      profile,
      signIn,
      signUp,
      signInWithSocial,
      sendPasswordReset,
      logout,
      deleteAccount,
      deleteUnverifiedAccount,
      signInAgainNotice,
      clearSignInAgainNotice,
      accountDeletedNotice,
      clearAccountDeletedNotice,
      getJwtToken,
      refreshProfile,
      setProfile,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
