import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';

const STORAGE_KEY = 'kidocoach_referral_v1';
const CLICK_KEY = 'kidocoach_referral_click_v1';
const WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
// Must match normalizeAffiliateCode in functions/src/affiliateModel.ts.
const CODE = /^[a-z0-9][a-z0-9_-]{2,31}$/;

/** Partner link `?ref={code}`, kept in this browser until the family signs in and checks out. */
export interface Referral {
  code: string;
  capturedAt: number;
}

export type ClaimStatus = 'claimed' | 'already_attributed' | 'invalid_code' | 'unknown_code' | 'inactive' |
  'self_referral' | 'existing_customer';

export function parseReferral(search: string, now = Date.now()): Referral | null {
  const code = new URLSearchParams(search).get('ref')?.trim().toLowerCase();
  return code && CODE.test(code) ? { code, capturedAt: now } : null;
}

export function validReferral(value: unknown, now = Date.now()): value is Referral {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<Referral>;
  return typeof r.code === 'string' && CODE.test(r.code) &&
    typeof r.capturedAt === 'number' && Number.isFinite(r.capturedAt) &&
    r.capturedAt <= now && now - r.capturedAt < WINDOW_MS;
}

export function readReferral(now = Date.now()): Referral | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return validReferral(value, now) ? value : null;
  } catch {
    return null;
  }
}

/** First touch: a saved, unexpired referral is never replaced by a later partner link. */
export function captureReferral(search: string, now = Date.now()): void {
  const referral = parseReferral(search, now);
  if (!referral || readReferral(now)) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(referral));
  } catch (error) {
    // Storage blocked: the code still reaches checkout if the parent buys in this visit via the URL.
    console.warn('[Referral] Could not save partner link:', error);
  }
}

/**
 * Counts a partner link visit for the partner's dashboard: at most once per browser, code and
 * UTC day, so reloads and in-site navigation don't inflate clicks.
 */
export function trackReferralClick(search: string, now = Date.now()): void {
  const code = parseReferral(search, now)?.code;
  if (!code) return;
  const marker = `${code}:${new Date(now).toISOString().slice(0, 10)}`;
  try {
    if (localStorage.getItem(CLICK_KEY) === marker) return;
    localStorage.setItem(CLICK_KEY, marker);
  } catch {
    // Storage blocked: count it anyway.
  }
  httpsCallable<{ code: string }, unknown>(functions, 'trackAffiliateClick')({ code })
    .catch((error: unknown) => console.warn('[Referral] Click not counted:', error));
}

function clearReferral(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing saved.
  }
}

/**
 * Attaches the saved referral to the signed-in parent account (server-side, first touch).
 * The saved code is dropped once the server gives a final answer; network errors keep it for a retry.
 */
export async function claimSavedReferral(): Promise<ClaimStatus | null> {
  const referral = readReferral();
  if (!referral) return null;
  const result = await httpsCallable<{ code: string }, { status: ClaimStatus }>(
    functions, 'claimAffiliateReferral',
  )({ code: referral.code });
  clearReferral();
  return result.data.status;
}
