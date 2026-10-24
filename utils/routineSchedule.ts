import type { ActivityKey } from '../types';
import { EVENING_START_MINUTES } from './timeOfDay';

/** Ordinary activities share this window; activities with a catalog `scheduleMinutes` get their own slot on top. */
export const SHARED_WINDOW_MINUTES = 30;

const DAY_MINUTES = 24 * 60;

function parseTime(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 0;
}

function formatTime(minutes: number): string {
  const total = ((Math.round(minutes) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Slot length per step: own `scheduleMinutes`, else an even share of the 30-min window. */
export function stepSlotMinutes(
  keys: ActivityKey[],
  scheduleMinutes: (key: ActivityKey) => number | undefined
): number[] {
  const own = keys.map((key) => scheduleMinutes(key));
  const sharedCount = own.filter((value) => value === undefined).length;
  const share = sharedCount ? SHARED_WINDOW_MINUTES / sharedCount : 0;
  return own.map((value) => value ?? share);
}

/** Morning: steps start at wake-up and run forward. */
export function scheduleFromStart(
  start: string,
  keys: ActivityKey[],
  scheduleMinutes: (key: ActivityKey) => number | undefined
): string[] {
  const slots = stepSlotMinutes(keys, scheduleMinutes);
  let offset = parseTime(start);
  return slots.map((slot) => {
    const time = formatTime(offset);
    offset += slot;
    return time;
  });
}

/**
 * Evening: planned backwards so the last step ends at bedtime. Never starts before the evening
 * segment begins, so every step still counts as evening on Home.
 */
export function scheduleToEnd(
  end: string,
  keys: ActivityKey[],
  scheduleMinutes: (key: ActivityKey) => number | undefined
): string[] {
  const total = stepSlotMinutes(keys, scheduleMinutes).reduce((sum, slot) => sum + slot, 0);
  const endMinutes = parseTime(end);
  // Bedtimes after midnight are treated as the same evening.
  const endOnEvening = endMinutes < EVENING_START_MINUTES ? endMinutes + DAY_MINUTES : endMinutes;
  const start = Math.max(EVENING_START_MINUTES, endOnEvening - total);
  return scheduleFromStart(formatTime(start), keys, scheduleMinutes);
}
