import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { auth } from '../services/firebase';
import { openPrivacyChoices } from '../services/analytics';
import PartnerPanel from '../components/PartnerPanel';
import SignInCard from '../components/SignInCard';
import { usePartnerProgramOpen } from '../hooks/usePartnerProgramOpen';
import type { PartnerAccess } from '../services/partner';
import '../styles/subscribe.css';

function Pitch() {
  return (
    <>
      <p>Recommend KidoCoach to parents and earn <strong>15% of every web payment</strong> they make
        for <strong>12 months</strong>.</p>
      <ul>
        <li>Pick your own link, e.g. <code>kidocoach.app/?ref=yourname</code>, and start sharing right away.</li>
        <li>Families are credited to you for 60 days after their first click (first link wins).</li>
        <li>Track clicks, sign-ups, sales and payouts live on your dashboard.</li>
        <li>Commissions are approved after a 30-day refund window and paid monthly by Wise (lowest fees) or PayPal, your choice. No account needed in advance: you claim the payment with the email you give us.</li>
      </ul>
      <p>Only web subscriptions bought on kidocoach.app count; App Store and Google Play purchases can&apos;t be tracked.</p>
    </>
  );
}

/**
 * Partner (affiliate) program: pitch, sign-up and the partner's own dashboard. While the public
 * program is closed (ADR-021), only existing partners and invited emails see it: signed-out visitors
 * get a plain sign-in, and accounts the server hides are sent to /profile without any mention of it.
 */
export default function PartnersPage() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [access, setAccess] = useState<PartnerAccess | undefined>(undefined);
  const programOpen = usePartnerProgramOpen();

  useEffect(() => onAuthStateChanged(auth, (next) => {
    setUser(next);
    setAccess(undefined);
    setAuthReady(true);
  }), []);
  const onAccess = useCallback((next: PartnerAccess) => setAccess(next), []);

  const signedIn = Boolean(user && !user.isAnonymous);
  if (!authReady || (!signedIn && programOpen === undefined)) return <main className="subscription-shell"><p>Loading...</p></main>;
  if (signedIn && access === 'hidden') return <Navigate to="/profile" replace />;
  // Closed program: invited people follow this link signed out, so ask them to sign in without
  // saying what for; the server decides what they see afterwards.
  if (!signedIn && !programOpen) {
    return (
      <main className="subscription-shell">
        <Link to="/">KidoCoach home</Link>
        <SignInCard title="Sign in to continue" />
      </main>
    );
  }

  return (
    <main className="subscription-shell">
      <Link to="/">KidoCoach home</Link>
      {/* Signed in: nothing about the program shows until the server says this account may see it. */}
      {(!signedIn || access !== undefined) && <h1>KidoCoach partner program</h1>}
      {(!signedIn || access === 'join' || access === 'verify_email') && <Pitch />}
      {!signedIn || !user ? (
        <SignInCard title="Sign in or create an account to join" />
      ) : (
        <>
          <PartnerPanel uid={user.uid} join defaultName={user.displayName ?? ''} defaultEmail={user.email ?? ''}
            onAccess={onAccess} />
          <p>Signed in as {user.email ?? 'partner'} · <button type="button" onClick={() => void signOut(auth)}>Sign out</button></p>
        </>
      )}
      {(!signedIn || access !== undefined) && (
        <footer><Link to="/terms#partners">Partner terms</Link> · <Link to="/privacy">Privacy</Link> · <button type="button" className="privacy-choices" onClick={openPrivacyChoices}>Privacy choices</button></footer>
      )}
    </main>
  );
}
