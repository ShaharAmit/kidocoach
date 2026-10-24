import { ACTIVITY_KEY_PATTERN } from './activityCatalogModel';
import {
  ActivityKey,
  ChildProfile,
  MasteredTask,
  MorningStuckPoint,
  QuestionnaireAnswers,
  normalizeActivityStack,
  normalizeStepTimes,
} from '../types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const isTime = (value: unknown): value is string =>
  typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

// Format check only: activities come from the cloud catalog, so a key this build has never seen
// is still valid (it renders as a placeholder until the catalog loads).
const isActivity = (value: unknown): value is ActivityKey =>
  typeof value === 'string' && ACTIVITY_KEY_PATTERN.test(value);

const STUCK_POINTS: readonly MorningStuckPoint[] = [
  'getting_out_of_bed', 'getting_dressed', 'brushing_washing', 'turning_off_screens', 'everything_negotiation',
];
const MASTERED_TASKS: readonly MasteredTask[] = ['eating_breakfast', 'choosing_clothes', 'putting_toys_away', 'none_yet'];
const SINGLE_CHOICES = {
  motivationStyle: ['race_game', 'autonomy_choose', 'praise_encouragement', 'hug_connection'],
  helpLevel: ['independent', 'little_push', 'step_by_step'],
  morningSpeed: ['fast_energetic', 'slow_dreamy', 'easily_distracted'],
} as const;

/**
 * Multi-select answer: the new array field, else the legacy single-value field (profiles saved
 * before multi-select). `null` = invalid. An exclusive option wins over everything else.
 */
function parseMultiAnswer<T extends string>(
  list: unknown,
  legacy: unknown,
  allowed: readonly T[],
  exclusive: T
): T[] | undefined | null {
  const raw = list !== undefined ? list : legacy !== undefined ? [legacy] : undefined;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every((item) => allowed.includes(item as T))) return null;
  const unique = allowed.filter((option) => raw.includes(option));
  if (!unique.length) return undefined;
  return unique.includes(exclusive) ? [exclusive] : unique;
}

function normalizeAnswers(raw: Record<string, unknown>): QuestionnaireAnswers | null {
  const answers: QuestionnaireAnswers = {};
  const stuckPoints = parseMultiAnswer(raw.stuckPoints, raw.morningStuck, STUCK_POINTS, 'everything_negotiation');
  const masteredTasks = parseMultiAnswer(raw.masteredTasks, raw.masteredTask, MASTERED_TASKS, 'none_yet');
  if (stuckPoints === null || masteredTasks === null) return null;
  if (stuckPoints) answers.stuckPoints = stuckPoints;
  for (const [key, allowed] of Object.entries(SINGLE_CHOICES) as [keyof typeof SINGLE_CHOICES, readonly string[]][]) {
    const answer = raw[key];
    if (answer === undefined) continue;
    if (typeof answer !== 'string' || !allowed.includes(answer)) return null;
    (answers as Record<string, string>)[key] = answer;
  }
  if (masteredTasks) answers.masteredTasks = masteredTasks;
  return answers;
}

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
  const bedtime = isTime(value.bedtime) ? value.bedtime : undefined;
  if (stepTimes !== undefined && (!Array.isArray(stepTimes) || !stepTimes.every(isTime))) return null;

  let answers: QuestionnaireAnswers | undefined;
  if (value.answers !== undefined) {
    if (!isRecord(value.answers)) return null;
    const parsed = normalizeAnswers(value.answers);
    if (!parsed) return null;
    answers = parsed;
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
    ...(bedtime ? { bedtime } : {}),
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
