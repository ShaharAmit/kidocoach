import { GoogleAuthProvider, OAuthProvider, signInWithPopup } from 'firebase/auth';
import { auth } from './firebase';

export type SignInProvider = 'google' | 'apple';

export function signInWithProvider(provider: SignInProvider) {
  if (provider === 'google') {
    const google = new GoogleAuthProvider();
    google.setCustomParameters({ prompt: 'select_account' });
    return signInWithPopup(auth, google);
  }
  const apple = new OAuthProvider('apple.com');
  apple.addScope('email');
  apple.addScope('name');
  return signInWithPopup(auth, apple);
}

export function getAuthErrorMessage(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error) ||
      typeof error.code !== 'string') return null;
  const messages: Record<string, string> = {
    'auth/invalid-credential': 'Could not sign in. Check your email and password, or try your sign-in provider again.',
    'auth/wrong-password': 'Could not sign in. Check your email and password.',
    'auth/user-not-found': 'Could not sign in. Check your email and password.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/missing-password': 'Enter your password.',
    'auth/weak-password': 'Choose a stronger password with at least 6 characters.',
    'auth/password-does-not-meet-requirements': 'Choose a password that meets the account password requirements.',
    'auth/email-already-in-use': 'An account already uses this email. Sign in or reset your password instead.',
    'auth/account-exists-with-different-credential': 'An account already uses this email. Sign in with your original method. Accounts are not automatically merged.',
    'auth/popup-blocked': 'Your browser blocked the sign-in window. Allow pop-ups for this website and try again, or use email and password.',
    'auth/popup-closed-by-user': 'Sign-in was cancelled. Try again when you are ready.',
    'auth/cancelled-popup-request': 'Another sign-in window was opened. Complete the latest one.',
    'auth/unauthorized-domain': 'Sign-in is not configured for this website domain. Contact support or use the mobile app.',
    'auth/operation-not-allowed': 'This sign-in method is not enabled yet. Use another method or contact support.',
    'auth/operation-not-supported-in-this-environment': 'Sign-in is unavailable in this browser. Open this page in Safari, Chrome, or another supported browser.',
    'auth/invalid-oauth-client-id': 'This sign-in provider is not configured correctly. Use another method or contact support.',
    'auth/invalid-oauth-provider': 'This sign-in provider is not configured correctly. Use another method or contact support.',
    'auth/network-request-failed': 'Check your internet connection and try again.',
    'auth/too-many-requests': 'Too many attempts. Wait a little before trying again.',
    'auth/user-disabled': 'This account has been disabled. Contact support.',
    'auth/web-storage-unsupported': 'Allow website storage in your browser to sign in.',
  };
  return messages[error.code] ?? (error.code.startsWith('auth/')
    ? 'Sign-in failed. Please try again or use another sign-in method.'
    : null);
}
