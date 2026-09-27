import { httpsCallable } from 'firebase/functions';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { db, ensureAuth, functions } from './firebase';
import { getChildProfile, saveChildProfile } from './profile';

interface AwardRoutineStepStarRequest {
  userId: string;
  routineId: string;
  date: string; // YYYY-MM-DD
  segment: 'morning' | 'evening';
  stepIndex: number;
  stepId: string;
  stars?: number;
}

interface AwardRoutineStepStarResponse {
  totalStars: number;
  awarded: boolean;
}

const pendingAwardsKey = (userId: string) => `pending_step_awards_${userId}`;
let pendingFlush: Promise<void> | null = null;
let pendingWrite: Promise<void> = Promise.resolve();

function updatePendingAwards(
  userId: string,
  update: (pending: AwardRoutineStepStarRequest[]) => AwardRoutineStepStarRequest[]
): Promise<void> {
  const next = pendingWrite.then(async () => {
    const key = pendingAwardsKey(userId);
    const pending = JSON.parse((await AsyncStorage.getItem(key)) ?? '[]') as AwardRoutineStepStarRequest[];
    await AsyncStorage.setItem(key, JSON.stringify(update(pending)));
  });
  pendingWrite = next.catch(() => undefined);
  return next;
}

export async function queueRoutineStepStars(payload: AwardRoutineStepStarRequest): Promise<void> {
  await updatePendingAwards(payload.userId, (pending) => {
    if (pending.some((item) => item.date === payload.date && item.routineId === payload.routineId
      && item.segment === payload.segment && item.stepId === payload.stepId)) return pending;
    return [...pending, payload];
  });
}

export function flushPendingStepStars(userId: string): Promise<void> {
  if (pendingFlush) return pendingFlush;
  pendingFlush = (async () => {
    const key = pendingAwardsKey(userId);
    while (true) {
      await pendingWrite;
      const pending = JSON.parse((await AsyncStorage.getItem(key)) ?? '[]') as AwardRoutineStepStarRequest[];
      if (pending.length === 0) break;
      const current = pending[0];
      try {
        const award = await awardRoutineStepStar(current);
        const profile = await getChildProfile();
        if (profile?.userId === userId) {
          await saveChildProfile({ ...profile, totalStarsEarned: award.totalStars, updatedAt: Date.now() });
        }
        await updatePendingAwards(userId, (items) => items.filter((item) =>
          !(item.date === current.date && item.routineId === current.routineId
            && item.segment === current.segment && item.stepId === current.stepId)));
      } catch (err) {
        console.warn('[Stars] Pending task award will retry:', err);
        break;
      }
    }
  })().finally(() => { pendingFlush = null; });
  return pendingFlush;
}

export async function getUserTotalStars(userId: string): Promise<number | null> {
  if (!userId) return null;
  const statsRef = doc(db, 'users', userId, 'stats', 'main');
  const snap = await getDoc(statsRef);
  if (snap.exists()) {
    const total = snap.data()?.totalStars;
    if (typeof total === 'number') return total;
  }

  const awardsRef = collection(db, 'users', userId, 'awards');
  const awardsSnap = await getDocs(awardsRef);
  if (awardsSnap.empty) return null;

  let fallbackTotal = 0;
  awardsSnap.forEach((docSnap) => {
    const stars = docSnap.data()?.stars;
    fallbackTotal += typeof stars === 'number' ? stars : 1;
  });
  return fallbackTotal;
}

export async function awardRoutineStepStar(
  payload: AwardRoutineStepStarRequest
): Promise<AwardRoutineStepStarResponse> {
  await ensureAuth();
  const callable = httpsCallable<AwardRoutineStepStarRequest, AwardRoutineStepStarResponse>(
    functions,
    'awardRoutineStepStar'
  );
  const result = await callable({
    ...payload,
    stars: payload.stars ?? 1,
  });
  return result.data;
}
