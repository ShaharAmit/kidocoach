/**
 * Pure rules of the in-house affiliate program (no Firebase / network), shared by the callables,
 * the Paddle webhook, the admin script and the tests. All money is integer minor units (cents).
 */
import { createHmac, timingSafeEqual } from 'crypto';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A visitor's referral must be turned into a first payment within this window. */
export const ATTRIBUTION_WINDOW_DAYS = 60;
/** Commissions stay pending this long so refunds and chargebacks can void them before approval. */
export const COMMISSION_HOLD_DAYS = 30;
export const DEFAULT_COMMISSION_RATE_BPS = 1500;
/** Renewals earn commission for this many months after the referred family's first payment. */
export const DEFAULT_RECURRING_MONTHS = 12;
/** Replay protection for Paddle-Signature timestamps. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const AFFILIATE_CODE = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const COUPON_CODE = /^[A-Z0-9]{1,32}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PADDLE_ID = /^[a-z]{3}_[a-z0-9]{10,64}$/;

export type AffiliateStatus = 'active' | 'disabled';
export type AttributionSource = 'link' | 'coupon';
export type CommissionStatus = 'pending' | 'approved' | 'paid' | 'void';
export type ClaimRejection = 'invalid_code' | 'unknown_code' | 'inactive' | 'self_referral' | 'existing_customer';
export type Ineligibility = 'no_attribution' | 'code_mismatch' | 'affiliate_inactive' | 'before_claim' |
  'window_expired' | 'recurring_ended' | 'zero_amount';

export interface Affiliate {
  code: string;
  name: string;
  email: string;
  status: AffiliateStatus;
  commissionRateBps: number;
  recurringMonths: number;
  ownerUid: string | null;
  /** Partner-specific Paddle discount code; checkout with it attributes the family to this partner. */
  discountCode: string | null;
}

export interface Attribution {
  code: string;
  source: AttributionSource;
  claimedAt: number;
  /** Set by the first commissioned payment; starts the recurring window. */
  firstPaidAt: number | null;
}

export interface PaddleTransactionEvent {
  id: string;
  uid: string;
  affiliateCode: string | null;
  subscriptionId: string | null;
  origin: string;
  billedAt: number;
  currency: string;
  /** Amount the family paid before tax, after discounts (Paddle `total - tax`). */
  netAmount: number;
}

export interface PaddleAdjustmentEvent {
  id: string;
  transactionId: string;
  action: 'refund' | 'chargeback' | 'chargeback_reverse';
  status: string;
  /** Pre-tax adjusted amount (Paddle `totals.subtotal`). */
  subtotal: number;
  currency: string;
}

export interface Commission {
  code: string;
  uid: string;
  transactionId: string;
  subscriptionId: string | null;
  currency: string;
  netAmount: number;
  rateBps: number;
  amount: number;
  /** Sum of refunds/chargebacks taken back from `amount`. */
  reversed: number;
  /** What was already paid out to the partner (set by the payout script). */
  paidAmount: number;
  adjustmentIds: string[];
  status: CommissionStatus;
  billedAt: number;
  holdUntil: number;
}

/** Partner links use `?ref=`; codes are case-insensitive and stored lowercase. */
export function normalizeAffiliateCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase();
  return AFFILIATE_CODE.test(code) ? code : null;
}

/** Codes a partner can't pick for themselves (brand, support and route names). */
const RESERVED_CODES = new Set([
  'kidocoach', 'kido', 'kidocoach_app', 'admin', 'administrator', 'support', 'help', 'official', 'staff', 'team',
  'paddle', 'apple', 'google', 'revenuecat', 'test', 'null', 'undefined', 'partner', 'partners', 'affiliate',
  'affiliates', 'profile', 'privacy', 'terms', 'subscribe', 'pricing', 'billing', 'refund', 'discount', 'coupon',
]);

export type SelfServeCodeProblem = 'invalid_code' | 'reserved_code';

/** Why a partner may not choose this code themselves (null when it is acceptable; availability is separate). */
export function selfServeCodeProblem(value: unknown): SelfServeCodeProblem | null {
  const code = normalizeAffiliateCode(value);
  if (!code) return 'invalid_code';
  const bare = code.replace(/[_-]/g, '');
  if (RESERVED_CODES.has(code) || bare.includes('kidocoach') || RESERVED_CODES.has(bare)) return 'reserved_code';
  return null;
}

