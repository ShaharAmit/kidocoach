import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { defineSecret, defineString } from 'firebase-functions/params';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import {
  discountCode, isLiveSubscription, NO_ACCESS, paddleApiBase, parsePriceIds, parseRevenueCatAccess,
  parseRevenueCatV2Access, transactionId, type WebAccess,
} from './billingModel';
import { resolveCheckoutAffiliate } from './affiliates';
import { normalizeEmail } from './affiliateModel';

const paddleApiKey = defineSecret('PADDLE_SANDBOX_API_KEY');
const revenueCatSecretKey = defineSecret('REVENUECAT_SECRET_API_KEY');
const revenueCatPaddleKey = defineString('REVENUECAT_PADDLE_PUBLIC_API_KEY', {
  description: 'Public API key of the Paddle web config in the SAME RevenueCat project as iOS/Android.',
});
const revenueCatProjectId = defineString('REVENUECAT_PROJECT_ID', {
  description: 'RevenueCat project id (proj...) shared by iOS, Android and the Paddle web app.',
});
const paddlePriceIds = defineString('PADDLE_PRICE_IDS', {
  description: 'Comma-separated recurring Paddle price ids sold on the website (pri_...).',
});

const REVENUECAT_API = 'https://api.revenuecat.com/v1';
const REVENUECAT_V2_API = 'https://api.revenuecat.com/v2';
const PLAN_CACHE_MS = 5 * 60 * 1000;
const LIVE_STATUSES = 'active,trialing,past_due,paused';
const callableOptions = { cors: true, secrets: [paddleApiKey, revenueCatSecretKey], timeoutSeconds: 30 };

export interface WebPlan {
  priceId: string;
  name: string;
  amount: number;
  currency: string;
  interval: string;
  intervalCount: number;
  trialDays: number | null;
}

interface PaddlePrice {
  id: string;
  status: string;
  unit_price: { amount: string; currency_code: string };
  billing_cycle: { interval: string; frequency: number } | null;
  trial_period: { interval: string; frequency: number } | null;
  product?: { name: string; status: string };
}

interface PaddleTransaction {
  id: string;
  status: string;
  customer_id: string | null;
  subscription_id: string | null;
  custom_data: Record<string, unknown> | null;
}

interface PaddleSubscription {
  id: string;
  status: string;
  custom_data: Record<string, unknown> | null;
}

let planCache: { key: string; at: number; plans: WebPlan[] } | null = null;

class PaddleApiError extends Error {}

async function paddle<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = paddleApiKey.value();
  const response = await fetch(`${paddleApiBase(key)}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Paddle-Version': '1' },
  });
  if (!response.ok) {
    throw new PaddleApiError(`Paddle ${init.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as { data: T }).data;
}

function requireParent(request: CallableRequest): { uid: string; email: string | null } {
  if (!request.auth || request.auth.token.firebase?.sign_in_provider === 'anonymous') {
    throw new HttpsError('unauthenticated', 'Sign in to your parent account first.');
  }
  return { uid: request.auth.uid, email: normalizeEmail(request.auth.token.email) };
}

function unavailable(context: string, error: unknown): HttpsError {
  console.error(`[Billing] ${context}:`, error);
  return new HttpsError('unavailable', 'Billing is temporarily unavailable. Please try again.');
}

