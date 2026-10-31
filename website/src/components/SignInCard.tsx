import { useState, type FormEvent } from 'react';
import {
  createUserWithEmailAndPassword, sendPasswordResetEmail, signInWithEmailAndPassword,
} from 'firebase/auth';
import { auth } from '../services/firebase';
import { getAuthErrorMessage, signInWithProvider, type SignInProvider } from '../services/accountAuth';
import ProviderSignInButton from './ProviderSignInButton';

function messageFor(error: unknown): string {
  const authMessage = getAuthErrorMessage(error);
  if (authMessage) return authMessage;
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

/** Email/password, Google and Apple sign-in for the parent (or partner) account. */
export default function SignInCard({ title }: { title?: string }) {
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingProvider, setPendingProvider] = useState<SignInProvider | null>(null);
  const [message, setMessage] = useState('');

  async function run(operation: () => Promise<unknown>, provider?: SignInProvider) {
    if (busy) return;
    setBusy(true);
    setPendingProvider(provider ?? null);
    setMessage('');
    try {
      await operation();
    } catch (error) {
      console.warn('[Auth] Sign-in failed:', error);
      setMessage(messageFor(error));
    } finally {
      setBusy(false);
      setPendingProvider(null);
    }
  }

  function authenticate(event: FormEvent) {
    event.preventDefault();
    void run(() => register
      ? createUserWithEmailAndPassword(auth, email.trim(), password)
      : signInWithEmailAndPassword(auth, email.trim(), password));
  }

  return (
    <section className="subscription-card">
      <h2>{title ?? (register ? 'Create an account' : 'Sign in')}</h2>
      <form onSubmit={authenticate}>
        <label>Email<input type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required value={email}
          onChange={(e) => setEmail(e.target.value)} disabled={busy} /></label>
        <label>Password<input type="password" autoComplete={register ? 'new-password' : 'current-password'}
          required minLength={register ? 6 : undefined} value={password}
          onChange={(e) => setPassword(e.target.value)} disabled={busy} /></label>
        <button disabled={busy}>{register ? 'Create account' : 'Sign in'}</button>
      </form>
      <button disabled={busy} onClick={() => setRegister(!register)}>
        {register ? 'Already have an account? Sign in' : 'New here? Create an account'}
      </button>
      <button disabled={busy || !email.trim()} onClick={() => void run(async () => {
        await sendPasswordResetEmail(auth, email.trim());
        setMessage('If an account exists, you will receive a password reset email.');
      })}>Reset password</button>
      <ProviderSignInButton provider="google" disabled={busy}
        onClick={() => void run(() => signInWithProvider('google'), 'google')} />
      <ProviderSignInButton provider="apple" disabled={busy}
        onClick={() => void run(() => signInWithProvider('apple'), 'apple')} />
      {pendingProvider && <div>
        <p role="status" aria-live="polite">
          Waiting for {pendingProvider === 'apple' ? 'Apple' : 'Google'}.
          If you closed the sign-in window, cancel below to try again.
        </p>
        <button type="button" onClick={() => {
          // Firebase cannot abort a popup request; reload prevents a late result racing a retry.
          window.location.reload();
        }}>Cancel sign-in</button>
      </div>}
      {message && <p role="status" aria-live="polite">{message}</p>}
    </section>
  );
}
