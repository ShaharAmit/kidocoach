import { useState, useEffect } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { db } from '../services/firebase';
import { defaultDurationMinutes, resolveDurationMode, starsForStep } from '../constants/activities';
import { ActivityKey, ActivityStep, ChildProfile, DurationMode, Routine } from '../types';
import { getHomeBootstrapSnapshot } from '../services/homeBootstrap';
import { cacheRoutine, cacheRoutines } from '../services/routineLocalCache';
import { isMorningTime } from '../utils/timeOfDay';

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
  activityKey: ActivityKey;
  order: number;
  time: string;
  durationMinutes: number;
  durationMode: DurationMode;
  stars: number;
};

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
      const activityKey = entry.data.activityKey;
      const orderRaw = entry.data.order;
      const timeRaw = entry.data.time;
      if (typeof activityKey !== 'string') return null;
      if (typeof timeRaw !== 'string') return null;

      return {
        id: entry.id,
        activityKey: activityKey as ActivityKey,
        order: typeof orderRaw === 'number' ? orderRaw : index,
        time: timeRaw,
        durationMinutes: typeof entry.data.durationMinutes === 'number' &&
          Number.isInteger(entry.data.durationMinutes * 4) && entry.data.durationMinutes >= 0.25 && entry.data.durationMinutes <= 180
          ? entry.data.durationMinutes : defaultDurationMinutes(activityKey as ActivityKey),
        durationMode: resolveDurationMode(
          activityKey as ActivityKey,
          entry.data.durationMode,
          typeof entry.data.durationMinutes === 'number' ? entry.data.durationMinutes : undefined
        ),
        stars: Number.isInteger(entry.data.stars) && (entry.data.stars as number) >= 0 && (entry.data.stars as number) <= 2
          ? entry.data.stars as number : starsForStep([activityKey as ActivityKey]),
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
  const activityStack: ActivityStep[] = activities.map((item) => [item.activityKey]);
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

function inferRoutineId(routine: Routine): 'morning' | 'evening' {
  if (routine.id === 'morning' || routine.id === 'evening') {
    return routine.id;
  }
  const anchorTime = routine.stepTimes?.[0] ?? routine.scheduledTime;
  return isMorningTime(anchorTime) ? 'morning' : 'evening';
}

/**
 * Subscribe to a single routine document by ID.
 * Returns the routine and a loading flag.
 */
export function useRoutine(routineId: string, userId: string) {
  const [routine, setRoutine] = useState<Routine | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!routineId || !userId) return;

    let latestUserProfile: UserRoutineProfile | null = null;
    let latestMeta: RoutineMeta | null = null;
    let latestActivities: ActivityDoc[] = [];
    let userReady = false;
    let routineReady = false;
    let activitiesReady = false;

    const emit = () => {
      if (!userReady || !routineReady || !activitiesReady) return;
      if (!latestMeta) {
        setRoutine(null);
        setLoading(false);
        return;
      }
      setRoutine(composeRoutine(userId, latestMeta, latestActivities, latestUserProfile));
      setLoading(false);
    };

    const unsubscribeUser = onSnapshot(
      doc(db, 'users', userId),
      { includeMetadataChanges: true },
      (snap) => {
        if (snap.metadata.fromCache) return;
        latestUserProfile = snap.exists()
          ? normalizeUserRoutineProfile(snap.data() as Record<string, unknown>)
          : null;
        userReady = true;
        emit();
      },
      (err) => {
        setError(err);
        setLoading(false);
      }
    );

    const routineRef = doc(db, 'users', userId, 'routines', routineId);
    const unsubscribeRoutine = onSnapshot(
      routineRef,
      (snap) => {
        latestMeta = snap.exists()
          ? normalizeRoutineMeta(snap.id, snap.data() as Record<string, unknown>)
          : null;
        routineReady = true;
        emit();
      },
      (err) => {
        setError(err);
        setLoading(false);
      }
    );

    const unsubscribeActivities = onSnapshot(
      collection(db, 'users', userId, 'routines', routineId, 'activities'),
      (snap) => {
        latestActivities = normalizeActivityDocs(
          snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }))
        );
        activitiesReady = true;
        emit();
      },
      (err) => {
        setError(err);
        setLoading(false);
      }
    );

    return () => {
      unsubscribeUser();
      unsubscribeRoutine();
      unsubscribeActivities();
    };
  }, [routineId, userId]);

  return { routine, loading, error };
}

