import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { saveRoutine } from '../../hooks/useRoutine';
import { scheduleRoutineNotification } from '../../services/notifications';
import { syncRoutineAssets } from '../../services/assetSync';
import { ensureAudioForRoutine } from '../../services/tts';
import { ChildProfile, Routine, ActivityKey } from '../../types';
import { ACTIVITIES, activityKeysForSegment } from '../../constants/activities';
import { db, ensureAuth } from '../../services/firebase';
import { getChildProfile, saveChildProfile, saveUserProfileDoc } from '../../services/profile';
import { colors, fs, ms, s, vs } from '../../theme';
import { retryLocalImage, useLocalImage } from '../../utils/localImages';
import { getTodayISO } from '../../utils/date';
import { isMorningTime } from '../../utils/timeOfDay';
import PageBackground from '../../components/PageBackground';
import { InPageHeader } from '../../components/ScreenHeader';
import { MOON_IMAGE, SUN_IMAGE } from '../../constants/images';


type DaySegment = 'morning' | 'evening';
type TimePickerMode = 'add' | 'edit';
type ActivityEntry = { id: string; key: ActivityKey; time: string; order: number };

type SegmentDraft = {
  scheduledTime: string;
  entries: ActivityEntry[];
  notificationId?: string;
};

type SegmentDrafts = Record<DaySegment, SegmentDraft>;

type TimePickerState = {
  visible: boolean;
  segment: DaySegment;
  mode: TimePickerMode;
  time: string;
  entryId?: string;
  activityKey?: ActivityKey;
};

const SEGMENTS: DaySegment[] = ['morning', 'evening'];
const DEFAULT_TIMES: Record<DaySegment, string> = {
  morning: '08:00',
  evening: '19:00',
};

