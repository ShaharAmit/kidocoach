import type {
  ActivityDefinition,
  RoutineLevel,
  RoutinePlacement,
  RoutineSegment,
} from '../types/activityDefinition';
import type { ActivityKey, MasteredTask, MorningStuckPoint, QuestionnaireAnswers } from '../types';

/**
 * Builds a child's starting routine from activity metadata instead of fixed per-age lists, so
 * activities added to the cloud catalog (with `tags` + `routine`) join generated routines without
 * an app release. Pure: no Firebase/React imports, so it is unit testable.
 *
 * 1. The questionnaire picks a template tier: 1 survival, 2 recommended, 3 independence.
 * 2. An activity is included when its level at the child's age is 1..tier.
 * 3. Stuck points pull in age-appropriate activities with matching tags, whatever their level.
 * 4. Mastered tasks leave out optional (level 2–3) activities with matching tags — parents can
 *    still add them manually.
 */

export type RoutineTier = 1 | 2 | 3;

const TAG_PATTERN = /^[a-z0-9_]{1,32}$/;
const MAX_TAGS = 12;
const MAX_AGE_KEY = 17;
const SEGMENTS: RoutineSegment[] = ['morning', 'evening'];

/** Category keys each stuck point focuses on (applies to morning and evening). */
export const STUCK_POINT_TAGS: Record<MorningStuckPoint, string[]> = {
  getting_out_of_bed: ['wake_up'],
  getting_dressed: ['dressing'],
  brushing_washing: ['hygiene'],
  turning_off_screens: ['screens'],
  everything_negotiation: [],
};

/** Category keys the child already handles; their optional activities are left out. */
export const MASTERED_TASK_TAGS: Record<MasteredTask, string[]> = {
  eating_breakfast: ['food'],
  choosing_clothes: ['clothes'],
  putting_toys_away: ['toys'],
  none_yet: [],
};

/** The evening is not covered by the (morning-focused) questionnaire, so it uses the default. */
const EVENING_TIER: RoutineTier = 2;

/** Level of a placement at `age`: the entry with the highest `fromAge` ≤ age, else 0. */
export function routineLevelAt(placement: RoutinePlacement, age: number): RoutineLevel {
  let bestAge = -1;
  let level: RoutineLevel = 0;
  for (const [fromAgeRaw, value] of Object.entries(placement.levels)) {
    const fromAge = Number(fromAgeRaw);
    if (fromAge <= age && fromAge > bestAge) {
      bestAge = fromAge;
      level = value;
    }
  }
  return level;
}

/**
 * Morning template from the POC table (ages 2–3 / 4–5 / 6+). A slow, dreamy child never gets the
 * full independence routine: the result is capped at recommended.
 */
export function pickMorningTier(age: number, answers: QuestionnaireAnswers): RoutineTier {
  const tier = pocMorningTier(age, answers);
  return answers.morningSpeed === 'slow_dreamy' ? (Math.min(tier, 2) as RoutineTier) : tier;
}

function pocMorningTier(age: number, answers: QuestionnaireAnswers): RoutineTier {
  if (answers.stuckPoints?.includes('everything_negotiation')) return 1;
  if (age >= 6 && answers.morningSpeed === 'easily_distracted') return 1;
  if (age <= 3) {
    const active = answers.morningSpeed === 'fast_energetic';
    const motivatedByRewards =
      answers.motivationStyle === 'race_game' || answers.motivationStyle === 'praise_encouragement';
    return active || motivatedByRewards ? 3 : 2;
  }
  if (answers.helpLevel === 'independent') return 3;
  if (age <= 5 && answers.motivationStyle === 'autonomy_choose') return 3;
  return 2;
}

function tagsFor<T extends string>(answers: T[] | undefined, map: Record<T, string[]>): Set<string> {
  return new Set((answers ?? []).flatMap((answer) => map[answer] ?? []));
}

/**
 * Activity keys for one segment, ordered by `routine[segment].position`. Pass only selectable
 * definitions (see `getSelectableActivityDefinitions`).
 */
export function composeRoutine(
  definitions: ActivityDefinition[],
  segment: RoutineSegment,
  age: number,
  answers: QuestionnaireAnswers
): ActivityKey[] {
  const tier = segment === 'morning' ? pickMorningTier(age, answers) : EVENING_TIER;
  const focus = tagsFor(answers.stuckPoints, STUCK_POINT_TAGS);
  const mastered = tagsFor(answers.masteredTasks, MASTERED_TASK_TAGS);

  const picked: { key: ActivityKey; position: number }[] = [];
  for (const def of definitions) {
    const placement = def.routine[segment];
    if (!placement) continue;
    const level = routineLevelAt(placement, age);
    if (level === 0) continue;
    const include =
      level === 1 ||
      def.tags.some((tag) => focus.has(tag)) ||
      (!def.tags.some((tag) => mastered.has(tag)) && level <= tier);
    if (include) picked.push({ key: def.key, position: placement.position });
  }
  return picked
    .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key))
    .map((entry) => entry.key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Catalog `tags`: unique `[a-z0-9_]` keys. `undefined` when absent or invalid. */
export function parseActivityTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_TAGS) return undefined;
  if (!raw.every((tag) => typeof tag === 'string' && TAG_PATTERN.test(tag))) return undefined;
  return [...new Set(raw as string[])];
}

function parsePlacement(raw: unknown): RoutinePlacement | undefined {
  if (!isRecord(raw) || !isRecord(raw.levels)) return undefined;
  if (typeof raw.position !== 'number' || !Number.isFinite(raw.position)) return undefined;
  const entries = Object.entries(raw.levels);
  if (!entries.length) return undefined;
  const levels: Record<string, RoutineLevel> = {};
  for (const [age, level] of entries) {
    if (!/^\d{1,2}$/.test(age) || Number(age) > MAX_AGE_KEY) return undefined;
    if (level !== 0 && level !== 1 && level !== 2 && level !== 3) return undefined;
    levels[String(Number(age))] = level;
  }
  return { position: raw.position, levels };
}

/** Catalog `routine`: `{ morning?, evening? }` placements. `undefined` when absent or invalid. */
export function parseRoutineRules(raw: unknown): Partial<Record<RoutineSegment, RoutinePlacement>> | undefined {
  if (!isRecord(raw)) return undefined;
  if (Object.keys(raw).some((key) => !SEGMENTS.includes(key as RoutineSegment))) return undefined;
  const rules: Partial<Record<RoutineSegment, RoutinePlacement>> = {};
  for (const segment of SEGMENTS) {
    if (raw[segment] === undefined) continue;
    const placement = parsePlacement(raw[segment]);
    if (!placement) return undefined;
    rules[segment] = placement;
  }
  return rules;
}
