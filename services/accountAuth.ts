import { Platform, TurboModuleRegistry } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  OAuthProvider,
  linkWithCredential,
  revokeAccessToken,
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut,
  type AuthCredential,
  type User,
} from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { auth, ensureAuth, functions } from './firebase';

export type AccountProvider = 'apple' | 'google';

type GoogleModule = typeof import('@react-native-google-signin/google-signin');
let googleModule: GoogleModule | undefined;
let googleModulePromise: Promise<GoogleModule> | undefined;
let accountOperationInProgress = false;

class AccountAuthError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'AccountAuthError';
  }
}

function errorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return '';
  return typeof error.code === 'string' || typeof error.code === 'number'
    ? String(error.code)
    : '';
}

async function runAccountOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (accountOperationInProgress) throw new AccountAuthError('account/in-progress');
  accountOperationInProgress = true;
  try {
    return await operation();
  } finally {
    accountOperationInProgress = false;
  }
}

function normalizedEmail(email: string): string {
  const value = email.trim();
  if (!value) throw new AccountAuthError('auth/invalid-email');
  return value;
}

function validatePassword(password: string): void {
  // Password whitespace is significant; never trim it.
  if (!password) throw new AccountAuthError('account/missing-password');
}

async function anonymousUser(): Promise<User> {
  const user = await ensureAuth();
  if (!user.isAnonymous) throw new AccountAuthError('account/already-registered');
  return user;
}

function assertAnonymousSession(user: User): void {
  if (auth.currentUser?.uid !== user.uid || !auth.currentUser.isAnonymous) {
    throw new AccountAuthError('account/session-changed');
  }
}

function googleIsConfigured(): boolean {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return false;
  if (!process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID?.trim()) return false;
  if (Platform.OS === 'ios' && !Constants.expoConfig?.ios?.googleServicesFile) {
    const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim();
    if (!iosClientId?.endsWith('.apps.googleusercontent.com')) return false;
    const scheme = `com.googleusercontent.apps.${iosClientId.replace('.apps.googleusercontent.com', '')}`;
    const hasScheme = Constants.expoConfig?.plugins?.some((plugin) =>
      Array.isArray(plugin) &&
      plugin[0] === '@react-native-google-signin/google-signin' &&
      plugin[1]?.iosUrlScheme === scheme
    );
    if (!hasScheme) return false;
  }
  return TurboModuleRegistry.get('RNGoogleSignin') !== null;
}

async function getGoogleModule(): Promise<GoogleModule> {
  if (!googleIsConfigured()) throw new AccountAuthError('account/provider-unavailable');
  if (!googleModulePromise) {
    googleModulePromise = import('@react-native-google-signin/google-signin').then((module) => {
      module.GoogleSignin.configure({
        webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID?.trim(),
        iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim() || undefined,
      });
      googleModule = module;
      return module;
    });
  }
  return googleModulePromise;
}

async function providerCredential(
  provider: AccountProvider
): Promise<{ credential: AuthCredential; appleAuthorizationCode?: string }> {
  if (provider === 'apple') {
    if (Platform.OS !== 'ios' || !(await AppleAuthentication.isAvailableAsync())) {
      throw new AccountAuthError('account/provider-unavailable');
    }
    const bytes = await Crypto.getRandomBytesAsync(32);
    const rawNonce = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const nonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);
    const result = await AppleAuthentication.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL],
      nonce,
    });
    if (!result.identityToken) throw new AccountAuthError('account/missing-token');
    // Apple receives the hash; Firebase must receive the original nonce.
    return {
      credential: new OAuthProvider('apple.com').credential({
        idToken: result.identityToken,
        rawNonce,
      }),
      appleAuthorizationCode: result.authorizationCode ?? undefined,
    };
  }
  if (provider === 'google') {
    const { GoogleSignin } = await getGoogleModule();
    if (!(await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true }))) {
      throw new AccountAuthError('account/play-services-unavailable');
    }
    const result = await GoogleSignin.signIn();
    if (result.type === 'cancelled') throw new AccountAuthError('account/cancelled');
    if (!result.data.idToken) throw new AccountAuthError('account/missing-token');
    return { credential: GoogleAuthProvider.credential(result.data.idToken) };
  }
  throw new AccountAuthError('account/provider-unavailable');
}

