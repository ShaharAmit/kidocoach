import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';

const STORAGE_KEY = 'kidocoach_referral_v1';
const CLICK_KEY = 'kidocoach_referral_click_v1';
const WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
// Must match normalizeAffiliateCode in functions/src/affiliateModel.ts.
const CODE = /^[a-z0-9][a-z0-9_-]{2,31}$/;

/** Partner link `?ref={code}`, kept until the family signs in (on the device only with consent). */
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

// Saving the link on the device needs consent in the EU/UK (ePrivacy; docs/WEB_ANALYTICS.md §7).
// Until the visitor accepts, it lives only in memory, so a sign-up in this visit is still credited.
let storageAllowed = false;
let memoryReferral: Referral | null = null;
let memoryClick: string | null = null;

function storedReferral(now: number): Referral | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return validReferral(value, now) ? value : null;
  } catch {
    return null;
  }
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    // Storage blocked: the in-memory copy still covers this visit.
    console.warn('[Referral] Could not save partner link:', error);
  }
}

function removeStored(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(CLICK_KEY);
  } catch {
    // Nothing saved.
  }
}

/**
 * Follows the consent banner ("analytics + partner credit"). Accept saves the in-memory link for
 * 60 days; no choice, Reject or GPC moves a saved link into memory for this visit and erases it from the device.
 */
export function setReferralStorageAllowed(allowed: boolean, now = Date.now()): void {
  storageAllowed = allowed;
  if (allowed) {
    if (memoryReferral && validReferral(memoryReferral, now) && !storedReferral(now)) {
      persist(STORAGE_KEY, JSON.stringify(memoryReferral));
    }
    if (memoryClick) persist(CLICK_KEY, memoryClick);
    return;
  }
  memoryReferral = readReferral(now);
  try {
    memoryClick = localStorage.getItem(CLICK_KEY) ?? memoryClick;
  } catch {
    // Storage blocked.
  }
  removeStored();
}

export function readReferral(now = Date.now()): Referral | null {
  return storedReferral(now) ?? (memoryReferral && validReferral(memoryReferral, now) ? memoryReferral : null);
}

/** First touch: a saved, unexpired referral is never replaced by a later partner link. */
export function captureReferral(search: string, now = Date.now()): void {
  const referral = parseReferral(search, now);
  if (!referral || readReferral(now)) return;
  memoryReferral = referral;
  if (storageAllowed) persist(STORAGE_KEY, JSON.stringify(referral));
}

/**
 * Counts a partner link visit for the partner's dashboard: at most once per browser, code and
 * UTC day, so reloads and in-site navigation don't inflate clicks.
 */
export function trackReferralClick(search: string, now = Date.now()): void {
  const code = parseReferral(search, now)?.code;
  if (!code) return;
  const marker = `${code}:${new Date(now).toISOString().slice(0, 10)}`;
  let saved: string | null = null;
  try {
    saved = storageAllowed ? localStorage.getItem(CLICK_KEY) : null;
  } catch {
    // Storage blocked: fall back to memory.
  }
  if (saved === marker || memoryClick === marker) return;
  memoryClick = marker;
  if (storageAllowed) persist(CLICK_KEY, marker);
  httpsCallable<{ code: string }, unknown>(functions, 'trackAffiliateClick')({ code })
    .catch((error: unknown) => console.warn('[Referral] Click not counted:', error));
}

function clearReferral(): void {
  memoryReferral = null;
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
export async function claimSavedReferral(now = Date.now()): Promise<ClaimStatus | null> {
  const referral = readReferral(now);
  if (!referral) return null;
  const result = await httpsCallable<{ code: string }, { status: ClaimStatus }>(
    functions, 'claimAffiliateReferral',
  )({ code: referral.code });
  clearReferral();
  return result.data.status;
}
