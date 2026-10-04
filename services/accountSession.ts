import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { clearHomeBootstrap, primeHomeBootstrap } from './homeBootstrap';
import {
  clearChildProfile, fetchRecoverableChildProfile, getChildProfile, saveChildProfile, saveUserProfileDoc,
} from './profile';
import { completionStorageKey } from '../utils/dailyCompletion';
import { auth } from './firebase';
import { scheduleRoutineNotification } from './notifications';

export async function backUpCurrentFamily(): Promise<void> {
  const profile = await getChildProfile();
  if (profile) await saveUserProfileDoc(profile);
}

export async function clearLocalFamilySession(): Promise<void> {
  clearHomeBootstrap();
  await clearChildProfile();
  const notifications = await Notifications.getAllScheduledNotificationsAsync();
  for (const notification of notifications) {
    if (typeof notification.content.data?.routineId === 'string') {
      await Notifications.cancelScheduledNotificationAsync(notification.identifier);
    }
  }
  // Completion keys predate account linking and use shared morning/evening IDs.
  const keys = await AsyncStorage.getAllKeys();
  const completionKeys = keys.filter((key) => key.startsWith(completionStorageKey('')));
  if (completionKeys.length) await AsyncStorage.removeMany(completionKeys);
}

export async function recoverSignedInFamily(): Promise<boolean> {
  const user = auth.currentUser;
  if (!user || user.isAnonymous) throw new Error('Sign in to a linked parent account to recover setup.');
  const localProfile = await getChildProfile();
  if (auth.currentUser?.uid !== user.uid) throw new Error('The family account changed during recovery.');
  // Keep same-account offline state, but isolate an explicitly switched family before any network work.
  if (!localProfile) await clearLocalFamilySession();
  const recovered = await fetchRecoverableChildProfile(user.uid);
  if (!recovered) return false;
  if (auth.currentUser?.uid !== user.uid) throw new Error('The family account changed during recovery.');
  await saveChildProfile(recovered);
  const snapshot = await primeHomeBootstrap(user.uid);
  for (const routine of snapshot.routines) {
    // Notification IDs from Firestore belong to the original device.
    await scheduleRoutineNotification({ ...routine, notificationId: undefined });
  }
  return true;
}
