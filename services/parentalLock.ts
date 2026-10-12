import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, db } from './firebase';

/**
 * Parent-chosen unlock method for the parental gate. The config lives in SecureStore (hashed PIN
 * only) and is mirrored to `users/{uid}.parentalLock` so a reinstall or new device can restore it.
 */
export type ParentalLockMethod = 'pin' | 'math';

export const PARENTAL_LOCK_METHODS: readonly ParentalLockMethod[] = ['pin', 'math'];
/** Methods offered by earlier builds. A saved one reads as "not chosen yet" so the parent picks again. */
const RETIRED_METHODS: readonly string[] = ['biometric', 'none'];
export const PIN_LENGTH = 4;
export const MAX_PIN_ATTEMPTS = 5;
export const PIN_LOCKOUT_MS = 60_000;

const LOCK_KEY = 'parental_lock_v1';
const LOCKOUT_KEY = 'parental_lock_lockout_v1';
const REMOTE_TIMEOUT_MS = 4_000;
const REMOTE_RETRY_MS = 5 * 60_000;

interface StoredLock {
  userId: string;
  method: ParentalLockMethod;
  pinHash?: string;
  pinSalt?: string;
  updatedAt: number;
}

interface LockoutState {
  failures: number;
  lockedUntil: number;
}

export type PinVerifyResult = { status: 'ok' } | { status: 'wrong'; attemptsLeft: number } | { status: 'locked'; remainingMs: number };

let memory: StoredLock | null = null;
let remoteFailedAt = 0;

function isMethod(value: unknown): value is ParentalLockMethod {
  return typeof value === 'string' && (PARENTAL_LOCK_METHODS as readonly string[]).includes(value);
}

export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

function parseLock(value: unknown, userId: string): StoredLock | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (typeof data.method === 'string' && RETIRED_METHODS.includes(data.method)) {
    return { userId, method: 'math', updatedAt: 0 };
  }
  if (!isMethod(data.method)) return null;
  const lock: StoredLock = {
    userId,
    method: data.method,
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
  };
  if (data.method === 'pin') {
    if (typeof data.pinHash !== 'string' || typeof data.pinSalt !== 'string') return null;
    lock.pinHash = data.pinHash;
    lock.pinSalt = data.pinSalt;
  }
  return lock;
}

async function hashPin(pin: string, salt: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `kidocoach:${salt}:${pin}`);
}

async function currentUserId(): Promise<string | null> {
  await auth.authStateReady();
  return auth.currentUser?.uid ?? null;
}

