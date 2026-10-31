import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';

export interface PartnerEarnings {
  currency: string;
  /** Minor units (cents), net of refunds. */
  pending: number;
  approved: number;
  paid: number;
}

export interface PartnerConversion {
  billedAt: number;
  kind: 'first' | 'renewal';
  currency: string;
  /** Minor units: sale before tax after discounts, and the commission net of refunds. */
  saleAmount: number;
  commission: number;
  status: 'pending' | 'approved' | 'paid' | 'void';
}

export interface PartnerPayout {
  paidAt: number;
  currency: string;
  amount: number;
  commissions: number;
}

export type PayoutMethod = 'paypal' | 'wise';

export const PAYOUT_METHOD_HELP: Record<PayoutMethod, string> = {
  paypal: 'PayPal: we send to this email. No PayPal account yet? PayPal emails you to create one with this address and claim it within 30 days.',
  wise: 'Wise: we send to this email and Wise asks you for your bank details (free Wise account with this address). Claim it within 7 days.',
};

export interface PartnerSummary {
  code: string;
  name: string;
  status: 'active' | 'disabled';
  link: string;
  discountCode: string | null;
  payoutEmail: string;
  payoutMethod: PayoutMethod;
  commissionRateBps: number;
  recurringMonths: number;
  clicks: number;
  clicksLast30Days: number;
  signups: number;
  payingFamilies: number;
  earnings: PartnerEarnings[];
  conversions: PartnerConversion[];
  payouts: PartnerPayout[];
}

export type CodeCheck = { available: true; code: string } |
  { available: false; reason: 'invalid_code' | 'reserved_code' | 'code_taken' };

export type JoinStatus = 'created' | 'already_partner' | 'code_taken' | 'invalid_code' | 'reserved_code' |
  'invalid_name' | 'invalid_payout_email' | 'invalid_payout_method' | 'terms_required';

export interface JoinRequest {
  code: string;
  name: string;
  payoutEmail: string;
  payoutMethod: PayoutMethod;
  acceptTerms: boolean;
}

export const JOIN_MESSAGES: Record<Exclude<JoinStatus, 'created'>, string> = {
  already_partner: 'This account already has a partner code.',
  code_taken: 'That code is taken. Try another one.',
  invalid_code: 'Use 3-32 characters: a-z, 0-9, - or _ (start with a letter or digit).',
  reserved_code: 'That code is reserved. Try another one.',
  invalid_name: 'Use 2-60 characters for your name.',
  invalid_payout_email: 'Enter a valid payout email.',
  invalid_payout_method: 'Choose PayPal or Wise.',
  terms_required: 'Accept the partner terms to join.',
};

/** The signed-in account's partner program summary, or null when it isn't a partner. */
export async function loadPartnerSummary(): Promise<PartnerSummary | null> {
  const result = await httpsCallable<void, { affiliate: PartnerSummary | null }>(functions, 'getAffiliateSummary')();
  return result.data.affiliate;
}

export async function checkPartnerCode(code: string): Promise<CodeCheck> {
  return (await httpsCallable<{ code: string }, CodeCheck>(functions, 'checkAffiliateCode')({ code })).data;
}

export async function joinPartnerProgram(request: JoinRequest): Promise<JoinStatus> {
  return (await httpsCallable<JoinRequest, { status: JoinStatus }>(functions, 'createAffiliateAccount')(request))
    .data.status;
}

export async function updatePartnerSettings(changes: { name?: string; payoutEmail?: string; payoutMethod?: PayoutMethod }): Promise<void> {
  await httpsCallable(functions, 'updateAffiliateSettings')(changes);
}

export function formatMinor(amount: number, currency: string, locale?: string): string {
  const fraction = new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits ?? 2;
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount / 10 ** fraction);
}
