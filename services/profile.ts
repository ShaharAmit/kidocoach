import AsyncStorage from '@react-native-async-storage/async-storage';
import { ChildProfile } from '../types';
import { doc, getDoc, getDocFromServer, setDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import { normalizeChildProfile } from '../utils/childProfile';

const PROFILE_KEY = 'child_profile_v1';

type UserProfileDoc = {
  childName: string;
  age: number;
  voice: ChildProfile['voice'];
  tone: ChildProfile['tone'];
  avatarId: string;
  updatedAt: number;
};

function isValidVoice(value: unknown): value is ChildProfile['voice'] {
  return value === 'woman' || value === 'man';
}

function isValidTone(value: unknown): value is ChildProfile['tone'] {
  return value === 'cheerful' || value === 'encouraging' || value === 'calm';
}

async function removeInvalidProfile(reason: string): Promise<null> {
  console.warn('[Profile] clearing invalid stored profile:', reason);
  await AsyncStorage.removeItem(PROFILE_KEY);
  return null;
}

export async function saveChildProfile(profile: ChildProfile): Promise<void> {
  if (auth.currentUser?.uid !== profile.userId) {
    throw new Error('The family account changed. Please reload before saving its setup.');
  }
  const normalized = normalizeChildProfile(profile, profile.userId);
  if (!normalized) throw new Error('Cannot save an invalid child profile.');
  await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(normalized));
}

export async function saveUserProfileDoc(profile: ChildProfile): Promise<void> {
  const payload: UserProfileDoc = {
    childName: profile.childName.trim(),
    age: profile.age,
    voice: profile.voice,
    tone: profile.tone,
    avatarId: profile.avatarId,
    updatedAt: Date.now(),
  };
  const normalized = normalizeChildProfile(profile, profile.userId);
  if (!normalized) throw new Error('Cannot back up an invalid child profile.');
  if (auth.currentUser?.uid !== profile.userId) {
    throw new Error('Sign in to the family account before saving its profile.');
  }
  // JSON removes optional undefined fields, which Firestore rejects.
  const childProfile = JSON.parse(JSON.stringify({
    ...normalized,
    activityStack: normalized.activityStack.map((activities) => ({ activities })),
  }));
  await setDoc(doc(db, 'users', profile.userId), { ...payload, childProfile }, {
    mergeFields: [...Object.keys(payload), 'childProfile'],
  });
}

export async function fetchRecoverableChildProfile(userId: string): Promise<ChildProfile | null> {
  if (auth.currentUser?.uid !== userId) throw new Error('The family account has changed. Please sign in again.');
  const snap = await getDocFromServer(doc(db, 'users', userId));
  if (auth.currentUser?.uid !== userId) throw new Error('The family account changed during recovery.');
  if (!snap.exists() || snap.data().childProfile === undefined) return null;
  const profile = normalizeChildProfile(snap.data().childProfile, userId);
  if (!profile) {
    console.warn('[Profile] Cloud questionnaire profile is invalid; setup is required.');
    return null;
  }
  return profile;
}

export async function recoverChildProfile(userId: string): Promise<ChildProfile | null> {
  const profile = await fetchRecoverableChildProfile(userId);
  if (profile) await saveChildProfile(profile);
  return profile;
}

export async function getUserProfileDoc(userId: string): Promise<UserProfileDoc | null> {
  if (!userId) return null;
  const snap = await getDoc(doc(db, 'users', userId));
  if (!snap.exists()) return null;
  const data = snap.data() as Partial<UserProfileDoc>;
  if (
    typeof data.childName !== 'string' ||
    typeof data.age !== 'number' ||
    !isValidVoice(data.voice) ||
    !isValidTone(data.tone) ||
    typeof data.avatarId !== 'string'
  ) {
    return null;
  }

  return {
    childName: data.childName.trim(),
    age: data.age,
    voice: data.voice,
    tone: data.tone,
    avatarId: data.avatarId,
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : Date.now(),
  };
}

export async function getChildProfile(): Promise<ChildProfile | null> {
  await auth.authStateReady();
  if (!auth.currentUser) return null;
  const raw = await AsyncStorage.getItem(PROFILE_KEY);
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    const profile = normalizeChildProfile(parsed);
    if (!profile) return removeInvalidProfile('invalid-profile');
    // Never display one family's cached setup under another Firebase identity.
    if (auth.currentUser && profile.userId !== auth.currentUser.uid) return null;
    return profile;
  } catch {
    return removeInvalidProfile('json-parse-failure');
  }
}

export async function clearChildProfile(): Promise<void> {
  await AsyncStorage.removeItem(PROFILE_KEY);
}

export async function hasCompletedOnboarding(): Promise<boolean> {
  const profile = await getChildProfile();
  return !!profile;
}