/**
 * Hands Apple's one-time authorization code to the backend, which keeps a refresh token so
 * account deletion can revoke the Apple grant without another Apple prompt. Best-effort: if it
 * fails, deletion falls back to {@link revokeAppleSignInWithPrompt}.
 */
function registerAppleAuthorization(authorizationCode: string | undefined): void {
  if (!authorizationCode) return;
  httpsCallable<{ authorizationCode: string }, { stored: true }>(functions, 'registerAppleAuthorization')({
    authorizationCode,
  }).catch((err: unknown) => {
    console.warn('[AccountAuth] Failed to register Apple authorization for deletion:', err);
  });
}

/** Upgrade the guest account without changing its UID or switching accounts on conflicts. */
export async function registerParentWithEmail(email: string, password: string): Promise<User> {
  return runAccountOperation(async () => {
    const address = normalizedEmail(email);
    validatePassword(password);
    const user = await anonymousUser();
    assertAnonymousSession(user);
    return (await linkWithCredential(user, EmailAuthProvider.credential(address, password))).user;
  });
}

/** Explicit account switching; the caller owns profile recovery and navigation. */
export async function loginParentWithEmail(email: string, password: string): Promise<User> {
  return runAccountOperation(async () => {
    const address = normalizedEmail(email);
    validatePassword(password);
    await ensureAuth();
    return (await signInWithEmailAndPassword(auth, address, password)).user;
  });
}

export async function connectParentProvider(provider: AccountProvider): Promise<User> {
  return runAccountOperation(async () => {
    const user = await anonymousUser();
    const { credential, appleAuthorizationCode } = await providerCredential(provider);
    assertAnonymousSession(user);
    const linkedUser = (await linkWithCredential(user, credential)).user;
    registerAppleAuthorization(appleAuthorizationCode);
    return linkedUser;
  });
}

export async function loginParentProvider(provider: AccountProvider): Promise<User> {
  return runAccountOperation(async () => {
    await ensureAuth();
    const { credential, appleAuthorizationCode } = await providerCredential(provider);
    const signedInUser = (await signInWithCredential(auth, credential)).user;
    registerAppleAuthorization(appleAuthorizationCode);
    return signedInUser;
  });
}

export async function resetParentPassword(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, normalizedEmail(email));
}

/** Only signs out Firebase; local profile/cache cleanup is the caller's responsibility. */
export async function signOutParent(): Promise<void> {
  return runAccountOperation(async () => {
    await auth.authStateReady();
    await signOut(auth);
  });
}

/**
 * Fallback Apple revocation for account deletion when the backend has no usable refresh token
 * (accounts linked before server-side registration, or a failed exchange). Apple requires a
 * fresh authorization code for this, so its sheet is shown once. Throws `account/cancelled` if
 * the parent dismisses it.
 */
export async function revokeAppleSignInWithPrompt(): Promise<void> {
  if (Platform.OS !== 'ios' || !(await AppleAuthentication.isAvailableAsync())) {
    throw new AccountAuthError('account/provider-unavailable');
  }
  const result = await AppleAuthentication.signInAsync({ requestedScopes: [] });
  if (!result.authorizationCode) throw new AccountAuthError('account/missing-token');
  await revokeAccessToken(auth, result.authorizationCode);
}

/** Revokes the Google grant before account deletion; never prompts. */
export async function revokeGoogleSignIn(user: User): Promise<void> {
  if (!user.providerData.some((provider) => provider.providerId === 'google.com') || !googleIsConfigured()) return;
  const { GoogleSignin } = await getGoogleModule();
  await GoogleSignin.revokeAccess().catch((err: unknown) => {
    console.warn('[AccountAuth] Google revokeAccess failed:', err);
  });
}

