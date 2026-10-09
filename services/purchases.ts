import { Platform } from 'react-native';
import Purchases, { CustomerInfo, PurchasesPackage } from 'react-native-purchases';
import { auth, ensureAuth } from './firebase';

/**
 * RevenueCat public SDK keys. Unlike Google Cloud / Gemini keys, RevenueCat's SDK keys are
 * meant to be embedded in client apps — they only allow purchase/entitlement operations scoped
 * to this app, never account or billing management. Replace these with the real keys from the
 * RevenueCat dashboard (Project Settings > API Keys) before shipping.
 */
const REVENUECAT_IOS_API_KEY =
  process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY ||
  'appl_VDcFodNHmkxScTABerxjQoXGVxs';

const REVENUECAT_ANDROID_API_KEY =
  process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY ||
  'goog_REPLACE_WITH_ANDROID_KEY';

let configured = false;
let initPromise: Promise<void> | null = null;

function currentApiKey(): string | null {
  const key = Platform.OS === 'ios' ? REVENUECAT_IOS_API_KEY : REVENUECAT_ANDROID_API_KEY;
  return !key || key.includes('REPLACE_WITH') ? null : key;
}

async function configurePurchases(): Promise<void> {
  const apiKey = currentApiKey();
  if (!apiKey) {
    console.warn('[Purchases] RevenueCat API key not configured yet — paywall will not load offerings.');
    return;
  }
  try {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      await Purchases.setLogLevel(Purchases.LOG_LEVEL.DEBUG);
    } else {
      await Purchases.setLogLevel(Purchases.LOG_LEVEL.WARN);
    }
    Purchases.configure({ apiKey });
    configured = true;
  } catch (err) {
    console.warn('[Purchases] Failed to configure RevenueCat:', err);
  }
}

/**
 * Configures the RevenueCat SDK once per app session. Safe to call multiple times and
 * concurrently (root layout + loading screen both call it on cold start) — callers share a
 * single in-flight configure so the native SDK is never configured twice.
 * The RevenueCat app user ID is bound to the Firebase UID via {@link identifyPurchasesUser}.
 */
export function initPurchases(): Promise<void> {
  if (configured) return Promise.resolve();
  if (!initPromise) {
    initPromise = configurePurchases().finally(() => {
      if (!configured) initPromise = null;
    });
  }
  return initPromise;
}

/**
 * KidoCoach has a single paid tier, so any active RevenueCat entitlement grants full access —
 * the entitlement identifier lives only in the RevenueCat dashboard and can be renamed there
 * without an app release. Revisit if a second, partial tier/add-on entitlement is ever added.
 */
export function hasPremiumEntitlement(info: CustomerInfo): boolean {
  return Object.keys(info.entitlements.active).length > 0;
}

export async function fetchOfferingPackages(): Promise<PurchasesPackage[]> {
  if (!configured) return [];
  try {
    const offerings = await Purchases.getOfferings();
    return offerings.current?.availablePackages ?? [];
  } catch (err) {
    console.warn('[Purchases] Failed to fetch offerings:', err);
    return [];
  }
}

/**
 * Purchases a package and returns whether the premium entitlement is now active. RevenueCat is
 * bound to the Firebase UID first so the subscription lands on (and follows) the family account.
 *
 * If the store account already owns the subscription (Apple's "already subscribed" sheet returns
 * the existing transaction; Google raises PRODUCT_ALREADY_PURCHASED), the receipt may still be
 * attached to another RevenueCat customer — e.g. an older anonymous ID. Re-buying never moves it,
 * so fall back to a restore, which transfers it per the dashboard's Restore behavior.
 */
export async function purchasePackageAndCheckEntitlement(pkg: PurchasesPackage): Promise<boolean> {
  await ensurePurchasesIdentity();
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    if (hasPremiumEntitlement(customerInfo)) return true;
    console.warn('[Purchases] Purchase completed without premium entitlement — restoring to transfer it.');
  } catch (err: any) {
    if (err?.code !== Purchases.PURCHASES_ERROR_CODE.PRODUCT_ALREADY_PURCHASED_ERROR) throw err;
    console.warn('[Purchases] Product already owned by this store account — restoring to transfer it.');
  }
  const restoredInfo = await Purchases.restorePurchases();
  const isEntitled = hasPremiumEntitlement(restoredInfo);
  if (!isEntitled) logEntitlementDiagnostics(restoredInfo);
  return isEntitled;
}

/** Restores prior store purchases onto the current Firebase UID and returns entitlement state. */
export async function restorePurchasesAndCheckEntitlement(): Promise<boolean> {
  await ensurePurchasesIdentity();
  const customerInfo = await Purchases.restorePurchases();
  const isEntitled = hasPremiumEntitlement(customerInfo);
  if (!isEntitled) logEntitlementDiagnostics(customerInfo);
  return isEntitled;
}

