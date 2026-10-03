import { Platform } from 'react-native';
import Purchases, { CustomerInfo, PurchasesPackage } from 'react-native-purchases';

/**
 * RevenueCat public SDK keys. Unlike Google Cloud / Gemini keys, RevenueCat's SDK keys are
 * meant to be embedded in client apps — they only allow purchase/entitlement operations scoped
 * to this app, never account or billing management. Replace these with the real keys from the
 * RevenueCat dashboard (Project Settings > API Keys) before shipping.
 */
const REVENUECAT_IOS_API_KEY =
  process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY ||
  process.env.EXPO_PUBLIC_REVENUECAT_API_KEY ||
  'test_CttHZCmUIMsxPYVtOvvOmLlXFFS';

const REVENUECAT_ANDROID_API_KEY =
  process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY ||
  process.env.EXPO_PUBLIC_REVENUECAT_API_KEY ||
  'test_CttHZCmUIMsxPYVtOvvOmLlXFFS';

/** Entitlement identifier configured in the RevenueCat dashboard for full app access. */
export const PREMIUM_ENTITLEMENT_ID = 'premium';

let configured = false;

function currentApiKey(): string | null {
  const key = Platform.OS === 'ios' ? REVENUECAT_IOS_API_KEY : REVENUECAT_ANDROID_API_KEY;
  return !key || key.includes('REPLACE_WITH') ? null : key;
}

/**
 * Configures the RevenueCat SDK once per app session. Safe to call multiple times.
 * Uses RevenueCat's default (anonymous, per-device) identity — restoring purchases relies on
 * the underlying Apple ID / Google account, matching the same-device-account subscription model.
 */
export async function initPurchases(): Promise<void> {
  if (configured) return;
  const apiKey = currentApiKey();
  if (!apiKey) {
    console.warn('[Purchases] RevenueCat API key not configured yet — paywall will not load offerings.');
    return;
  }
  try {
    await Purchases.configure({ apiKey });
    configured = true;
  } catch (err) {
    console.warn('[Purchases] Failed to configure RevenueCat:', err);
  }
}

export function hasPremiumEntitlement(info: CustomerInfo): boolean {
  return !!info.entitlements.active[PREMIUM_ENTITLEMENT_ID];
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

/** Purchases a package and returns whether the premium entitlement is now active. */
export async function purchasePackageAndCheckEntitlement(pkg: PurchasesPackage): Promise<boolean> {
  const { customerInfo } = await Purchases.purchasePackage(pkg);
  return hasPremiumEntitlement(customerInfo);
}

/** Restores prior purchases for the current Apple ID / Google account and returns entitlement state. */
export async function restorePurchasesAndCheckEntitlement(): Promise<boolean> {
  const customerInfo = await Purchases.restorePurchases();
  return hasPremiumEntitlement(customerInfo);
}

/**
 * Best-effort online check against RevenueCat. Returns null (instead of throwing) when the SDK
 * isn't configured yet or the device is offline, so callers can fall back to the cached local
 * status — required for offline-first behavior on iPads with intermittent Wi-Fi.
 */
export async function refreshEntitlementFromRevenueCat(): Promise<boolean | null> {
  if (!configured) return null;
  try {
    const customerInfo = await Purchases.getCustomerInfo();
    return hasPremiumEntitlement(customerInfo);
  } catch (err) {
    console.warn('[Purchases] Failed to refresh entitlement from RevenueCat:', err);
    return null;
  }
}
