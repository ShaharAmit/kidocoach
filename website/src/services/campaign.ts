const STORAGE_KEY = 'kidocoach_campaign_v1';
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// Paddle discount codes: letters and numbers, up to 32 characters.
const CODE = /^[A-Za-z0-9]{1,32}$/;

/** Coupon links only; partner `?ref=` links are handled by ./referral. */
export interface Campaign {
  discountCode: string;
  capturedAt: number;
}

export function parseCampaign(search: string, now = Date.now()): Campaign | null {
  const params = new URLSearchParams(search);
  const discount = params.get('discount_code') ?? params.get('coupon');
  if (!discount) return null;
  if (!CODE.test(discount)) throw new Error('This promotion link contains an invalid coupon code.');
  return { discountCode: discount, capturedAt: now };
}

export function validCampaign(value: unknown, now = Date.now()): value is Campaign {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<Campaign>;
  return typeof c.discountCode === 'string' && CODE.test(c.discountCode) &&
    typeof c.capturedAt === 'number' && Number.isFinite(c.capturedAt) &&
    c.capturedAt <= now && now - c.capturedAt < WINDOW_MS;
}

export function readCampaign(): Campaign | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return validCampaign(value) ? value : null;
  } catch (error) {
    console.warn('[Campaign] Could not read saved promotion:', error);
    return null;
  }
}

export function captureCampaign(search: string): void {
  const campaign = parseCampaign(search);
  if (!campaign) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(campaign));
  } catch (error) {
    console.warn('[Campaign] Could not save promotion:', error);
    throw new Error('Enable browser storage to keep this promotion while signing in.');
  }
}