/**
 * Subscribe to all routines for a given user ID.
 */
export function useUserRoutines(userId: string) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      setRoutines([]);
      return;
    }

    const bootstrapped = getHomeBootstrapSnapshot(userId);
    if (bootstrapped?.routines?.length) {
      setRoutines(bootstrapped.routines);
      setLoading(false);
    } else {
      setLoading(true);
    }

    let latestUserProfile: UserRoutineProfile | null = null;
    const metaById = new Map<string, RoutineMeta>();
    const activitiesById = new Map<string, ActivityDoc[]>();
    const activityUnsubs = new Map<string, () => void>();
    let routinesReady = false;
    let userReady = false;

    const emit = () => {
      if (!routinesReady || !userReady || Array.from(metaById.keys()).some((id) => !activitiesById.has(id))) return;
      const data = Array.from(metaById.values())
        .map((meta) =>
          composeRoutine(userId, meta, activitiesById.get(meta.id) ?? [], latestUserProfile)
        )
        .sort((a, b) => a.id.localeCompare(b.id));
      setRoutines(data);
      setLoading(false);
      cacheRoutines(userId, data).catch((err) => {
        console.warn('[useUserRoutines] Failed to cache routines:', err);
      });
    };

    const unsubscribeUser = onSnapshot(
      doc(db, 'users', userId),
      (snap) => {
        latestUserProfile = snap.exists()
          ? normalizeUserRoutineProfile(snap.data() as Record<string, unknown>)
          : null;
        userReady = true;
        emit();
      },
      (err) => {
        setError(err);
        setLoading(false);
      }
    );

    const unsubscribeRoutines = onSnapshot(
      collection(db, 'users', userId, 'routines'),
      { includeMetadataChanges: true },
      (snap) => {
        if (snap.metadata.fromCache) return;
        const nextIds = new Set<string>();

        snap.docs.forEach((d) => {
          nextIds.add(d.id);
          metaById.set(d.id, normalizeRoutineMeta(d.id, d.data() as Record<string, unknown>));

          if (!activityUnsubs.has(d.id)) {
            const unsub = onSnapshot(
              collection(db, 'users', userId, 'routines', d.id, 'activities'),
              { includeMetadataChanges: true },
              (activitySnap) => {
                if (activitySnap.metadata.fromCache) return;
                activitiesById.set(
                  d.id,
                  normalizeActivityDocs(
                    activitySnap.docs.map((a) => ({ id: a.id, data: a.data() as Record<string, unknown> }))
                  )
                );
                emit();
              },
              (err) => {
                setError(err);
                setLoading(false);
              }
            );
            activityUnsubs.set(d.id, unsub);
          }
        });

        Array.from(metaById.keys()).forEach((id) => {
          if (nextIds.has(id)) return;
          metaById.delete(id);
          activitiesById.delete(id);
          const unsub = activityUnsubs.get(id);
          if (unsub) {
            unsub();
            activityUnsubs.delete(id);
          }
        });

        routinesReady = true;
        emit();
      },
      (err) => {
        setError(err);
        setLoading(false);
      }
    );

    return () => {
      unsubscribeUser();
      unsubscribeRoutines();
      Array.from(activityUnsubs.values()).forEach((unsub) => unsub());
    };
  }, [userId]);

  return { routines, loading, error };
}

