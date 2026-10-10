import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { colors, fs, ms, s, vs } from '../theme';

/**
 * Parental gate for App Store Kids Category (guideline 1.3): an adult-level challenge that must
 * be passed before purchases, links that leave the app, and parent-only areas. The question is
 * spelled out in words so pre-readers cannot solve it by pattern-matching digits.
 */

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
/** A passed gate stays valid briefly so one parent action (e.g. Settings → Delete) isn't asked twice. */
const GATE_GRACE_MS = 60_000;

type Presenter = (reason?: string) => Promise<boolean>;
let presenter: Presenter | null = null;
let passedAt = 0;

/** Resolves true only after an adult answers correctly. Fails closed if the host isn't mounted. */
export function requestParentalGate(reason?: string): Promise<boolean> {
  if (Date.now() - passedAt < GATE_GRACE_MS) return Promise.resolve(true);
  return presenter ? presenter(reason) : Promise.resolve(false);
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function newChallenge() {
  const a = randomInt(3, 9);
  const b = randomInt(6, 9);
  return { question: `What is ${NUMBER_WORDS[a]} times ${NUMBER_WORDS[b]}?`, answer: a * b };
}

interface PendingGate {
  reason?: string;
  resolve: (passed: boolean) => void;
}

/** Mount once at the app root. */
export function ParentalGateHost() {
  const [pending, setPending] = useState<PendingGate | null>(null);
  const [challenge, setChallenge] = useState(newChallenge);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const pendingRef = useRef<PendingGate | null>(null);

  const finish = useCallback((passed: boolean) => {
    if (passed) passedAt = Date.now();
    pendingRef.current?.resolve(passed);
    pendingRef.current = null;
    setPending(null);
  }, []);

  useEffect(() => {
    presenter = (reason) =>
      new Promise<boolean>((resolve) => {
        pendingRef.current?.resolve(false);
        const next = { reason, resolve };
        pendingRef.current = next;
        setChallenge(newChallenge());
        setInput('');
        setError('');
        setPending(next);
      });
    return () => {
      presenter = null;
      pendingRef.current?.resolve(false);
      pendingRef.current = null;
    };
  }, []);

  const submit = () => {
    if (Number.parseInt(input.trim(), 10) === challenge.answer) {
      finish(true);
      return;
    }
    setChallenge(newChallenge());
    setInput('');
    setError('That is not right. Please try the new question.');
  };

  return (
    <Modal visible={pending !== null} transparent animationType="fade" onRequestClose={() => finish(false)}>
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal>
          <Text style={styles.title}>Parents only</Text>
          <Text style={styles.body}>
            {pending?.reason ?? 'Ask a grown-up to continue.'}
          </Text>
          <Text style={styles.question}>{challenge.question}</Text>
          <TextInput
            value={input}
            onChangeText={(value) => setInput(value.replace(/[^0-9]/g, ''))}
            onSubmitEditing={submit}
            keyboardType="number-pad"
            returnKeyType="done"
            maxLength={3}
            autoFocus
            style={styles.input}
            accessibilityLabel="Answer"
          />
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <View style={styles.row}>
            <TouchableOpacity style={styles.secondary} onPress={() => finish(false)}>
              <Text style={styles.secondaryText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.primary, !input && styles.disabled]} disabled={!input} onPress={submit}>
              <Text style={styles.primaryText}>Continue</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
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
  row: { flexDirection: 'row', gap: s(12), marginTop: vs(4) },
  primary: { flex: 1, backgroundColor: colors.primary, padding: s(14), borderRadius: ms(14), alignItems: 'center' },
  primaryText: { color: '#FFF', fontWeight: '700', fontSize: fs(16) },
  secondary: { flex: 1, padding: s(14), borderRadius: ms(14), alignItems: 'center', backgroundColor: '#F1F5F9' },
  secondaryText: { color: colors.textInk, fontWeight: '700', fontSize: fs(16) },
  disabled: { opacity: 0.5 },
});
