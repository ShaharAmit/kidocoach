import AsyncStorage from '@react-native-async-storage/async-storage';
import { Routine } from '../types';

let pendingWrite: Promise<void> = Promise.resolve();

function queueWrite(write: () => Promise<void>): Promise<void> {
  const current = pendingWrite.then(write, write);
  pendingWrite = current.catch(() => {});
  return current;
}

function storageKey(userId: string): string {
  return `routines_v1_${userId}`;
}

export async function readCachedRoutines(userId: string): Promise<Routine[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((routine): routine is Routine =>
      routine !== null && typeof routine === 'object' &&
      routine.userId === userId && typeof routine.id === 'string' &&
      Array.isArray(routine.activityStack) && Array.isArray(routine.stepTimes) &&
      Array.isArray(routine.stepDurations) && Array.isArray(routine.stepDurationModes)
    );
  } catch (err) {
    console.warn('[RoutineCache] Cannot read local routines:', err);
    return [];
  }
}

export async function cacheRoutines(userId: string, routines: Routine[]): Promise<void> {
  await queueWrite(() =>
    AsyncStorage.setItem(
      storageKey(userId),
      JSON.stringify(routines.filter((routine) => routine.userId === userId))
    )
  );
}

export async function cacheRoutine(routine: Routine): Promise<void> {
  await queueWrite(async () => {
    const routines = await readCachedRoutines(routine.userId);
    await AsyncStorage.setItem(
      storageKey(routine.userId),
      JSON.stringify([...routines.filter((item) => item.id !== routine.id), routine])
    );
  });
}