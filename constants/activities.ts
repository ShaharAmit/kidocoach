import { ActivityKey, ActivityMeta, DurationMode } from '../types';
import { colors} from '../theme';

export interface ActivityConfig {
  id: string;
  uiTitle: string;
  uiEmoji: string;
  defaultTTSPhrase: string; // Used by Cloud Function for Gemini TTS
  avatarVideoRef: string;   // Reference to fetch from CDN -> FileSystem.documentDirectory
}

export const ADDITIONAL_ACTIVITIES: ActivityConfig[] = [
  {
    id: 'tidy_room',
    uiTitle: 'Tidy Room',
    uiEmoji: '🧸',
    defaultTTSPhrase: 'Great job {childName}! Now, let\'s tidy up our room.',
    avatarVideoRef: 'avatar_loop_tidy_room.mp4',
  },
  {
    id: 'read_book',
    uiTitle: 'Read a Book',
    uiEmoji: '📚',
    defaultTTSPhrase: 'Let\'s read a fun book together, {childName}.',
    avatarVideoRef: 'avatar_loop_read_book.mp4',
  },
  {
    id: 'put_on_pajamas',
    uiTitle: 'Put on Pajamas',
    uiEmoji: '👕',
    defaultTTSPhrase: 'Time to get cozy, {childName}. Let\'s put on our pajamas!',
    avatarVideoRef: 'avatar_loop_pajamas.mp4',
  },
];

export const ACTIVITIES: Record<ActivityKey, ActivityMeta> = {
  brush_teeth: {
    key: 'brush_teeth',
    label: 'Brush Teeth',
    promptTemplate: (name) => `It is time to brush your teeth, ${name}, for a bright, sparkly smile.`,
    videoFile: 'brush_teeth.mp4',
    emoji: '🦷',
    color: colors.primary,
  },
  get_dressed: {
    key: 'get_dressed',
    label: 'Get Dressed',
    promptTemplate: (name) => `Great job, ${name}. Now let us get dressed and ready for an amazing day.`,
    videoFile: 'get_dressed.mp4',
    emoji: '👕',
    color: colors.primary,
  },
  eat_breakfast: {
    key: 'eat_breakfast',
    label: 'Eat Breakfast',
    promptTemplate: (name) => `Superstar ${name}, it is breakfast time. Let us eat and fill up with energy for the day.`,
    videoFile: 'eat_breakfast.mp4',
    emoji: '🥞',
    color: colors.primary,
  },
  pack_backpack: {
    key: 'pack_backpack',
    label: 'Pack Backpack',
    promptTemplate: (name) => `You are doing great, ${name}. Let us pack your backpack so you are ready for school.`,
    videoFile: 'pack_backpack.mp4',
    emoji: '🎒',
    color: colors.primary,
  },
  wash_face: {
    key: 'wash_face',
    label: 'Wash Face',
    promptTemplate: (name) => `Let us wash your face, ${name}, and feel fresh and clean.`,
    videoFile: 'wash_face.mp4',
    emoji: '🚿',
    color: colors.primary,
  },
  comb_hair: {
    key: 'comb_hair',
    label: 'Comb Hair',
    promptTemplate: (name) => `Looking good, ${name}. Time to comb your hair so you can look your best.`,
    videoFile: 'comb_hair.mp4',
    emoji: '💇',
    color: colors.primary,
  },
  put_shoes_on: {
    key: 'put_shoes_on',
    label: 'Put Shoes On',
    promptTemplate: (name) => `Almost ready, ${name}. Put your shoes on, and we are good to go.`,
    videoFile: 'put_shoes_on.mp4',
    emoji: '👟',
    color: colors.primary,
  },
  drink_water: {
    key: 'drink_water',
    label: 'Drink Water',
    promptTemplate: (name) => `Stay healthy, ${name}. Let us drink a big glass of water.`,
    videoFile: 'drink_water.mp4',
    emoji: '💧',
    color: colors.primary,
  },
  tidy_room: {
    key: 'tidy_room',
    label: 'Tidy Room',
    promptTemplate: (name) => `Great job ${name}! Now, let us tidy up our room.`,
    videoFile: 'avatar_loop_tidy_room.mp4',
    emoji: '🧸',
    color: colors.primary,
  },
  read_book: {
    key: 'read_book',
    label: 'Read a Book',
    promptTemplate: (name) => `Let us read a fun book together, ${name}.`,
    videoFile: 'avatar_loop_read_book.mp4',
    emoji: '📚',
    color: colors.primary,
  },
  put_on_pajamas: {
    key: 'put_on_pajamas',
    label: 'Put on Pajamas',
    promptTemplate: (name) => `Time to get cozy, ${name}. Let us put on our pajamas!`,
    videoFile: 'avatar_loop_pajamas.mp4',
    emoji: '👕',
    color: colors.primary,
  },
  bedtime_story: {
    key: 'bedtime_story',
    label: 'Bedtime Story',
    promptTemplate: (name) => `Cuddle up, ${name}. Let us read a lovely bedtime story together.`,
    videoFile: 'bedtime_story.mp4',
    emoji: '📖',
    color: colors.primary,
  },
  eat_dinner: {
    key: 'eat_dinner',
    label: 'Eat Dinner',
    promptTemplate: (name) => `Dinner time, ${name}! Let us sit down and enjoy a healthy meal.`,
    videoFile: 'eat_dinner.mp4',
    emoji: '🍽️',
    color: colors.primary,
  },
  go_to_sleep: {
    key: 'go_to_sleep',
    label: 'Go to Sleep',
    promptTemplate: (name) => `Sweet dreams, ${name}. It is time to close your eyes and go to sleep.`,
    videoFile: 'go_to_sleep.mp4',
    emoji: '😴',
    color: colors.primary,
  },
  homework: {
    key: 'homework',
    label: 'Homework',
    promptTemplate: (name) => `Great focus, ${name}! Let us sit down and finish our homework.`,
    videoFile: 'homework.mp4',
    emoji: '📝',
    color: colors.primary,
  },
  make_bed: {
    key: 'make_bed',
    label: 'Make Bed',
    promptTemplate: (name) => `Nice work, ${name}! Let us make the bed nice and tidy.`,
    videoFile: 'make_bed.mp4',
    emoji: '🛏️',
    color: colors.primary,
  },
  wake_up: {
    key: 'wake_up',
    label: 'Wake Up',
    promptTemplate: (name) => `Good morning, ${name}! Time to wake up and start a wonderful day.`,
    videoFile: 'wake_up.mp4',
    emoji: '☀️',
    color: colors.primary,
  },
};

