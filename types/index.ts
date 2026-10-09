export type ActivityKey =
  | 'brush_teeth'
  | 'get_dressed'
  | 'eat_breakfast'
  | 'pack_backpack'
  | 'wash_face'
  | 'comb_hair'
  | 'put_shoes_on'
  | 'drink_water'
  | 'tidy_room'
  | 'read_book'
  | 'put_on_pajamas'
  | 'bedtime_story'
  | 'eat_dinner'
  | 'go_to_sleep'
  | 'homework'
  | 'make_bed'
  | 'wake_up';

export type ToneOption = 'cheerful' | 'encouraging' | 'calm';
export type VoiceOption = 'woman' | 'man';
export type ChildGender = 'boy' | 'girl';
export type ActivityStep = ActivityKey[];
export type DurationMode = 'fixed' | 'variable';

/** Setup questionnaire answers — collected during onboarding to personalize the routine */
export type MorningStuckPoint =
  | 'getting_out_of_bed'
  | 'getting_dressed'
  | 'brushing_washing'
  | 'turning_off_screens'
  | 'everything_negotiation';

export type MotivationStyle =
  | 'race_game'
  | 'autonomy_choose'
  | 'praise_encouragement'
  | 'hug_connection';

export type MasteredTask =
  | 'eating_breakfast'
  | 'choosing_clothes'
  | 'putting_toys_away'
  | 'none_yet';

export type HelpLevel = 'independent' | 'little_push' | 'step_by_step';

export type MorningSpeed = 'fast_energetic' | 'slow_dreamy' | 'easily_distracted';

export interface QuestionnaireAnswers {
  morningStuck?: MorningStuckPoint;
  motivationStyle?: MotivationStyle;
  masteredTask?: MasteredTask;
  helpLevel?: HelpLevel;
  morningSpeed?: MorningSpeed;
}

// Star level system
export type StarLevel = 'Beginner' | 'Explorer' | 'Champion' | 'Superstar';

export interface StarLevelConfig {
  level: StarLevel;
  emoji: string;
  minStars: number;
  maxStars: number;
}

export const STAR_LEVELS: StarLevelConfig[] = [
  { level: 'Beginner', emoji: '🌱', minStars: 0, maxStars: 9 },
  { level: 'Explorer', emoji: '🚀', minStars: 10, maxStars: 24 },
  { level: 'Champion', emoji: '🏆', minStars: 25, maxStars: 49 },
  { level: 'Superstar', emoji: '👑', minStars: 50, maxStars: Infinity },
];

export function getStarLevel(stars: number): StarLevelConfig {
  return STAR_LEVELS.find((l) => stars >= l.minStars && stars <= l.maxStars) ?? STAR_LEVELS[0];
}

export function getStarsToNextLevel(currentStars: number): number {
  const currentLevel = getStarLevel(currentStars);
  if (currentLevel.level === 'Superstar') return 0;
  return currentLevel.maxStars + 1 - currentStars;
}

export interface DailyProgress {
  morningCompleted: number;
  morningTotal: number;
  eveningCompleted: number;
  eveningTotal: number;
}

export interface Routine {
  id: string;
  userId: string;
  childName: string;
  childAge?: number;
  avatarId: string;
  scheduledTime: string; // "HH:MM" 24h format
  activityStack: ActivityStep[];
  stepIds?: string[];
  stepTimes?: string[];
  stepDurations?: number[];
  stepDurationModes?: DurationMode[];
  stepStars?: number[];
  tone?: ToneOption;
  voice?: VoiceOption;
  notificationId?: string;
}

export interface ChildProfile {
  userId: string;
  childName: string;
  age: number;
  /** ISO `YYYY-MM-DD` date of birth. `age` is derived from this and kept in sync at save time. */
  birthDate?: string;
  gender: ChildGender;
  avatarId: string;
  voice: VoiceOption;
  tone: ToneOption;
  scheduledTime: string;
  activityStack: ActivityStep[];
  stepTimes?: string[];
  answers?: QuestionnaireAnswers;
  totalStarsEarned: number;
  updatedAt: number;
  /** Parent preference: overlay subtitles on avatar videos during routine playback. Defaults to true. */
  showCaptions?: boolean;
}

/** Daily task completion state — stored in AsyncStorage only, never synced to Firestore */
export interface LocalDailyCompletion {
  date: string;       // 'YYYY-MM-DD' — used to detect day rollover
  morning: string[];  // completed step IDs
  evening: string[];
}

/** Written once to Firestore `users/{userId}/trophies` when a full segment completes */
export interface DailyTrophy {
  userId: string;
  date: string;               // 'YYYY-MM-DD'
  segment: 'morning' | 'evening';
  routineId: string;
  childName: string;
  completedAt: null;          // serverTimestamp() on write
}

export interface AudioCacheEntry {
  id: string; // {normalizedName}_{activityKey}_{avatarId}_{tone}_{voice}
  audioUrl: string;
  status: 'pending' | 'generating' | 'ready' | 'error';
  createdAt?: number;
}

/** A single timed subtitle line, in seconds, rendered as an overlay while its video plays. */
export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

export interface ActivityMeta {
  key: ActivityKey;
  label: string;
  promptTemplate: (childName: string) => string;
  videoFile: string; // local filename e.g. "brush_teeth.mp4"
  emoji: string;
  color: string;
}

export function normalizeActivityStack(
  stack: ActivityKey[] | ActivityStep[]
): ActivityStep[] {
  if (!Array.isArray(stack)) return [];
  if (stack.length === 0) return [];

  const first = stack[0] as unknown;
  if (typeof first === 'string') {
    return (stack as ActivityKey[]).map((key) => [key]);
  }

  // Product rule: never keep multi-activity steps. Flatten stacked steps
  // into one activity per step while preserving order.
  return (stack as ActivityStep[])
    .filter((step) => Array.isArray(step) && step.length > 0)
    .flatMap((step) => step.map((key) => [key] as ActivityStep));
}

export function normalizeStepTimes(
  stepTimes: string[] | undefined,
  stack: ActivityStep[],
  fallbackTime: string
): string[] {
  const source = Array.isArray(stepTimes) ? stepTimes : [];
  const normalized: string[] = [];

  for (let i = 0; i < stack.length; i += 1) {
    normalized.push(source[i] ?? fallbackTime);
  }

  return normalized;
}
