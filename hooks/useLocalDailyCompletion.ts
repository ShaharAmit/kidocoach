import { useState, useEffect, useCallback, useRef } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../services/firebase';
import { LocalDailyCompletion } from '../types';
import { getTodayISO } from '../utils/date';

function storageKey(routineId: string): string {
  return `daily_completion_${routineId}`;
}

interface DailyCompletionState {
  completedMorningStepIds: Set<string>;
  completedEveningStepIds: Set<string>;
  isMorningAllDone: boolean;
  isEveningAllDone: boolean;
  /**
   * Marks a step complete for today. Returns `true` only when the step was not
   * already completed (i.e. a genuinely new completion). Returns `false` for
   * no-op cases — missing routine or re-completing an already-done step — so
   * callers can avoid re-awarding stars when a child re-watches finished activities.
   */
  markStepDone: (
    segment: 'morning' | 'evening',
    stepId: string,
    totalSteps: number
  ) => Promise<boolean>;
  loading: boolean;
  /**
   * ISO date the currently exposed completion sets belong to. Changes when the hook detects a
   * midnight rollover, so consumers holding their own per-day session state (trophy shown,
   * star awarded, ...) can reset it instead of silently carrying yesterday's flags into today.
   */
  activeDate: string;
}

export function useLocalDailyCompletion(
  userId: string,
  routineId: string,
  childName?: string,
  initialCompletion?: LocalDailyCompletion | null,
  refreshSignal?: string | number
): DailyCompletionState {
  const hasInitialForToday =
    Boolean(initialCompletion) && initialCompletion?.date === getTodayISO();
  const [morningStepIds, setMorningStepIds] = useState<Set<string>>(
    hasInitialForToday ? new Set(initialCompletion?.morning ?? []) : new Set()
  );
  const [eveningStepIds, setEveningStepIds] = useState<Set<string>>(
    hasInitialForToday ? new Set(initialCompletion?.evening ?? []) : new Set()
  );
  const [isMorningAllDone, setIsMorningAllDone] = useState(false);
  const [isEveningAllDone, setIsEveningAllDone] = useState(false);
  const [loading, setLoading] = useState(!hasInitialForToday);
  const [activeDate, setActiveDate] = useState(getTodayISO());

  // Keep a ref to always have the latest sets inside markStepDone without stale closures
  const morningRef = useRef<Set<string>>(new Set());
  const eveningRef = useRef<Set<string>>(new Set());
  const loadedDateRef = useRef(getTodayISO());

  useEffect(() => {
    morningRef.current = morningStepIds;
  }, [morningStepIds]);
  useEffect(() => {
    eveningRef.current = eveningStepIds;
  }, [eveningStepIds]);

  // Load from AsyncStorage on mount / routineId change
  useEffect(() => {
    if (!routineId) {
      setLoading(false);
      return;
    }

    if (initialCompletion?.date === getTodayISO()) {
      setMorningStepIds(new Set(initialCompletion.morning ?? []));
      setEveningStepIds(new Set(initialCompletion.evening ?? []));
      setLoading(false);
    }

    let mounted = true;

    async function load() {
      try {
        const raw = await AsyncStorage.getItem(storageKey(routineId));
        if (!mounted) return;

        // Recomputed here rather than closed over, so a hook instance that stays mounted across
        // midnight still evaluates "is this snapshot for today?" against the current date.
        const today = getTodayISO();
        const initialIsForToday = initialCompletion?.date === today;
        const parsed: LocalDailyCompletion | null = raw ? JSON.parse(raw) : null;

        // Cleared unconditionally: these are "did the segment finish during this load's day?"
        // flags, so a load that resolves after a rollover must drop yesterday's answer even when
        // storage already holds a record for the new day (written by another hook instance).
        setIsMorningAllDone(false);
        setIsEveningAllDone(false);

        if (parsed?.date === today) {
          setMorningStepIds(new Set((parsed.morning ?? []).filter((id) => typeof id === 'string')));
          setEveningStepIds(new Set((parsed.evening ?? []).filter((id) => typeof id === 'string')));
          return;
        }

        // No stored record, or one from a previous day: today starts clean. A stale record is
        // deliberately left on disk — every reader already ignores a record whose `date` is not
        // today, and `markStepDone` rewrites it on the first completion of the new day.
        if (!initialIsForToday) {
          setMorningStepIds(new Set());
          setEveningStepIds(new Set());
        }
      } catch (err) {
        console.warn('[useLocalDailyCompletion] Load error:', err);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    loadedDateRef.current = getTodayISO();
    setActiveDate(loadedDateRef.current);
    load();

    // This hook can stay mounted across midnight, either backgrounded or left open on screen, so
    // yesterday's marks would otherwise remain visible until a manual restart. Reload only when
    // the date actually rolled over — re-running on every foreground would flash the spinner and
    // re-read storage on every app resume for nothing.
    const reloadIfDayChanged = () => {
      const today = getTodayISO();
      if (!mounted || loadedDateRef.current === today) return;
      loadedDateRef.current = today;
      setActiveDate(today);
      setLoading(true);
      load();
    };

    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') reloadIfDayChanged();
    });
    const dayTimer = setInterval(reloadIfDayChanged, 60_000);

    return () => {
      mounted = false;
      appStateSub.remove();
      clearInterval(dayTimer);
    };
  }, [routineId, initialCompletion, refreshSignal]);

  const markStepDone = useCallback(
    async (
      segment: 'morning' | 'evening',
      stepId: string,
      totalSteps: number
    ): Promise<boolean> => {
      if (!routineId) return false;
      if (!stepId) return false;

      const currentSet = segment === 'morning' ? morningRef.current : eveningRef.current;
      if (currentSet.has(stepId)) return false; // already done, no-op

      const newSet = new Set(currentSet);
      newSet.add(stepId);
      const newSize = newSet.size;
      const allDone = newSize >= totalSteps;

      // Optimistic state update
      if (segment === 'morning') {
        setMorningStepIds(newSet);
        if (allDone) setIsMorningAllDone(true);
      } else {
        setEveningStepIds(newSet);
        if (allDone) setIsEveningAllDone(true);
      }

      // Persist to AsyncStorage
      const today = getTodayISO();
      try {
        const raw = await AsyncStorage.getItem(storageKey(routineId));
        const current: LocalDailyCompletion = raw
          ? JSON.parse(raw)
          : { date: today, morning: [], evening: [] };

        // Reset if it's a new day
        const stored: LocalDailyCompletion =
          current.date === today ? current : { date: today, morning: [], evening: [] };

        const updatedArray = Array.from(newSet);
        const updated: LocalDailyCompletion = {
          ...stored,
          [segment]: updatedArray,
        };
        await AsyncStorage.setItem(storageKey(routineId), JSON.stringify(updated));
      } catch (err) {
        console.warn('[useLocalDailyCompletion] Persist error:', err);
      }

      // Write one-shot trophy to Firestore when segment is fully done
      if (allDone && userId) {
        const trophyDocId = `${today}_${segment}`;
        const trophyRef = doc(db, 'users', userId, 'trophies', trophyDocId);
        try {
          await setDoc(trophyRef, {
            userId,
            date: today,
            segment,
            routineId,
            childName: childName ?? '',
            completedAt: serverTimestamp(),
          });
        } catch (err) {
          // Non-critical — trophy write failure should not block UX
          console.warn('[useLocalDailyCompletion] Trophy write error:', err);
        }
      }

      return true;
    },
    [routineId, userId, childName]
  );

  return {
    completedMorningStepIds: morningStepIds,
    completedEveningStepIds: eveningStepIds,
    isMorningAllDone,
    isEveningAllDone,
    markStepDone,
    loading,
    activeDate,
  };
}
