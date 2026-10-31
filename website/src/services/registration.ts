import { doc, getDocFromServer, runTransaction } from 'firebase/firestore';
import { auth, db } from './firebase';
import type { ChildGender, ChildProfile, QuestionnaireAnswers } from '../../../types';
import { parseActivityCatalog } from '../../../utils/activityCatalogModel';
import { normalizeChildProfile } from '../../../utils/childProfile';
import { composeRoutine } from '../../../utils/routineComposer';
import { scheduleFromStart, scheduleToEnd } from '../../../utils/routineSchedule';
import { calculateAgeFromISO, getTodayISO } from '../../../utils/date';
import { isValidChildName } from '../../../utils/nameToken';
import { isMorningTime } from '../../../utils/timeOfDay';
import { toneFromMotivation } from '../../../utils/questionnaire';
import { version as appVersion } from '../../../package.json';

export interface RegistrationInput {
  childName: string;
  gender: ChildGender;
  birthDate: string;
  answers: QuestionnaireAnswers;
  wakeTime: string;
  bedtime: string;
}

function assertUser(uid: string): void {
  if (auth.currentUser?.uid !== uid || auth.currentUser.isAnonymous) {
    throw new Error('Your account changed. Sign in again before saving setup.');
  }
}

export async function loadChildProfile(uid: string): Promise<ChildProfile | null> {
  assertUser(uid);
  const snapshot = await getDocFromServer(doc(db, 'users', uid));
  assertUser(uid);
  if (!snapshot.exists() || snapshot.data().childProfile === undefined) return null;
  const profile = normalizeChildProfile(snapshot.data().childProfile, uid);
  if (!profile) throw new Error('Your saved setup could not be read. Please contact support.');
  return profile;
}

export function buildRegistration(uid: string, input: RegistrationInput, catalog: unknown) {
  const age = calculateAgeFromISO(input.birthDate);
  const birth = new Date(`${input.birthDate}T00:00:00`);
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!isValidChildName(input.childName) || !/^\d{4}-\d{2}-\d{2}$/.test(input.birthDate) ||
      !Number.isFinite(birth.getTime()) || getTodayISO(birth) !== input.birthDate ||
      age < 2 || age > 12 || !['boy', 'girl'].includes(input.gender) ||
      !timePattern.test(input.wakeTime) || !isMorningTime(input.wakeTime) ||
      !timePattern.test(input.bedtime) || isMorningTime(input.bedtime) ||
      !input.answers.stuckPoints?.length || !input.answers.masteredTasks?.length ||
      !input.answers.motivationStyle || !input.answers.helpLevel || !input.answers.morningSpeed) {
    throw new Error('Complete all questionnaire answers with valid details before continuing.');
  }
  const definitions = parseActivityCatalog(catalog, { appVersion })?.definitions.filter((d) => d.selectable) ?? [];
  const segments = (['morning', 'evening'] as const).map((segment) => {
    const keys = composeRoutine(definitions, segment, age, input.answers);
    if (!keys.length) throw new Error('Could not load activities. Check your connection and try again.');
    const slots = (key: string) => definitions.find((d) => d.key === key)?.scheduleMinutes;
    const times = segment === 'morning'
      ? scheduleFromStart(input.wakeTime, keys, slots) : scheduleToEnd(input.bedtime, keys, slots);
    return {
      id: segment,
      scheduledTime: times[0],
      activities: keys.map((activityKey, order) => {
        const definition = definitions.find((d) => d.key === activityKey)!;
        return {
          activityKey, order, time: times[order],
          durationMinutes: definition.timerSeconds / 60,
          durationMode: definition.durationMode, stars: definition.stars,
        };
      }),
    };
  });
  const candidate: ChildProfile = {
    userId: uid, childName: input.childName.trim(), age, birthDate: input.birthDate,
    gender: input.gender, avatarId: 'becky', voice: 'woman', tone: toneFromMotivation(input.answers.motivationStyle),
    scheduledTime: input.wakeTime, bedtime: input.bedtime, answers: input.answers,
    activityStack: segments[0].activities.map((activity) => [activity.activityKey]),
    stepTimes: segments[0].activities.map((activity) => activity.time), totalStarsEarned: 0, updatedAt: Date.now(),
  };
  const profile = normalizeChildProfile(candidate, uid);
  if (!profile) throw new Error('Questionnaire answers are invalid. Please review your setup.');
  return { profile, segments };
}

export async function saveRegistration(uid: string, input: RegistrationInput): Promise<ChildProfile> {
  assertUser(uid);
  const catalog = await getDocFromServer(doc(db, 'catalog', 'activities'));
  const { profile, segments } = buildRegistration(uid, input, catalog.data());
  return runTransaction(db, async (tx) => {
    assertUser(uid);
    const userRef = doc(db, 'users', uid);
    const existing = await tx.get(userRef);
    const stored = existing.data()?.childProfile;
    if (stored !== undefined) {
      const saved = normalizeChildProfile(stored, uid);
      if (!saved) throw new Error('Your saved setup could not be read. Please contact support.');
      return saved;
    }
    const refs = segments.map((segment) => doc(db, 'users', uid, 'routines', segment.id));
    const snapshots = await Promise.all(refs.map((ref) => tx.get(ref)));
    assertUser(uid);
    const cloudProfile = {
      ...profile, activityStack: profile.activityStack.map((activities) => ({ activities })),
    };
    tx.set(userRef, {
      childName: profile.childName, age: profile.age, voice: profile.voice, tone: profile.tone,
      avatarId: profile.avatarId, updatedAt: profile.updatedAt,
      childProfile: JSON.parse(JSON.stringify(cloudProfile)),
    }, { mergeFields: ['childName', 'age', 'voice', 'tone', 'avatarId', 'updatedAt', 'childProfile'] });
    segments.forEach((segment, index) => {
      if (snapshots[index].exists()) return;
      tx.set(refs[index], { scheduledTime: segment.scheduledTime, updatedAt: profile.updatedAt });
      segment.activities.forEach((activity, step) => {
        tx.set(doc(db, 'users', uid, 'routines', segment.id, 'activities', `step_${step}`),
          { ...activity, updatedAt: profile.updatedAt });
      });
    });
    return profile;
  });
}
