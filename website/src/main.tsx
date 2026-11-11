import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { initAnalytics, subscribeConsent } from './services/analytics';
import { setReferralStorageAllowed } from './services/referral';
// Self-hosted fonts: loading them from Google would send visitors' IPs to Google before consent.
import '@fontsource/baloo-2/500.css';
import '@fontsource/baloo-2/700.css';
import '@fontsource/baloo-2/800.css';
import '@fontsource/nunito/500.css';
import '@fontsource/nunito/700.css';
import '@fontsource/nunito/800.css';
import './styles/global.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

initAnalytics();
// One consent covers analytics and remembering the partner link (docs/WEB_ANALYTICS.md §7).
subscribeConsent(({ choice }) => setReferralStorageAllowed(choice === 'granted'));

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