export const ACTIVITY_KEYS = Object.keys(ACTIVITIES) as Array<keyof typeof ACTIVITIES>;

export const ACTIVITY_TIMER_SECONDS: Record<ActivityKey, number> = {
  wake_up: 60,
  brush_teeth: 60,
  wash_face: 90,
  comb_hair: 120,
  get_dressed: 180,
  put_shoes_on: 90,
  pack_backpack: 180,
  drink_water: 30,
  tidy_room: 300,
  make_bed: 180,
  eat_breakfast: 600,
  homework: 900,
  read_book: 600,
  put_on_pajamas: 180,
  eat_dinner: 900,
  bedtime_story: 600,
  go_to_sleep: 300,
};

export const ACTIVITY_DURATION_MODES: Record<ActivityKey, DurationMode> = {
  wake_up: 'variable',
  brush_teeth: 'fixed',
  wash_face: 'fixed',
  comb_hair: 'variable',
  get_dressed: 'variable',
  put_shoes_on: 'variable',
  pack_backpack: 'variable',
  drink_water: 'fixed',
  tidy_room: 'variable',
  make_bed: 'variable',
  eat_breakfast: 'variable',
  homework: 'variable',
  read_book: 'variable',
  put_on_pajamas: 'variable',
  eat_dinner: 'variable',
  bedtime_story: 'variable',
  go_to_sleep: 'variable',
};

export function resolveDurationMode(
  activity: ActivityKey,
  savedMode: unknown,
  durationMinutes?: number
): DurationMode {
  if (savedMode === 'fixed' || savedMode === 'variable') return savedMode;
  if (durationMinutes !== undefined && Math.round(durationMinutes * 60) !== ACTIVITY_TIMER_SECONDS[activity]) {
    return 'variable';
  }
  return ACTIVITY_DURATION_MODES[activity];
}

export function defaultDurationMinutes(activity: ActivityKey): number {
  return ACTIVITY_TIMER_SECONDS[activity] / 60;
}

export const ACTIVITY_STARS: Record<ActivityKey, 0 | 1 | 2> = {
  brush_teeth: 2,
  get_dressed: 2,
  eat_breakfast: 1,
  pack_backpack: 2,
  wash_face: 1,
  comb_hair: 1,
  put_shoes_on: 1,
  drink_water: 0,
  tidy_room: 2,
  read_book: 1,
  put_on_pajamas: 1,
  bedtime_story: 0,
  eat_dinner: 1,
  go_to_sleep: 0,
  homework: 2,
  make_bed: 2,
  wake_up: 0,
};

export function starsForStep(step: ActivityKey[]): number {
  return Math.max(0, ...step.map((activity) => ACTIVITY_STARS[activity]));
}

export type ActivityTimeOfDay = 'morning' | 'evening' | 'general';

export const ACTIVITY_TIME_OF_DAY: Record<ActivityKey, ActivityTimeOfDay> = {
  brush_teeth: 'general',
  get_dressed: 'general',
  eat_breakfast: 'morning',
  pack_backpack: 'general',
  wash_face: 'general',
  comb_hair: 'general',
  put_shoes_on: 'general',
  drink_water: 'general',
  tidy_room: 'general',
  read_book: 'general',
  put_on_pajamas: 'evening',
  bedtime_story: 'evening',
  eat_dinner: 'evening',
  go_to_sleep: 'evening',
  homework: 'general',
  make_bed: 'general',
  wake_up: 'morning',
};

export function activityKeysForSegment(segment: 'morning' | 'evening'): ActivityKey[] {
  return ACTIVITY_KEYS.filter((key) => {
    const timeOfDay = ACTIVITY_TIME_OF_DAY[key];
    return timeOfDay === 'general' || timeOfDay === segment;
  });
}

/** Remote base URL for avatar video assets stored in Firebase Storage */
export const AVATAR_VIDEO_BASE_URL =
  'https://storage.googleapis.com/kids-routine-coach-app.firebasestorage.app/avatars';

/** Remote base URL for generated TTS audio stored in Firebase Storage */
export const AUDIO_BASE_URL =
  'https://storage.googleapis.com/kids-routine-coach-app.firebasestorage.app/audio';
