import type { ActivityKey, DurationMode, ToneOption } from './index';

export type ActivityTimeOfDay = 'morning' | 'evening' | 'general';
export type RoutineSegment = 'morning' | 'evening';
/** 1 = survival, 2 = recommended, 3 = independence, 0 = never auto-included. */
export type RoutineLevel = 0 | 1 | 2 | 3;

export interface RoutinePlacement {
  position: number;
  /** Highest from-age not exceeding the child's age applies. */
  levels: Record<string, RoutineLevel>;
}

/** Cloud-catalog definition, shared by native and web composition. */
export interface ActivityDefinition {
  key: ActivityKey;
  label: string;
  emoji: string;
  subtitle: string;
  timeOfDay: ActivityTimeOfDay;
  timerSeconds: number;
  /** An independent time slot; otherwise the activity shares the ordinary 30-minute window. */
  scheduleMinutes?: number;
  durationMode: DurationMode;
  stars: 0 | 1 | 2;
  order: number;
  part1Text: string;
  part1Tone: ToneOption;
  /** Bump when greeting text/tone changes so cached personalized greetings regenerate. */
  part1Version: number;
  promptText: string;
  selectable: boolean;
  tags: string[];
  routine: Partial<Record<RoutineSegment, RoutinePlacement>>;
}
