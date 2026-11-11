import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import HomePage from './pages/Home';
import TermsPage from './pages/Terms';
import PrivacyPage from './pages/Privacy';
import RoutineGuidePage from './pages/RoutineGuide';
import { captureCampaign } from './services/campaign';
import { captureReferral, readReferral, trackReferralClick } from './services/referral';
import { trackEvent, trackPageView } from './services/analytics';
import { describeEntry } from './services/analyticsEvents';
import ConsentBanner from './components/ConsentBanner';

const SITE_URL = 'https://kidocoach.app';
const ProfilePage = lazy(() => import('./pages/Profile'));
const PartnersPage = lazy(() => import('./pages/Partners'));
const EmailPreferencesPage = lazy(() => import('./pages/EmailPreferences'));

function LegacyAccountRedirect({ path }: { path: string }) {
  const location = useLocation();
  return <Navigate to={`${path}${location.search}`} replace />;
}

const ROUTE_META: Record<string, { title: string; description: string }> = {
  '/': {
    title: 'Kidocoach | Daily Routine App for Kids (Morning & Bedtime)',
    description:
      'Kidocoach is a daily routine app for kids (ages 2–12) that helps families build calmer mornings, smoother bedtime routines, and independent habits with an animated routine coach.',
  },
  '/terms': {
    title: 'Terms and Conditions | Kidocoach',
    description:
      'Read the Terms and Conditions for Kidocoach, covering our daily routine app for kids, website, Early Access waitlist, and family subscriptions.',
  },
  '/privacy': {
    title: 'Privacy Policy | Kidocoach',
    description:
      'Read the Kidocoach Privacy Policy to learn how we protect parent and family data, handle subscriptions, and respect your privacy choices.',
  },
  '/profile': {
    title: 'Parent Profile & Routine Setup | Kidocoach',
    description:
      'Sign in or create your Kidocoach parent account to customize your child’s morning and bedtime routines and manage your family subscription.',
  },
  '/partners': {
    title: 'Partner Program | Kidocoach',
    description:
      'Join the Kidocoach Partner Program and share calmer morning and bedtime routines with families.',
  },
  '/email-preferences': {
    title: 'Email Preferences | Kidocoach',
    description: 'Manage your Kidocoach email preferences and subscription notifications.',
  },
  '/morning-routine-for-kids': {
    title: 'Morning Routine App for Kids (Ages 2–12) | Kidocoach',
    description:
      'End morning battles before school with Kidocoach—a playful daily routine app for kids with an animated coach that calls your child by name.',
  },
  '/bedtime-routine-for-kids': {
    title: 'Bedtime Routine App for Kids & Calm Evenings | Kidocoach',
    description:
      'Build smoother bedtime routines for kids ages 2–12 with calm voice prompts, step-by-step visual activities, and story-time wind-downs.',
  },
  '/visual-routine-schedule-for-kids': {
    title: 'Visual Routine Schedule & Step-by-Step Timer for Kids | Kidocoach',
    description:
      'Help easily distracted and visual-learning kids stay on track with one clear step at a time, personalized voice cues, and Mission Complete rewards.',
  },
};

function syncSeoForPath(pathname: string) {
  const normalizedPath = pathname === '/' ? '/' : pathname.replace(/\/+$/, '');
  const canonicalUrl = normalizedPath === '/' ? SITE_URL : `${SITE_URL}${normalizedPath}`;
  const meta = ROUTE_META[normalizedPath] ?? ROUTE_META['/'];

  document.title = meta.title;

  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) {
    canonical.setAttribute('href', canonicalUrl);
  }

  const ogUrl = document.querySelector('meta[property="og:url"]');
  if (ogUrl) {
    ogUrl.setAttribute('content', canonicalUrl);
  }

  const description = document.querySelector('meta[name="description"]');
  if (description) {
    description.setAttribute('content', meta.description);
  }

  const ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle) {
    ogTitle.setAttribute('content', meta.title);
  }

  const ogDescription = document.querySelector('meta[property="og:description"]');
  if (ogDescription) {
    ogDescription.setAttribute('content', meta.description);
  }

  const twitterTitle = document.querySelector('meta[name="twitter:title"]');
  if (twitterTitle) {
    twitterTitle.setAttribute('content', meta.title);
  }

  const twitterDescription = document.querySelector('meta[name="twitter:description"]');
  if (twitterDescription) {
    twitterDescription.setAttribute('content', meta.description);
  }
}

function RouteSeoSync() {
  const location = useLocation();
  const [promotionError, setPromotionError] = useState('');

  useEffect(() => {
    syncSeoForPath(location.pathname);
    trackPageView(location.pathname, location.search);
    const entry = describeEntry(location.pathname, location.search, document.referrer, window.location.hostname);
    trackEvent('site_entry', entry);
    const savedPartner = readReferral()?.code;
    captureReferral(location.search);
    trackReferralClick(location.search);
    const linkPartner = readReferral()?.code;
    if (entry.affiliate_code) {
      trackEvent('partner_link_open', {
        affiliate_code: entry.affiliate_code,
        // First touch wins: false when an earlier partner link is already saved in this browser.
        first_touch: !savedPartner && linkPartner === entry.affiliate_code,
        landing_path: location.pathname,
      });
    }
    try {
      captureCampaign(location.search);
      if (entry.coupon_code) trackEvent('coupon_link_open', { coupon_code: entry.coupon_code, landing_path: location.pathname });
      setPromotionError('');
    } catch (error) {
      console.warn('[Campaign] Invalid promotion:', error);
      setPromotionError(error instanceof Error ? error.message : 'Could not save this promotion.');
    }
  }, [location.pathname, location.search]);

  return promotionError ? <p role="alert">{promotionError}</p> : null;
}

// New pages open at the top (or at their #hash); Back/Forward keep the browser's restored position.
function ScrollOnNavigate() {
  const { pathname, hash } = useLocation();
  const navigationType = useNavigationType();

  useEffect(() => {
    if (navigationType === 'POP') return;
    if (hash) {
      const target = document.getElementById(decodeURIComponent(hash.slice(1)));
      if (target) {
        target.scrollIntoView();
        return;
      }
    }
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [pathname, hash, navigationType]);

  return null;
}

export default function App() {
  return (
    <>
      <ScrollOnNavigate />
      <RouteSeoSync />
      <ConsentBanner />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/morning-routine-for-kids" element={<RoutineGuidePage variant="morning" />} />
        <Route path="/bedtime-routine-for-kids" element={<RoutineGuidePage variant="bedtime" />} />
        <Route path="/visual-routine-schedule-for-kids" element={<RoutineGuidePage variant="visual" />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/profile" element={<Suspense fallback={<p>Loading profile...</p>}><ProfilePage /></Suspense>} />
        <Route path="/partners" element={<Suspense fallback={<p>Loading...</p>}><PartnersPage /></Suspense>} />
        <Route path="/email-preferences" element={<Suspense fallback={<p>Loading...</p>}><EmailPreferencesPage /></Suspense>} />
        <Route path="/affiliates" element={<LegacyAccountRedirect path="/partners" />} />
        <Route path="/subscribe" element={<LegacyAccountRedirect path="/profile" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