/** Public partner display name: 2-60 printable characters, no markup. */
export function normalizePartnerName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  return name.length >= 2 && name.length <= 60 && !/[<>\u0000-\u001f]/.test(name) ? name : null;
}

/** How a partner wants to be paid; both pay to `payoutEmail` (the recipient claims it with that email). */
export const PAYOUT_METHODS = ['paypal', 'wise'] as const;
export type PayoutMethod = typeof PAYOUT_METHODS[number];
export const DEFAULT_PAYOUT_METHOD: PayoutMethod = 'paypal';

export function normalizePayoutMethod(value: unknown): PayoutMethod | null {
  return typeof value === 'string' && (PAYOUT_METHODS as readonly string[]).includes(value.trim().toLowerCase())
    ? value.trim().toLowerCase() as PayoutMethod
    : null;
}

/** UTC calendar day `YYYY-MM-DD` used to bucket link clicks. */
export function clickDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Paddle discount codes are matched case-insensitively. */
export function normalizeCouponCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return COUPON_CODE.test(code) ? code : null;
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return EMAIL.test(email) && email.length <= 254 ? email : null;
}

function isRate(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= 5000;
}

/** Validates an `affiliates/{code}` document; anything malformed is treated as unknown. */
export function parseAffiliate(code: string, data: unknown): Affiliate | null {
  if (!data || typeof data !== 'object' || normalizeAffiliateCode(code) !== code) return null;
  const doc = data as Record<string, unknown>;
  const email = normalizeEmail(doc.email);
  if (typeof doc.name !== 'string' || !doc.name.trim() || !email) return null;
  if (doc.status !== 'active' && doc.status !== 'disabled') return null;
  const rate = doc.commissionRateBps ?? DEFAULT_COMMISSION_RATE_BPS;
  const months = doc.recurringMonths ?? DEFAULT_RECURRING_MONTHS;
  if (!isRate(rate) || !Number.isInteger(months) || (months as number) < 0 || (months as number) > 120) return null;
  return {
    code,
    name: doc.name.trim(),
    email,
    status: doc.status,
    commissionRateBps: rate,
    recurringMonths: months as number,
    ownerUid: typeof doc.ownerUid === 'string' && doc.ownerUid ? doc.ownerUid : null,
    discountCode: normalizeCouponCode(doc.discountCode),
  };
}

/** Why a family may not be attributed to this partner, or null when the claim is allowed. */
export function claimRejection(
  affiliate: Affiliate | null,
  family: { uid: string; email: string | null; isExistingCustomer: boolean },
): ClaimRejection | null {
  if (!affiliate) return 'unknown_code';
  if (affiliate.status !== 'active') return 'inactive';
  if (affiliate.ownerUid === family.uid || (family.email !== null && affiliate.email === family.email)) {
    return 'self_referral';
  }
  return family.isExistingCustomer ? 'existing_customer' : null;
}

/** Whether a fresh checkout may still carry the partner's code (first payment inside the window). */
export function isAttributionOpen(attribution: Attribution, now: number): boolean {
  return attribution.firstPaidAt !== null || now - attribution.claimedAt <= ATTRIBUTION_WINDOW_DAYS * DAY_MS;
}

/**
 * Paddle-Signature: `ts=<unix>;h1=<hex>[;h1=<hex>]`, HMAC-SHA256 of `${ts}:${rawBody}`.
 * Several h1 values may be present while Paddle rotates the secret.
 */
export function verifyPaddleSignature(
  header: unknown, rawBody: Buffer | string, secret: string, nowMs = Date.now(),
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  if (typeof header !== 'string' || !secret) return false;
  let ts: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(';')) {
    const [key, value] = part.split('=', 2).map((piece) => piece?.trim());
    if (key === 'ts' && value) ts = value;
    if (key === 'h1' && value && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  if (!ts || !/^\d{1,12}$/.test(ts) || !signatures.length) return false;
  if (Math.abs(nowMs / 1000 - Number(ts)) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret)
    .update(`${ts}:`)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest();
  return signatures.some((signature) => timingSafeEqual(Buffer.from(signature, 'hex'), expected));
}

function minorUnits(value: unknown): number | null {
  if (typeof value !== 'string' || !/^-?\d{1,15}$/.test(value)) return null;
  return Number(value);
}

function timestamp(value: unknown): number | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
}

