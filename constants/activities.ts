import { ActivityKey, ActivityMeta, DurationMode, ToneOption } from '../types';
import { colors } from '../theme';

export type ActivityTimeOfDay = 'morning' | 'evening' | 'general';
export type RoutineSegment = 'morning' | 'evening';

/**
 * Routine template levels: 1 = survival (always included), 2 = recommended, 3 = independence,
 * 0 = never auto-included (parents can still add it manually).
 */
export type RoutineLevel = 0 | 1 | 2 | 3;

/** Where an activity lands when a routine is auto-composed for one segment. */
export interface RoutinePlacement {
  /** Sort key inside the composed routine (lower runs first). */
  position: number;
  /** `{ fromAge: level }`. The entry with the highest age ≤ the child's age applies; none → 0. */
  levels: Record<string, RoutineLevel>;
}

/**
 * Everything the app knows about one activity. Bundled defaults below are the offline fallback;
 * `services/activityCatalog.ts` overlays the Firestore `catalog/activities` document on top of
 * them at runtime, so activities uploaded to the cloud appear without an app release.
 */
export interface ActivityDefinition {
  key: ActivityKey;
  label: string;
  emoji: string;
  subtitle: string;
  timeOfDay: ActivityTimeOfDay;
  timerSeconds: number;
  durationMode: DurationMode;
  stars: 0 | 1 | 2;
  order: number;
  /** Personalized Part 1 greeting; `{name}` is replaced with the child's name. */
  part1Text: string;
  part1Tone: ToneOption;
  /** Bumped whenever `part1Text`/`part1Tone` change so cached greetings are regenerated. */
  part1Version: number;
  /** On-screen line under the player; `{name}` is replaced with the child's name. */
  promptText: string;
  /** Parents may add it to a routine (complete media, enabled, supported by this app build). */
  selectable: boolean;
  /** Category keys (`[a-z0-9_]+`) the routine composer matches questionnaire answers against. */
  tags: string[];
  /** Auto-composition rules per segment; a segment without one is only added manually. */
  routine: Partial<Record<RoutineSegment, RoutinePlacement>>;
}

const FALLBACK_TIMER_SECONDS = 120;

type BundledActivity = Omit<ActivityDefinition, 'key' | 'order' | 'part1Version' | 'tags' | 'routine'>;

