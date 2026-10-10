import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { httpsCallable } from 'firebase/functions';
import { signOut } from 'firebase/auth';
import { auth, ensureAuth, functions } from './firebase';
import { revokeAppleSignInWithPrompt, revokeGoogleSignIn } from './accountAuth';
import { clearLocalFamilySession } from './accountSession';
import { clearAllLocalCachedAssets } from './assetCacheService';
import { logOutPurchasesUser } from './purchases';
import { setPaidStatus } from './subscription';

const deleteAccountCallable = httpsCallable<{ appleTokenRevoked?: true }, { deleted: true }>(functions, 'deleteAccount');

function isAppleReauthRequired(err: unknown): boolean {
  const { code, details } = (err ?? {}) as { code?: unknown; details?: { reason?: unknown } };
  return code === 'functions/failed-precondition' && details?.reason === 'apple-reauth-required';
}

/**
 * Permanently deletes the current family: provider grants (Apple/Google), all server data and the
 * Firebase Auth user (via the `deleteAccount` callable), then every local trace on this device.
 * The backend revokes Sign in with Apple using the refresh token stored at sign-in, so no Apple
 * prompt is shown; only accounts without a usable stored token see Apple's sheet once.
 * Store subscriptions are NOT cancelled — Apple/Google own billing; the UI must say so.
 * Leaves the device signed in as a fresh guest, ready for onboarding.
 */
export async function deleteFamilyAccount(): Promise<void> {
  const user = await ensureAuth();
  await revokeGoogleSignIn(user);

  try {
    await deleteAccountCallable({});
  } catch (err) {
    if (!isAppleReauthRequired(err)) throw err;
    await revokeAppleSignInWithPrompt();
    await deleteAccountCallable({ appleTokenRevoked: true });
  }

  await clearLocalFamilySession();
  await Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
  await clearAllLocalCachedAssets();
  await logOutPurchasesUser();
  await AsyncStorage.clear();
  await setPaidStatus(false);

  // The Auth user is already gone server-side; drop the stale local session.
  await signOut(auth).catch(() => {});
  await ensureAuth();
}
