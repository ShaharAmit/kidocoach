import type { Analytics } from 'firebase/analytics';
import { sanitizeSearch, type AnalyticsParams } from './analyticsEvents';

export type { AnalyticsParams } from './analyticsEvents';
export type ConsentChoice = 'granted' | 'denied';
type ConsentListener = (state: { choice: ConsentChoice | null; open: boolean }) => void;
type Pending = { name: string; params: AnalyticsParams };

/**
 * Firebase Analytics (GA4) for the website, opt-in only (docs/WEB_ANALYTICS.md).
 * Nothing is loaded, stored or sent until the visitor accepts. Events from the current page view
 * wait in memory (never on disk) and are sent on accept or dropped on reject or page close.
 */
const CONSENT_KEY = 'kidocoach_analytics_consent_v1';
const ENTRY_KEY = 'kidocoach_entry_tracked_v1';
const MAX_PENDING = 50;
const SITE_ORIGIN = 'https://kidocoach.app';

const MEASUREMENT_ID = import.meta.env.VITE_GA_MEASUREMENT_ID?.trim();
const listeners = new Set<ConsentListener>();
let pending: Pending[] = [];
let userId: string | null = null;
let userProperties: Record<string, string> = {};
let choicesOpen = false;
let backend: Promise<Analytics | null> | null = null;

function storedChoice(): ConsentChoice | null {
  try {
    const value = localStorage.getItem(CONSENT_KEY);
    return value === 'granted' || value === 'denied' ? value : null;
  } catch {
    return null;
  }
}

/** Global Privacy Control (CCPA/CPRA opt-out signal) counts as "reject" until the visitor explicitly accepts. */
function hasGlobalPrivacyControl(): boolean {
  return typeof navigator !== 'undefined' &&
    (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
}

export function getConsentChoice(): ConsentChoice | null {
  return storedChoice() ?? (hasGlobalPrivacyControl() ? 'denied' : null);
}

function notify(): void {
  const state = { choice: getConsentChoice(), open: choicesOpen };
  listeners.forEach((listener) => listener(state));
}

export function subscribeConsent(listener: ConsentListener): () => void {
  listeners.add(listener);
  listener({ choice: getConsentChoice(), open: choicesOpen });
  return () => listeners.delete(listener);
}

/** Reopens the banner (footer "Privacy choices"), so consent is as easy to withdraw as to give. */
export function openPrivacyChoices(): void {
  choicesOpen = true;
  notify();
}

function deleteAnalyticsCookies(): void {
  const host = window.location.hostname;
  const domains = ['', host, `.${host}`, `.${host.split('.').slice(-2).join('.')}`];
  document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter((name) => /^_ga/.test(name))
    .forEach((name) => domains.forEach((domain) => {
      document.cookie = `${name}=; Max-Age=0; path=/${domain ? `; domain=${domain}` : ''}`;
    }));
}

// GA sends the page URL with every hit, so it's always replaced with the sanitized one.
function pageLocation(pathname: string, search: string): string {
  return `${SITE_ORIGIN}${pathname}${sanitizeSearch(search)}`;
}

function referrerOrigin(): string | undefined {
  try {
    return document.referrer ? `${new URL(document.referrer).origin}/` : undefined;
  } catch {
    return undefined;
  }
}

async function loadBackend(): Promise<Analytics | null> {
  const [{ app }, sdk] = await Promise.all([import('./firebase'), import('firebase/analytics')]);
  if (!MEASUREMENT_ID || !(await sdk.isSupported())) return null;
  // Analytics only: ads, ad personalization and Google signals stay off (no cross-site profiling).
  sdk.setConsent({
    analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
    personalization_storage: 'denied', functionality_storage: 'granted', security_storage: 'granted',
  });
  return sdk.initializeAnalytics(app, {
    config: {
      send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false,
      page_location: pageLocation(window.location.pathname, window.location.search),
      page_referrer: referrerOrigin(),
    },
  });
}

function withAnalytics(
  run: (analytics: Analytics, sdk: typeof import('firebase/analytics')) => void, evenWithoutConsent = false,
): void {
  if (!backend) return;
  void Promise.all([backend, import('firebase/analytics')]).then(([analytics, sdk]) => {
    if (analytics && (evenWithoutConsent || getConsentChoice() === 'granted')) run(analytics, sdk);
  }).catch((error: unknown) => console.warn('[Analytics] Unavailable:', error));
}

function send(name: string, params: AnalyticsParams): void {
  if (name === 'site_entry') {
    // One entry per browser tab session, so reloads and in-site navigation don't inflate entries.
    try {
      if (sessionStorage.getItem(ENTRY_KEY)) return;
      sessionStorage.setItem(ENTRY_KEY, '1');
    } catch {
      // Storage blocked: count it.
    }
  }
  const clean = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== ''));
  withAnalytics((analytics, sdk) => sdk.logEvent(analytics, name, clean));
}