/** Reads a `transaction.completed` payload; null when it isn't a KidoCoach family's charge. */
export function parsePaddleTransaction(data: unknown): PaddleTransactionEvent | null {
  if (!data || typeof data !== 'object') return null;
  const txn = data as Record<string, unknown>;
  const custom = (txn.custom_data ?? {}) as Record<string, unknown>;
  const totals = ((txn.details as Record<string, unknown> | undefined)?.totals ?? {}) as Record<string, unknown>;
  const total = minorUnits(totals.total);
  const tax = minorUnits(totals.tax);
  const billedAt = timestamp(txn.billed_at) ?? timestamp(txn.created_at);
  const currency = typeof txn.currency_code === 'string' ? txn.currency_code.toUpperCase() : null;
  if (typeof txn.id !== 'string' || !PADDLE_ID.test(txn.id) || typeof custom.app_user_id !== 'string' ||
      !custom.app_user_id || total === null || tax === null || billedAt === null || !currency) {
    return null;
  }
  return {
    id: txn.id,
    uid: custom.app_user_id,
    affiliateCode: normalizeAffiliateCode(custom.affiliate_code),
    subscriptionId: typeof txn.subscription_id === 'string' ? txn.subscription_id : null,
    origin: typeof txn.origin === 'string' ? txn.origin : 'unknown',
    billedAt,
    currency,
    netAmount: Math.max(0, total - tax),
  };
}

/** Reads an `adjustment.created|updated` payload; only money-moving actions are returned. */
export function parsePaddleAdjustment(data: unknown): PaddleAdjustmentEvent | null {
  if (!data || typeof data !== 'object') return null;
  const adj = data as Record<string, unknown>;
  const totals = (adj.totals ?? {}) as Record<string, unknown>;
  const subtotal = minorUnits(totals.subtotal);
  if (typeof adj.id !== 'string' || typeof adj.transaction_id !== 'string' || typeof adj.status !== 'string' ||
      subtotal === null || typeof totals.currency_code !== 'string') {
    return null;
  }
  if (adj.action !== 'refund' && adj.action !== 'chargeback' && adj.action !== 'chargeback_reverse') return null;
  return {
    id: adj.id,
    transactionId: adj.transaction_id,
    action: adj.action,
    status: adj.status,
    subtotal: Math.abs(subtotal),
    currency: totals.currency_code.toUpperCase(),
  };
}

export function commissionAmount(netAmount: number, rateBps: number): number {
  return Math.floor((netAmount * rateBps) / 10000);
}

function addMonths(at: number, months: number): number {
  const date = new Date(at);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.getTime();
}

/**
 * Whether a paid transaction earns commission. The partner code must have been put on the
 * checkout by the server (Paddle copies custom_data to the subscription and its renewals) AND
 * match the family's immutable attribution, so neither a later claim nor a forged field counts.
 */
export function commissionIneligibility(
  attribution: Attribution | null, affiliate: Affiliate | null, txn: PaddleTransactionEvent,
): Ineligibility | null {
  if (!attribution) return 'no_attribution';
  if (txn.affiliateCode !== attribution.code || !affiliate || affiliate.code !== attribution.code) {
    return 'code_mismatch';
  }
  if (affiliate.status !== 'active') return 'affiliate_inactive';
  if (txn.billedAt < attribution.claimedAt) return 'before_claim';
  if (attribution.firstPaidAt === null) {
    if (txn.billedAt - attribution.claimedAt > ATTRIBUTION_WINDOW_DAYS * DAY_MS) return 'window_expired';
  } else if (txn.billedAt >= addMonths(attribution.firstPaidAt, affiliate.recurringMonths)) {
    return 'recurring_ended';
  }
  if (commissionAmount(txn.netAmount, affiliate.commissionRateBps) <= 0) return 'zero_amount';
  return null;
}

export function newCommission(affiliate: Affiliate, txn: PaddleTransactionEvent): Commission {
  return {
    code: affiliate.code,
    uid: txn.uid,
    transactionId: txn.id,
    subscriptionId: txn.subscriptionId,
    currency: txn.currency,
    netAmount: txn.netAmount,
    rateBps: affiliate.commissionRateBps,
    amount: commissionAmount(txn.netAmount, affiliate.commissionRateBps),
    reversed: 0,
    paidAmount: 0,
    adjustmentIds: [],
    status: 'pending',
    billedAt: txn.billedAt,
    holdUntil: txn.billedAt + COMMISSION_HOLD_DAYS * DAY_MS,
  };
}

