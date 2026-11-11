import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Early-access email list rules (docs/WEB_ANALYTICS.md §6). Pure, so the admin script and tests share them.
 * A lead is `early_access/{sha256(email)}`; unsubscribing deletes the address and keeps only the hash
 * as a suppression record, so the address is never imported again.
 */
export const SITE_URL = 'https://kidocoach.app';
export const LEAD_PURPOSE = 'launch_updates';
const CONSENT_VERSION = /^[a-z0-9_]{1,40}$/;
const LEAD_ID = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{32}$/;

export type PreferenceAction = 'confirm' | 'unsubscribe';
export type PreferenceStatus = 'confirmed' | 'unsubscribed' | 'invalid';

export interface LeadConsent {
  version: string;
  purpose: string;
  method: 'signup_form' | 'email_link';
}

export interface ExportRow {
  email: string;
  consent_version: string;
  confirmed: 'yes' | 'no';
  needs_reconfirm: 'yes' | 'no';
  confirm_url: string;
  unsubscribe_url: string;
}

export function normalizeLeadEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isValidLeadEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function leadId(email: string): string {
  return createHash('sha256').update(email).digest('hex');
}

export function validConsentVersion(value: unknown): value is string {
  return typeof value === 'string' && CONSENT_VERSION.test(value);
}

export function newUnsubscribeToken(): string {
  return randomBytes(16).toString('hex');
}

export function validPreferenceRequest(id: unknown, token: unknown, action: unknown): action is PreferenceAction {
  return typeof id === 'string' && LEAD_ID.test(id) && typeof token === 'string' && TOKEN.test(token) &&
    (action === 'confirm' || action === 'unsubscribe');
}

export function tokensMatch(expected: unknown, given: string): boolean {
  if (typeof expected !== 'string' || expected.length !== given.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

export function preferenceUrl(id: string, token: string, action: PreferenceAction): string {
  return `${SITE_URL}/email-preferences?id=${id}&t=${token}&action=${action}`;
}

/** Whether a lead may be emailed: has an address, isn't unsubscribed and gave consent (form or email link). */
export function isMailable(data: Record<string, unknown>): boolean {
  return typeof data.email === 'string' && !data.unsubscribedAt && Boolean(data.consent);
}

/** One CSV row for the email provider; null for unsubscribed leads. Legacy leads (no consent) only get the re-confirm email. */
export function exportRow(id: string, data: Record<string, unknown>): ExportRow | null {
  if (typeof data.email !== 'string' || data.unsubscribedAt || typeof data.unsubscribeToken !== 'string') return null;
  const consent = data.consent as Partial<LeadConsent> | undefined;
  return {
    email: data.email,
    consent_version: consent?.version ?? '',
    confirmed: data.confirmedAt ? 'yes' : 'no',
    needs_reconfirm: consent ? 'no' : 'yes',
    confirm_url: preferenceUrl(id, data.unsubscribeToken, 'confirm'),
    unsubscribe_url: preferenceUrl(id, data.unsubscribeToken, 'unsubscribe'),
  };
}

export function toCsv<T extends object>(rows: T[]): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]) as (keyof T)[];
  const cell = (value: unknown) => {
    // A leading = + - @ would run as a spreadsheet formula.
    const text = String(value ?? '').replace(/^([=+\-@])/, "'$1");
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((key) => cell(row[key])).join(','))].join('\n') + '\n';
}