const TIME_OPTIONS = Array.from({ length: 96 }, (_, index) => {
  const totalMinutes = index * 15;
  const hours = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const minutes = String(totalMinutes % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
});

function addMinutes(time: string, minutesToAdd: number): string {
  const [hourStr, minuteStr] = time.split(':');
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const total = ((hour * 60 + minute + minutesToAdd) % (24 * 60) + 24 * 60) % (24 * 60);
  const h = String(Math.floor(total / 60)).padStart(2, '0');
  const m = String(total % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function validateTime(time: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(time);
}

function isTimeInSegment(time: string, segment: DaySegment): boolean {
  const morning = isMorningTime(time);
  return segment === 'morning' ? morning : !morning;
}

function coerceTimeToSegment(time: string, segment: DaySegment): string {
  if (validateTime(time) && isTimeInSegment(time, segment)) return time;
  return DEFAULT_TIMES[segment];
}

function makeEmptyDraft(segment: DaySegment): SegmentDraft {
  return {
    scheduledTime: DEFAULT_TIMES[segment],
    entries: [],
  };
}

function cloneDrafts(source: SegmentDrafts): SegmentDrafts {
  return {
    morning: {
      ...source.morning,
      entries: source.morning.entries.map((entry) => ({ ...entry })),
    },
    evening: {
      ...source.evening,
      entries: source.evening.entries.map((entry) => ({ ...entry })),
    },
  };
}

async function readExistingActivityEntries(
  userId: string,
  routineId: DaySegment
): Promise<ActivityEntry[]> {
  const docs = await getDocs(collection(db, 'users', userId, 'routines', routineId, 'activities'));
  return docs.docs
    .map((d, index) => {
      const data = d.data() as Record<string, unknown>;
      const key = data.activityKey;
      const time = data.time;
      const order = data.order;
      if (typeof key !== 'string' || typeof time !== 'string') return null;
      return {
        id: d.id,
        key: key as ActivityKey,
        time,
        order: typeof order === 'number' ? order : index,
      };
    })
    .filter((item): item is ActivityEntry => Boolean(item))
    .sort((a, b) => a.order - b.order);
}

async function readSegmentDraft(userId: string, segment: DaySegment): Promise<SegmentDraft> {
  const [routineSnap, entries] = await Promise.all([
    getDoc(doc(db, 'users', userId, 'routines', segment)),
    readExistingActivityEntries(userId, segment),
  ]);

  const routineData = routineSnap.exists() ? (routineSnap.data() as Record<string, unknown>) : null;
  const scheduledTime =
    typeof routineData?.scheduledTime === 'string'
      ? routineData.scheduledTime
      : entries[0]?.time ?? DEFAULT_TIMES[segment];
  const notificationId =
    typeof routineData?.notificationId === 'string' && routineData.notificationId.length > 0
      ? routineData.notificationId
      : undefined;

  return {
    scheduledTime,
    notificationId,
    entries,
  };
}

function normalizeEntriesForSave(entries: ActivityEntry[]): ActivityEntry[] {
  return entries.map((entry, index) => ({
    ...entry,
    id: entry.id.startsWith('tmp_')
      ? `step_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`
      : entry.id,
    order: index,
  }));
}

function segmentHasChanged(current: SegmentDraft, original: SegmentDraft): boolean {
  if (current.entries.length !== original.entries.length) return true;
  for (let i = 0; i < current.entries.length; i += 1) {
    const now = current.entries[i];
    const prev = original.entries[i];
    if (!prev) return true;
    if (now.id !== prev.id || now.key !== prev.key || now.time !== prev.time || now.order !== prev.order) {
      return true;
    }
  }
  return false;
}

async function remapLocalDailyCompletionForUpdatedActivities(
  routineId: DaySegment,
  next: ActivityEntry[]
): Promise<void> {
  const storageKey = `daily_completion_${routineId}`;
  const raw = await AsyncStorage.getItem(storageKey);
  if (!raw) return;

  let parsed: { date?: string; morning?: string[]; evening?: string[] } | null = null;
  try {
    parsed = JSON.parse(raw) as { date?: string; morning?: string[]; evening?: string[] };
  } catch {
    return;
  }
  if (!parsed || parsed.date !== getTodayISO()) return;

  const previousMorning = Array.isArray(parsed.morning) ? parsed.morning : [];
  const previousEvening = Array.isArray(parsed.evening) ? parsed.evening : [];

  const remapForSegment = (segment: DaySegment, completedIds: string[]): string[] => {
    const validStepIds = new Set(
      next
        .filter((entry) => (isMorningTime(entry.time) ? 'morning' : 'evening') === segment)
        .map((entry) => entry.id)
    );
    return completedIds.filter((id) => validStepIds.has(id));
  };

  const updated = {
    date: parsed.date,
    morning: remapForSegment('morning', previousMorning),
    evening: remapForSegment('evening', previousEvening),
  };
  await AsyncStorage.setItem(storageKey, JSON.stringify(updated));
}

export default function CreateRoutineScreen() {
  const insets = useSafeAreaInsets();
  const sunSource = useLocalImage(SUN_IMAGE);
  const moonSource = useLocalImage(MOON_IMAGE);
  const [activeSegment, setActiveSegment] = useState<DaySegment>('morning');
  const [profile, setProfile] = useState<ChildProfile | null>(null);
  const [drafts, setDrafts] = useState<SegmentDrafts>({
    morning: makeEmptyDraft('morning'),
    evening: makeEmptyDraft('evening'),
  });
  const [originalDrafts, setOriginalDrafts] = useState<SegmentDrafts>({
    morning: makeEmptyDraft('morning'),
    evening: makeEmptyDraft('evening'),
  });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedCollapsed, setSelectedCollapsed] = useState(false);
  const [catalogCollapsed, setCatalogCollapsed] = useState(false);
  const [segmentCollapsed, setSegmentCollapsed] = useState(false);
  const [timePicker, setTimePicker] = useState<TimePickerState>({
    visible: false,
    segment: 'morning',
    mode: 'add',
    time: DEFAULT_TIMES.morning,
  });

  const isEvening = activeSegment === 'evening';
  const activeDraft = drafts[activeSegment];
  const selectedCounts = useMemo(() => {
    const counts = new Map<ActivityKey, number>();
    activeDraft.entries.forEach((entry) => {
      counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
    });
    return counts;
  }, [activeDraft.entries]);
  const pickerTimeOptions = useMemo(() => {
    const options = TIME_OPTIONS.filter((time) => isTimeInSegment(time, timePicker.segment));
    if (options.includes(timePicker.time)) return options;
    const fallback = coerceTimeToSegment(timePicker.time, timePicker.segment);
    return [fallback, ...options.filter((time) => time !== fallback)];
  }, [timePicker.segment, timePicker.time]);

  useEffect(() => {
    let mounted = true;

    async function loadData() {
      const user = await ensureAuth();
      const localProfile = await getChildProfile();
      if (!mounted) return;

      if (!localProfile) {
        Alert.alert('Finish setup first', 'Please complete the questionnaire to set up your child first.', [
          { text: 'Go to setup', onPress: () => router.replace('/onboarding/questionnaire') },
        ]);
        return;
      }

      const [morningDraft, eveningDraft] = await Promise.all([
        readSegmentDraft(user.uid, 'morning'),
        readSegmentDraft(user.uid, 'evening'),
      ]);

      const nextDrafts: SegmentDrafts = {
        morning: morningDraft,
        evening: eveningDraft,
      };

      setProfile(localProfile);
      setDrafts(cloneDrafts(nextDrafts));
      setOriginalDrafts(cloneDrafts(nextDrafts));
      setLoaded(true);
    }

    loadData().catch((err) => {
      console.warn('[CreateRoutine] failed to load screen data:', err);
      if (!mounted) return;
      Alert.alert('Load failed', 'Could not load routines. Please try again.');
    });

    return () => {
      mounted = false;
    };
  }, []);

  const openEditTime = useCallback((entry: ActivityEntry) => {
    setTimePicker({
      visible: true,
      segment: activeSegment,
      mode: 'edit',
      time: entry.time,
      entryId: entry.id,
    });
  }, [activeSegment]);

  const openAddTime = useCallback((activityKey: ActivityKey) => {
    const current = drafts[activeSegment];
    const suggested =
      current.entries.length > 0
        ? addMinutes(current.entries[current.entries.length - 1].time, 15)
        : current.scheduledTime;

    setTimePicker({
      visible: true,
      segment: activeSegment,
      mode: 'add',
      time: coerceTimeToSegment(suggested, activeSegment),
      activityKey,
    });
  }, [activeSegment, drafts]);

  const removeSelected = useCallback((entryId: string) => {
    setDrafts((prev) => {
      const current = prev[activeSegment];
      const entries = current.entries
        .filter((entry) => entry.id !== entryId)
        .map((entry, index) => ({ ...entry, order: index }));
      return {
        ...prev,
        [activeSegment]: {
          ...current,
          entries,
          scheduledTime: entries[0]?.time ?? DEFAULT_TIMES[activeSegment],
        },
      };
    });
  }, [activeSegment]);

  const applyTimePicker = useCallback(() => {
    if (!validateTime(timePicker.time)) {
      Alert.alert('Invalid Time', 'Please select a valid time.');
      return;
    }
    if (!isTimeInSegment(timePicker.time, timePicker.segment)) {
      Alert.alert(
        'Time not allowed',
        `Please choose a ${timePicker.segment} time for this ${timePicker.segment} routine.`
      );
      return;
    }

    setDrafts((prev) => {
      const segment = timePicker.segment;
      const current = prev[segment];

      if (timePicker.mode === 'edit' && timePicker.entryId) {
        const entries = current.entries.map((entry) =>
          entry.id === timePicker.entryId ? { ...entry, time: timePicker.time } : entry
        );
        return {
          ...prev,
          [segment]: {
            ...current,
            entries,
            scheduledTime: entries[0]?.time ?? DEFAULT_TIMES[segment],
          },
        };
      }

      if (timePicker.mode === 'add' && timePicker.activityKey) {
        const entries = [
          ...current.entries,
          {
            id: `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            key: timePicker.activityKey,
            time: timePicker.time,
            order: current.entries.length,
          },
        ];
        return {
          ...prev,
          [segment]: {
            ...current,
            entries,
            scheduledTime: entries[0]?.time ?? DEFAULT_TIMES[segment],
          },
        };
      }

      return prev;
    });

    setTimePicker((prev) => ({ ...prev, visible: false }));
  }, [timePicker]);

  const handleSave = useCallback(async () => {
    if (!loaded || !profile) {
      Alert.alert('Missing profile', 'Please complete child setup first.');
      return;
    }

    const hasAnySelected =
      drafts.morning.entries.length > 0 || drafts.evening.entries.length > 0;
    if (!hasAnySelected) {
      Alert.alert('No Activities', 'Please add at least one activity before saving.');
      return;
    }

    const changedSegments = SEGMENTS.filter((segment) =>
      segmentHasChanged(drafts[segment], originalDrafts[segment])
    );

    if (changedSegments.length === 0) {
      Alert.alert('No changes', 'There are no routine changes to save.');
      return;
    }
    for (const segment of changedSegments) {
      const invalidEntry = drafts[segment].entries.find((entry) => !isTimeInSegment(entry.time, segment));
      if (invalidEntry) {
        Alert.alert(
          'Fix activity time',
          `One of the ${segment} activities has a time outside the ${segment} range. Please update it and try again.`
        );
        return;
      }
    }

    setSaving(true);

    try {
      const user = await ensureAuth();
      const nextDrafts = cloneDrafts(drafts);

      for (const segment of changedSegments) {
        const segmentDraft = nextDrafts[segment];
        const normalizedEntries = normalizeEntriesForSave(segmentDraft.entries);
        const scheduledTime = normalizedEntries[0]?.time ?? DEFAULT_TIMES[segment];

        const routine: Routine = {
          id: segment,
          userId: user.uid,
          childName: profile.childName.trim(),
          childAge: profile.age,
          avatarId: profile.avatarId,
          scheduledTime,
          activityStack: normalizedEntries.map((entry) => [entry.key]),
          stepIds: normalizedEntries.map((entry) => entry.id),
          stepTimes: normalizedEntries.map((entry) => entry.time),
          tone: profile.tone,
          voice: profile.voice,
          notificationId: segmentDraft.notificationId,
        };

        await saveRoutine(routine);

        let nextNotificationId = segmentDraft.notificationId;
        if (normalizedEntries.length > 0) {
          await ensureAudioForRoutine(routine);
          nextNotificationId = await scheduleRoutineNotification(routine);
          await saveRoutine({ ...routine, notificationId: nextNotificationId });
          syncRoutineAssets({ ...routine, notificationId: nextNotificationId }).catch((err) => {
            console.warn(`[CreateRoutine] Asset sync error for ${segment}:`, err);
          });
        }

        await remapLocalDailyCompletionForUpdatedActivities(
          segment,
          normalizedEntries
        );

        nextDrafts[segment] = {
          scheduledTime,
          notificationId: nextNotificationId,
          entries: normalizedEntries.map((entry, index) => ({ ...entry, order: index })),
        };
      }

      const profileSource =
        nextDrafts.morning.entries.length > 0 ? nextDrafts.morning : nextDrafts.evening;
      const profileStack = profileSource.entries.map((entry) => [entry.key] as [ActivityKey]);
      const profileTimes = profileSource.entries.map((entry) => entry.time);

      const updatedProfile: ChildProfile = {
        ...profile,
        userId: user.uid,
        childName: profile.childName.trim(),
        scheduledTime: profileTimes[0] ?? profile.scheduledTime,
        activityStack: profileStack,
        stepTimes: profileTimes,
        updatedAt: Date.now(),
      };

      await saveChildProfile(updatedProfile);
      await saveUserProfileDoc(updatedProfile);

      setDrafts(cloneDrafts(nextDrafts));
      setOriginalDrafts(cloneDrafts(nextDrafts));

      Alert.alert(
        '✅ Routines Saved!',
        `${profile.childName}'s morning and evening routines were updated.`,
        [{ text: 'Great!', onPress: () => router.replace({ pathname: '/loading', params: { mode: 'generating_experience' } } as never) }]
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      Alert.alert('Error', `Failed to save routines: ${message}`);
    } finally {
      setSaving(false);
    }
  }, [drafts, loaded, originalDrafts, profile]);

  return (
    <PageBackground variant={isEvening ? 'evening' : 'morning'} safeArea={false} style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {!loaded ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading routines…</Text>
        </View>
      ) : (
        <>
          <ScrollView
            style={styles.container}
            contentContainerStyle={[styles.content, { paddingBottom: vs(32) + insets.bottom, paddingTop: insets.top + vs(6) }]}
            showsVerticalScrollIndicator={false}
          >
            {/* Custom in-page header row */}
            <InPageHeader
              title={activeSegment === 'morning' ? 'Morning routines' : 'Evening routines'}
              onBack={() => router.back()}
              evening={isEvening}
              icon={
                <Image
                  source={activeSegment === 'morning' ? sunSource : moonSource}
                  style={styles.headerSegmentIcon}
                  resizeMode="contain"
                  onError={() =>
                    retryLocalImage(activeSegment === 'morning' ? SUN_IMAGE : MOON_IMAGE)
                  }
                />
              }
              right={
                <TouchableOpacity
                  style={[styles.headerSaveButton, saving && styles.headerSaveButtonDisabled]}
                  onPress={handleSave}
                  disabled={saving}
                  activeOpacity={0.9}
                >
                  <Text style={styles.headerSaveButtonText}>{saving ? 'Saving…' : 'Save ✓'}</Text>
                </TouchableOpacity>
              }
            />

            {/* Collapsible segment toggle card */}
              {/* Card toggle row */}
              <TouchableOpacity
                style={styles.sectionHeaderRow}
                onPress={() => setSegmentCollapsed((prev) => !prev)}
                activeOpacity={0.85}
              >
              <Text style={[styles.sectionTitle, isEvening && styles.sectionTitleEvening]}>
                Toggle Routines
              </Text>
              <Text style={[styles.sectionChevron, isEvening && styles.sectionChevronEvening]}>
                {selectedCollapsed ? '▾' : '▴'}
              </Text>
              </TouchableOpacity>

              {!segmentCollapsed && (
                <>
                <View style={[styles.headerCard, isEvening && styles.headerCardEvening]}>

                  <View style={[styles.segmentRow, { marginTop: vs(12) }]}>
                    <TouchableOpacity
                      style={[
                        styles.segmentButton,
                        activeSegment === 'morning' && styles.segmentButtonActive,
                        isEvening && styles.segmentButtonEveningBase,
                        activeSegment === 'morning' && isEvening && styles.segmentButtonEveningActive,
                      ]}
                      disabled={activeSegment === 'morning'}
                      onPress={() => setActiveSegment('morning')}
                    >
                      <Image
                        source={sunSource}
                        style={styles.segmentIconLarge}
                        resizeMode="contain"
                        onError={() => retryLocalImage(SUN_IMAGE)}
                      />
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[
                        styles.segmentButton,
                        activeSegment === 'evening' && styles.segmentButtonActive,
                        isEvening && styles.segmentButtonEveningBase,
                        activeSegment === 'evening' && isEvening && styles.segmentButtonEveningActive,
                      ]}
                      disabled={activeSegment === 'evening'}
                      onPress={() => setActiveSegment('evening')}
                    >
                      <Image
                        source={moonSource}
                        style={styles.segmentIconLarge}
                        resizeMode="contain"
                        onError={() => retryLocalImage(MOON_IMAGE)}
                      />
                    </TouchableOpacity>
                  </View>
            </View>
                </>
              )}

            <TouchableOpacity
              style={styles.sectionHeaderRow}
              onPress={() => setSelectedCollapsed((prev) => !prev)}
              activeOpacity={0.85}
            >
              <Text style={[styles.sectionTitle, isEvening && styles.sectionTitleEvening]}>
                Selected activities
              </Text>
              <Text style={[styles.sectionChevron, isEvening && styles.sectionChevronEvening]}>
                {selectedCollapsed ? '▾' : '▴'}
              </Text>
            </TouchableOpacity>
            {!selectedCollapsed && (
              activeDraft.entries.length === 0 ? (
                <View style={[styles.emptyCard, isEvening && styles.emptyCardEvening]}>
                  <Text style={[styles.emptyTitle, isEvening && styles.emptyTitleEvening]}>
                    No activities selected yet
                  </Text>
                  <Text style={[styles.emptyHint, isEvening && styles.emptyHintEvening]}>
                    Add one from the activity list below.
                  </Text>
                </View>
              ) : (
                <View style={styles.sectionBorder}>
                  <ScrollView style={styles.selectedScroll} nestedScrollEnabled showsVerticalScrollIndicator={false}>
                    {activeDraft.entries.map((entry, index) => {
                      const activity = ACTIVITIES[entry.key];
                      return (
                        <View key={entry.id} style={[styles.selectedRow, isEvening && styles.selectedRowEvening]}>
                          <Text style={[styles.selectedOrder, isEvening && styles.selectedOrderEvening]}>
                            {index + 1}
                          </Text>
                          <View style={styles.selectedMeta}>
                            <Text style={[styles.selectedLabel, isEvening && styles.selectedLabelEvening]}>
                              {activity.emoji} {activity.label}
                            </Text>
                          </View>
                          <TouchableOpacity
                            style={styles.timePill}
                            onPress={() => openEditTime(entry)}
                            activeOpacity={0.85}
                          >
                            <Text style={styles.timePillText}>{entry.time}</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={styles.removeButton}
                            onPress={() => removeSelected(entry.id)}
                            activeOpacity={0.85}
                          >
                            <Text style={styles.removeButtonText}>✕</Text>
                          </TouchableOpacity>
                        </View>
                      );
                    })}
                  </ScrollView>
                </View>
              )
            )}

            <TouchableOpacity
              style={styles.sectionHeaderRow}
              onPress={() => setCatalogCollapsed((prev) => !prev)}
              activeOpacity={0.85}
            >
              <Text style={[styles.sectionTitle, isEvening && styles.sectionTitleEvening]}>
                {isEvening ? 'Evening' : 'Morning'} Activities
              </Text>
              <Text style={[styles.sectionChevron, isEvening && styles.sectionChevronEvening]}>
                {catalogCollapsed ? '▾' : '▴'}
              </Text>
            </TouchableOpacity>
            {!catalogCollapsed && (
              <View style={styles.sectionBorder}>
                <ScrollView style={styles.catalogScroll} nestedScrollEnabled showsVerticalScrollIndicator={false}>
                  <View style={styles.catalogGrid}>
                    {activityKeysForSegment(activeSegment).map((key) => {
                      const activity = ACTIVITIES[key];
                      const selectedCount = selectedCounts.get(key) ?? 0;
                      return (
                        <TouchableOpacity
                          key={key}
                          style={[
                            styles.catalogChip,
                            selectedCount > 0 && styles.catalogChipSelected,
                            isEvening && styles.catalogChipEvening,
                          ]}
                          onPress={() => openAddTime(key)}
                          activeOpacity={0.85}
                        >
                          <Text style={styles.catalogEmoji}>{activity.emoji}</Text>
                          <Text
                            style={[
                              styles.catalogLabel,
                              selectedCount > 0 && styles.catalogLabelSelected,
                              isEvening && styles.catalogLabelEvening,
                            ]}
                          >
                            {activity.label}
                          </Text>
                          <Text
                            style={[
                              styles.catalogState,
                              selectedCount > 0 && styles.catalogStateSelected,
                              isEvening && styles.catalogStateEvening,
                            ]}
                          >
                            {selectedCount > 0 ? `Added ×${selectedCount}` : 'Add'}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </ScrollView>
              </View>
            )}
          </ScrollView>
        </>
      )}

      <Modal
        visible={timePicker.visible}
        transparent
        animationType="fade"
        onRequestClose={() => setTimePicker((prev) => ({ ...prev, visible: false }))}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {timePicker.mode === 'add' ? 'Pick time for activity' : 'Change activity time'}
            </Text>
            <ScrollView style={styles.timeList} showsVerticalScrollIndicator={false}>
              {pickerTimeOptions.map((option) => {
                const selected = option === timePicker.time;
                return (
                  <TouchableOpacity
                    key={option}
                    style={[styles.timeRow, selected && styles.timeRowSelected]}
                    onPress={() => setTimePicker((prev) => ({ ...prev, time: option }))}
                  >
                    <Text style={[styles.timeRowText, selected && styles.timeRowTextSelected]}>
                      {option}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalCancel]}
                onPress={() => setTimePicker((prev) => ({ ...prev, visible: false }))}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalButton, styles.modalConfirm]} onPress={applyTimePicker}>
                <Text style={styles.modalConfirmText}>Confirm</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </PageBackground>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: s(16),
    paddingTop: vs(12),
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    marginTop: vs(10),
    fontSize: fs(14),
    color: colors.textInk,
  },
  headerSaveButton: {
    borderRadius: ms(10),
    backgroundColor: colors.primary,
    paddingHorizontal: s(12),
    paddingVertical: vs(6),
    marginRight: s(8),
  },
  headerSaveButtonDisabled: {
    opacity: 0.6,
  },
  headerSaveButtonText: {
    color: colors.white,
    fontSize: fs(12),
    fontWeight: '800',
  },
  headerCard: {
    backgroundColor: colors.white,
    borderRadius: ms(18),
    padding: ms(14),
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  headerCardEvening: {
    backgroundColor: '#405598',
    borderColor: '#5A6FB0',
  },
  headerSegmentIcon: {
    width: s(24),
    height: s(24),
    marginRight: s(6),
  },
  segmentToggleIcon: {
    width: s(26),
    height: s(26),
  },
  segmentToggleIconDim: {
    opacity: 0.35,
  },
  segmentIconLarge: {
    width: s(40),
    height: s(40),
  },
  subTitle: {
    marginTop: vs(2),
    fontSize: fs(13),
    color: colors.morningSubtitle,
  },
  subTitleEvening: {
    color: colors.eveningSubtitle,
  },
  segmentRow: {
    flexDirection: 'row',
    gap: s(10),
  },
  segmentButton: {
    flex: 1,
    borderRadius: ms(12),
    borderWidth: 1.5,
    borderColor: colors.borderLight,
    backgroundColor: '#F7FAFC',
    paddingVertical: vs(14),
    paddingHorizontal: s(8),
    alignItems: 'center',
  },
  segmentButtonEveningBase: {
    backgroundColor: '#334884',
    borderColor: '#5A6FB0',
  },
  segmentButtonActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  segmentButtonEveningActive: {
    backgroundColor: '#6E84C9',
    borderColor: '#6E84C9',
  },
  profileMeta: {
    marginTop: vs(10),
    fontSize: fs(12),
    color: colors.textMuted,
  },
  profileMetaEvening: {
    color: '#D7E1FF',
  },
  sectionTitle: {
    marginTop: vs(18),
    fontSize: fs(16),
    fontWeight: '800',
    color: colors.textInk,
  },
  sectionTitleEvening: {
    color: colors.eveningTitle,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: vs(8),
  },
  sectionChevron: {
    fontSize: fs(18),
    fontWeight: '800',
    color: colors.textInk,
    marginTop: vs(12),
  },
  sectionChevronEvening: {
    color: colors.eveningTitle,
  },
  emptyCard: {
    borderRadius: ms(14),
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.white,
    padding: ms(14),
  },
  emptyCardEvening: {
    backgroundColor: '#405598',
    borderColor: '#5A6FB0',
  },
  emptyTitle: {
    fontSize: fs(14),
    fontWeight: '700',
    color: colors.textInk,
  },
  emptyTitleEvening: {
    color: colors.eveningTitle,
  },
  emptyHint: {
    marginTop: vs(4),
    fontSize: fs(12),
    color: colors.textMuted,
  },
  emptyHintEvening: {
    color: colors.eveningSubtitle,
  },
  selectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: ms(14),
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.white,
    paddingHorizontal: s(12),
    paddingVertical: vs(11),
    marginBottom: vs(8),
    gap: s(8),
  },
  selectedRowEvening: {
    backgroundColor: '#405598',
    borderColor: '#5A6FB0',
  },
  selectedOrder: {
    width: s(24),
    textAlign: 'center',
    fontSize: fs(13),
    fontWeight: '800',
    color: colors.textMuted,
  },
  selectedOrderEvening: {
    color: colors.eveningSubtitle,
  },
  selectedMeta: {
    flex: 1,
    minWidth: 0,
  },
  selectedLabel: {
    fontSize: fs(14),
    fontWeight: '700',
    color: colors.textInk,
  },
  selectedLabelEvening: {
    color: colors.eveningTitle,
  },
  timePill: {
    borderRadius: ms(99),
    backgroundColor: colors.primary,
    paddingVertical: vs(6),
    paddingHorizontal: s(10),
  },
  timePillText: {
    color: colors.white,
    fontSize: fs(12),
    fontWeight: '800',
  },
  removeButton: {
    width: s(26),
    height: s(26),
    borderRadius: ms(13),
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeButtonText: {
    fontSize: fs(13),
    color: colors.textMuted,
    fontWeight: '800',
  },
  catalogGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: s(8),
  },
  catalogScroll: {
    height: vs(172),
  },
  catalogChip: {
    width: '48%',
    borderRadius: ms(14),
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.white,
    paddingVertical: vs(10),
    paddingHorizontal: s(10),
  },
  catalogChipEvening: {
    backgroundColor: '#405598',
    borderColor: '#5A6FB0',
  },
  catalogChipSelected: {
    opacity: 0.55,
  },
  catalogEmoji: {
    fontSize: fs(19),
  },
  catalogLabel: {
    marginTop: vs(4),
    fontSize: fs(13),
    fontWeight: '700',
    color: colors.textInk,
  },
  catalogLabelSelected: {
    color: colors.textSlate,
  },
  catalogLabelEvening: {
    color: colors.eveningTitle,
  },
  catalogState: {
    marginTop: vs(4),
    fontSize: fs(11),
    fontWeight: '800',
    color: colors.primary,
  },
  catalogStateSelected: {
    color: colors.textMuted,
  },
  catalogStateEvening: {
    color: colors.eveningSubtitle,
  },
  sectionBorder: {
    borderWidth: 1,
    borderColor: '#BDBDBD',
    borderRadius: ms(12),
    overflow: 'hidden',
    marginBottom: vs(8),
    paddingHorizontal: s(4),
    paddingVertical: vs(4),
  },
  selectedScroll: {
    height: vs(150),
  },
  saveBar: {
    position: 'absolute',
    left: s(16),
    right: s(16),
  },
  saveButton: {
    borderRadius: ms(16),
    backgroundColor: colors.primary,
    paddingVertical: vs(15),
    alignItems: 'center',
  },
  saveButtonEvening: {
    backgroundColor: '#6E84C9',
  },
  saveButtonText: {
    color: colors.white,
    fontSize: fs(16),
    fontWeight: '800',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'center',
    paddingHorizontal: s(22),
  },
  modalCard: {
    maxHeight: '72%',
    borderRadius: ms(18),
    backgroundColor: colors.white,
    padding: ms(14),
  },
  modalTitle: {
    fontSize: fs(16),
    fontWeight: '800',
    color: colors.textInk,
    marginBottom: vs(10),
  },
  timeList: {
    maxHeight: vs(320),
  },
  timeRow: {
    paddingVertical: vs(10),
    paddingHorizontal: s(12),
    borderRadius: ms(10),
  },
  timeRowSelected: {
    backgroundColor: '#E7F1FC',
  },
  timeRowText: {
    fontSize: fs(15),
    color: colors.textInk,
    fontWeight: '600',
  },
  timeRowTextSelected: {
    color: colors.primary,
    fontWeight: '800',
  },
  modalActions: {
    marginTop: vs(12),
    flexDirection: 'row',
    gap: s(10),
  },
  modalButton: {
    flex: 1,
    borderRadius: ms(12),
    paddingVertical: vs(12),
    alignItems: 'center',
  },
  modalCancel: {
    backgroundColor: '#EEF2F7',
  },
  modalConfirm: {
    backgroundColor: colors.primary,
  },
  modalCancelText: {
    color: colors.textInk,
    fontSize: fs(14),
    fontWeight: '700',
  },
  modalConfirmText: {
    color: colors.white,
    fontSize: fs(14),
    fontWeight: '800',
  },
});
