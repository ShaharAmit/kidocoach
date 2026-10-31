import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import HomePage from './pages/Home';
import TermsPage from './pages/Terms';
import PrivacyPage from './pages/Privacy';
import { captureCampaign } from './services/campaign';
import { captureReferral, trackReferralClick } from './services/referral';
import { trackPageView } from './services/analytics';

const SITE_URL = 'https://kidocoach.app';
const ProfilePage = lazy(() => import('./pages/Profile'));
const PartnersPage = lazy(() => import('./pages/Partners'));

function LegacyAccountRedirect({ path }: { path: string }) {
  const location = useLocation();
  return <Navigate to={`${path}${location.search}`} replace />;
}

function syncSeoForPath(pathname: string) {
  const normalizedPath = pathname === '/' ? '/' : pathname.replace(/\/+$/, '');
  const canonicalUrl = normalizedPath === '/' ? SITE_URL : `${SITE_URL}${normalizedPath}`;

  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) {
    canonical.setAttribute('href', canonicalUrl);
  }

  const ogUrl = document.querySelector('meta[property="og:url"]');
  if (ogUrl) {
    ogUrl.setAttribute('content', canonicalUrl);
  }
}

function RouteSeoSync() {
  const location = useLocation();
  const [promotionError, setPromotionError] = useState('');

  useEffect(() => {
    syncSeoForPath(location.pathname);
    trackPageView(`${location.pathname}${location.search}`);
    captureReferral(location.search);
    trackReferralClick(location.search);
    try {
      captureCampaign(location.search);
      setPromotionError('');
    } catch (error) {
      console.warn('[Campaign] Invalid promotion:', error);
      setPromotionError(error instanceof Error ? error.message : 'Could not save this promotion.');
    }
  }, [location.pathname, location.search]);

  return promotionError ? <p role="alert">{promotionError}</p> : null;
}

export default function App() {
  return (
    <>
      <RouteSeoSync />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/profile" element={<Suspense fallback={<p>Loading profile...</p>}><ProfilePage /></Suspense>} />
        <Route path="/partners" element={<Suspense fallback={<p>Loading...</p>}><PartnersPage /></Suspense>} />
        <Route path="/affiliates" element={<LegacyAccountRedirect path="/partners" />} />
        <Route path="/subscribe" element={<LegacyAccountRedirect path="/profile" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