let identifyInFlight: { uid: string; promise: Promise<CustomerInfo | null> } | null = null;

/**
 * Binds RevenueCat's app user ID to the Firebase UID. Resolves server-fresh CustomerInfo when
 * the identity switched (logIn always hits the backend), or null when it already matched.
 * The first call from a RevenueCat anonymous ID aliases it, carrying prior purchases over.
 */
function identifyPurchasesUser(uid: string): Promise<CustomerInfo | null> {
  if (identifyInFlight?.uid === uid) return identifyInFlight.promise;
  const promise = (async () => {
    if ((await Purchases.getAppUserID()) === uid) return null;
    const { customerInfo } = await Purchases.logIn(uid);
    return customerInfo;
  })().finally(() => {
    if (identifyInFlight?.promise === promise) identifyInFlight = null;
  });
  identifyInFlight = { uid, promise };
  return promise;
}

/** Throws when RevenueCat is unavailable so a purchase never lands on the wrong customer. */
async function ensurePurchasesIdentity(): Promise<void> {
  await initPurchases();
  if (!configured) throw new Error('The store is not available right now. Please try again later.');
  try {
    const { uid } = await ensureAuth();
    await identifyPurchasesUser(uid);
  } catch (err) {
    console.warn('[Purchases] Failed to identify RevenueCat customer:', err);
    throw new Error('Could not reach the store. Check your connection and try again.');
  }
}

/**
 * Forwards RevenueCat CustomerInfo updates (renewals, expirations, purchases on another device)
 * as entitlement state — only when they belong to the current Firebase UID, so updates for a
 * pre-logIn anonymous or previous family customer are ignored. Requires {@link initPurchases}.
 */
export function addPremiumEntitlementListener(listener: (isEntitled: boolean) => void): () => void {
  if (!configured) return () => {};
  const handler = (info: CustomerInfo) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    Purchases.getAppUserID()
      .then((appUserId) => {
        if (appUserId === uid && auth.currentUser?.uid === uid) listener(hasPremiumEntitlement(info));
      })
      .catch((err) => console.warn('[Purchases] Failed to read RevenueCat app user ID:', err));
  };
  Purchases.addCustomerInfoUpdateListener(handler);
  return () => {
    Purchases.removeCustomerInfoUpdateListener(handler);
  };
}

function logEntitlementDiagnostics(info: CustomerInfo): void {
  console.warn('[Purchases] No active entitlement for current customer:', {
    appUserId: info.originalAppUserId,
    entitlements: Object.values(info.entitlements.all).map((entitlement) => ({
      identifier: entitlement.identifier,
      isActive: entitlement.isActive,
      productIdentifier: entitlement.productIdentifier,
      expirationDate: entitlement.expirationDate,
      isSandbox: entitlement.isSandbox,
    })),
    activeSubscriptions: info.activeSubscriptions,
    allPurchasedProductIdentifiers: info.allPurchasedProductIdentifiers,
  });
}

/**
 * Best-effort online check against RevenueCat for the current Firebase UID. Returns null
 * (instead of throwing) when the SDK isn't configured or the device is offline, so callers can
 * fall back to the cached local status — required for offline-first behavior on iPads with
 * intermittent Wi-Fi.
 *
 * A negative result is only trusted after a server fetch: the SDK's cached CustomerInfo still
 * carries the pre-renewal expiration date, so right after a trial/period rolls over (minutes in
 * sandbox) it reports the entitlement as expired even though the store renewed it.
 */
export async function refreshEntitlementFromRevenueCat(): Promise<boolean | null> {
  await initPurchases();
  if (!configured) return null;
  try {
    const { uid } = await ensureAuth();
    const identifiedInfo = await identifyPurchasesUser(uid);
    if (identifiedInfo) {
      const isEntitled = hasPremiumEntitlement(identifiedInfo);
      if (!isEntitled) logEntitlementDiagnostics(identifiedInfo);
      return isEntitled;
    }

    const cachedInfo = await Purchases.getCustomerInfo();
    if (hasPremiumEntitlement(cachedInfo)) return true;

    await Purchases.invalidateCustomerInfoCache();
    const freshInfo = await Purchases.getCustomerInfo();
    const isEntitled = hasPremiumEntitlement(freshInfo);
    if (!isEntitled) logEntitlementDiagnostics(freshInfo);
    return isEntitled;
  } catch (err) {
    console.warn('[Purchases] Failed to refresh entitlement from RevenueCat:', err);
    return null;
  }
}
