import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { getFunctions } from 'firebase/functions';
import * as FirebaseAuth from 'firebase/auth';
import { createAsyncStorage } from '@react-native-async-storage/async-storage';

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? '',
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ?? '',
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET ?? '',
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID ?? '',
};

// Prevent duplicate app initializations in hot-reload
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

export const db = getFirestore(app);
export const storage = getStorage(app);
// The SDK retries Storage metadata/URL calls on network errors for up to 2 minutes by default,
// which stalls boot on offline iPads. Callers already fall back to on-device copies.
storage.maxOperationRetryTime = 15_000;
export const functions = getFunctions(app);

const appStorage = createAsyncStorage('kids-routine-coach-auth');

const getReactNativePersistence = (
  FirebaseAuth as unknown as {
    getReactNativePersistence?: (storage: ReturnType<typeof createAsyncStorage>) => FirebaseAuth.Persistence;
  }
).getReactNativePersistence;

export const auth = (() => {
  try {
    if (typeof getReactNativePersistence === 'function') {
      return FirebaseAuth.initializeAuth(app, {
        persistence: getReactNativePersistence(appStorage),
      });
    }

    return FirebaseAuth.initializeAuth(app);
  } catch {
    // Auth may already be initialized during Fast Refresh.
    return FirebaseAuth.getAuth(app);
  }
})();

let anonymousSignIn: Promise<FirebaseAuth.User> | null = null;

/** Restores persisted auth first; concurrent callers share one guest sign-in. */
export async function ensureAuth(): Promise<FirebaseAuth.User> {
  await auth.authStateReady();
  if (auth.currentUser) return auth.currentUser;
  if (!anonymousSignIn) {
    anonymousSignIn = FirebaseAuth.signInAnonymously(auth)
      .then((credential) => credential.user)
      .finally(() => { anonymousSignIn = null; });
  }
  return anonymousSignIn;
}

export default app;
