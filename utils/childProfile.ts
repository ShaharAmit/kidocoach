import { ACTIVITY_KEYS } from '../constants/activities';
import {
  ActivityKey,
  ChildProfile,
  QuestionnaireAnswers,
  normalizeActivityStack,
  normalizeStepTimes,
} from '../types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const isTime = (value: unknown): value is string =>
  typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

const isActivity = (value: unknown): value is ActivityKey =>
  ACTIVITY_KEYS.some((key) => key === value);

export function normalizeChildProfile(value: unknown, userId?: string): ChildProfile | null {
  if (!isRecord(value)) return null;
  if (typeof value.userId !== 'string' || !value.userId.trim() ||
      (userId !== undefined && value.userId !== userId)) return null;
  if (typeof value.childName !== 'string' || !value.childName.trim()) return null;
  if (typeof value.age !== 'number' || !Number.isFinite(value.age) ||
      value.age < 2 || value.age > 17) return null;
  if (value.gender !== 'boy' && value.gender !== 'girl') return null;
  if (value.voice !== 'woman' && value.voice !== 'man') return null;
  if (value.tone !== 'cheerful' && value.tone !== 'encouraging' && value.tone !== 'calm') return null;
  if (typeof value.avatarId !== 'string' || !value.avatarId.trim()) return null;

  // Firestore cannot store arrays of arrays; cloud steps are wrapped in maps.
  const stack = Array.isArray(value.activityStack)
    ? value.activityStack.map((step: unknown) => isRecord(step) ? step.activities : step)
    : [];
  let activities: ActivityKey[] | ActivityKey[][];
  if (stack.every(isActivity)) {
    activities = stack;
  } else if (stack.every((step): step is ActivityKey[] =>
    Array.isArray(step) && step.length > 0 && step.every(isActivity))) {
    activities = stack;
  } else {
    return null;
  }
  const activityStack = normalizeActivityStack(activities);
  if (!activityStack.length) return null;
  const scheduledTime = value.scheduledTime ?? '08:00';
  if (!isTime(scheduledTime)) return null;
  const stepTimes = value.stepTimes;
  if (stepTimes !== undefined && (!Array.isArray(stepTimes) || !stepTimes.every(isTime))) return null;

  let answers: QuestionnaireAnswers | undefined;
  if (value.answers !== undefined) {
    if (!isRecord(value.answers)) return null;
    const choices = {
      morningStuck: ['getting_out_of_bed', 'getting_dressed', 'brushing_washing', 'turning_off_screens', 'everything_negotiation'],
      motivationStyle: ['race_game', 'autonomy_choose', 'praise_encouragement', 'hug_connection'],
      masteredTask: ['eating_breakfast', 'choosing_clothes', 'putting_toys_away', 'none_yet'],
      helpLevel: ['independent', 'little_push', 'step_by_step'],
      morningSpeed: ['fast_energetic', 'slow_dreamy', 'easily_distracted'],
    };
    for (const [key, allowed] of Object.entries(choices)) {
      const answer = value.answers[key];
      if (answer !== undefined && (typeof answer !== 'string' || !allowed.includes(answer))) return null;
    }
    answers = value.answers;
  }

  return {
    userId: value.userId,
    childName: value.childName.trim(),
    age: value.age,
    gender: value.gender,
    avatarId: value.avatarId,
    voice: value.voice,
    tone: value.tone,
    scheduledTime,
    activityStack,
    stepTimes: normalizeStepTimes(stepTimes, activityStack, scheduledTime),
    answers,
    totalStarsEarned: typeof value.totalStarsEarned === 'number' &&
      Number.isFinite(value.totalStarsEarned) && value.totalStarsEarned >= 0 ? value.totalStarsEarned : 0,
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
    showCaptions: typeof value.showCaptions === 'boolean' ? value.showCaptions : true,
    birthDate: typeof value.birthDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.birthDate)
      ? value.birthDate : undefined,
  };
}
