import { httpsCallable } from 'firebase/functions';
import { auth, functions } from './firebase';
import { openPaddleCheckout } from './paddle';
import { readReferral } from './referral';

export type BillingStore = 'app_store' | 'mac_app_store' | 'play_store' | 'stripe' | 'rc_billing' |
  'promotional' | 'amazon' | 'paddle' | 'unknown';

export interface WebAccess {
  active: boolean;
  store: BillingStore | null;
  expiresAt: string | null;
  managementUrl: string | null;
}

export interface WebPlan {
  priceId: string;
  name: string;
  amount: number;
  currency: string;
  interval: string;
  intervalCount: number;
  trialDays: number | null;
}

const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx',
  'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

function requireParent(uid: string): void {
  if (auth.currentUser?.uid !== uid || auth.currentUser.isAnonymous) {
    throw new Error('Sign in to your parent account before managing a subscription.');
  }
}

function assertSameUser(uid: string): void {
  if (auth.currentUser?.uid !== uid) throw new Error('Your account changed. Please try again.');
}

export function formatPlanPrice(plan: WebPlan, locale?: string): string {
  const amount = ZERO_DECIMAL.has(plan.currency) ? plan.amount : plan.amount / 100;
  const price = new Intl.NumberFormat(locale, { style: 'currency', currency: plan.currency.toUpperCase() })
    .format(amount);
  const every = plan.intervalCount === 1 ? plan.interval : `${plan.intervalCount} ${plan.interval}s`;
  return `${price} / ${every}`;
}

export function storeLabel(store: BillingStore | null): string {
  switch (store) {
    case 'app_store': case 'mac_app_store': return 'the App Store';
    case 'play_store': return 'Google Play';
    case 'paddle': case 'stripe': case 'rc_billing': return 'the website';
    case 'promotional': return 'a KidoCoach promotion';
    default: return 'another store';
  }
}

export async function loadBilling(uid: string): Promise<{ access: WebAccess; plans: WebPlan[] }> {
  requireParent(uid);
  const result = await httpsCallable<void, { access: WebAccess; plans: WebPlan[] }>(functions, 'getWebBilling')();
  assertSameUser(uid);
  return result.data;
}

/**
 * Creates the Paddle transaction on the server, then opens Paddle's checkout overlay.
 * Resolves with the paid transaction id, or null if the parent closed checkout.
 */
export async function startCheckout(uid: string, priceId: string, coupon: string): Promise<string | null> {
  requireParent(uid);
  const result = await httpsCallable<
    { priceId: string; discountCode?: string; referral?: string }, { transactionId: string }
  >(functions, 'createPaddleCheckout')({
    priceId,
    discountCode: coupon.trim() || undefined,
    // The server only uses this to claim a first attribution; checkout trusts its own record.
    referral: readReferral()?.code,
  });
  assertSameUser(uid);
  return openPaddleCheckout(result.data.transactionId, auth.currentUser?.email);
}

/** Imports the family's Paddle purchase into RevenueCat so the apps unlock right away. */
export async function syncPurchases(uid: string, transactionId?: string): Promise<WebAccess> {
  requireParent(uid);
  const result = await httpsCallable<{ transactionId?: string }, { access: WebAccess }>(
    functions, 'syncPaddlePurchases',
  )(transactionId ? { transactionId } : {});
  assertSameUser(uid);
  return result.data.access;
}

export async function openBillingPortal(uid: string): Promise<string> {
  requireParent(uid);
  const result = await httpsCallable<void, { url: string }>(functions, 'createPaddlePortal')();
  assertSameUser(uid);
  return result.data.url;
}