// Activities without uploaded videos stay known (so existing routines still render) but are not
// selectable until the cloud catalog reports complete media for them.
const BUNDLED: Record<string, BundledActivity> = {
  wake_up: {
    label: 'Wake Up', emoji: '☀️', subtitle: 'Good morning, rise and shine!', timeOfDay: 'morning',
    timerSeconds: 60, durationMode: 'variable', stars: 0, selectable: true,
    part1Text: 'Good morning, {name}!', part1Tone: 'encouraging',
    promptText: 'Good morning, {name}! Time to wake up and start a wonderful day.',
  },
  make_bed: {
    label: 'Make Bed', emoji: '🛏️', subtitle: "Let's make the bed nice and neat", timeOfDay: 'general',
    timerSeconds: 180, durationMode: 'variable', stars: 2, selectable: true,
    part1Text: 'Good morning, {name}!', part1Tone: 'encouraging',
    promptText: 'Nice work, {name}! Let us make the bed nice and tidy.',
  },
  brush_teeth: {
    label: 'Brush Teeth', emoji: '🦷', subtitle: "Let's make those teeth sparkle!", timeOfDay: 'general',
    timerSeconds: 60, durationMode: 'fixed', stars: 2, selectable: true,
    part1Text: 'Toothbrush time, {name}!', part1Tone: 'encouraging',
    promptText: 'It is time to brush your teeth, {name}, for a bright, sparkly smile.',
  },
  eat_breakfast: {
    label: 'Eat Breakfast', emoji: '🥞', subtitle: 'Time to fuel up for the day!', timeOfDay: 'morning',
    timerSeconds: 600, durationMode: 'variable', stars: 1, selectable: true,
    part1Text: 'Breakfast time, {name}!', part1Tone: 'encouraging',
    promptText: 'Superstar {name}, it is breakfast time. Let us eat and fill up with energy for the day.',
  },
  get_dressed: {
    label: 'Get Dressed', emoji: '👕', subtitle: 'Time to put on comfy clothes', timeOfDay: 'general',
    timerSeconds: 180, durationMode: 'variable', stars: 2, selectable: true,
    part1Text: "Let's get dressed, {name}!", part1Tone: 'encouraging',
    promptText: 'Great job, {name}. Now let us get dressed and ready for an amazing day.',
  },
  put_shoes_on: {
    label: 'Put Shoes On', emoji: '👟', subtitle: "Let's get those shoes on!", timeOfDay: 'general',
    timerSeconds: 90, durationMode: 'variable', stars: 1, selectable: true,
    part1Text: 'All right, {name}!', part1Tone: 'encouraging',
    promptText: 'Almost ready, {name}. Put your shoes on, and we are good to go.',
  },
  comb_hair: {
    label: 'Comb Hair', emoji: '💇', subtitle: "Let's look neat and tidy!", timeOfDay: 'general',
    timerSeconds: 120, durationMode: 'variable', stars: 1, selectable: true,
    part1Text: "Let's take care of your hair, {name}!", part1Tone: 'encouraging',
    promptText: 'Looking good, {name}. Time to comb your hair so you can look your best.',
  },
  drink_water: {
    label: 'Drink Water', emoji: '💧', subtitle: 'A little sip for sweet dreams', timeOfDay: 'general',
    timerSeconds: 30, durationMode: 'fixed', stars: 0, selectable: true,
    part1Text: 'Water time, {name}!', part1Tone: 'encouraging',
    promptText: 'Stay healthy, {name}. Let us drink a big glass of water.',
  },
  homework: {
    label: 'Homework', emoji: '📝', subtitle: 'Time to focus and learn!', timeOfDay: 'general',
    timerSeconds: 900, durationMode: 'variable', stars: 2, selectable: true,
    part1Text: 'All right, {name}!', part1Tone: 'encouraging',
    promptText: 'Great focus, {name}! Let us sit down and finish our homework.',
  },
  eat_dinner: {
    label: 'Eat Dinner', emoji: '🍽️', subtitle: 'Yummy food to end the day!', timeOfDay: 'evening',
    timerSeconds: 900, durationMode: 'variable', stars: 1, selectable: true,
    part1Text: 'Dinner time, {name}!', part1Tone: 'calm',
    promptText: 'Dinner time, {name}! Let us sit down and enjoy a healthy meal.',
  },
  tidy_room: {
    label: 'Tidy Room', emoji: '🧸', subtitle: "Let's clean up our space!", timeOfDay: 'general',
    timerSeconds: 300, durationMode: 'variable', stars: 2, selectable: true,
    part1Text: 'What a busy day of playing, {name}!', part1Tone: 'encouraging',
    promptText: 'Great job {name}! Now, let us tidy up our room.',
  },
  put_on_pajamas: {
    label: 'Put on Pajamas', emoji: '👕', subtitle: 'Time to get cozy for bed', timeOfDay: 'evening',
    timerSeconds: 180, durationMode: 'variable', stars: 1, selectable: true,
    part1Text: 'Time to transform for the night, {name}!', part1Tone: 'calm',
    promptText: 'Time to get cozy, {name}. Let us put on our pajamas!',
  },
  bedtime_story: {
    label: 'Bedtime Story', emoji: '📖', subtitle: "Let's read a cozy story", timeOfDay: 'evening',
    timerSeconds: 600, durationMode: 'variable', stars: 0, selectable: true,
    part1Text: 'Story time, {name}.', part1Tone: 'calm',
    promptText: 'Cuddle up, {name}. Let us read a lovely bedtime story together.',
  },
  go_to_sleep: {
    label: 'Go to Sleep', emoji: '😴', subtitle: 'Sweet dreams, sleep tight!', timeOfDay: 'evening',
    timerSeconds: 300, durationMode: 'variable', stars: 0, selectable: true,
    part1Text: 'You did it, {name}.', part1Tone: 'calm',
    promptText: 'Sweet dreams, {name}. It is time to close your eyes and go to sleep.',
  },
  pack_backpack: {
    label: 'Pack Backpack', emoji: '🎒', subtitle: "Let's get ready for school!", timeOfDay: 'general',
    timerSeconds: 180, durationMode: 'variable', stars: 2, selectable: false,
    part1Text: 'Backpack time, {name}!', part1Tone: 'encouraging',
    promptText: 'You are doing great, {name}. Let us pack your backpack so you are ready for school.',
  },
  wash_face: {
    label: 'Wash Face', emoji: '🚿', subtitle: 'A splash of water to wake up!', timeOfDay: 'general',
    timerSeconds: 90, durationMode: 'fixed', stars: 1, selectable: false,
    part1Text: 'Face washing time, {name}!', part1Tone: 'encouraging',
    promptText: 'Let us wash your face, {name}, and feel fresh and clean.',
  },
  read_book: {
    label: 'Read a Book', emoji: '📚', subtitle: "Let's go on an adventure!", timeOfDay: 'general',
    timerSeconds: 600, durationMode: 'variable', stars: 1, selectable: false,
    part1Text: 'Reading time, {name}!', part1Tone: 'encouraging',
    promptText: 'Let us read a fun book together, {name}.',
  },
};

export const BUNDLED_ACTIVITY_DEFINITIONS: ActivityDefinition[] = Object.entries(BUNDLED).map(
  ([key, value], order) => ({
    ...value,
    key,
    order,
    part1Version: 1,
    // Routine composition data lives only in the cloud catalog (`tags` / `routine`).
    tags: [],
    routine: {},
  })
);

function fillName(template: string, name: string): string {
  return template.replace(/\{\{\s*name\s*\}\}/gi, name).replace(/\{name\}/gi, name);
}

function toMeta(def: ActivityDefinition): ActivityMeta {
  return {
    key: def.key,
    label: def.label,
    emoji: def.emoji,
    subtitle: def.subtitle,
    color: colors.primary,
    promptTemplate: (name) => fillName(def.promptText, name),
  };
}

