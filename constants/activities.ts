import { ActivityKey, ActivityMeta, DurationMode } from '../types';
import { colors } from '../theme';

import type { ActivityDefinition, ActivityTimeOfDay } from '../types/activityDefinition';
export type {
  ActivityDefinition, ActivityTimeOfDay, RoutineLevel, RoutinePlacement, RoutineSegment,
} from '../types/activityDefinition';

const FALLBACK_TIMER_SECONDS = 120;

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
