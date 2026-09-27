import AsyncStorage from '@react-native-async-storage/async-storage';
import { refreshEntitlementFromRevenueCat } from './purchases';

const PAID_STATUS_KEY = 'paid_status_v2';

/** In-memory mirror of the persisted flag so repeated reads during a session are synchronous-fast. */
let cachedPaidStatus: boolean | null = null;

export async function setPaidStatus(isPaid: boolean): Promise<void> {
  cachedPaidStatus = isPaid;
  await AsyncStorage.setItem(PAID_STATUS_KEY, isPaid ? '1' : '0');
}

/** Reads the locally cached paid flag (AsyncStorage-backed, no network). */
export async function getPaidStatus(): Promise<boolean> {
  if (cachedPaidStatus !== null) return cachedPaidStatus;
  const raw = await AsyncStorage.getItem(PAID_STATUS_KEY);
  cachedPaidStatus = raw === '1';
  return cachedPaidStatus;
}

/**
 * Best-effort online refresh against RevenueCat, falling back to the cached/local value when
 * offline. Call this at cold start and on paywall entry so a lapsed subscription is caught, while
 * never hard-blocking offline-first usage (e.g. iPads with intermittent Wi-Fi).
 */
export async function refreshPaidStatusFromRevenueCat(): Promise<boolean> {
  const remoteStatus = await refreshEntitlementFromRevenueCat();
  if (remoteStatus === null) {
    return getPaidStatus();
  }
  await setPaidStatus(remoteStatus);
  return remoteStatus;
}