/**
 * Applies an approved refund / chargeback (or a chargeback reversal) to a commission, in proportion
 * to the adjusted pre-tax amount. Returns null when the adjustment doesn't change anything
 * (not approved yet, already applied, or another currency).
 */
export function applyAdjustment(
  commission: Commission, adjustment: PaddleAdjustmentEvent, now = Date.now(),
): Commission | null {
  if (adjustment.status !== 'approved' || adjustment.currency !== commission.currency) return null;
  if (commission.adjustmentIds.includes(adjustment.id)) return null;
  const share = Math.min(commission.amount, Math.ceil((adjustment.subtotal * commission.rateBps) / 10000));
  const reversed = adjustment.action === 'chargeback_reverse'
    ? Math.max(0, commission.reversed - share)
    : Math.min(commission.amount, commission.reversed + share);
  let status = commission.status;
  if (reversed >= commission.amount && commission.paidAmount === 0) status = 'void';
  else if (status === 'void' && reversed < commission.amount) status = commission.holdUntil > now ? 'pending' : 'approved';
  return { ...commission, reversed, status, adjustmentIds: [...commission.adjustmentIds, adjustment.id] };
}

/** What the partner is still owed for this commission; negative means a clawback from the next payout. */
export function owedAmount(commission: Pick<Commission, 'amount' | 'reversed' | 'paidAmount' | 'status'>): number {
  if (commission.status === 'pending' || commission.status === 'void') return 0;
  return commission.amount - commission.reversed - commission.paidAmount;
}

export interface PayoutLine {
  code: string;
  currency: string;
  commissions: number;
  owed: number;
}

/** Sums approved/paid commissions into one payout line per partner and currency (non-zero only). */
export function payoutLines(commissions: Commission[]): PayoutLine[] {
  const lines = new Map<string, PayoutLine>();
  for (const commission of commissions) {
    const owed = owedAmount(commission);
    if (owed === 0) continue;
    const key = `${commission.code}\u0000${commission.currency}`;
    const line = lines.get(key) ?? { code: commission.code, currency: commission.currency, commissions: 0, owed: 0 };
    line.commissions += 1;
    line.owed += owed;
    lines.set(key, line);
  }
  return [...lines.values()].sort((a, b) => a.code.localeCompare(b.code) || a.currency.localeCompare(b.currency));
}

export interface EarningsSummary {
  currency: string;
  pending: number;
  approved: number;
  paid: number;
}

/** Partner-facing totals per currency (net of refunds). */
export function summarizeEarnings(commissions: Commission[]): EarningsSummary[] {
  const byCurrency = new Map<string, EarningsSummary>();
  for (const commission of commissions) {
    const row = byCurrency.get(commission.currency) ??
      { currency: commission.currency, pending: 0, approved: 0, paid: 0 };
    const net = commission.amount - commission.reversed;
    if (commission.status === 'pending') row.pending += net;
    else if (commission.status !== 'void') {
      row.paid += commission.paidAmount;
      row.approved += Math.max(0, net - commission.paidAmount);
    }
    byCurrency.set(commission.currency, row);
  }
  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export interface PartnerConversion {
  billedAt: number;
  /** `first` = the family's first paid charge, `renewal` = a later subscription charge. */
  kind: 'first' | 'renewal';
  currency: string;
  /** Sale amount before tax, after discounts. */
  saleAmount: number;
  /** Commission net of refunds. */
  commission: number;
  status: CommissionStatus;
}

export type PartnerLedgerEntry = Commission & { origin?: string };

/** Partner-facing list of the most recent conversions, without any family identifier. */
export function partnerConversions(entries: PartnerLedgerEntry[], max = 50): PartnerConversion[] {
  return [...entries]
    .sort((a, b) => b.billedAt - a.billedAt)
    .slice(0, max)
    .map((entry) => ({
      billedAt: entry.billedAt,
      kind: entry.origin === 'subscription_recurring' ? 'renewal' as const : 'first' as const,
      currency: entry.currency,
      saleAmount: entry.netAmount,
      commission: entry.amount - entry.reversed,
      status: entry.status,
    }));
}
