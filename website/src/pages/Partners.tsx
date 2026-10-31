import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { auth } from '../services/firebase';
import PartnerPanel from '../components/PartnerPanel';
import SignInCard from '../components/SignInCard';
import '../styles/subscribe.css';

/** Public partner (affiliate) program: pitch, self-serve sign-up and the partner's own dashboard. */
export default function PartnersPage() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => onAuthStateChanged(auth, (next) => {
    setUser(next);
    setAuthReady(true);
  }), []);

  const signedIn = user && !user.isAnonymous;
  return (
    <main className="subscription-shell">
      <Link to="/">KidoCoach home</Link>
      <h1>KidoCoach partner program</h1>
      <p>Recommend KidoCoach to parents and earn <strong>15% of every web payment</strong> they make
        for <strong>12 months</strong>.</p>
      <ul>
        <li>Pick your own link, e.g. <code>kidocoach.app/?ref=yourname</code>, and start sharing right away.</li>
        <li>Families are credited to you for 60 days after their first click (first link wins).</li>
        <li>Track clicks, sign-ups, sales and payouts live on your dashboard.</li>
        <li>Commissions are approved after a 30-day refund window and paid monthly by Wise (lowest fees) or PayPal, your choice. No account needed in advance: you claim the payment with the email you give us.</li>
      </ul>
      <p>Only web subscriptions bought on kidocoach.app count; App Store and Google Play purchases can&apos;t be tracked.</p>
      {!authReady ? <p>Loading your account...</p> : !signedIn ? (
        <SignInCard title="Sign in or create an account to join" />
      ) : (
        <>
          <PartnerPanel uid={user.uid} join defaultName={user.displayName ?? ''} defaultEmail={user.email ?? ''} />
          <p>Signed in as {user.email ?? 'partner'} · <button type="button" onClick={() => void signOut(auth)}>Sign out</button></p>
        </>
      )}
      <footer><Link to="/terms#partners">Partner terms</Link> · <Link to="/privacy">Privacy</Link></footer>
    </main>
  );
}
