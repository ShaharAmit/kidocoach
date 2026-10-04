import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { Routine } from '../types';

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

/**
 * Schedule a daily recurring local notification for a routine.
 * Returns the notification identifier so it can be cancelled later.
 */
export async function scheduleRoutineNotification(routine: Routine): Promise<string> {
  await cancelNotificationsForRoutine(routine.id, routine.userId);

  const triggerTime = routine.stepTimes?.[0] ?? routine.scheduledTime;
  const [hourStr, minuteStr] = triggerTime.split(':');
  const hour = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);

  const notificationId = await Notifications.scheduleNotificationAsync({
    content: {
      title: `⏰ Time for ${routine.childName}'s routine!`,
      body: `${routine.childName}, your morning routine is starting now. Tap to begin! 🚀`,
      data: {
        routineId: routine.id,
        userId: routine.userId,
        url: `kidocoach://routine/${routine.id}`,
      },
      sound: true,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.CALENDAR,
      hour,
      minute,
      repeats: true,
    },
  });

  return notificationId;
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
