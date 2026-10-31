import { colors } from '../theme/colors';

// 04:00–14:59 → morning, 15:00–03:59 → evening
export const MORNING_START_MINUTES = 4 * 60;
export const EVENING_START_MINUTES = 16 * 60;

export type DaySegment = 'morning' | 'evening';

export function getCurrentSegment(): DaySegment {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= MORNING_START_MINUTES && minutes < EVENING_START_MINUTES
    ? 'morning'
    : 'evening';
}

export function timeToMinutes(value: string): number {
  const [hourStr, minuteStr] = value.split(':');
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return 8 * 60;
  }
  return hour * 60 + minute;
}

export function isMorningTime(value: string): boolean {
  const minutes = timeToMinutes(value);
  return minutes >= MORNING_START_MINUTES && minutes < EVENING_START_MINUTES;
}

export function segmentToTitle(segment: DaySegment): string {
  return segment === 'morning' ? 'Good Morning' : 'Good Evening';
}

export function segmentToSubtitle(segment: DaySegment): string {
  return segment === 'morning' ? "Let's start the day!" : 'Time to wind down';
}

export function segmentToTitleColor(segment: DaySegment): string {
  return segment === 'morning' ? colors.morningTitle : colors.eveningTitle;
}

export function segmentToSubtitleColor(segment: DaySegment): string {
  return segment === 'morning' ? colors.morningSubtitle : colors.eveningSubtitle;
}