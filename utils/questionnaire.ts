import type {
  HelpLevel, MasteredTask, MorningSpeed, MorningStuckPoint, MotivationStyle, ToneOption,
} from '../types';

export type QuestionnaireOption<T extends string> = { key: T; label: string };

export const MORNING_STUCK_OPTIONS: QuestionnaireOption<MorningStuckPoint>[] = [
  { key: 'getting_out_of_bed', label: 'Getting out of bed' },
  { key: 'getting_dressed', label: 'Getting dressed' },
  { key: 'brushing_washing', label: 'Brushing teeth & washing up' },
  { key: 'turning_off_screens', label: 'Putting screens away' },
  { key: 'everything_negotiation', label: "Honestly? Everything's a negotiation" },
];
export const MOTIVATION_OPTIONS: QuestionnaireOption<MotivationStyle>[] = [
  { key: 'race_game', label: 'Turning it into a race or game' },
  { key: 'autonomy_choose', label: 'Letting them choose' },
  { key: 'praise_encouragement', label: 'Lots of praise and encouragement' },
  { key: 'hug_connection', label: 'A warm hug and some connection' },
];
export const MASTERED_OPTIONS: QuestionnaireOption<MasteredTask>[] = [
  { key: 'eating_breakfast', label: 'Eating breakfast' },
  { key: 'choosing_clothes', label: 'Choosing their clothes' },
  { key: 'putting_toys_away', label: 'Putting toys away' },
  { key: 'none_yet', label: "None yet, that's why we're here!" },
];
export const HELP_OPTIONS: QuestionnaireOption<HelpLevel>[] = [
  { key: 'independent', label: '"I can do it myself!" (fully independent)' },
  { key: 'little_push', label: 'Needs a little push to get started' },
  { key: 'step_by_step', label: 'Needs me there step by step' },
];
export const SPEED_OPTIONS: QuestionnaireOption<MorningSpeed>[] = [
  { key: 'fast_energetic', label: 'Fast and full of energy' },
  { key: 'slow_dreamy', label: 'Slow and dreamy' },
  { key: 'easily_distracted', label: 'Easily distracted' },
];
export const WAKE_TIME_OPTIONS = ['05:30', '06:00', '06:30', '07:00', '07:30', '08:00', '08:30', '09:00'];
export const BEDTIME_OPTIONS = ['18:30', '19:00', '19:30', '20:00', '20:30', '21:00', '21:30', '22:00'];

export function toggleMulti<T extends string>(current: T[] | undefined, key: T, exclusive: T): T[] {
  const list = current ?? [];
  if (list.includes(key)) return list.filter((item) => item !== key);
  if (key === exclusive) return [key];
  return [...list.filter((item) => item !== exclusive), key];
}

export function toneFromMotivation(style: MotivationStyle | undefined): ToneOption {
  switch (style) {
    case 'race_game': return 'cheerful';
    case 'hug_connection': return 'calm';
    default: return 'encouraging';
  }
}
