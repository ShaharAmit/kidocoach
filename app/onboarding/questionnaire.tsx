import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import PageBackground from '../../components/PageBackground';
import { getActivityDefinition, getSelectableActivityDefinitions } from '../../constants/activities';
import { composeRoutine } from '../../utils/routineComposer';
import { refreshActivityCatalog } from '../../services/activityCatalog';
import { InPageHeader } from '../../components/ScreenHeader';
import {
  ChildGender,
  ChildProfile,
  HelpLevel,
  MasteredTask,
  MorningSpeed,
  MorningStuckPoint,
  MotivationStyle,
  QuestionnaireAnswers,
  Routine,
  ToneOption,
} from '../../types';
import { ensureAuth } from '../../services/firebase';
import { saveRoutine, saveRoutineIfMissing } from '../../hooks/useRoutine';
import { scheduleRoutineNotification } from '../../services/notifications';
import { saveChildProfile, getChildProfile, saveUserProfileDoc } from '../../services/profile';
import { getPaidStatus } from '../../services/subscription';
import { calculateAgeFromISO, formatBirthDate, getTodayISO, isoDateYearsAgo } from '../../utils/date';
import { colors, fs, ms, s, vs } from '../../theme';
import { retryLocalImage, useLocalImage } from '../../utils/localImages';
import { GRASS_IMAGE as GRASS } from '../../constants/images';
import { isValidChildName, MAX_CHILD_NAME_LENGTH } from '../../utils/nameToken';
import { isMorningTime } from '../../utils/timeOfDay';
import { scheduleFromStart, scheduleToEnd } from '../../utils/routineSchedule';


const DEFAULT_AVATAR_ID = 'becky';
const DEFAULT_VOICE = 'woman' as const;
const DEFAULT_WAKE_TIME = '07:00';
const DEFAULT_BEDTIME = '20:00';

const WAKE_TIME_OPTIONS = ['05:30', '06:00', '06:30', '07:00', '07:30', '08:00', '08:30', '09:00'];
const BEDTIME_OPTIONS = ['18:30', '19:00', '19:30', '20:00', '20:30', '21:00', '21:30', '22:00'];

const MIN_AGE = 2;
const MAX_AGE = 12;

type Option<T extends string> = { key: T; label: string };

const MORNING_STUCK_OPTIONS: Option<MorningStuckPoint>[] = [
  { key: 'getting_out_of_bed', label: 'Getting out of bed' },
  { key: 'getting_dressed', label: 'Getting dressed' },
  { key: 'brushing_washing', label: 'Brushing teeth & washing up' },
  { key: 'turning_off_screens', label: 'Putting screens away' },
  { key: 'everything_negotiation', label: "Honestly? Everything's a negotiation" },
];

const MOTIVATION_OPTIONS: Option<MotivationStyle>[] = [
  { key: 'race_game', label: 'Turning it into a race or game' },
  { key: 'autonomy_choose', label: 'Letting them choose' },
  { key: 'praise_encouragement', label: 'Lots of praise and encouragement' },
  { key: 'hug_connection', label: 'A warm hug and some connection' },
];

const MASTERED_OPTIONS: Option<MasteredTask>[] = [
  { key: 'eating_breakfast', label: 'Eating breakfast' },
  { key: 'choosing_clothes', label: 'Choosing their clothes' },
  { key: 'putting_toys_away', label: 'Putting toys away' },
  { key: 'none_yet', label: "None yet, that's why we're here!" },
];

const HELP_OPTIONS: Option<HelpLevel>[] = [
  { key: 'independent', label: '"I can do it myself!" (fully independent)' },
  { key: 'little_push', label: 'Needs a little push to get started' },
  { key: 'step_by_step', label: 'Needs me there step by step' },
];

const SPEED_OPTIONS: Option<MorningSpeed>[] = [
  { key: 'fast_energetic', label: 'Fast and full of energy' },
  { key: 'slow_dreamy', label: 'Slow and dreamy' },
  { key: 'easily_distracted', label: 'Easily distracted' },
];

const GENDER_OPTIONS: { key: ChildGender; label: string; emoji: string }[] = [
  { key: 'boy', label: 'Boy', emoji: '👦' },
  { key: 'girl', label: 'Girl', emoji: '👧' },
];