function start(): void {
  if (!MEASUREMENT_ID || typeof window === 'undefined') return;
  if (!backend) {
    backend = loadBackend().catch((error: unknown) => {
      console.warn('[Analytics] Could not start:', error);
      return null;
    });
  }
  withAnalytics((analytics, sdk) => {
    sdk.setAnalyticsCollectionEnabled(analytics, true);
    sdk.setConsent({ analytics_storage: 'granted' });
    sdk.setUserId(analytics, userId);
    if (Object.keys(userProperties).length) sdk.setUserProperties(analytics, userProperties);
  });
  const queued = pending;
  pending = [];
  queued.forEach((event) => send(event.name, event.params));
}

export function setAnalyticsConsent(choice: ConsentChoice): void {
  try {
    localStorage.setItem(CONSENT_KEY, choice);
  } catch {
    // Storage blocked: the choice applies to this page only.
  }
  choicesOpen = false;
  if (choice === 'granted') {
    start();
  } else {
    pending = [];
    withAnalytics((analytics, sdk) => {
      sdk.setConsent({ analytics_storage: 'denied' });
      sdk.setAnalyticsCollectionEnabled(analytics, false);
    }, true);
    deleteAnalyticsCookies();
  }
  notify();
}

/** Starts analytics on page load only if the visitor already accepted. */
export function initAnalytics(): void {
  if (getConsentChoice() === 'granted') start();
}

export function trackEvent(name: string, params: AnalyticsParams = {}): void {
  const choice = getConsentChoice();
  if (choice === 'granted') send(name, params);
  else if (choice === null && pending.length < MAX_PENDING) pending.push({ name, params });
}

export function trackPageView(pathname: string, search: string): void {
  const location = pageLocation(pathname, search);
  withAnalytics((_analytics, sdk) => sdk.setDefaultEventParameters({ page_location: location }));
  trackEvent('page_view', {
    page_title: typeof document === 'undefined' ? undefined : document.title,
    page_path: `${pathname}${sanitizeSearch(search)}`,
    page_location: location,
  });
}

/** Firebase UID only (pseudonymous); joins web events to Firestore `users/{uid}` in BigQuery. Never an email. */
export function identifyUser(uid: string | null): void {
  if (uid === userId) return;
  userId = uid;
  const cleared = uid ? {} : Object.fromEntries(Object.keys(userProperties).map((key) => [key, null]));
  if (!uid) userProperties = {};
  withAnalytics((analytics, sdk) => {
    sdk.setUserId(analytics, uid);
    if (Object.keys(cleared).length) sdk.setUserProperties(analytics, cleared);
  });
}

export function setAnalyticsUserProperties(properties: Record<string, string>): void {
  userProperties = { ...userProperties, ...properties };
  withAnalytics((analytics, sdk) => sdk.setUserProperties(analytics, properties));
}
