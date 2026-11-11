import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { updateEmailPreference, type EmailPreferenceAction, type EmailPreferenceStatus } from '../services/earlyAccess';
import '../styles/legal.css';

const COPY: Record<EmailPreferenceAction, { title: string; body: string; button: string }> = {
  confirm: {
    title: 'Confirm launch updates',
    body: 'Yes, KidoCoach may email me launch updates and the launch-rate offer. I can unsubscribe anytime with the link in every email.',
    button: 'Confirm',
  },
  unsubscribe: {
    title: 'Unsubscribe',
    body: 'Stop all KidoCoach launch emails and delete my email address from the list.',
    button: 'Unsubscribe',
  },
};

const RESULT: Record<EmailPreferenceStatus, string> = {
  confirmed: "Thanks, you're confirmed. We'll email you when KidoCoach launches.",
  unsubscribed: "You're unsubscribed and your email address was deleted from our list. You won't get more launch emails.",
  invalid: 'This link is not valid anymore. If you still get emails, reply to one of them or contact admin@kidocoach.app.',
};

/**
 * Landing page for the links in launch emails. Acting needs one button press, so link scanners
 * that open emails never confirm or unsubscribe on their own.
 */
export default function EmailPreferencesPage() {
  const [params] = useSearchParams();
  const id = params.get('id') ?? '';
  const token = params.get('t') ?? '';
  const action: EmailPreferenceAction = params.get('action') === 'confirm' ? 'confirm' : 'unsubscribe';
  const [status, setStatus] = useState<EmailPreferenceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const robots = document.querySelector('meta[name="robots"]');
    const previous = robots?.getAttribute('content');
    robots?.setAttribute('content', 'noindex,nofollow');
    return () => { if (previous) robots?.setAttribute('content', previous); };
  }, []);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      setStatus(await updateEmailPreference(id, token, action));
    } catch {
      setError('Something went wrong. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  const copy = COPY[action];
  return (
    <main className="legal-shell">
      <article className="legal-card">
        <Link to="/" className="back-link">Back to Home</Link>
        <h1>{copy.title}</h1>
        {status ? <p role="status">{RESULT[status]}</p> : (
          <>
            <p>{copy.body}</p>
            <p><button type="button" className="privacy-choices" disabled={busy || !id || !token} onClick={submit}>
              {busy ? 'Saving...' : copy.button}
            </button></p>
            {error && <p role="alert">{error}</p>}
            <p className="meta">See our <Link to="/privacy">Privacy Policy</Link>.</p>
          </>
        )}
      </article>
    </main>
  );
}
