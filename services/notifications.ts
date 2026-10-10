import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { Routine } from '../types';
import { ACTIVITIES } from '../constants/activities';

// Configure how notifications appear when the app is in the foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/**
 * Request push notification permissions from the OS.
 * Returns true if permissions were granted.
 */
export async function requestNotificationPermissions(): Promise<boolean> {
  if (!Device.isDevice) {
    console.log('[Notifications] Push notifications skipped (simulator/emulator environment).');
    return false;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.warn('Notification permission not granted.');
    return false;
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('routine-reminders', {
      name: 'Routine Reminders',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#4A90D9',
      sound: null,
    });
  }

  return true;
}

/** Reminders fire this many minutes before each activity's scheduled time. */
export const ACTIVITY_REMINDER_LEAD_MINUTES = 2;
const ROUTINE_CHANNEL_ID = 'routine-reminders';

/** "HH:MM" minus the lead time, wrapping across midnight (00:01 -> 23:59). */
function reminderTriggerTime(time: string | undefined): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time?.trim() ?? '');
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  const total = (hour * 60 + minute - ACTIVITY_REMINDER_LEAD_MINUTES + 24 * 60) % (24 * 60);
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

/**
 * Schedules one daily repeating reminder per routine step, ACTIVITY_REMINDER_LEAD_MINUTES before
 * that step's time. Replaces every reminder this device previously scheduled for the routine.
 * Returns the first reminder's identifier ('' when no step has a valid time).
 */
export async function scheduleRoutineNotification(routine: Routine): Promise<string> {
  await cancelNotificationsForRoutine(routine.id, routine.userId);

  const identifiers: string[] = [];
  for (let stepIndex = 0; stepIndex < routine.activityStack.length; stepIndex += 1) {
    const step = routine.activityStack[stepIndex] ?? [];
    const stepTime = routine.stepTimes?.[stepIndex] ?? (stepIndex === 0 ? routine.scheduledTime : undefined);
    const triggerTime = reminderTriggerTime(stepTime);
    const activities = step.map((key) => ACTIVITIES[key]).filter(Boolean);
    if (!triggerTime || activities.length === 0) continue;

    const label = activities.map((activity) => activity.label).join(' + ');
    const emoji = activities[0].emoji;

    const identifier = await Notifications.scheduleNotificationAsync({
      content: {
        title: `${emoji} ${label} in ${ACTIVITY_REMINDER_LEAD_MINUTES} minutes`,
        body: `Get ready, ${routine.childName}! ${label} starts at ${stepTime}.`,
        data: {
          routineId: routine.id,
          userId: routine.userId,
          stepIndex,
          url: `kidocoach://routine/${routine.id}`,
        },
        sound: true,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour: triggerTime.hour,
        minute: triggerTime.minute,
        channelId: ROUTINE_CHANNEL_ID,
      },
    });
    identifiers.push(identifier);
  }

  return identifiers[0] ?? '';
}

/** The OS notification list is the per-device registry; cloud IDs belong to other devices. */
export async function cancelNotificationsForRoutine(routineId: string, userId: string): Promise<void> {
  const notifications = await Notifications.getAllScheduledNotificationsAsync();
  for (const notification of notifications) {
    const data = notification.content.data;
    if (data?.routineId === routineId && (data.userId === userId || data.userId === undefined)) {
      await Notifications.cancelScheduledNotificationAsync(notification.identifier);
    }
  }
}

/**
 * Cancel all scheduled notifications for a given notification ID.
 */
export async function cancelRoutineNotification(notificationId: string): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(notificationId);
}

const TRIAL_LENGTH_DAYS = 7;
const NOTIFY_HOURS_BEFORE_TRIAL_END = 24;

/**
 * Schedules a one-off local reminder ~24h before the paywall's free trial converts to a paid
 * subscription. Tied to the "Notify me before trial ends" toggle on the paywall screen.
 */
export async function scheduleTrialEndingNotification(): Promise<string> {
  const secondsFromNow = (TRIAL_LENGTH_DAYS * 24 - NOTIFY_HOURS_BEFORE_TRIAL_END) * 3600;

  return Notifications.scheduleNotificationAsync({
    content: {
      title: 'Your free trial ends tomorrow',
      body: "Your KidoCoach subscription starts tomorrow unless you cancel first.",
      sound: true,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: secondsFromNow,
      repeats: false,
    },
  });
}

export async function cancelTrialEndingNotification(notificationId: string): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(notificationId).catch(() => {});
}

/**
 * Get all currently scheduled notifications (for debugging/display).
 */
export async function getScheduledNotifications() {
  return Notifications.getAllScheduledNotificationsAsync();
}
