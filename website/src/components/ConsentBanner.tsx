import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { setAnalyticsConsent, subscribeConsent } from '../services/analytics';

/**
 * Opt-in consent for analytics and remembering the partner link (GDPR/ePrivacy, UK, Quebec Law 25).
 * Accept and Reject are equally prominent; "Privacy choices" in the footers reopens it so consent can be withdrawn at any time.
 */
export default function ConsentBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => subscribeConsent(({ choice, open }) => setVisible(open || choice === null)), []);

  if (!visible) return null;
  return (
    <section className="consent-banner" role="dialog" aria-live="polite" aria-label="Privacy choices">
      <p>
        With your permission, we use analytics cookies (Google Analytics for Firebase) to see how
        parents find and use KidoCoach, and we remember which partner link brought you here so the
        partner can be credited if you join later. No advertising, and we never sell your data. You can
        change this anytime under &quot;Privacy choices&quot;.{' '}
        <Link to="/privacy#analytics">Learn more</Link>
      </p>
      <div className="consent-actions">
        <button type="button" onClick={() => setAnalyticsConsent('denied')}>Reject</button>
        <button type="button" onClick={() => setAnalyticsConsent('granted')}>Accept</button>
      </div>
    </section>
  );
}
