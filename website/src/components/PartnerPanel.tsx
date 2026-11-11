import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { sendEmailVerification } from 'firebase/auth';
import { auth } from '../services/firebase';
import {
  checkPartnerCode, formatMinor, JOIN_MESSAGES, joinPartnerProgram, loadPartnerAccess, PAYOUT_METHOD_HELP,
  updatePartnerSettings, type CodeCheck, type PartnerAccess, type PartnerSummary, type PayoutMethod,
} from '../services/partner';
import { trackEvent } from '../services/analytics';

const CODE_HINT = /^[a-z0-9][a-z0-9_-]{2,31}$/;

function suggestCode(source: string): string {
  return source.toLowerCase().split('@')[0].replace(/[^a-z0-9_-]+/g, '').replace(/^[-_]+/, '').slice(0, 32);
}

function formatDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const METHOD_LABEL: Record<PayoutMethod, string> = { wise: 'Wise (to your bank, lowest fees)', paypal: 'PayPal' };

function PayoutFields({ method, email, busy, onMethod, onEmail }: {
  method: PayoutMethod; email: string; busy: boolean;
  onMethod: (method: PayoutMethod) => void; onEmail: (email: string) => void;
}) {
  return (
    <>
      <label>How should we pay you?
        <select value={method} onChange={(e) => onMethod(e.target.value as PayoutMethod)} disabled={busy}>
          {(Object.keys(METHOD_LABEL) as PayoutMethod[]).map((key) => <option key={key} value={key}>{METHOD_LABEL[key]}</option>)}
        </select>
      </label>
      <label>{method === 'paypal' ? 'PayPal email' : 'Email for Wise'}<input type="email" value={email} required
        onChange={(e) => onEmail(e.target.value)} disabled={busy} /></label>
      <p className="field-help">{PAYOUT_METHOD_HELP[method]}</p>
    </>
  );
}

const STATUS_LABEL = { pending: 'Pending (30-day hold)', approved: 'Approved', paid: 'Paid', void: 'Refunded' };

function JoinForm({ defaultName, defaultEmail, onJoined }: {
  defaultName: string; defaultEmail: string; onJoined: () => void;
}) {
  const [code, setCode] = useState(() => suggestCode(defaultName || defaultEmail));
  const [name, setName] = useState(defaultName);
  const [payoutEmail, setPayoutEmail] = useState(defaultEmail);
  const [payoutMethod, setPayoutMethod] = useState<PayoutMethod>('wise');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [check, setCheck] = useState<CodeCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const normalized = code.trim().toLowerCase();

  useEffect(() => {
    setCheck(null);
    if (!CODE_HINT.test(normalized)) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      checkPartnerCode(normalized).then((result) => {
        if (!cancelled) setCheck(result);
      }).catch((error: unknown) => console.warn('[Partner] Code check failed:', error));
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [normalized]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const status = await joinPartnerProgram({
        code: normalized, name: name.trim(), payoutEmail: payoutEmail.trim(), payoutMethod, acceptTerms,
      });
      trackEvent('partner_join', { status });
      if (status === 'created' || status === 'already_partner') onJoined();
      else setMessage(JOIN_MESSAGES[status]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not join. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const codeStatus = !normalized ? '' : !CODE_HINT.test(normalized) ? JOIN_MESSAGES.invalid_code
    : !check ? 'Checking...' : check.available ? `Available: https://kidocoach.app/?ref=${check.code}`
      : JOIN_MESSAGES[check.reason];

  return (
    <section className="subscription-card" aria-labelledby="join-heading">
      <h2 id="join-heading">Create your partner link</h2>
      <form onSubmit={(event) => void submit(event)}>
        <label>Your code (it becomes your link and can&apos;t be changed later)
          <input value={code} maxLength={32} autoCapitalize="none" spellCheck={false} required
            onChange={(e) => setCode(e.target.value)} disabled={busy} />
        </label>
        {codeStatus && <p role="status" aria-live="polite">{codeStatus}</p>}
        <label>Name or brand<input value={name} maxLength={60} required onChange={(e) => setName(e.target.value)} disabled={busy} /></label>
        <PayoutFields method={payoutMethod} email={payoutEmail} busy={busy}
          onMethod={setPayoutMethod} onEmail={setPayoutEmail} />
        <label className="checkbox-row"><input type="checkbox" checked={acceptTerms}
          onChange={(e) => setAcceptTerms(e.target.checked)} disabled={busy} />
          I accept the <a href="/terms#partners" target="_blank" rel="noopener noreferrer">partner terms</a>
        </label>
        <button disabled={busy || !acceptTerms || check?.available !== true}>Join the partner program</button>
      </form>
      {message && <p role="alert">{message}</p>}
    </section>
  );
}

function SettingsForm({ summary, onSaved }: { summary: PartnerSummary; onSaved: () => void }) {
  const [name, setName] = useState(summary.name);
  const [payoutEmail, setPayoutEmail] = useState(summary.payoutEmail);
  const [payoutMethod, setPayoutMethod] = useState<PayoutMethod>(summary.payoutMethod);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await updatePartnerSettings({ name: name.trim(), payoutEmail: payoutEmail.trim(), payoutMethod });
      setMessage('Saved.');
      onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)}>
      <h3>Settings</h3>
      <label>Name or brand<input value={name} maxLength={60} required onChange={(e) => setName(e.target.value)} disabled={busy} /></label>
      <PayoutFields method={payoutMethod} email={payoutEmail} busy={busy}
        onMethod={setPayoutMethod} onEmail={setPayoutEmail} />
      <button disabled={busy || (name.trim() === summary.name && payoutEmail.trim() === summary.payoutEmail &&
        payoutMethod === summary.payoutMethod)}>Save settings</button>
      {message && <p role="status" aria-live="polite">{message}</p>}
    </form>
  );
}

