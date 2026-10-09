import AsyncStorage from '@react-native-async-storage/async-storage';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from './firebase';
import { addPremiumEntitlementListener, initPurchases, refreshEntitlementFromRevenueCat } from './purchases';

const PAID_STATUS_KEY = 'paid_status_v2';

/** In-memory mirror of the persisted flag so repeated reads during a session are synchronous-fast. */
let cachedPaidStatus: boolean | null = null;
let refreshInFlight: { uid: string | null; promise: Promise<boolean> } | null = null;

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
 * never hard-blocking offline-first usage (e.g. iPads with intermittent Wi-Fi). Concurrent callers
 * for the same Firebase UID share one request; a result is discarded if the UID changed mid-flight.
 */
export function refreshPaidStatusFromRevenueCat(): Promise<boolean> {
  const uid = auth.currentUser?.uid ?? null;
  if (refreshInFlight && refreshInFlight.uid === uid) return refreshInFlight.promise;
  const promise = (async (): Promise<boolean> => {
    const remoteStatus = await refreshEntitlementFromRevenueCat();
    if (remoteStatus === null || auth.currentUser?.uid !== uid) return getPaidStatus();
    await setPaidStatus(remoteStatus);
    return remoteStatus;
  })().finally(() => {
    if (refreshInFlight?.promise === promise) refreshInFlight = null;
  });
  refreshInFlight = { uid, promise };
  return promise;
}

let stopPaidStatusSync: (() => void) | null = null;

/**
 * Keeps the local paid flag in sync with RevenueCat for the lifetime of the app session:
 * re-checks whenever the Firebase UID changes (sign-in on a new device, family switch, sign-out)
 * and on RevenueCat CustomerInfo pushes. Positive pushes apply immediately; negative pushes are
 * re-verified against the server before downgrading. Idempotent.
 */
export function startPaidStatusSync(): () => void {
  if (stopPaidStatusSync) return stopPaidStatusSync;

  let stopped = false;
  let lastUid: string | null = null;
  let removeEntitlementListener: () => void = () => {};

  const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
    if (!user || user.uid === lastUid) return;
    lastUid = user.uid;
    void refreshPaidStatusFromRevenueCat();
  });

  initPurchases()
    .then(() => {
      if (stopped) return;
      removeEntitlementListener = addPremiumEntitlementListener((isEntitled) => {
        const sync = isEntitled ? setPaidStatus(true) : refreshPaidStatusFromRevenueCat();
        sync.catch((err) => console.warn('[Subscription] Failed to sync paid status:', err));
      });
    })
    .catch((err) => console.warn('[Subscription] Failed to start paid status sync:', err));

  stopPaidStatusSync = () => {
    stopped = true;
    unsubscribeAuth();
    removeEntitlementListener();
    stopPaidStatusSync = null;
  };
  return stopPaidStatusSync;
}
