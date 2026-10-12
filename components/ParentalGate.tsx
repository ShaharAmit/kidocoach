import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { colors, fs, ms, s, vs } from '../theme';
import PinPad from './PinPad';
import { NewPinEntry } from './ParentLockSetup';
import {
  getParentalLockMethod,
  getPinLockoutRemainingMs,
  PIN_LENGTH,
  setParentalLock,
  verifyParentalPin,
} from '../services/parentalLock';
import { newGateChallenge, newRecoveryChallenge } from '../utils/parentalChallenge';

/**
 * Parental gate for App Store Kids Category (guideline 1.3): an adult-level challenge that must
 * be passed before purchases, links that leave the app, and parent-only areas. The parent picks
 * the unlock method (PIN or math) the first time they open Settings or Profile; until then, and
 * whenever the saved lock can't be read, math is used. There is no grace window: every request challenges.
 *
 * "Forgot PIN?" is parent-initiated (failed tries only lock entry) and harder than the math gate:
 * a wait, then RECOVERY_QUESTIONS harder questions in a row, then a new PIN must be set. A child
 * who gets through can't bypass silently — the parent's old PIN stops working.
 */

const RECOVERY_WAIT_MS = 30_000;
const RECOVERY_QUESTIONS = 2;

type GateMode = 'pin' | 'math' | 'recover-wait' | 'recover-math' | 'recover-pin';
type Presenter = (reason: string | undefined) => Promise<boolean>;
let presenter: Presenter | null = null;

/** Resolves true only after an adult passes the gate. Fails closed if the host isn't mounted. */
export function requestParentalGate(reason?: string): Promise<boolean> {
  return presenter ? presenter(reason) : Promise.resolve(false);
}

interface PendingGate {
  reason?: string;
  resolve: (passed: boolean) => void;
}

