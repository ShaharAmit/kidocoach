import { useMemo } from 'react';
import { useLocalDailyCompletion } from './useLocalDailyCompletion';
import { useRoutine } from './useRoutine';
import { DailyProgress } from '../types';
import { isMorningTime } from '../utils/timeOfDay';

export function useDailyProgress(
  userId: string,
  routineId: string,
  refreshSignal?: string | number
): DailyProgress {
  const { routine } = useRoutine(routineId, userId);
  const completion = useLocalDailyCompletion(userId, routineId, undefined, undefined, refreshSignal);

  return useMemo(() => {
    if (!routine || !completion) {
      return {
        morningCompleted: 0,
        morningTotal: 0,
        eveningCompleted: 0,
        eveningTotal: 0,
      };
    }

    let morningTotal = 0;
    let eveningTotal = 0;
    let morningCompleted = 0;
    let eveningCompleted = 0;

    routine.activityStack.forEach((_, stepIndex) => {
      const time = routine.stepTimes?.[stepIndex] ?? routine.scheduledTime;
      const isMorning = isMorningTime(time);
      const stepId = routine.stepIds?.[stepIndex] ?? `step_${stepIndex}`;

      if (isMorning) {
        morningTotal += 1;
        if (completion.completedMorningStepIds.has(stepId)) {
          morningCompleted += 1;
        }
      } else {
        eveningTotal += 1;
        if (completion.completedEveningStepIds.has(stepId)) {
          eveningCompleted += 1;
        }
      }
    });

    return {
      morningCompleted,
      morningTotal,
      eveningCompleted,
      eveningTotal,
    };
  }, [routine, completion]);
}
