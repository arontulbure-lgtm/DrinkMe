import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { User, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, signInWithCredential, AuthCredential } from 'firebase/auth';
import { auth } from '../config/firebase';
import { apiFetch, setApiToken } from '../lib/api';
import * as SecureStore from 'expo-secure-store';
import { BaseUser } from '../types/api';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  serverUserId: string | null;
  profile: BaseUser | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signInWithSocial: (credential: AuthCredential) => Promise<void>;
  logout: () => Promise<void>;
  getJwtToken: () => Promise<string | null>;
  refreshProfile: () => Promise<void>;
  setProfile: (profile: BaseUser | null) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [serverUserId, setServerUserId] = useState<string | null>(null);
  const [profile, setProfile] = useState<BaseUser | null>(null);

  const buildFallbackProfile = (firebaseUser: User, id: string): BaseUser => ({
    id,
    email: firebaseUser.email || `user+${id}@drinkme.app`,
    firstName: firebaseUser.displayName?.split(' ')[0],
    lastName: firebaseUser.displayName?.split(' ').slice(1).join(' ') || undefined,
    avatar: firebaseUser.photoURL || null,
  });

  const loadProfile = useCallback(
    async (uid: string, firebaseUser: User | null) => {
      try {
        const data = await apiFetch<BaseUser>(`/api/users/${uid}`);
        setProfile({ ...data, id: uid });
      } catch {
        if (firebaseUser) {
          setProfile(buildFallbackProfile(firebaseUser, uid));
        } else {
          setProfile(null);
        }
      }
    },
    []
  );

  // SEC-5: fiecare user folosește propriul Firebase UID ca serverUserId.
  // Mappingul anterior (email prefix → demo ID) a fost eliminat — era un risc de securitate.
  const resolveServerUid = (firebaseUser: User): string => firebaseUser.uid;

  // Restaurează JWT-ul din SecureStore la cold start (înainte de orice query)
  useEffect(() => {
    SecureStore.getItemAsync('jwt_token').then((stored) => {
      if (stored) setApiToken(stored);
    });
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);

      if (firebaseUser) {
        const serverUid = resolveServerUid(firebaseUser);
        setServerUserId(serverUid);
        try {
          const idToken = await firebaseUser.getIdToken();
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
          // Stochează JWT-ul semnat returnat de server (nu UID-ul brut)
          if (token) {
            await SecureStore.setItemAsync('jwt_token', token);
            setApiToken(token); // injectează în apiFetch pentru toate request-urile viitoare
          }
        } catch (error) {
          console.error('Failed to exchange Firebase token for JWT:', error);
        } finally {
          await loadProfile(serverUid, firebaseUser);
        }
      } else {
        setServerUserId(null);
        setApiToken(null); // curăță token-ul din apiFetch
        await SecureStore.deleteItemAsync('jwt_token');
        setProfile(null);
      }

      setIsLoading(false);
    });

    return unsubscribe;
  }, [loadProfile]);

  const signIn = async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password);
  };

  const signUp = async (email: string, password: string) => {
    await createUserWithEmailAndPassword(auth, email, password);
  };

  const signInWithSocial = async (credential: AuthCredential) => {
    await signInWithCredential(auth, credential);
  };

  const logout = async () => {
    await signOut(auth);
  };

  const getJwtToken = async (): Promise<string | null> => {
    return SecureStore.getItemAsync('jwt_token');
  };

  const refreshProfile = useCallback(async () => {
    if (!serverUserId) return;
    await loadProfile(serverUserId, user);
  }, [loadProfile, serverUserId, user]);

  return (
    <AuthContext.Provider value={{
      user,
      isLoading,
      isAuthenticated: !!user,
      serverUserId,
      profile,
      signIn,
      signUp,
      signInWithSocial,
      logout,
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