function VerifyEmail({ email, onVerified }: { email: string; onVerified: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setMessage('');
    try {
      setMessage(await action());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const send = async () => {
    if (!auth.currentUser) return 'Sign in again.';
    await sendEmailVerification(auth.currentUser);
    return `Verification email sent to ${email}. Open the link, then tap "I verified my email".`;
  };
  const check = async () => {
    const user = auth.currentUser;
    if (!user) return 'Sign in again.';
    await user.reload();
    if (!user.emailVerified) return 'Not verified yet. Open the link in the email first.';
    // The server reads email_verified from the ID token, so refresh it before asking again.
    await user.getIdToken(true);
    onVerified();
    return '';
  };

  return (
    <section className="subscription-card" aria-labelledby="verify-heading">
      <h2 id="verify-heading">You&apos;re invited to the KidoCoach partner program</h2>
      <p>Verify {email} to continue.</p>
      <button type="button" disabled={busy} onClick={() => void run(send)}>Send verification email</button>
      <button type="button" disabled={busy} onClick={() => void run(check)}>I verified my email</button>
      {message && <p role="status" aria-live="polite">{message}</p>}
    </section>
  );
}

/**
 * Partner dashboard: link, clicks → sign-ups → paying families, earnings, conversions and payouts.
 * What a non-partner sees is decided by the server (ADR-021): nothing while the program is closed
 * to them; otherwise the sign-up form when `join` is set, or a link to /partners.
 */
export default function PartnerPanel({ uid, join, defaultName = '', defaultEmail = '', onAccess }: {
  uid: string; join?: boolean; defaultName?: string; defaultEmail?: string;
  onAccess?: (access: PartnerAccess) => void;
}) {
  const [state, setState] = useState<{ summary: PartnerSummary | null; access: PartnerAccess } | undefined>(undefined);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError('');
    loadPartnerAccess().then((next) => {
      if (!cancelled) setState(next);
    }).catch((failure: unknown) => {
      console.warn('[Partner] Could not load summary:', failure);
      if (!cancelled) setError('Could not load this page.');
    });
    return () => { cancelled = true; };
  }, [uid, revision]);

  useEffect(() => setState(undefined), [uid]);

  useEffect(() => {
    if (state) onAccess?.(state.access);
  }, [state, onAccess]);

  const reload = () => setRevision((value) => value + 1);

  // Outside the partner page, failures stay silent so a hidden program isn't hinted at.
  if (error) return join ? <p role="alert">{error} <button type="button" onClick={reload}>Retry</button></p> : null;
  if (state === undefined) return join ? <p>Loading...</p> : null;
  const { summary, access } = state;
  if (summary === null) {
    if (access === 'verify_email') return <VerifyEmail email={defaultEmail || 'your email'} onVerified={reload} />;
    if (access !== 'join') return null;
    return join ? <JoinForm defaultName={defaultName} defaultEmail={defaultEmail} onJoined={reload} />
      : (
        <section className="subscription-card" aria-labelledby="partner-invite-heading">
          <h2 id="partner-invite-heading">KidoCoach partner program</h2>
          <p>Recommend KidoCoach to parents and earn commission on their web subscriptions.</p>
          <Link to="/partners">Become a partner</Link>
        </section>
      );
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const conversionRate = summary.clicks > 0 ? `${((summary.signups / summary.clicks) * 100).toFixed(1)}%` : '-';
  return (
    <section className="subscription-card partner-dashboard" aria-labelledby="partner-heading">
      <h2 id="partner-heading">Partner dashboard</h2>
      {summary.status !== 'active' && <p role="status">Your partner code is paused; new referrals are not credited.</p>}
      <p>Your link: <code>{summary.link}</code>{' '}
        <button type="button" onClick={() => void copy(summary.link)}>{copied ? 'Copied' : 'Copy link'}</button>
      </p>
      <p>Add <code>?ref={summary.code}</code> to any kidocoach.app page, e.g. <code>https://kidocoach.app/profile?ref={summary.code}</code>.</p>
      {summary.discountCode && <p>Your coupon code: <code>{summary.discountCode}</code></p>}
      <p>{summary.commissionRateBps / 100}% of each web payment (before tax, after discounts)
        {summary.recurringMonths > 0 ? ` for ${summary.recurringMonths} months` : ' on the first payment'}.
        Commissions are held for 30 days for refunds, then approved for the next monthly payout.</p>

      <dl className="partner-stats">
        <div><dt>Link visits</dt><dd>{summary.clicks}</dd>
          <p className="partner-stat-hint">All time, counted once per visitor per day</p></div>
        <div><dt>Visits, last 30 days</dt><dd>{summary.clicksLast30Days}</dd>
          <p className="partner-stat-hint">Same count, recent month only</p></div>
        <div><dt>Sign-ups</dt><dd>{summary.signups}</dd>
          <p className="partner-stat-hint">Families who created an account from your link</p></div>
        <div><dt>Sign-up rate</dt><dd>{conversionRate}</dd>
          <p className="partner-stat-hint">Sign-ups ÷ link visits</p></div>
        <div><dt>Paying families</dt><dd>{summary.payingFamilies}</dd>
          <p className="partner-stat-hint">Families who bought a subscription (refunds excluded)</p></div>
      </dl>

      <h3>Earnings</h3>
      <p className="partner-stat-hint"><strong>Pending</strong>: in the 30-day refund hold.{' '}
        <strong>Approved</strong>: ready for the next monthly payout.{' '}
        <strong>Paid</strong>: already sent to you.</p>
      {summary.earnings.length === 0 ? <p>No commissions yet.</p> : (
        <table>
          <thead><tr><th>Currency</th><th>Pending</th><th>Approved</th><th>Paid</th></tr></thead>
          <tbody>
            {summary.earnings.map((row) => (
              <tr key={row.currency}>
                <td>{row.currency}</td>
                <td>{formatMinor(row.pending, row.currency)}</td>
                <td>{formatMinor(row.approved, row.currency)}</td>
                <td>{formatMinor(row.paid, row.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Recent sales</h3>
      {summary.conversions.length === 0 ? <p>No sales yet. Share your link to get started.</p> : (
        <table>
          <thead><tr><th>Date</th><th>Type</th><th>Sale</th><th>Commission</th><th>Status</th></tr></thead>
          <tbody>
            {summary.conversions.map((sale, index) => (
              <tr key={`${sale.billedAt}-${index}`}>
                <td>{formatDate(sale.billedAt)}</td>
                <td>{sale.kind === 'first' ? 'New subscription' : 'Renewal'}</td>
                <td>{formatMinor(sale.saleAmount, sale.currency)}</td>
                <td>{formatMinor(sale.commission, sale.currency)}</td>
                <td>{STATUS_LABEL[sale.status]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Payouts</h3>
      {summary.payouts.length === 0 ? <p>No payouts yet. Approved commissions are paid monthly by {METHOD_LABEL[summary.payoutMethod]} to {summary.payoutEmail}.</p> : (
        <table>
          <thead><tr><th>Date</th><th>Amount</th><th>Sales</th></tr></thead>
          <tbody>
            {summary.payouts.map((payout) => (
              <tr key={`${payout.paidAt}-${payout.currency}`}>
                <td>{formatDate(payout.paidAt)}</td>
                <td>{formatMinor(payout.amount, payout.currency)}</td>
                <td>{payout.commissions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <SettingsForm key={`${summary.name}|${summary.payoutEmail}|${summary.payoutMethod}`} summary={summary} onSaved={reload} />
    </section>
  );
}
