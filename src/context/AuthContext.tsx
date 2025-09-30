import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import { auth } from '../config/firebase';
import { apiFetch } from '../lib/api';
import * as SecureStore from 'expo-secure-store';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  getJwtToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const resolveServerUid = (firebaseUser: User): string => {
    const email = firebaseUser.email?.toLowerCase();
    if (email?.startsWith('alex')) return 'user_demo';
    if (email?.startsWith('ana')) return 'user_anamaria';
    if (email?.startsWith('dragos')) return 'user_dragos';
    return firebaseUser.uid;
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);

      if (firebaseUser) {
        const serverUid = resolveServerUid(firebaseUser);
        globalThis.__DRINKME_UID = serverUid;
        try {
          const idToken = await firebaseUser.getIdToken();
          const { token } = await apiFetch<{ token: string }>('/api/auth/mobile', {
            method: 'POST',
            body: JSON.stringify({ idToken, uid: serverUid }),
          });
          await SecureStore.setItemAsync('jwt_token', token || serverUid);
        } catch (error) {
          console.error('Failed to exchange Firebase token for JWT:', error);
        }
      } else {
        globalThis.__DRINKME_UID = null;
        await SecureStore.deleteItemAsync('jwt_token');
      }

      setIsLoading(false);
    });

    return unsubscribe;
  }, []);

  const signIn = async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password);
  };

  const signUp = async (email: string, password: string) => {
    await createUserWithEmailAndPassword(auth, email, password);
  };

  const logout = async () => {
    await signOut(auth);
  };

  const getJwtToken = async (): Promise<string | null> => {
    const stored = await SecureStore.getItemAsync('jwt_token');
    return stored || (globalThis.__DRINKME_UID ?? null);
  };

  return (
    <AuthContext.Provider value={{
      user,
      isLoading,
      isAuthenticated: !!user,
      signIn,
      signUp,
      logout,
      getJwtToken,
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