/** Humanizes an unknown key (e.g. a step synced from a newer catalog) so it still renders. */
function placeholderDefinition(key: ActivityKey): ActivityDefinition {
  const label = key
    .split('_')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ') || 'Activity';
  return {
    key,
    label,
    emoji: '⭐',
    subtitle: "Let's do it together!",
    timeOfDay: 'general',
    timerSeconds: FALLBACK_TIMER_SECONDS,
    durationMode: 'variable',
    stars: 1,
    order: Number.MAX_SAFE_INTEGER,
    part1Text: 'All right, {name}!',
    part1Tone: 'encouraging',
    part1Version: 1,
    promptText: `${label} time, {name}!`,
    selectable: false,
    tags: [],
    routine: {},
  };
}

// The exported records below are mutated in place by `applyActivityDefinitions`, so every module
// that already imported them sees catalog updates without re-importing.
const DEFINITIONS: Record<ActivityKey, ActivityDefinition> = {};
export const ACTIVITIES: Record<ActivityKey, ActivityMeta> = {};
export const ACTIVITY_KEYS: ActivityKey[] = [];
export const ACTIVITY_TIMER_SECONDS: Record<ActivityKey, number> = {};
export const ACTIVITY_DURATION_MODES: Record<ActivityKey, DurationMode> = {};
export const ACTIVITY_STARS: Record<ActivityKey, 0 | 1 | 2> = {};
export const ACTIVITY_TIME_OF_DAY: Record<ActivityKey, ActivityTimeOfDay> = {};

function clearRecord(record: Record<string, unknown>) {
  for (const key of Object.keys(record)) delete record[key];
}

/**
 * Replaces the registry with `definitions`. Keys missing from the new set are kept (as
 * non-selectable) when they were known before, so routines that still reference a retired
 * activity keep rendering instead of crashing.
 */
export function applyActivityDefinitions(definitions: ActivityDefinition[]): void {
  const previous = { ...DEFINITIONS };
  const next: Record<ActivityKey, ActivityDefinition> = {};
  for (const def of definitions) next[def.key] = def;
  for (const [key, def] of Object.entries(previous)) {
    if (!next[key]) next[key] = { ...def, selectable: false };
  }

  for (const record of [DEFINITIONS, ACTIVITIES, ACTIVITY_TIMER_SECONDS, ACTIVITY_DURATION_MODES, ACTIVITY_STARS, ACTIVITY_TIME_OF_DAY]) {
    clearRecord(record as Record<string, unknown>);
  }
  ACTIVITY_KEYS.length = 0;

  const ordered = Object.values(next).sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  for (const def of ordered) {
    DEFINITIONS[def.key] = def;
    ACTIVITIES[def.key] = toMeta(def);
    ACTIVITY_TIMER_SECONDS[def.key] = def.timerSeconds;
    ACTIVITY_DURATION_MODES[def.key] = def.durationMode;
    ACTIVITY_STARS[def.key] = def.stars;
    ACTIVITY_TIME_OF_DAY[def.key] = def.timeOfDay;
    ACTIVITY_KEYS.push(def.key);
  }
}

applyActivityDefinitions(BUNDLED_ACTIVITY_DEFINITIONS);

export function getActivityDefinition(key: ActivityKey): ActivityDefinition {
  return DEFINITIONS[key] ?? placeholderDefinition(key);
}

export function getActivityMeta(key: ActivityKey): ActivityMeta {
  return ACTIVITIES[key] ?? toMeta(placeholderDefinition(key));
}

export function isKnownActivity(key: ActivityKey): boolean {
  return Boolean(DEFINITIONS[key]);
}

export function isActivitySelectable(key: ActivityKey): boolean {
  return DEFINITIONS[key]?.selectable === true;
}

/** Selectable activities in catalog order (input for `composeRoutine`). */
export function getSelectableActivityDefinitions(): ActivityDefinition[] {
  return ACTIVITY_KEYS.map((key) => DEFINITIONS[key]).filter((def) => def?.selectable);
}

export function resolveDurationMode(
  activity: ActivityKey,
  savedMode: unknown,
  durationMinutes?: number
): DurationMode {
  if (savedMode === 'fixed' || savedMode === 'variable') return savedMode;
  const def = getActivityDefinition(activity);
  if (durationMinutes !== undefined && Math.round(durationMinutes * 60) !== def.timerSeconds) {
    return 'variable';
  }
  return def.durationMode;
}

export function defaultDurationMinutes(activity: ActivityKey): number {
  return getActivityDefinition(activity).timerSeconds / 60;
}

export function defaultDurationMode(activity: ActivityKey): DurationMode {
  return getActivityDefinition(activity).durationMode;
}

export function starsForStep(step: ActivityKey[]): number {
  return Math.max(0, ...step.map((activity) => getActivityDefinition(activity).stars));
}

/** Selectable activities for a picker, in catalog order. */
export function activityKeysForSegment(segment: 'morning' | 'evening'): ActivityKey[] {
  return ACTIVITY_KEYS.filter((key) => {
    const def = DEFINITIONS[key];
    if (!def?.selectable) return false;
    return def.timeOfDay === 'general' || def.timeOfDay === segment;
  });
}