/** Mount once at the app root. */
export function ParentalGateHost() {
  const [pending, setPending] = useState<PendingGate | null>(null);
  const [mode, setMode] = useState<GateMode>('math');
  const [challenge, setChallenge] = useState(newGateChallenge);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [lockedUntil, setLockedUntil] = useState(0);
  const [recoverUntil, setRecoverUntil] = useState(0);
  const [recoverSolved, setRecoverSolved] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [verifying, setVerifying] = useState(false);
  const [savingPin, setSavingPin] = useState(false);
  const pendingRef = useRef<PendingGate | null>(null);
  const requestIdRef = useRef(0);

  const settle = useCallback((passed: boolean) => {
    pendingRef.current?.resolve(passed);
    pendingRef.current = null;
    setPending(null);
  }, []);

  useEffect(() => {
    presenter = (reason) =>
      new Promise<boolean>((resolve) => {
        pendingRef.current?.resolve(false);
        pendingRef.current = null;
        setPending(null);
        const requestId = ++requestIdRef.current;
        const next: PendingGate = { reason, resolve };

        const open = (nextMode: 'pin' | 'math') => {
          if (requestId !== requestIdRef.current) return resolve(false);
          pendingRef.current = next;
          setInput('');
          setError('');
          setRecoverSolved(0);
          setMode(nextMode);
          setNow(Date.now());
          if (nextMode === 'math') setChallenge(newGateChallenge());
          setPending(next);
        };

        void (async () => {
          const method = await getParentalLockMethod();
          if (requestId !== requestIdRef.current) return resolve(false);
          if (method === 'pin') {
            const remaining = await getPinLockoutRemainingMs();
            setLockedUntil(remaining > 0 ? Date.now() + remaining : 0);
            open('pin');
            return;
          }
          open('math');
        })().catch(() => open('math'));
      });
    return () => {
      presenter = null;
      requestIdRef.current += 1;
      pendingRef.current?.resolve(false);
      pendingRef.current = null;
    };
  }, []);

  const locked = mode === 'pin' && lockedUntil > now;
  const recoverWaiting = mode === 'recover-wait' && recoverUntil > now;
  const tickUntil = mode === 'recover-wait' ? recoverUntil : mode === 'pin' ? lockedUntil : 0;
  useEffect(() => {
    if (!pending || tickUntil <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [pending, tickUntil]);

  const startRecovery = () => {
    setMode('recover-wait');
    setRecoverUntil(Date.now() + RECOVERY_WAIT_MS);
    setRecoverSolved(0);
    setNow(Date.now());
    setInput('');
    setError('');
  };

  const startRecoveryQuestions = () => {
    setMode('recover-math');
    setChallenge(newRecoveryChallenge());
    setInput('');
    setError('');
  };

  const submitMath = () => {
    const correct = Number.parseInt(input.trim(), 10) === challenge.answer;
    setInput('');
    if (mode === 'recover-math') {
      if (!correct) {
        setRecoverSolved(0);
        setChallenge(newRecoveryChallenge());
        setError('That is not right. Please start again with the new question.');
        return;
      }
      setError('');
      const solved = recoverSolved + 1;
      if (solved >= RECOVERY_QUESTIONS) {
        setMode('recover-pin');
        return;
      }
      setRecoverSolved(solved);
      setChallenge(newRecoveryChallenge());
      return;
    }
    if (correct) {
      settle(true);
      return;
    }
    setChallenge(newGateChallenge());
    setError('That is not right. Please try the new question.');
  };

  const changePin = async (value: string) => {
    setInput(value);
    setError('');
    if (value.length < PIN_LENGTH || verifying) return;
    setVerifying(true);
    try {
      const result = await verifyParentalPin(value);
      if (result.status === 'ok') {
        settle(true);
        return;
      }
      setInput('');
      if (result.status === 'locked') {
        setLockedUntil(Date.now() + result.remainingMs);
        setNow(Date.now());
      } else {
        setError(`Wrong PIN. ${result.attemptsLeft} ${result.attemptsLeft === 1 ? 'try' : 'tries'} left.`);
      }
    } finally {
      setVerifying(false);
    }
  };

  const saveNewPin = async (pin: string) => {
    setSavingPin(true);
    setError('');
    try {
      const { backedUp } = await setParentalLock('pin', pin);
      setLockedUntil(0);
      if (!backedUp) {
        Alert.alert('Saved on this device', 'We could not back up the new PIN to your account. It still works on this device.');
      }
      settle(true);
    } catch (err) {
      console.warn('[ParentalGate] PIN reset failed:', err);
      setError('Could not save the new PIN. Please try again.');
    } finally {
      setSavingPin(false);
    }
  };

  const lockSeconds = Math.ceil(Math.max(0, lockedUntil - now) / 1000);
  const recoverSeconds = Math.ceil(Math.max(0, recoverUntil - now) / 1000);
  const recovering = mode.startsWith('recover-');
  const showsMathInput = mode === 'math' || mode === 'recover-math';

  return (
    <Modal visible={pending !== null} transparent animationType="fade" onRequestClose={() => settle(false)}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.card} accessibilityViewIsModal>
          <Text style={styles.title}>{recovering ? 'Reset parent PIN' : 'Parents only'}</Text>
          {!recovering ? <Text style={styles.body}>{pending?.reason ?? 'Ask a grown-up to continue.'}</Text> : null}

          {mode === 'pin' ? (
            <>
              <Text style={styles.question}>Enter your parent PIN</Text>
              <PinPad value={input} onChange={(value) => void changePin(value)} disabled={locked || verifying} />
              {locked ? (
                <Text accessibilityRole="alert" style={styles.error}>
                  Too many wrong tries. Try again in {lockSeconds}s.
                </Text>
              ) : null}
              <TouchableOpacity onPress={startRecovery}>
                <Text style={styles.link}>Forgot PIN?</Text>
              </TouchableOpacity>
            </>
          ) : null}

          {mode === 'recover-wait' ? (
            <>
              <Text style={styles.body}>
                To keep kids out, a PIN reset takes a moment. Next you will answer {RECOVERY_QUESTIONS} harder
                questions in a row, then choose a new PIN.
              </Text>
              <Text style={styles.question} accessibilityLiveRegion="polite">
                {recoverWaiting ? `Reset unlocks in ${recoverSeconds}s` : 'Ready when you are.'}
              </Text>
            </>
          ) : null}

          {showsMathInput ? (
            <>
              {mode === 'recover-math' ? (
                <Text style={styles.body}>Question {recoverSolved + 1} of {RECOVERY_QUESTIONS}</Text>
              ) : null}
              <Text style={styles.question}>{challenge.question}</Text>
              <TextInput
                value={input}
                onChangeText={(value) => setInput(value.replace(/[^0-9]/g, ''))}
                keyboardType="number-pad"
                maxLength={3}
                autoFocus
                style={styles.input}
                accessibilityLabel="Answer"
              />
            </>
          ) : null}

          {mode === 'recover-pin' ? (
            <NewPinEntry
              saving={savingPin}
              onSubmit={(pin) => void saveNewPin(pin)}
              backLabel="Cancel"
              onBack={() => settle(false)}
              style={styles.newPin}
            />
          ) : null}

          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          {mode !== 'recover-pin' ? (
            <View style={styles.row}>
              <TouchableOpacity style={styles.secondary} onPress={() => settle(false)}>
                <Text style={styles.secondaryText}>Cancel</Text>
              </TouchableOpacity>
              {showsMathInput ? (
                <TouchableOpacity style={[styles.primary, !input && styles.disabled]} disabled={!input} onPress={submitMath}>
                  <Text style={styles.primaryText}>Continue</Text>
                </TouchableOpacity>
              ) : null}
              {mode === 'recover-wait' ? (
                <TouchableOpacity
                  style={[styles.primary, recoverWaiting && styles.disabled]}
                  disabled={recoverWaiting}
                  onPress={startRecoveryQuestions}
                >
                  <Text style={styles.primaryText}>Continue</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.55)', justifyContent: 'center', padding: s(24) },
  card: { backgroundColor: '#FFF', borderRadius: ms(24), padding: s(24), gap: vs(12), maxWidth: 480, width: '100%', alignSelf: 'center' },
  title: { color: colors.textInk, fontSize: fs(22), fontWeight: '800' },
  body: { color: colors.textSlate, fontSize: fs(15), lineHeight: fs(22) },
  question: { color: colors.textInk, fontSize: fs(18), fontWeight: '700', marginTop: vs(4) },
  input: { borderWidth: 1, borderColor: '#CBD5E1', borderRadius: ms(12), padding: s(14), fontSize: fs(20), color: colors.textInk, textAlign: 'center' },
  error: { color: '#B42318', fontSize: fs(14) },
  link: { color: colors.primary, fontSize: fs(15), fontWeight: '700', textAlign: 'center', paddingVertical: vs(4) },
  row: { flexDirection: 'row', gap: s(12), marginTop: vs(4) },
  primary: { flex: 1, backgroundColor: colors.primary, padding: s(14), borderRadius: ms(14), alignItems: 'center' },
  primaryText: { color: '#FFF', fontWeight: '700', fontSize: fs(16) },
  secondary: { flex: 1, padding: s(14), borderRadius: ms(14), alignItems: 'center', backgroundColor: '#F1F5F9' },
  secondaryText: { color: colors.textInk, fontWeight: '700', fontSize: fs(16) },
  disabled: { opacity: 0.5 },
  newPin: { flex: 0 },
});
