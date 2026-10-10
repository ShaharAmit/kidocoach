import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { httpsCallable } from 'firebase/functions';
import { signOut } from 'firebase/auth';
import { auth, ensureAuth, functions } from './firebase';
import { revokeSignInProviders } from './accountAuth';
import { clearLocalFamilySession } from './accountSession';
import { clearAllLocalCachedAssets } from './assetCacheService';
import { logOutPurchasesUser } from './purchases';
import { setPaidStatus } from './subscription';

/**
 * Permanently deletes the current family: provider grants (Apple/Google), all server data and the
 * Firebase Auth user (via the `deleteAccount` callable), then every local trace on this device.
 * Store subscriptions are NOT cancelled — Apple/Google own billing; the UI must say so.
 * Leaves the device signed in as a fresh guest, ready for onboarding.
 */
export async function deleteFamilyAccount(): Promise<void> {
  const user = await ensureAuth();
  await revokeSignInProviders(user);

  await httpsCallable<Record<string, never>, { deleted: true }>(functions, 'deleteAccount')({});

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
