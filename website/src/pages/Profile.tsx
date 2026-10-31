import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { auth } from '../services/firebase';
import {
  formatPlanPrice, loadBilling, openBillingPortal, startCheckout, storeLabel, syncPurchases,
  type WebAccess, type WebPlan,
} from '../services/billing';
import { parseCampaign, readCampaign } from '../services/campaign';
import { loadChildProfile } from '../services/registration';
import RegistrationQuestionnaire from '../components/RegistrationQuestionnaire';
import SignInCard from '../components/SignInCard';
import PartnerPanel from '../components/PartnerPanel';
import { claimSavedReferral } from '../services/referral';
import { getAuthErrorMessage } from '../services/accountAuth';
import type { ChildProfile } from '../../../types';
import '../styles/subscribe.css';

function messageFor(error: unknown): string {
  const authMessage = getAuthErrorMessage(error);
  if (authMessage) return authMessage;
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export default function ProfilePage() {
  const location = useLocation();
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [discount, setDiscount] = useState(() => readCampaign()?.discountCode ?? '');
  const [access, setAccess] = useState<WebAccess | null>(null);
  const [plans, setPlans] = useState<WebPlan[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const refreshVersion = useRef(0);
  const actionInFlight = useRef(false);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [profile, setProfile] = useState<ChildProfile | null>(null);
  const [accountError, setAccountError] = useState('');
  const [accountRevision, setAccountRevision] = useState(0);

  useEffect(() => {
    if (!user || user.isAnonymous) return;
    let cancelled = false;
    loadChildProfile(user.uid).then((child) => {
      if (cancelled || auth.currentUser?.uid !== user.uid) return;
      setProfile(child);
      setProfileLoaded(true);
    }).catch((failure: unknown) => {
      console.warn('[Profile] Could not load account:', failure);
      if (!cancelled) setAccountError('Could not load your profile. Check your connection and try again.');
    });
    return () => { cancelled = true; };
  }, [user, accountRevision]);

  useEffect(() => {
    try {
      setDiscount(parseCampaign(location.search)?.discountCode ?? readCampaign()?.discountCode ?? '');
    } catch (error) {
      setMessage(messageFor(error));
    }
  }, [location.search]);

  useEffect(() => onAuthStateChanged(auth, (next) => {
    refreshVersion.current += 1;
    setAccess(null);
    setPlans([]);
    setProfile(null);
    setProfileLoaded(false);
    setAccountError('');
    setMessage('');
    setUser(next);
    setAuthReady(true);
    if (next && !next.isAnonymous) {
      // A partner link saved before sign-in follows the account (first touch, checked on the server).
      claimSavedReferral().catch((error: unknown) => console.warn('[Referral] Claim failed; will retry:', error));
    }
  }), []);

  async function refresh(uid: string) {
    const version = ++refreshVersion.current;
    setLoading(true);
    try {
      const billing = await loadBilling(uid);
      if (version !== refreshVersion.current || auth.currentUser?.uid !== uid) return;
      setAccess(billing.access);
      setPlans(billing.plans);
    } catch (error) {
      if (version === refreshVersion.current) setMessage(messageFor(error));
    } finally {
      if (version === refreshVersion.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (!user || user.isAnonymous || !profile) return;
    void refresh(user.uid);
    const onFocus = () => {
      if (!actionInFlight.current && document.visibilityState === 'visible') void refresh(user.uid);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      refreshVersion.current += 1;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [user, profile]);

  async function run(operation: () => Promise<unknown>) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      await operation();
    } catch (error) {
      console.warn('[WebBilling] Operation failed:', error);
      setMessage(messageFor(error));
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  }

  async function purchase(plan: WebPlan) {
    if (!user) return;
    const uid = user.uid;
    const paidTransaction = await startCheckout(uid, plan.priceId, discount);
    if (!paidTransaction) {
      setMessage('Checkout closed. You have not been charged.');
      return;
    }
    // Import the purchase into RevenueCat right away so the mobile apps unlock too.
    const synced = await syncPurchases(uid, paidTransaction);
    if (auth.currentUser?.uid !== uid) return;
    setAccess(synced);
    setMessage(synced.active
      ? 'Your subscription is active. Sign in to the mobile app with this same parent account.'
      : 'Payment received. Access can take a minute to appear; use Refresh subscription status.');
  }

  async function manage() {
    if (!user) return;
    window.location.assign(await openBillingPortal(user.uid));
  }

  async function refreshStatus(uid: string) {
    const synced = await syncPurchases(uid);
    if (auth.currentUser?.uid === uid) setAccess(synced);
    await refresh(uid);
  }

  const active = access?.active === true;
  return (
    <main className="subscription-shell">
      <Link to="/">KidoCoach home</Link>
      <h1>Your profile</h1>
      <p>Sign in to manage your family account and subscription.</p>
      <p>Parents: use the <strong>same account</strong> on every device.
        If you already use the app as a guest, link your account in the app&apos;s Profile first.</p>
      {!authReady ? <p>Loading your account...</p> : !user || user.isAnonymous ? (
        <SignInCard />
      ) : (
        <>
        <PartnerPanel uid={user.uid} />
        <section className="subscription-card">
          <p>Signed in as {user.email ?? 'parent'}</p>
          {accountError ? <>
            <p role="alert">{accountError}</p>
            <button onClick={() => { setAccountError(''); setAccountRevision((value) => value + 1); }}>Retry profile</button>
          </> : !profileLoaded ? <p>Loading your profile...</p> : <>
          {!profile && <RegistrationQuestionnaire
            key={user.uid} uid={user.uid} onSaved={(saved) => {
              if (auth.currentUser?.uid === user.uid) setProfile(saved);
            }} />}
          {profile && <>
          <h2>{profile.childName}&apos;s profile</h2>
          <p>Age {profile.age} · Wake-up {profile.scheduledTime} · Bedtime {profile.bedtime ?? 'not set'}</p>
          <p>Your questionnaire and routines sync to the mobile app with this same account.</p>
          {loading ? <p>Checking subscription...</p> : active ? (
            <>
              <h2>Your subscription is active</h2>
              <p>Access is shared across web, Apple, and Android with this account. Routines play in the mobile app.</p>
              {access.store === 'paddle' ? (
                <button disabled={busy} onClick={() => void run(manage)}>Manage or cancel subscription</button>
              ) : <>
                <p>This subscription was bought through {storeLabel(access.store)}; manage or cancel it there.</p>
                {access.managementUrl && <a href={access.managementUrl} target="_blank" rel="noopener noreferrer">
                  Manage subscription
                </a>}
              </>}
            </>
          ) : (
            <>
              <label>Coupon code (optional)<input value={discount} maxLength={32}
                onChange={(e) => setDiscount(e.target.value)} disabled={busy} /></label>
              <p>Final price, discount eligibility, billing interval, and renewal terms appear in checkout.</p>
              {access && plans.map((plan) => (
                <button key={plan.priceId} disabled={busy || loading} onClick={() => void run(() => purchase(plan))}>
                  {plan.name} - {formatPlanPrice(plan)}
                  {plan.trialDays ? ` (${plan.trialDays}-day free trial)` : ''}
                </button>
              ))}
              {access && plans.length === 0 && <p>No plans are available right now.</p>}
              <p>Payments are processed securely by Paddle, our reseller and merchant of record.</p>
            </>
          )}
          <button disabled={busy || loading} onClick={() => void run(() => refreshStatus(user.uid))}>
            Refresh subscription status
          </button>
          </>}
          </>}
          <button disabled={busy} onClick={() => void run(() => signOut(auth))}>Sign out</button>
        </section>
        </>
      )}
      {message && <p role="status" aria-live="polite">{message}</p>}
      <p>Web coupons apply to web checkout only, not App Store or Google Play purchases.
        Already subscribed elsewhere? Sign in instead of buying again.</p>
      <p>Recommend KidoCoach and earn commission: <Link to="/partners">become a partner</Link>.</p>
      <footer><Link to="/terms">Terms</Link> · <Link to="/privacy">Privacy</Link></footer>
    </main>
  );
}