/** Email/password is always available independently of native provider availability. */
export async function getAvailableAccountProviders(): Promise<AccountProvider[]> {
  const providers: AccountProvider[] = [];
  if (Platform.OS === 'ios' && await AppleAuthentication.isAvailableAsync()) providers.push('apple');
  if (googleIsConfigured()) providers.push('google');
  return providers;
}

export function isAccountCancellation(error: unknown): boolean {
  const code = errorCode(error);
  return ['account/cancelled', 'ERR_REQUEST_CANCELED', 'SIGN_IN_CANCELLED', '12501'].includes(code) ||
    (googleModule !== undefined && code === googleModule.statusCodes.SIGN_IN_CANCELLED);
}

export function getAccountErrorMessage(error: unknown): string {
  if (isAccountCancellation(error)) return 'Sign-in was cancelled.';
  const code = errorCode(error);
  const messages: Record<string, string> = {
    'account/already-registered': 'This session already has a parent account. Sign out before connecting a different account.',
    'account/session-changed': 'Your account changed during sign-in. Please try again.',
    'account/in-progress': 'Another account action is in progress. Please wait.',
    'account/provider-unavailable': 'This sign-in option is not configured or available on this device. Use email instead.',
    'account/missing-token': 'The sign-in provider did not return a valid identity token. Please try again.',
    'account/missing-password': 'Enter your password.',
    'account/play-services-unavailable': 'Google Play Services must be installed and up to date to sign in with Google.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/weak-password': 'Choose a stronger password with at least 6 characters.',
    'auth/password-does-not-meet-requirements': 'Choose a password that meets the account password requirements.',
    'auth/email-already-in-use': 'This email already belongs to an account. Use Log In to access it; your current guest data has not been moved.',
    'auth/credential-already-in-use': 'This sign-in already belongs to another account. Use Log In to access it; your current guest data has not been moved.',
    'auth/account-exists-with-different-credential': 'An account already exists with this email. Log in using the original sign-in method.',
    'auth/provider-already-linked': 'This account is already connected. Use Log In instead.',
    'auth/invalid-credential': 'The email, password, or sign-in credential is invalid. Please try again.',
    'auth/wrong-password': 'The email or password is incorrect.',
    'auth/user-not-found': 'The email or password is incorrect.',
    'auth/user-disabled': 'This account has been disabled. Contact support.',
    'auth/too-many-requests': 'Too many attempts. Wait a little before trying again.',
    'auth/network-request-failed': 'Check your internet connection and try again.',
    'auth/operation-not-allowed': 'This sign-in method is not enabled. Contact support or use another method.',
    'auth/requires-recent-login': 'Please log in again before changing this account.',
    'auth/invalid-api-key': 'Account sign-in is not configured correctly. Contact support.',
    'auth/app-not-authorized': 'This app is not authorized for account sign-in. Contact support.',
    'auth/missing-or-invalid-nonce': 'Apple sign-in could not be verified. Please try again.',
    'ERR_REQUEST_NOT_HANDLED': 'Apple sign-in is unavailable. Check your Apple account and try again.',
    'ERR_REQUEST_FAILED': 'Apple sign-in failed. Please try again.',
    'ERR_REQUEST_INVALID_RESPONSE': 'Apple sign-in returned an invalid response. Please try again.',
    'ERR_REQUEST_UNKNOWN': 'Apple sign-in failed. Please try again.',
    'DEVELOPER_ERROR': 'Google sign-in is not configured correctly. Contact support or use email.',
    '10': 'Google sign-in is not configured correctly. Contact support or use email.',
  };
  if (googleModule && code === googleModule.statusCodes.IN_PROGRESS) {
    return 'Google sign-in is already in progress. Please wait.';
  }
  if (googleModule && code === googleModule.statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
    return messages['account/play-services-unavailable'];
  }
  return messages[code] ?? 'Account sign-in failed. Please try again or use a different sign-in method.';
}
