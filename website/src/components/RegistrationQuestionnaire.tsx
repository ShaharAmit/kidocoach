import { useState } from 'react';
import type { ChildGender, ChildProfile, QuestionnaireAnswers } from '../../../types';
import {
  BEDTIME_OPTIONS, HELP_OPTIONS, MASTERED_OPTIONS, MORNING_STUCK_OPTIONS, MOTIVATION_OPTIONS,
  SPEED_OPTIONS, WAKE_TIME_OPTIONS, toggleMulti, type QuestionnaireOption,
} from '../../../utils/questionnaire';
import { calculateAgeFromISO, isoDateYearsAgo } from '../../../utils/date';
import { isValidChildName } from '../../../utils/nameToken';
import { isMorningTime } from '../../../utils/timeOfDay';
import { saveRegistration } from '../services/registration';

function Choices<T extends string>({ title, options, selected, onSelect, multi = false }: {
  title: string; options: QuestionnaireOption<T>[]; selected: T[]; onSelect: (key: T) => void; multi?: boolean;
}) {
  return <fieldset><legend>{title}</legend>
    {multi && <p>Pick all that apply</p>}
    {options.map((option) => <label className="questionnaire-choice" key={option.key}>
      <input type={multi ? 'checkbox' : 'radio'} name={title} checked={selected.includes(option.key)}
        onChange={() => onSelect(option.key)} />{option.label}
    </label>)}
  </fieldset>;
}

export default function RegistrationQuestionnaire({ uid, onSaved }: {
  uid: string; onSaved: (profile: ChildProfile) => void;
}) {
  const [step, setStep] = useState(0);
  const [childName, setChildName] = useState('');
  const [gender, setGender] = useState<ChildGender | null>(null);
  const [birthDate, setBirthDate] = useState(() => isoDateYearsAgo(6));
  const [answers, setAnswers] = useState<QuestionnaireAnswers>({});
  const [wakeTime, setWakeTime] = useState('07:00');
  const [bedtime, setBedtime] = useState('20:00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const age = calculateAgeFromISO(birthDate);
  const name = childName.trim() || 'your child';
  const valid = [
    isValidChildName(childName) && gender !== null && age >= 2 && age <= 12,
    Boolean(answers.stuckPoints?.length), Boolean(answers.motivationStyle),
    Boolean(answers.masteredTasks?.length), Boolean(answers.helpLevel), Boolean(answers.morningSpeed),
    Boolean(wakeTime && bedtime && isMorningTime(wakeTime) && !isMorningTime(bedtime)),
  ][step];

  async function save() {
    if (busy || !valid || !gender) return;
    setBusy(true);
    setError('');
    try {
      onSaved(await saveRegistration(uid, { childName, gender, birthDate, answers, wakeTime, bedtime }));
    } catch (failure) {
      console.warn('[Registration] Could not save setup:', failure);
      setError(failure instanceof Error ? failure.message : 'Could not save setup. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return <section className="subscription-card">
    <h2>Set up your child&apos;s routine</h2>
    <p>Step {step + 1} of 7 - the same setup as the mobile app.</p>
    <fieldset disabled={busy}>
      {step === 0 && <>
        <label>What&apos;s their name?<input value={childName} maxLength={30}
          onChange={(event) => setChildName(event.target.value)} autoComplete="off" /></label>
        <Choices title="Boy or girl?" options={[{ key: 'boy', label: 'Boy' }, { key: 'girl', label: 'Girl' }]}
          selected={gender ? [gender] : []} onSelect={setGender} />
        <label>Date of birth<input type="date" value={birthDate} onChange={(event) => setBirthDate(event.target.value)} /></label>
        <p>Ages 2-12</p>
      </>}
      {step === 1 && <Choices title="Where do mornings usually get stuck?" options={MORNING_STUCK_OPTIONS}
        multi selected={answers.stuckPoints ?? []} onSelect={(key) => setAnswers((a) => ({
          ...a, stuckPoints: toggleMulti(a.stuckPoints, key, 'everything_negotiation'),
        }))} />}
      {step === 2 && <Choices title={`When ${name} is dragging their feet, what helps most?`} options={MOTIVATION_OPTIONS}
        selected={answers.motivationStyle ? [answers.motivationStyle] : []}
        onSelect={(key) => setAnswers((a) => ({ ...a, motivationStyle: key }))} />}
      {step === 3 && <Choices title={`Which activities does ${name} already handle like a pro?`} options={MASTERED_OPTIONS}
        multi selected={answers.masteredTasks ?? []} onSelect={(key) => setAnswers((a) => ({
          ...a, masteredTasks: toggleMulti(a.masteredTasks, key, 'none_yet'),
        }))} />}
      {step === 4 && <Choices title={`How much help does ${name} usually need in the morning?`} options={HELP_OPTIONS}
        selected={answers.helpLevel ? [answers.helpLevel] : []}
        onSelect={(key) => setAnswers((a) => ({ ...a, helpLevel: key }))} />}
      {step === 5 && <Choices title={`What's ${name}'s natural morning pace?`} options={SPEED_OPTIONS}
        selected={answers.morningSpeed ? [answers.morningSpeed] : []}
        onSelect={(key) => setAnswers((a) => ({ ...a, morningSpeed: key }))} />}
      {step === 6 && <>
        <label>Wake-up time<input type="time" list="wake-times" value={wakeTime}
          onChange={(event) => setWakeTime(event.target.value)} /></label>
        <datalist id="wake-times">{WAKE_TIME_OPTIONS.map((time) => <option key={time} value={time} />)}</datalist>
        <label>Bedtime<input type="time" list="bed-times" value={bedtime}
          onChange={(event) => setBedtime(event.target.value)} /></label>
        <datalist id="bed-times">{BEDTIME_OPTIONS.map((time) => <option key={time} value={time} />)}</datalist>
        <p>Your setup and routines will sync when you sign in to the mobile app. Notifications and
          offline media are prepared on your device, not in this browser.</p>
      </>}
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {step > 0 && <button disabled={busy} onClick={() => setStep((value) => value - 1)}>Back</button>}
    <button disabled={busy || !valid} onClick={() => step === 6 ? void save() : setStep((value) => value + 1)}>
      {busy ? 'Saving setup...' : step === 6 ? "Let's go!" : 'Continue'}
    </button>
  </section>;
}
