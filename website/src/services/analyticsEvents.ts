import type { QuestionnaireAnswers } from '../../../types';

/**
 * Pure builders for analytics event parameters. Every event name and parameter is documented in
 * docs/WEB_ANALYTICS.md; keep the two in sync. Never put names, emails, birth dates or free text here.
 */

export interface AnalyticsItem {
  item_id: string;
  item_name?: string;
  price?: number;
  quantity?: number;
}

export type AnalyticsValue = string | number | boolean | undefined;
export type AnalyticsParams = Record<string, AnalyticsValue | AnalyticsItem[]>;

// GA4 drops parameter values longer than 100 characters.
const MAX_VALUE = 100;
// Only these query parameters are reported; anything else (tokens, emails) is stripped from page URLs.
const KEPT_QUERY = ['ref', 'coupon', 'discount_code', 'utm_source', 'utm_medium', 'utm_campaign',
  'utm_term', 'utm_content'];

export const QUESTIONNAIRE_STEPS = ['child', 'stuck_points', 'motivation', 'mastered_tasks', 'help_level',
  'morning_speed', 'schedule'] as const;

export type EntryType = 'partner_link' | 'coupon_link' | 'campaign' | 'referral_site' | 'direct';

function clip(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, MAX_VALUE) : undefined;
}

export function sanitizeSearch(search: string): string {
  const params = new URLSearchParams(search);
  const kept = new URLSearchParams();
  KEPT_QUERY.forEach((key) => {
    const value = clip(params.get(key));
    if (value) kept.set(key, value);
  });
  const query = kept.toString();
  return query ? `?${query}` : '';
}

function referrerHost(referrer: string, siteHost: string): string | undefined {
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '');
    return host && host !== siteHost.replace(/^www\./, '') ? host : undefined;
  } catch {
    return undefined;
  }
}

/** How a visitor arrived: one `site_entry` per landing. Only the referrer's host is kept, never its path. */
export function describeEntry(pathname: string, search: string, referrer: string, siteHost: string): AnalyticsParams {
  const params = new URLSearchParams(search);
  const affiliateCode = clip(params.get('ref')?.toLowerCase());
  const couponCode = clip(params.get('discount_code') ?? params.get('coupon'));
  const utmSource = clip(params.get('utm_source'));
  const host = referrerHost(referrer, siteHost);
  const entryType: EntryType = affiliateCode ? 'partner_link' : couponCode ? 'coupon_link'
    : utmSource ? 'campaign' : host ? 'referral_site' : 'direct';
  return {
    entry_type: entryType,
    landing_path: clip(pathname) ?? '/',
    affiliate_code: affiliateCode,
    coupon_code: couponCode,
    utm_source: utmSource,
    utm_medium: clip(params.get('utm_medium')),
    utm_campaign: clip(params.get('utm_campaign')),
    referrer_host: host,
  };
}

export function ageBand(age: number): string {
  if (age <= 3) return '2-3';
  if (age <= 5) return '4-5';
  if (age <= 8) return '6-8';
  return '9-12';
}

export function listParam(values: readonly string[] | undefined): string | undefined {
  return values?.length ? clip([...values].sort().join(',')) : undefined;
}

/** Questionnaire answers as categories only: no child name, birth date or gender. */
export function questionnaireParams(input: {
  age: number; answers: QuestionnaireAnswers; wakeTime: string; bedtime: string;
}): AnalyticsParams {
  return {
    child_age_band: ageBand(input.age),
    stuck_points: listParam(input.answers.stuckPoints),
    motivation_style: input.answers.motivationStyle,
    mastered_tasks: listParam(input.answers.masteredTasks),
    help_level: input.answers.helpLevel,
    morning_speed: input.answers.morningSpeed,
    wake_time: input.wakeTime,
    bedtime: input.bedtime,
  };
}