async function readLocal(userId: string): Promise<StoredLock | null> {
  if (memory?.userId === userId) return memory;
  try {
    const raw = await SecureStore.getItemAsync(LOCK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Never apply one family's lock to another signed-in family on the same device.
    if (parsed.userId !== userId) return null;
    const lock = parseLock(parsed, userId);
    if (lock) memory = lock;
    return lock;
  } catch (err) {
    console.warn('[ParentalLock] failed to read local lock:', err);
    return null;
  }
}

async function writeLocal(lock: StoredLock): Promise<void> {
  await SecureStore.setItemAsync(LOCK_KEY, JSON.stringify(lock));
  memory = lock;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

type RemoteLookup = { ok: true; lock: StoredLock | null } | { ok: false };

/** Pulls the cloud copy. Offline failures back off for a while (the gate falls back to math). */
async function fetchRemote(userId: string): Promise<RemoteLookup> {
  if (Date.now() - remoteFailedAt < REMOTE_RETRY_MS) return { ok: false };
  try {
    const snap = await withTimeout(getDoc(doc(db, 'users', userId)), REMOTE_TIMEOUT_MS);
    if (auth.currentUser?.uid !== userId) return { ok: false };
    const lock = snap.exists() ? parseLock(snap.data().parentalLock, userId) : null;
    // Cache a "nothing set" answer too (updatedAt 0), so later gates skip the network round-trip.
    await writeLocal(lock ?? { userId, method: 'math', updatedAt: 0 });
    return { ok: true, lock };
  } catch (err) {
    remoteFailedAt = Date.now();
    console.warn('[ParentalLock] cloud lookup failed; using math gate:', err);
    return { ok: false };
  }
}

async function readRemote(userId: string): Promise<StoredLock | null> {
  const result = await fetchRemote(userId);
  return result.ok ? result.lock : null;
}

async function resolveLock(): Promise<StoredLock | null> {
  const userId = await currentUserId();
  if (!userId) return null;
  return (await readLocal(userId)) ?? (await readRemote(userId));
}

/** Active method for the signed-in family. Defaults to the math question. */
export async function getParentalLockMethod(): Promise<ParentalLockMethod> {
  return (await resolveLock())?.method ?? 'math';
}

export type ParentalLockSetupState = 'configured' | 'unset' | 'unknown';

/**
 * Whether a parent has explicitly chosen a lock method for the signed-in family. A local
 * placeholder (updatedAt 0) is re-checked against the cloud, so a device never asks again — or
 * overwrites — a choice made on another device. `unknown` means offline; don't prompt yet.
 */
export async function getParentalLockSetupState(): Promise<ParentalLockSetupState> {
  const userId = await currentUserId();
  if (!userId) return 'unknown';
  const local = await readLocal(userId);
  if (local && local.updatedAt > 0) return 'configured';
  const remote = await fetchRemote(userId);
  if (!remote.ok) return 'unknown';
  return remote.lock && remote.lock.updatedAt > 0 ? 'configured' : 'unset';
}

/**
 * Saves the method on-device first (source of truth for the gate), then mirrors it to Firestore.
 * Returns whether the cloud backup succeeded; the local save throws on failure.
 */
export async function setParentalLock(method: ParentalLockMethod, pin?: string): Promise<{ backedUp: boolean }> {
  const userId = await currentUserId();
  if (!userId) throw new Error('Sign in before setting a parent lock.');
  const lock: StoredLock = { userId, method, updatedAt: Date.now() };
  if (method === 'pin') {
    if (!pin || !isValidPin(pin)) throw new Error(`The PIN must be ${PIN_LENGTH} digits.`);
    lock.pinSalt = Crypto.randomUUID();
    lock.pinHash = await hashPin(pin, lock.pinSalt);
  }
  await writeLocal(lock);
  await resetPinFailures();

  try {
    const { userId: _omit, ...parentalLock } = lock;
    await setDoc(doc(db, 'users', userId), { parentalLock }, { mergeFields: ['parentalLock'] });
    return { backedUp: true };
  } catch (err) {
    console.warn('[ParentalLock] cloud backup failed:', err);
    return { backedUp: false };
  }
}

async function readLockout(): Promise<LockoutState> {
  try {
    const raw = await SecureStore.getItemAsync(LOCKOUT_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<LockoutState>) : {};
    return {
      failures: typeof parsed.failures === 'number' ? parsed.failures : 0,
      lockedUntil: typeof parsed.lockedUntil === 'number' ? parsed.lockedUntil : 0,
    };
  } catch {
    return { failures: 0, lockedUntil: 0 };
  }
}

async function resetPinFailures(): Promise<void> {
  await SecureStore.deleteItemAsync(LOCKOUT_KEY).catch(() => undefined);
}

export async function getPinLockoutRemainingMs(): Promise<number> {
  const { lockedUntil } = await readLockout();
  return Math.max(0, lockedUntil - Date.now());
}

/** Verifies the PIN; locks entry for a minute after repeated failures (persisted across restarts). */
export async function verifyParentalPin(pin: string): Promise<PinVerifyResult> {
  const lockout = await readLockout();
  const remainingMs = lockout.lockedUntil - Date.now();
  if (remainingMs > 0) return { status: 'locked', remainingMs };

  const lock = await resolveLock();
  if (lock?.method !== 'pin' || !lock.pinHash || !lock.pinSalt) return { status: 'wrong', attemptsLeft: 0 };
  if (isValidPin(pin) && (await hashPin(pin, lock.pinSalt)) === lock.pinHash) {
    await resetPinFailures();
    return { status: 'ok' };
  }

  const failures = lockout.failures + 1;
  if (failures >= MAX_PIN_ATTEMPTS) {
    const lockedUntil = Date.now() + PIN_LOCKOUT_MS;
    await SecureStore.setItemAsync(LOCKOUT_KEY, JSON.stringify({ failures: 0, lockedUntil }));
    return { status: 'locked', remainingMs: PIN_LOCKOUT_MS };
  }
  await SecureStore.setItemAsync(LOCKOUT_KEY, JSON.stringify({ failures, lockedUntil: 0 }));
  return { status: 'wrong', attemptsLeft: MAX_PIN_ATTEMPTS - failures };
}

/** Removes this device's copy (account switch / reset). The cloud copy follows the user doc. */
export async function clearLocalParentalLock(): Promise<void> {
  memory = null;
  remoteFailedAt = 0;
  await Promise.all([
    SecureStore.deleteItemAsync(LOCK_KEY).catch(() => undefined),
    resetPinFailures(),
  ]);
}

export function parentalLockLabel(method: ParentalLockMethod): string {
  switch (method) {
    case 'pin': return '4-digit PIN';
    case 'math': return 'Math question';
  }
}
