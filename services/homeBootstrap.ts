import AsyncStorage from '@react-native-async-storage/async-storage';
import { collection, doc, getDocFromServer, getDocsFromServer } from 'firebase/firestore';
import { db } from './firebase';
import { cacheRoutines, readCachedRoutines } from './routineLocalCache';
import { defaultDurationMinutes, resolveDurationMode, starsForStep } from '../constants/activities';
import { ActivityKey, ActivityStep, ChildProfile, DurationMode, LocalDailyCompletion, Routine } from '../types';

type HomeBootstrapSnapshot = {
  userId: string;
  routines: Routine[];
  completions: Record<string, LocalDailyCompletion>;
  warmedRoutineIds: Record<string, true>;
  createdAt: number;
};

type UserRoutineProfile = {
  childName: string;
  childAge?: number;
  tone?: ChildProfile['tone'];
  voice?: ChildProfile['voice'];
  avatarId?: string;
};

type RoutineMeta = {
  id: string;
  scheduledTime: string;
  notificationId?: string;
};

type ActivityDoc = {
  id: string;
  activityKey: string;
  order: number;
  time: string;
  durationMinutes: number;
  durationMode: DurationMode;
  stars: number;
};

let snapshot: HomeBootstrapSnapshot | null = null;

function getTodayISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function completionStorageKey(routineId: string): string {
  return `daily_completion_${routineId}`;
}

function normalizeUserRoutineProfile(raw: Record<string, unknown> | null): UserRoutineProfile | null {
  if (!raw) return null;
  const childName = typeof raw.childName === 'string' ? raw.childName.trim() : '';
  if (!childName) return null;

  const age = typeof raw.age === 'number' ? raw.age : undefined;
  const tone = raw.tone === 'cheerful' || raw.tone === 'encouraging' || raw.tone === 'calm'
    ? raw.tone
    : undefined;
  const voice = raw.voice === 'woman' || raw.voice === 'man' ? raw.voice : undefined;
  const avatarId = typeof raw.avatarId === 'string' && raw.avatarId.trim().length > 0
    ? raw.avatarId
    : undefined;

  return {
    childName,
    childAge: age,
    tone,
    voice,
    avatarId,
  };
}

function normalizeRoutineMeta(id: string, raw: Record<string, unknown>): RoutineMeta {
  const scheduledTime = typeof raw.scheduledTime === 'string' ? raw.scheduledTime : '08:00';
  const notificationId = typeof raw.notificationId === 'string' ? raw.notificationId : undefined;
  return { id, scheduledTime, notificationId };
}

function normalizeActivityDocs(
  docs: Array<{ id: string; data: Record<string, unknown> }>
): ActivityDoc[] {
  return docs
    .map((entry, index) => {
      const key = entry.data.activityKey;
      const orderRaw = entry.data.order;
      const timeRaw = entry.data.time;
      if (typeof key !== 'string') return null;
      if (typeof timeRaw !== 'string') return null;
      return {
        id: entry.id,
        activityKey: key,
        order: typeof orderRaw === 'number' ? orderRaw : index,
        time: timeRaw,
        durationMinutes: typeof entry.data.durationMinutes === 'number' &&
          Number.isInteger(entry.data.durationMinutes * 4) && entry.data.durationMinutes >= 0.25 && entry.data.durationMinutes <= 180
          ? entry.data.durationMinutes : defaultDurationMinutes(key as ActivityKey),
        durationMode: resolveDurationMode(
          key as ActivityKey,
          entry.data.durationMode,
          typeof entry.data.durationMinutes === 'number' ? entry.data.durationMinutes : undefined
        ),
        stars: Number.isInteger(entry.data.stars) && (entry.data.stars as number) >= 0 && (entry.data.stars as number) <= 2
          ? entry.data.stars as number : starsForStep([key as ActivityKey]),
      };
    })
    .filter((item): item is ActivityDoc => Boolean(item))
    .sort((a, b) => a.order - b.order);
}

