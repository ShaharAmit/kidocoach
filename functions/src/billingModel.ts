/** Pure web-billing rules shared by the Paddle callables and their tests. */

export type BillingStore = 'app_store' | 'mac_app_store' | 'play_store' | 'stripe' | 'rc_billing' |
  'promotional' | 'amazon' | 'paddle' | 'unknown';

export interface WebAccess {
  active: boolean;
  store: BillingStore | null;
  expiresAt: string | null;
  managementUrl: string | null;
}

export const NO_ACCESS: WebAccess = { active: false, store: null, expiresAt: null, managementUrl: null };

/** Paddle statuses that already hold the family's single subscription (paused can be resumed). */
const LIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'paused']);
const KNOWN_STORES = new Set<BillingStore>(['app_store', 'mac_app_store', 'play_store', 'stripe', 'rc_billing',
  'promotional', 'amazon', 'paddle']);
const PRICE_ID = /^pri_[a-z0-9]{10,64}$/;
const DISCOUNT_CODE = /^[A-Za-z0-9]{1,32}$/;
const TRANSACTION_ID = /^txn_[a-z0-9]{10,64}$/;

/** Paddle discount codes: letters and numbers, up to 32 characters. */
export function discountCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return DISCOUNT_CODE.test(trimmed) ? trimmed : null;
}

export function transactionId(value: unknown): string | null {
  return typeof value === 'string' && TRANSACTION_ID.test(value) ? value : null;
}

/** Comma-separated `PADDLE_PRICE_IDS`; invalid entries fail loudly so a typo never sells nothing. */
export function parsePriceIds(raw: string): string[] {
  const ids = raw.split(',').map((id) => id.trim()).filter(Boolean);
  const invalid = ids.find((id) => !PRICE_ID.test(id));
  if (invalid) throw new Error(`Invalid Paddle price id in PADDLE_PRICE_IDS: ${invalid}`);
  return [...new Set(ids)];
}

/** Sandbox keys contain `_sdbx_`; everything else talks to the live API. */
export function paddleApiBase(apiKey: string): string {
  return apiKey.includes('_sdbx_') ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
}

export function isLiveSubscription(status: unknown): boolean {
  return typeof status === 'string' && LIVE_SUBSCRIPTION_STATUSES.has(status);
}

function isoDate(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

/** RevenueCat v2 timestamps are epoch milliseconds; ISO strings are accepted too. */
function epochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
}

/**
 * Reads RevenueCat's v2 customer (`active_entitlements`) plus its subscriptions list, used with a v2
 * secret key. Any active entitlement grants access; the store comes from the subscription giving it.
 */
export function parseRevenueCatV2Access(customer: unknown, subscriptions: unknown, now = Date.now()): WebAccess {
  const entitlements = (customer as { active_entitlements?: { items?: unknown } } | null)?.active_entitlements?.items;
  if (!Array.isArray(entitlements)) return NO_ACCESS;
  let lifetime = false;
  let until: number | null = null;
  for (const entitlement of entitlements as Record<string, unknown>[]) {
    if (!entitlement || typeof entitlement !== 'object') continue;
    if (entitlement.expires_at === null) lifetime = true;
    const expires = epochMs(entitlement.expires_at);
    if (expires !== null && expires > now && (until === null || expires > until)) until = expires;
  }
  if (!lifetime && until === null) return NO_ACCESS;
  const items = (subscriptions as { items?: unknown } | null)?.items;
  const source = (Array.isArray(items) ? items as Record<string, unknown>[] : [])
    .filter((subscription) => subscription?.gives_access === true)
    .sort((a, b) => (epochMs(b.current_period_ends_at) ?? Infinity) - (epochMs(a.current_period_ends_at) ?? Infinity))[0];
  const rawStore = source?.store;
  return {
    active: true,
    store: KNOWN_STORES.has(rawStore as BillingStore) ? rawStore as BillingStore : 'unknown',
    expiresAt: lifetime || until === null ? null : new Date(until).toISOString(),
    managementUrl: typeof source?.management_url === 'string' ? source.management_url : null,
  };
}

/**
 * Reads RevenueCat's v1 subscriber payload (returned by the v1 receipts import). Any active entitlement grants access (single paid tier,
 * same rule as `hasPremiumEntitlement` in the app), whatever store sold it.
 */
export function parseRevenueCatAccess(body: unknown, now = Date.now()): WebAccess {
  const subscriber = (body as { subscriber?: Record<string, unknown> } | null)?.subscriber;
  if (!subscriber || typeof subscriber !== 'object') return NO_ACCESS;
  const entitlements = (subscriber.entitlements ?? {}) as Record<string, Record<string, unknown>>;
  const subscriptions = (subscriber.subscriptions ?? {}) as Record<string, Record<string, unknown>>;
  const nonSubscriptions = (subscriber.non_subscriptions ?? {}) as Record<string, Record<string, unknown>[]>;
  let best: WebAccess = NO_ACCESS;
  for (const entitlement of Object.values(entitlements)) {
    if (!entitlement || typeof entitlement !== 'object') continue;
    const expires = isoDate(entitlement.expires_date);
    const grace = isoDate(entitlement.grace_period_expires_date);
    const until = [expires, grace].filter((date): date is string => Boolean(date))
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
    const lifetime = entitlement.expires_date === null;
    if (!lifetime && (!until || Date.parse(until) <= now)) continue;
    const product = typeof entitlement.product_identifier === 'string' ? entitlement.product_identifier : '';
    const rawStore = subscriptions[product]?.store ?? nonSubscriptions[product]?.[0]?.store;
    const store = KNOWN_STORES.has(rawStore as BillingStore) ? rawStore as BillingStore : 'unknown';
    const candidate: WebAccess = {
      active: true,
      store,
      expiresAt: lifetime ? null : until,
      managementUrl: typeof subscriber.management_url === 'string' ? subscriber.management_url : null,
    };
    if (!best.active || candidate.expiresAt === null ||
        (best.expiresAt !== null && Date.parse(candidate.expiresAt) > Date.parse(best.expiresAt))) {
      best = candidate;
    }
  }
  return best;
}