async function revenueCatRequest(path: string, init: RequestInit): Promise<WebAccess> {
  const response = await fetch(`${REVENUECAT_API}${path}`, init);
  if (!response.ok) {
    throw new Error(`RevenueCat ${init.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return parseRevenueCatAccess(await response.json());
}

async function revenueCatV2<T>(path: string): Promise<T | null> {
  const response = await fetch(`${REVENUECAT_V2_API}/projects/${encodeURIComponent(revenueCatProjectId.value())}${path}`, {
    headers: { Authorization: `Bearer ${revenueCatSecretKey.value()}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`RevenueCat GET ${path} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

/** Entitlement across every store (Apple, Google, Paddle) for the Firebase UID = RevenueCat App User ID. */
async function getAccess(uid: string): Promise<WebAccess> {
  const customerPath = `/customers/${encodeURIComponent(uid)}`;
  const customer = await revenueCatV2<unknown>(customerPath);
  if (!customer || !parseRevenueCatV2Access(customer, null).active) return NO_ACCESS;
  return parseRevenueCatV2Access(customer, await revenueCatV2<unknown>(`${customerPath}/subscriptions`));
}

/** Imports a Paddle subscription (sub_) or transaction (txn_) into RevenueCat for the same UID. */
function importPaddlePurchase(uid: string, fetchToken: string): Promise<WebAccess> {
  const key = revenueCatPaddleKey.value();
  if (!key) throw new Error('REVENUECAT_PADDLE_PUBLIC_API_KEY is not configured.');
  return revenueCatRequest('/receipts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Platform': 'paddle' },
    body: JSON.stringify({ app_user_id: uid, fetch_token: fetchToken }),
  });
}

function customerRef(uid: string) {
  return getFirestore().collection('billing_customers').doc(uid);
}

async function findCustomerId(uid: string): Promise<string | null> {
  const id = (await customerRef(uid).get()).get('paddleCustomerId');
  return typeof id === 'string' ? id : null;
}

/**
 * The parent types their billing email in Paddle's checkout, so the Paddle customer is linked only
 * after a paid transaction that the server itself created for this UID.
 */
async function rememberCustomer(uid: string, customerId: string): Promise<void> {
  await customerRef(uid).set({ paddleCustomerId: customerId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

/** This family's chargeable subscriptions; one Paddle customer (email) may also pay for other accounts. */
async function liveSubscriptions(uid: string, customerId: string): Promise<PaddleSubscription[]> {
  const subscriptions = await paddle<PaddleSubscription[]>(
    `/subscriptions?customer_id=${encodeURIComponent(customerId)}&status=${LIVE_STATUSES}&per_page=50`,
  );
  return subscriptions.filter((subscription) =>
    subscription.custom_data?.app_user_id === uid && isLiveSubscription(subscription.status));
}

async function importLiveSubscriptions(uid: string, customerId: string | null): Promise<WebAccess | null> {
  if (!customerId) return null;
  let access: WebAccess | null = null;
  for (const subscription of await liveSubscriptions(uid, customerId)) {
    access = await importPaddlePurchase(uid, subscription.id);
  }
  return access;
}

function trialDays(trial: PaddlePrice['trial_period']): number | null {
  if (!trial) return null;
  const days = { day: 1, week: 7, month: 30, year: 365 }[trial.interval];
  return days ? days * trial.frequency : null;
}

async function loadPlans(): Promise<WebPlan[]> {
  const ids = parsePriceIds(paddlePriceIds.value());
  const key = ids.join(',');
  if (planCache?.key === key && Date.now() - planCache.at < PLAN_CACHE_MS) return planCache.plans;
  const prices = ids.length
    ? await paddle<PaddlePrice[]>(`/prices?id=${ids.join(',')}&include=product&per_page=50`)
    : [];
  const byId = new Map(prices.map((price) => [price.id, price]));
  const plans = ids.flatMap((id): WebPlan[] => {
    const price = byId.get(id);
    if (!price || price.status !== 'active' || !price.billing_cycle || price.product?.status !== 'active') return [];
    return [{
      priceId: price.id,
      name: price.product.name,
      amount: Number(price.unit_price.amount),
      currency: price.unit_price.currency_code.toLowerCase(),
      interval: price.billing_cycle.interval,
      intervalCount: price.billing_cycle.frequency,
      trialDays: trialDays(price.trial_period),
    }];
  });
  planCache = { key, at: Date.now(), plans };
  return plans;
}

export const getWebBilling = onCall(callableOptions, async (request) => {
  const { uid } = requireParent(request);
  try {
    const [access, plans] = await Promise.all([getAccess(uid), loadPlans()]);
    return { access, plans };
  } catch (error) {
    throw unavailable('Could not load billing', error);
  }
});

/** Creates the Paddle transaction server-side so app_user_id and the partner code can't be tampered with. */
export const createPaddleCheckout = onCall(callableOptions, async (request) => {
  const { uid, email } = requireParent(request);
  const priceId = typeof request.data?.priceId === 'string' ? request.data.priceId : '';
  const rawCode = request.data?.discountCode;
  const code = discountCode(rawCode);
  if (typeof rawCode === 'string' && rawCode.trim() && !code) {
    throw new HttpsError('invalid-argument', 'This coupon code is not valid.');
  }

  let plans: WebPlan[];
  let access: WebAccess;
  try {
    [plans, access] = await Promise.all([loadPlans(), getAccess(uid)]);
  } catch (error) {
    throw unavailable('Could not prepare checkout', error);
  }
  if (!plans.some((plan) => plan.priceId === priceId)) {
    throw new HttpsError('invalid-argument', 'This plan is no longer available. Refresh and try again.');
  }
  // One paying family: a subscription bought on any device (Apple, Google or web) blocks another one.
  if (access.active) {
    throw new HttpsError('already-exists', 'This account already has an active subscription.');
  }

  try {
    if ((await importLiveSubscriptions(uid, await findCustomerId(uid)))?.active) {
      throw new HttpsError('already-exists', 'This account already has an active web subscription.');
    }
    let discountId: string | undefined;
    if (code) {
      const found = await paddle<{ id: string }[]>(`/discounts?code=${encodeURIComponent(code)}&status=active`);
      if (!found[0]) throw new HttpsError('invalid-argument', 'This coupon code is not valid or has expired.');
      discountId = found[0].id;
    }
    const affiliateCode = await resolveCheckoutAffiliate(uid, email, request.data?.referral, code);
    const transaction = await paddle<PaddleTransaction>('/transactions', {
      method: 'POST',
      body: JSON.stringify({
        items: [{ price_id: priceId, quantity: 1 }],
        ...(discountId ? { discount_id: discountId } : {}),
        // RevenueCat reads app_user_id; the affiliate webhook reads affiliate_code (from the server-side
        // attribution, never the client). Paddle copies both to the subscription and its renewals.
        custom_data: { app_user_id: uid, ...(affiliateCode ? { affiliate_code: affiliateCode } : {}) },
      }),
    });
    return { transactionId: transaction.id };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw unavailable('Could not create checkout', error);
  }
});

/** Pushes the family's Paddle purchases to RevenueCat; called after checkout and on Refresh. */
export const syncPaddlePurchases = onCall(callableOptions, async (request) => {
  const { uid } = requireParent(request);
  const rawTransaction = request.data?.transactionId;
  const txnId = transactionId(rawTransaction);
  if (rawTransaction !== undefined && rawTransaction !== null && !txnId) {
    throw new HttpsError('invalid-argument', 'Invalid checkout transaction.');
  }
  try {
    let imported: WebAccess | null = null;
    if (txnId) {
      const transaction = await paddle<PaddleTransaction>(`/transactions/${txnId}`);
      if (transaction.custom_data?.app_user_id !== uid) {
        throw new HttpsError('permission-denied', 'This checkout belongs to a different account.');
      }
      if (transaction.status === 'paid' || transaction.status === 'completed') {
        if (transaction.customer_id) await rememberCustomer(uid, transaction.customer_id);
        imported = await importPaddlePurchase(uid, transaction.subscription_id ?? transaction.id);
      }
    }
    if (!imported?.active) imported = await importLiveSubscriptions(uid, await findCustomerId(uid));
    return { access: imported?.active ? imported : await getAccess(uid) };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw unavailable('Could not sync Paddle purchases', error);
  }
});

export const createPaddlePortal = onCall(callableOptions, async (request) => {
  const { uid } = requireParent(request);
  try {
    const customerId = await findCustomerId(uid);
    if (!customerId) throw new HttpsError('failed-precondition', 'No web subscription was found for this account.');
    const subscriptions = await liveSubscriptions(uid, customerId);
    const session = await paddle<{ urls: { general: { overview: string } } }>(
      `/customers/${encodeURIComponent(customerId)}/portal-sessions`,
      { method: 'POST', body: JSON.stringify({ subscription_ids: subscriptions.map((s) => s.id) }) },
    );
    return { url: session.urls.general.overview };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw unavailable('Could not open the Paddle customer portal', error);
  }
});

/** Account deletion: stop web charges and forget the Paddle customer mapping. Store subscriptions stay with Apple/Google. */
export async function cancelPaddleBilling(uid: string): Promise<void> {
  const customerId = await findCustomerId(uid);
  if (!customerId) return;
  for (const subscription of await liveSubscriptions(uid, customerId)) {
    await paddle(`/subscriptions/${subscription.id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ effective_from: 'immediately' }),
    });
  }
  await customerRef(uid).delete();
}

export { paddleApiKey };