function composeRoutine(
  userId: string,
  meta: RoutineMeta,
  activities: ActivityDoc[],
  userProfile: UserRoutineProfile | null
): Routine {
  const activityStack: ActivityStep[] = activities.map((item) => [item.activityKey as ActivityKey]);
  const stepIds = activities.map((item) => item.id);
  const stepTimes = activities.map((item) => item.time);
  const stepDurations = activities.map((item) => item.durationMinutes);
  const stepDurationModes = activities.map((item) => item.durationMode);
  const stepStars = activities.map((item) => item.stars);
  const scheduledTime = meta.scheduledTime || stepTimes[0] || '08:00';

  return {
    id: meta.id,
    userId,
    childName: userProfile?.childName ?? '',
    childAge: userProfile?.childAge,
    avatarId: userProfile?.avatarId ?? 'becky',
    scheduledTime,
    activityStack,
    stepIds,
    stepTimes,
    stepDurations,
    stepDurationModes,
    stepStars,
    tone: userProfile?.tone,
    voice: userProfile?.voice,
    notificationId: meta.notificationId,
  };
}

async function readTodaysCompletion(routineId: string): Promise<LocalDailyCompletion | null> {
  try {
    const raw = await AsyncStorage.getItem(completionStorageKey(routineId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalDailyCompletion;
    if (parsed.date !== getTodayISO()) return null;
    if (!Array.isArray(parsed.morning) || !Array.isArray(parsed.evening)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function fetchRemoteRoutines(userId: string): Promise<Routine[]> {
  const userSnap = await getDocFromServer(doc(db, 'users', userId));
  const userProfile = userSnap.exists()
    ? normalizeUserRoutineProfile(userSnap.data() as Record<string, unknown>)
    : null;

  const routineDocs = await getDocsFromServer(collection(db, 'users', userId, 'routines'));
  const routines = await Promise.all(
    routineDocs.docs.map(async (routineDoc) => {
      const meta = normalizeRoutineMeta(routineDoc.id, routineDoc.data() as Record<string, unknown>);
      const activityDocs = await getDocsFromServer(
        collection(db, 'users', userId, 'routines', routineDoc.id, 'activities')
      );
      const activities = normalizeActivityDocs(
        activityDocs.docs.map((activityDoc) => ({
          id: activityDoc.id,
          data: activityDoc.data() as Record<string, unknown>,
        }))
      );
      return composeRoutine(userId, meta, activities, userProfile);
    })
  );

  return routines;
}

export async function primeHomeBootstrap(userId: string): Promise<HomeBootstrapSnapshot> {
  let routines: Routine[];
  try {
    routines = await fetchRemoteRoutines(userId);
    await cacheRoutines(userId, routines).catch((err) => {
      console.warn('[HomeBootstrap] Failed to cache remote routines:', err);
    });
  } catch (err) {
    routines = await readCachedRoutines(userId);
    if (routines.length === 0) throw err;
  }

  const completions: Record<string, LocalDailyCompletion> = {};
  await Promise.all(
    routines.map(async (routine) => {
      const completion = await readTodaysCompletion(routine.id);
      if (completion) {
        completions[routine.id] = completion;
      }
    })
  );

  snapshot = {
    userId,
    routines,
    completions,
    warmedRoutineIds: snapshot?.userId === userId ? snapshot.warmedRoutineIds : {},
    createdAt: Date.now(),
  };

  return snapshot;
}

export function getHomeBootstrapSnapshot(userId?: string): HomeBootstrapSnapshot | null {
  if (!snapshot) return null;
  if (userId && snapshot.userId !== userId) return null;
  return snapshot;
}

export function markRoutineWarmed(routineId: string, warmed: boolean): void {
  if (!snapshot) return;
  if (warmed) {
    snapshot.warmedRoutineIds[routineId] = true;
    return;
  }
  delete snapshot.warmedRoutineIds[routineId];
}

export function isRoutineWarmed(routineId: string): boolean {
  if (!snapshot) return false;
  return Boolean(snapshot.warmedRoutineIds[routineId]);
}

export function clearHomeBootstrap(): void {
  snapshot = null;
}