/**
 * Save or update a routine in Firestore under fixed IDs: morning/evening.
 * Activities are stored as one document per step in `activities`.
 */
export async function saveRoutine(routine: Routine): Promise<void> {
  if (!routine.userId) {
    throw new Error('Cannot save routine without userId.');
  }

  const routineId = inferRoutineId(routine);
  const routineRef = doc(db, 'users', routine.userId, 'routines', routineId);
  const activitiesRef = collection(db, 'users', routine.userId, 'routines', routineId, 'activities');
  const existingActivities = await getDocs(activitiesRef);

  const batch = writeBatch(db);
  existingActivities.docs.forEach((activityDoc) => {
    batch.delete(activityDoc.ref);
  });

  const stepTimes = routine.stepTimes ?? [];
  const stepIds = routine.stepIds ?? [];
  routine.activityStack.forEach((step, index) => {
    const activityKey = step[0];
    if (!activityKey) return;
    const stepId = typeof stepIds[index] === 'string' && stepIds[index].length > 0
      ? stepIds[index]
      : `step_${index}`;
    const activityRef = doc(db, 'users', routine.userId, 'routines', routineId, 'activities', stepId);
    batch.set(activityRef, {
      activityKey,
      order: index,
      time: stepTimes[index] ?? routine.scheduledTime,
      durationMinutes: routine.stepDurations?.[index] ?? defaultDurationMinutes(activityKey),
      durationMode: routine.stepDurationModes?.[index] ?? resolveDurationMode(activityKey, undefined, routine.stepDurations?.[index]),
      stars: routine.stepStars?.[index] ?? starsForStep(step),
      updatedAt: Date.now(),
    });
  });

  await batch.commit();

  const meta: Record<string, unknown> = {
    scheduledTime: stepTimes[0] ?? routine.scheduledTime,
    updatedAt: Date.now(),
  };
  if (typeof routine.notificationId === 'string' && routine.notificationId.length > 0) {
    meta.notificationId = routine.notificationId;
  }
  await setDoc(routineRef, meta, { merge: true });

  await cacheRoutine({
    ...routine,
    id: routineId,
    stepIds: routine.activityStack.map((_, index) => stepIds[index] ?? `step_${index}`),
    stepTimes: routine.activityStack.map((_, index) => stepTimes[index] ?? routine.scheduledTime),
    stepDurations: routine.activityStack.map((step, index) =>
      routine.stepDurations?.[index] ?? defaultDurationMinutes(step[0])
    ),
    stepDurationModes: routine.activityStack.map((step, index) =>
      routine.stepDurationModes?.[index] ?? resolveDurationMode(step[0], undefined, routine.stepDurations?.[index])
    ),
    stepStars: routine.activityStack.map((step, index) => routine.stepStars?.[index] ?? starsForStep(step)),
  });
}

export async function saveRoutineIfMissing(routine: Routine): Promise<boolean> {
  if (!routine.userId) {
    throw new Error('Cannot save routine without userId.');
  }
  const routineId = inferRoutineId(routine);
  const routineRef = doc(db, 'users', routine.userId, 'routines', routineId);
  const existing = await getDoc(routineRef);
  if (existing.exists()) return false;

  await saveRoutine({ ...routine, id: routineId });
  return true;
}

/**
 * Update only the notificationId field on an existing routine.
 */
export async function updateNotificationId(
  userId: string,
  routineId: string,
  notificationId: string
): Promise<void> {
  await updateDoc(doc(db, 'users', userId, 'routines', routineId), { notificationId });
}

export async function deleteRoutine(userId: string, routineId: string): Promise<void> {
  const activitiesRef = collection(db, 'users', userId, 'routines', routineId, 'activities');
  const activityDocs = await getDocs(activitiesRef);
  await Promise.all(activityDocs.docs.map((d) => deleteDoc(d.ref)));
  await deleteDoc(doc(db, 'users', userId, 'routines', routineId));
}