/** Multi-select toggle where `exclusive` clears every other choice (and vice versa). */
function toggleMulti<T extends string>(current: T[] | undefined, key: T, exclusive: T): T[] {
  const list = current ?? [];
  if (list.includes(key)) return list.filter((item) => item !== key);
  if (key === exclusive) return [key];
  return [...list.filter((item) => item !== exclusive), key];
}

/** Map the motivation answer to the TTS tone used by the rest of the app. */
function toneFromMotivation(style: MotivationStyle | undefined): ToneOption {
  switch (style) {
    case 'race_game':
      return 'cheerful';
    case 'hug_connection':
      return 'calm';
    case 'autonomy_choose':
    case 'praise_encouragement':
    default:
      return 'encouraging';
  }
}

function formatTime12h(time: string): string {
  const [hour, minute] = time.split(':').map(Number);
  const period = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${String(minute).padStart(2, '0')} ${period}`;
}

/** Preset chips plus the saved time when it isn't one of them (edited later in Add Routine). */
function withCurrentTime(options: string[], current: string): string[] {
  return options.includes(current) ? options : [...options, current].sort();
}

// Step 0 = name + gender + age, steps 1..5 = questions (1 and 3 are multi-select),
// step 6 = morning/evening start times. Final = trust screen.
const QUESTION_STEP_COUNT = 7;

export default function QuestionnaireScreen() {
  const grassSource = useLocalImage(GRASS);
  const [stepIndex, setStepIndex] = useState(0);
  const [showFinal, setShowFinal] = useState(false);
  const [saving, setSaving] = useState(false);

  const [childName, setChildName] = useState('');
  const [gender, setGender] = useState<ChildGender | null>(null);
  const [birthDate, setBirthDate] = useState(() => isoDateYearsAgo(6));

  const age = useMemo(() => calculateAgeFromISO(birthDate), [birthDate]);

  const [answers, setAnswers] = useState<QuestionnaireAnswers>({});
  const [wakeTime, setWakeTime] = useState(DEFAULT_WAKE_TIME);
  const [bedtime, setBedtime] = useState(DEFAULT_BEDTIME);

  useEffect(() => {
    let mounted = true;
    getChildProfile()
      .then((profile) => {
        if (!profile || !mounted) return;
        setChildName(profile.childName);
        setGender(profile.gender);
        setBirthDate(profile.birthDate ?? isoDateYearsAgo(profile.age));
        if (profile.answers) setAnswers(profile.answers);
        if (isMorningTime(profile.scheduledTime)) setWakeTime(profile.scheduledTime);
        if (profile.bedtime && !isMorningTime(profile.bedtime)) setBedtime(profile.bedtime);
      })
      .catch((err) => console.warn('[Questionnaire] failed to load profile defaults:', err));
    return () => {
      mounted = false;
    };
  }, []);

  const displayName = childName.trim() || 'your child';

  const goBack = useCallback(() => {
    if (showFinal) {
      setShowFinal(false);
      return;
    }
    if (stepIndex > 0) {
      setStepIndex((prev) => prev - 1);
      return;
    }
    router.back();
  }, [showFinal, stepIndex]);

  const canContinue = useMemo(() => {
    switch (stepIndex) {
      case 0:
        return isValidChildName(childName) && !!gender && age >= MIN_AGE && age <= MAX_AGE;
      case 1:
        return !!answers.stuckPoints?.length;
      case 2:
        return !!answers.motivationStyle;
      case 3:
        return !!answers.masteredTasks?.length;
      case 4:
        return !!answers.helpLevel;
      case 5:
        return !!answers.morningSpeed;
      case 6:
        return isMorningTime(wakeTime) && !isMorningTime(bedtime);
      default:
        return false;
    }
  }, [stepIndex, childName, gender, age, answers, wakeTime, bedtime]);

  const handleContinue = useCallback(() => {
    if (!canContinue) return;
    if (stepIndex < QUESTION_STEP_COUNT - 1) {
      setStepIndex((prev) => prev + 1);
    } else {
      setShowFinal(true);
    }
  }, [canContinue, stepIndex]);

  const saveQuestionnaire = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const user = await ensureAuth();
      const userId = user.uid;
      const tone = toneFromMotivation(answers.motivationStyle);
      // Composition rules (tags/levels) come only from the cloud catalog, so make sure it's loaded.
      await refreshActivityCatalog();
      // Only selectable activities (complete media) are used.
      const selectable = getSelectableActivityDefinitions();
      const morningActivityStack = composeRoutine(selectable, 'morning', age, answers).map((key) => [key]);
      const eveningActivityStack = composeRoutine(selectable, 'evening', age, answers).map((key) => [key]);
      if (!morningActivityStack.length || !eveningActivityStack.length) {
        Alert.alert(
          'No connection',
          "We couldn't load the activities. Check your internet connection and try again."
        );
        setSaving(false);
        return;
      }
      // Ordinary tasks share a 30-min window; long ones (e.g. dinner) use their catalog slot.
      const slotMinutes = (key: string) => getActivityDefinition(key).scheduleMinutes;
      const morningStepTimes = scheduleFromStart(wakeTime, morningActivityStack.map(([key]) => key), slotMinutes);
      const eveningStepTimes = scheduleToEnd(bedtime, eveningActivityStack.map(([key]) => key), slotMinutes);

      const profile: ChildProfile = {
        userId,
        childName: childName.trim(),
        age,
        birthDate,
        gender: gender ?? 'boy',
        avatarId: DEFAULT_AVATAR_ID,
        voice: DEFAULT_VOICE,
        tone,
        scheduledTime: wakeTime,
        bedtime,
        activityStack: morningActivityStack,
        stepTimes: morningStepTimes,
        answers,
        totalStarsEarned: 0,
        updatedAt: Date.now(),
      };

      const morningRoutine: Routine = {
        id: 'morning',
        userId,
        childName: profile.childName,
        childAge: age,
        avatarId: DEFAULT_AVATAR_ID,
        scheduledTime: morningStepTimes[0],
        activityStack: morningActivityStack,
        stepTimes: morningStepTimes,
        tone,
        voice: DEFAULT_VOICE,
      };
      const eveningRoutine: Routine = {
        id: 'evening',
        userId,
        childName: profile.childName,
        childAge: age,
        avatarId: DEFAULT_AVATAR_ID,
        scheduledTime: eveningStepTimes[0],
        activityStack: eveningActivityStack,
        stepTimes: eveningStepTimes,
        tone,
        voice: DEFAULT_VOICE,
      };

      await saveChildProfile(profile);
      await saveUserProfileDoc(profile);

      const morningCreated = await saveRoutineIfMissing(morningRoutine);
      const eveningCreated = await saveRoutineIfMissing(eveningRoutine);
      for (const [created, routine] of [
        [morningCreated, morningRoutine],
        [eveningCreated, eveningRoutine],
      ] as const) {
        if (!created) continue;
        const notificationId = await scheduleRoutineNotification(routine);
        const routineWithNotif: Routine = { ...routine, notificationId };
        await saveRoutine(routineWithNotif);
      }
      // The paywall's purchase/restore buttons sit behind the parental gate (math until the parent
      // picks their own lock method the first time they open Settings or Profile).
      const isPaid = await getPaidStatus();
      router.replace(isPaid
        ? { pathname: '/loading', params: { mode: 'generating_experience' } }
        : '/paywall');
    } catch (err) {
      console.warn('[Questionnaire] failed to save:', err);
      Alert.alert('Save failed', 'Could not save setup. Please try again.');
      setSaving(false);
    }
  }, [age, birthDate, answers, childName, gender, saving, wakeTime, bedtime]);

  return (
    <PageBackground variant="clouds">
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Header */}
        <View style={styles.headerPad}>
          <InPageHeader title="Setup Questionnaire" onBack={goBack} />
        </View>

          {!showFinal && (
            <View style={styles.progressWrap}>
              <View style={styles.dotsRow}>
                {Array.from({ length: QUESTION_STEP_COUNT }).map((_, index) => {
                  const active = index === stepIndex;
                  const done = index < stepIndex;
                  return (
                    <React.Fragment key={index}>
                      {index > 0 && <View style={styles.dotConnector} />}
                      <View
                        style={[styles.dot, active && styles.dotActive, done && styles.dotDone]}
                      />
                    </React.Fragment>
                  );
                })}
              </View>
              <Text style={styles.progressLabel}>
                {stepIndex + 1} of {QUESTION_STEP_COUNT}
              </Text>
            </View>
          )}

          {/* Body */}
          {showFinal ? (
            <FinalCard name={displayName} saving={saving} onStart={saveQuestionnaire} />
          ) : (
            <View style={styles.cardWrap}>
              <View style={styles.card}>
                <ScrollView
                  style={styles.cardBody}
                  contentContainerStyle={styles.cardScroll}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                >
                  {stepIndex === 0 && (
                    <NameAgeStep
                      childName={childName}
                      onChangeName={setChildName}
                      gender={gender}
                      onChangeGender={setGender}
                      birthDate={birthDate}
                      age={age}
                      onChangeBirthDate={setBirthDate}
                    />
                  )}

                  {stepIndex === 1 && (
                    <SelectStep
                      title="Where do mornings usually get stuck?"
                      hint="Pick all that apply"
                      options={MORNING_STUCK_OPTIONS}
                      selected={answers.stuckPoints ?? []}
                      multi
                      onSelect={(key) =>
                        setAnswers((a) => ({
                          ...a,
                          stuckPoints: toggleMulti(a.stuckPoints, key, 'everything_negotiation'),
                        }))
                      }
                    />
                  )}

                  {stepIndex === 2 && (
                    <SelectStep
                      title={`When ${displayName} is dragging their feet, what helps most?`}
                      options={MOTIVATION_OPTIONS}
                      selected={answers.motivationStyle ? [answers.motivationStyle] : []}
                      onSelect={(key) => setAnswers((a) => ({ ...a, motivationStyle: key }))}
                    />
                  )}

                  {stepIndex === 3 && (
                    <SelectStep
                      title={`Which activities does ${displayName} already handle like a pro?`}
                      hint="Pick all that apply"
                      options={MASTERED_OPTIONS}
                      selected={answers.masteredTasks ?? []}
                      multi
                      onSelect={(key) =>
                        setAnswers((a) => ({
                          ...a,
                          masteredTasks: toggleMulti(a.masteredTasks, key, 'none_yet'),
                        }))
                      }
                    />
                  )}

                  {stepIndex === 4 && (
                    <SelectStep
                      title={`How much help does ${displayName} usually need in the morning?`}
                      options={HELP_OPTIONS}
                      selected={answers.helpLevel ? [answers.helpLevel] : []}
                      onSelect={(key) => setAnswers((a) => ({ ...a, helpLevel: key }))}
                    />
                  )}

                  {stepIndex === 5 && (
                    <SelectStep
                      title={`What's ${displayName}'s natural morning pace?`}
                      options={SPEED_OPTIONS}
                      selected={answers.morningSpeed ? [answers.morningSpeed] : []}
                      onSelect={(key) => setAnswers((a) => ({ ...a, morningSpeed: key }))}
                    />
                  )}

                  {stepIndex === 6 && (
                    <ScheduleStep
                      name={displayName}
                      wakeTime={wakeTime}
                      onChangeWake={setWakeTime}
                      bedtime={bedtime}
                      onChangeBedtime={setBedtime}
                    />
                  )}
                </ScrollView>
                <View style={styles.grassScene} pointerEvents="none">
                  <Image
            source={grassSource}
            style={styles.grass}
            resizeMode="stretch"
            onError={() => retryLocalImage(GRASS)}
          />
                </View>
              </View>

              <TouchableOpacity
                style={[styles.continueButton, !canContinue && styles.continueButtonDisabled]}
                onPress={handleContinue}
                disabled={!canContinue}
                activeOpacity={0.85}
              >
                <Text style={styles.continueText}>Continue</Text>
                <Text style={styles.continueArrow}>→</Text>
              </TouchableOpacity>
            </View>
          )}
        </KeyboardAvoidingView>
    </PageBackground>
  );
}

function NameAgeStep({
  childName,
  onChangeName,
  gender,
  onChangeGender,
  birthDate,
  age,
  onChangeBirthDate,
}: {
  childName: string;
  onChangeName: (value: string) => void;
  gender: ChildGender | null;
  onChangeGender: (value: ChildGender) => void;
  birthDate: string;
  age: number;
  onChangeBirthDate: (value: string) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const [draftDate, setDraftDate] = useState(() => new Date(`${birthDate}T00:00:00`));

  const minDate = useMemo(() => new Date(`${isoDateYearsAgo(MAX_AGE + 1)}T00:00:00`), []);
  const maxDate = useMemo(() => new Date(`${isoDateYearsAgo(MIN_AGE)}T00:00:00`), []);

  const openPicker = useCallback(() => {
    setDraftDate(new Date(`${birthDate}T00:00:00`));
    setShowPicker(true);
  }, [birthDate]);

  const handleChange = useCallback(
    (event: DateTimePickerEvent, selectedDate?: Date) => {
      if (Platform.OS === 'android') {
        setShowPicker(false);
        if (event.type === 'set' && selectedDate) {
          onChangeBirthDate(getTodayISO(selectedDate));
        }
        return;
      }
      if (selectedDate) setDraftDate(selectedDate);
    },
    [onChangeBirthDate]
  );

  const confirmIOSDate = useCallback(() => {
    onChangeBirthDate(getTodayISO(draftDate));
    setShowPicker(false);
  }, [draftDate, onChangeBirthDate]);

  return (
    <View>
      <Text style={styles.cardTitle}>
        <Text style={styles.heartIcon}>💙 </Text>
        Hi! Let&apos;s get to know your child
      </Text>

      <Text style={styles.fieldLabel}>What&apos;s their name?</Text>
      <View style={styles.inputRow}>
        <Text style={styles.inputIcon}>👤</Text>
        <TextInput
          value={childName}
          onChangeText={onChangeName}
          style={styles.input}
          placeholder="Name"
          placeholderTextColor="#9CB8B8"
          autoCapitalize="words"
          returnKeyType="done"
          maxLength={MAX_CHILD_NAME_LENGTH}
        />
      </View>

      <Text style={[styles.fieldLabel, { marginTop: vs(22) }]}>Boy or girl?</Text>
      <View style={styles.genderRow} accessibilityRole="radiogroup">
        {GENDER_OPTIONS.map((option) => {
          const active = gender === option.key;
          return (
            <TouchableOpacity
              key={option.key}
              style={[styles.option, styles.genderOption, active && styles.optionSelected]}
              onPress={() => onChangeGender(option.key)}
              activeOpacity={0.85}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
            >
              <Text style={styles.inputIcon}>{option.emoji}</Text>
              <Text style={[styles.optionLabel, active && styles.optionLabelSelected]}>
                {option.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <Text style={[styles.fieldLabel, { marginTop: vs(22) }]}>How old are they?</Text>
      <TouchableOpacity style={styles.inputRow} onPress={openPicker} activeOpacity={0.8}>
        <Text style={styles.inputIcon}>📅</Text>
        <Text style={styles.input} numberOfLines={1}>
          {formatBirthDate(birthDate)}
        </Text>
        <View style={styles.ageBadge}>
          <Text style={styles.ageBadgeText}>{age} yrs</Text>
        </View>
      </TouchableOpacity>

      {showPicker && Platform.OS === 'android' && (
        <DateTimePicker
          value={draftDate}
          mode="date"
          display="default"
          maximumDate={maxDate}
          minimumDate={minDate}
          onChange={handleChange}
        />
      )}

      {Platform.OS === 'ios' && (
        <Modal
          transparent
          animationType="fade"
          visible={showPicker}
          onRequestClose={() => setShowPicker(false)}
        >
          <TouchableOpacity
            style={styles.pickerOverlay}
            activeOpacity={1}
            onPress={() => setShowPicker(false)}
          >
            <TouchableOpacity style={styles.pickerSheet} activeOpacity={1} onPress={() => {}}>
              <DateTimePicker
                value={draftDate}
                mode="date"
                display="spinner"
                maximumDate={maxDate}
                minimumDate={minDate}
                onChange={handleChange}
              />
              <TouchableOpacity style={styles.pickerDoneButton} onPress={confirmIOSDate}>
                <Text style={styles.pickerDoneText}>Done</Text>
              </TouchableOpacity>
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>
      )}

      <View style={styles.helperRow}>
        <Text style={styles.heartIconSmall}>💙</Text>
        <Text style={styles.helperText}>
          This helps Kido Coach personalize the experience for your child
        </Text>
      </View>
    </View>
  );
}

function SelectStep<T extends string>({
  title,
  hint,
  options,
  selected,
  multi = false,
  onSelect,
}: {
  title: string;
  hint?: string;
  options: Option<T>[];
  selected: T[];
  multi?: boolean;
  onSelect: (key: T) => void;
}) {
  return (
    <View>
      <Text style={[styles.cardTitle, hint ? styles.cardTitleWithHint : null]}>{title}</Text>
      {hint ? <Text style={styles.selectHint}>{hint}</Text> : null}
      <View style={styles.optionsList} accessibilityRole={multi ? undefined : 'radiogroup'}>
        {options.map((option) => {
          const active = selected.includes(option.key);
          return (
            <TouchableOpacity
              key={option.key}
              style={[styles.option, active && styles.optionSelected]}
              onPress={() => onSelect(option.key)}
              activeOpacity={0.85}
              accessibilityRole={multi ? 'checkbox' : 'radio'}
              accessibilityState={{ checked: active }}
            >
              <View
                style={[
                  styles.radio,
                  multi && styles.checkbox,
                  active && styles.radioSelected,
                  active && multi && styles.checkboxSelected,
                ]}
              >
                {active && (multi ? <Text style={styles.checkmark}>✓</Text> : <View style={styles.radioInner} />)}
              </View>
              <Text style={[styles.optionLabel, active && styles.optionLabelSelected]}>
                {option.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function TimeChips({
  options,
  selected,
  onSelect,
}: {
  options: string[];
  selected: string;
  onSelect: (time: string) => void;
}) {
  return (
    <View style={styles.timeChips} accessibilityRole="radiogroup">
      {options.map((time) => {
        const active = time === selected;
        return (
          <TouchableOpacity
            key={time}
            style={[styles.timeChip, active && styles.optionSelected]}
            onPress={() => onSelect(time)}
            activeOpacity={0.85}
            accessibilityRole="radio"
            accessibilityState={{ checked: active }}
          >
            <Text style={[styles.timeChipLabel, active && styles.optionLabelSelected]}>
              {formatTime12h(time)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function ScheduleStep({
  name,
  wakeTime,
  onChangeWake,
  bedtime,
  onChangeBedtime,
}: {
  name: string;
  wakeTime: string;
  onChangeWake: (time: string) => void;
  bedtime: string;
  onChangeBedtime: (time: string) => void;
}) {
  return (
    <View>
      <Text style={[styles.cardTitle, styles.cardTitleWithHint]}>
        What does {name}&apos;s day look like?
      </Text>
      <Text style={styles.selectHint}>
        Mornings start when {name} wakes up, and evenings wrap up by bedtime
      </Text>

      <Text style={styles.fieldLabel}>☀️ Wakes up at</Text>
      <TimeChips
        options={withCurrentTime(WAKE_TIME_OPTIONS, wakeTime)}
        selected={wakeTime}
        onSelect={onChangeWake}
      />

      <Text style={[styles.fieldLabel, { marginTop: vs(22) }]}>🌙 Bedtime</Text>
      <TimeChips
        options={withCurrentTime(BEDTIME_OPTIONS, bedtime)}
        selected={bedtime}
        onSelect={onChangeBedtime}
      />

      <View style={styles.helperRow}>
        <Text style={styles.heartIconSmall}>💙</Text>
        <Text style={styles.helperText}>
          You can fine-tune each activity&apos;s time later from Add Routine
        </Text>
      </View>
    </View>
  );
}

function FinalCard({
  name,
  saving,
  onStart,
}: {
  name: string;
  saving: boolean;
  onStart: () => void;
}) {
  const grassSource = useLocalImage(GRASS);

  return (
    <View style={styles.cardWrap}>
      <View style={styles.card}>
        <View style={styles.finalContent}>
          <Text style={styles.finalEmoji}>🎉</Text>
          <Text style={styles.finalTitle}>Awesome!</Text>
          <Text style={styles.finalBody}>
            Becky is building a routine just for{' '}
            <Text style={styles.finalName}>{name}</Text>, focused on the moments that get stuck,
            with plenty of time left for the things they love.
          </Text>
          <Text style={styles.finalCta}>Let&apos;s go!</Text>
        </View>
        <View style={styles.grassScene} pointerEvents="none">
          <Image
            source={grassSource}
            style={styles.grass}
            resizeMode="stretch"
            onError={() => retryLocalImage(GRASS)}
          />
        </View>
      </View>

      <TouchableOpacity
        style={[styles.continueButton, saving && styles.continueButtonDisabled]}
        onPress={onStart}
        disabled={saving}
        activeOpacity={0.85}
      >
        <Text style={styles.continueText}>{saving ? 'Setting up…' : "Let's go!"}</Text>
        {!saving && <Text style={styles.continueArrow}>→</Text>}
      </TouchableOpacity>
    </View>
  );
}

const TEAL_DARK = colors.teal;
const TEAL = '#3FA9A0';

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  headerPad: {
    paddingHorizontal: s(18),
    paddingTop: vs(6),
  },
  progressWrap: {
    alignItems: 'center',
    marginTop: vs(14),
    marginBottom: vs(8),
  },
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  dot: {
    width: s(16),
    height: s(16),
    borderRadius: ms(8),
    borderWidth: 2,
    borderColor: colors.white,
    backgroundColor: 'transparent',
  },
  dotActive: {
    backgroundColor: TEAL_DARK,
    borderColor: TEAL_DARK,
  },
  dotDone: {
    backgroundColor: colors.white,
  },
  dotConnector: {
    width: s(26),
    height: s(2),
    backgroundColor: colors.white,
  },
  progressLabel: {
    marginTop: vs(10),
    fontSize: fs(15),
    fontWeight: '700',
    color: TEAL_DARK,
  },
  cardWrap: {
    flex: 1,
    paddingHorizontal: s(18),
    paddingTop: vs(12),
    paddingBottom: vs(12),
  },
  card: {
    flex: 1,
    flexDirection: 'column',
    backgroundColor: colors.white,
    borderRadius: ms(28),
    overflow: 'hidden',
    shadowColor: '#0B5757',
    shadowOpacity: 0.1,
    shadowRadius: ms(16),
    shadowOffset: { width: s(0), height: vs(8) },
    elevation: 4,
  },
  cardScroll: {
    padding: ms(26),
    paddingBottom: vs(190),
  },
  cardBody: {
    flex: 1,
    zIndex: 1,
  },
  grass: {
    width: '100%',
    height: '100%',
  },
  grassScene: {
    position: 'absolute',
    left: s(0),
    right: s(0),
    bottom: vs(0),
    height: s(190),
    width: '100%',
    zIndex: 0,
  },
  cardTitle: {
    fontSize: fs(26),
    lineHeight: fs(32),
    fontWeight: '800',
    color: TEAL_DARK,
    marginBottom: vs(24),
  },
  cardTitleWithHint: {
    marginBottom: vs(6),
  },
  selectHint: {
    fontSize: fs(14),
    color: '#5C7A78',
    fontWeight: '600',
    marginBottom: vs(18),
  },
  heartIcon: {
    fontSize: fs(22),
  },
  fieldLabel: {
    fontSize: fs(16),
    fontWeight: '700',
    color: TEAL_DARK,
    marginBottom: vs(10),
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    borderRadius: ms(16),
    borderWidth: 1.5,
    borderColor: '#D6ECEC',
    paddingHorizontal: s(16),
    height: s(60),
  },
  inputIcon: {
    fontSize: fs(20),
    marginRight: s(12),
  },
  input: {
    flex: 1,
    fontSize: fs(20),
    color: '#21413F',
    fontWeight: '600',
  },
  ageBadge: {
    backgroundColor: '#EAF6F6',
    borderRadius: ms(10),
    paddingHorizontal: s(10),
    paddingVertical: vs(5),
  },
  ageBadgeText: {
    fontSize: fs(14),
    fontWeight: '700',
    color: TEAL_DARK,
  },
  pickerOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: colors.overlayLight,
  },
  pickerSheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: ms(20),
    borderTopRightRadius: ms(20),
    paddingTop: vs(8),
    paddingBottom: vs(24),
    paddingHorizontal: s(16),
  },
  pickerDoneButton: {
    marginTop: vs(8),
    backgroundColor: TEAL_DARK,
    borderRadius: ms(14),
    paddingVertical: vs(12),
    alignItems: 'center',
  },
  pickerDoneText: {
    color: colors.white,
    fontSize: fs(16),
    fontWeight: '700',
  },
  helperRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: vs(26),
    gap: s(8),
  },
  heartIconSmall: {
    fontSize: fs(16),
  },
  helperText: {
    flex: 1,
    fontSize: fs(14),
    lineHeight: fs(20),
    color: '#5C7A78',
    fontWeight: '500',
  },
  optionsList: {
    gap: s(12),
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    borderRadius: ms(16),
    borderWidth: 1.5,
    borderColor: '#D6ECEC',
    paddingHorizontal: s(16),
    paddingVertical: vs(16),
    gap: s(14),
  },
  genderRow: {
    flexDirection: 'row',
    gap: s(12),
  },
  genderOption: {
    flex: 1,
    paddingVertical: vs(12),
    gap: s(8),
  },
  optionSelected: {
    borderColor: TEAL,
    backgroundColor: '#EAF7F6',
  },
  radio: {
    width: s(24),
    height: s(24),
    borderRadius: ms(12),
    borderWidth: 2,
    borderColor: '#C2DDDD',
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: {
    borderColor: TEAL,
  },
  radioInner: {
    width: s(12),
    height: s(12),
    borderRadius: ms(6),
    backgroundColor: TEAL,
  },
  checkbox: {
    borderRadius: ms(7),
  },
  checkboxSelected: {
    backgroundColor: TEAL,
  },
  checkmark: {
    color: colors.white,
    fontSize: fs(14),
    fontWeight: '800',
    lineHeight: fs(16),
  },
  timeChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: s(10),
  },
  timeChip: {
    width: '22%',
    flexGrow: 1,
    alignItems: 'center',
    backgroundColor: colors.white,
    borderRadius: ms(14),
    borderWidth: 1.5,
    borderColor: '#D6ECEC',
    paddingVertical: vs(12),
  },
  timeChipLabel: {
    fontSize: fs(15),
    color: '#3C5654',
    fontWeight: '600',
  },
  optionLabel: {
    flex: 1,
    fontSize: fs(16),
    color: '#3C5654',
    fontWeight: '600',
  },
  optionLabelSelected: {
    color: TEAL_DARK,
    fontWeight: '700',
  },
  continueButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: TEAL,
    borderRadius: ms(30),
    height: s(60),
    marginTop: vs(16),
    gap: s(12),
    shadowColor: TEAL_DARK,
    shadowOpacity: 0.25,
    shadowRadius: ms(10),
    shadowOffset: { width: s(0), height: vs(4) },
    elevation: 3,
  },
  continueButtonDisabled: {
    backgroundColor: '#A9D2CF',
    shadowOpacity: 0,
  },
  continueText: {
    color: colors.white,
    fontSize: fs(19),
    fontWeight: '800',
  },
  continueArrow: {
    color: colors.white,
    fontSize: fs(20),
    fontWeight: '800',
  },
  finalContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: ms(32),
    paddingBottom: vs(190),
  },
  finalEmoji: {
    fontSize: fs(56),
    marginBottom: vs(16),
  },
  finalTitle: {
    fontSize: fs(30),
    fontWeight: '800',
    color: TEAL_DARK,
    marginBottom: vs(16),
  },
  finalBody: {
    fontSize: fs(18),
    lineHeight: fs(26),
    color: '#3C5654',
    textAlign: 'center',
    fontWeight: '500',
  },
  finalName: {
    color: TEAL_DARK,
    fontWeight: '800',
  },
  finalCta: {
    marginTop: vs(20),
    fontSize: fs(20),
    fontWeight: '800',
    color: TEAL,
  },
});
