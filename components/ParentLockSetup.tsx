import React, { useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, contentColumn, fs, ms, s, vs } from '../theme';
import PinPad from './PinPad';
import { PIN_LENGTH, setParentalLock, type ParentalLockMethod } from '../services/parentalLock';

interface ParentLockSetupProps {
  initialMethod?: ParentalLockMethod;
  doneLabel?: string;
  onDone: (method: ParentalLockMethod) => void;
  onCancel?: () => void;
}

const OPTIONS: { method: ParentalLockMethod; emoji: string; title: string; body: string }[] = [
  { method: 'pin', emoji: '🔢', title: '4-digit PIN', body: 'Quick and private. Saved on this device and backed up to your account.' },
  { method: 'math', emoji: '✖️', title: 'Math question', body: 'A multiplication question written in words. No setup needed.' },
];

interface NewPinEntryProps {
  saving: boolean;
  onSubmit: (pin: string) => void;
  backLabel?: string;
  onBack: () => void;
  style?: StyleProp<ViewStyle>;
}

/** Choose-and-confirm entry for a new PIN. Used by the setup flow and by "Forgot PIN?" recovery. */
export function NewPinEntry({ saving, onSubmit, backLabel = 'Back', onBack, style }: NewPinEntryProps) {
  const [confirming, setConfirming] = useState(false);
  const [pin, setPin] = useState('');
  const [firstPin, setFirstPin] = useState('');
  const [error, setError] = useState('');

  const changePin = (value: string) => {
    setPin(value);
    setError('');
    if (value.length < PIN_LENGTH) return;
    if (!confirming) {
      setFirstPin(value);
      setPin('');
      setConfirming(true);
      return;
    }
    if (value !== firstPin) {
      setPin('');
      setFirstPin('');
      setConfirming(false);
      setError('The PINs did not match. Please choose a PIN again.');
      return;
    }
    onSubmit(value);
  };

  return (
    <View style={[styles.pinRoot, style]}>
      <Text style={styles.title}>{confirming ? 'Enter the PIN again' : 'Choose a 4-digit PIN'}</Text>
      <Text style={styles.subtitle}>Avoid a PIN your child might guess, like a birthday.</Text>
      <PinPad value={pin} onChange={changePin} disabled={saving} />
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {saving ? <ActivityIndicator color={colors.primary} /> : null}
      <TouchableOpacity style={styles.backButton} onPress={onBack} disabled={saving}>
        <Text style={styles.secondaryText}>{backLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}

/** Lets a parent pick how the parental gate unlocks. Shown on the first visit to Settings/Profile and from Settings. */
export default function ParentLockSetup({ initialMethod = 'math', doneLabel = 'Continue', onDone, onCancel }: ParentLockSetupProps) {
  const [enteringPin, setEnteringPin] = useState(false);
  const [selected, setSelected] = useState<ParentalLockMethod>(initialMethod);
  const [saving, setSaving] = useState(false);

  const save = async (method: ParentalLockMethod, newPin?: string) => {
    setSaving(true);
    try {
      const { backedUp } = await setParentalLock(method, newPin);
      if (!backedUp) {
        Alert.alert('Saved on this device', 'We could not back up the parent lock to your account. It still works on this device.');
      }
      onDone(method);
    } catch (err) {
      console.warn('[ParentLockSetup] save failed:', err);
      Alert.alert('Save failed', 'Could not save the parent lock. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const continueFromChoice = () => {
    if (selected === 'pin') {
      setEnteringPin(true);
      return;
    }
    void save(selected);
  };

  if (enteringPin) {
    return <NewPinEntry saving={saving} onSubmit={(pin) => void save('pin', pin)} onBack={() => setEnteringPin(false)} />;
  }

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Parent lock</Text>
        <Text style={styles.subtitle}>
          Choose how grown-ups unlock settings, purchases, and routine changes. You can change this later in Settings.
        </Text>
        {OPTIONS.map((option) => {
          const active = selected === option.method;
          return (
            <TouchableOpacity
              key={option.method}
              style={[styles.option, active && styles.optionActive]}
              onPress={() => setSelected(option.method)}
              disabled={saving}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
            >
              <Text style={styles.optionEmoji}>{option.emoji}</Text>
              <View style={styles.optionText}>
                <Text style={styles.optionTitle}>{option.title}</Text>
                <Text style={styles.optionBody}>{option.body}</Text>
              </View>
              <View style={[styles.radio, active && styles.radioActive]} />
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      <View style={styles.row}>
        {onCancel ? (
          <TouchableOpacity style={styles.secondary} onPress={onCancel} disabled={saving}>
            <Text style={styles.secondaryText}>Cancel</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity style={[styles.primary, saving && styles.disabled]} onPress={continueFromChoice} disabled={saving}>
          {saving ? <ActivityIndicator color="#FFF" /> : <Text style={styles.primaryText}>{doneLabel}</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { ...contentColumn, flex: 1, gap: vs(12) },
  list: { gap: vs(10), paddingBottom: vs(8) },
  pinRoot: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: vs(14) },
  title: { color: colors.textInk, fontSize: fs(22), fontWeight: '800', textAlign: 'center' },
  subtitle: { color: colors.textSlate, fontSize: fs(14), lineHeight: fs(20), textAlign: 'center', marginBottom: vs(4) },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: s(12), padding: s(14), borderRadius: ms(16),
    borderWidth: 2, borderColor: colors.borderLight, backgroundColor: colors.white,
  },
  optionActive: { borderColor: colors.primary, backgroundColor: '#EEF8FB' },
  optionEmoji: { fontSize: fs(24) },
  optionText: { flex: 1 },
  optionTitle: { color: colors.textInk, fontSize: fs(16), fontWeight: '800' },
  optionBody: { color: colors.textSlate, fontSize: fs(13), lineHeight: fs(18), marginTop: vs(2) },
  radio: { width: ms(20), height: ms(20), borderRadius: ms(10), borderWidth: 2, borderColor: colors.textMuted },
  radioActive: { borderColor: colors.primary, backgroundColor: colors.primary },
  error: { color: '#B42318', fontSize: fs(14), textAlign: 'center' },
  row: { flexDirection: 'row', gap: s(12) },
  primary: { flex: 1, backgroundColor: colors.primary, padding: s(16), borderRadius: ms(16), alignItems: 'center' },
  primaryText: { color: '#FFF', fontWeight: '800', fontSize: fs(17) },
  secondary: { flex: 1, minWidth: s(120), padding: s(16), borderRadius: ms(16), alignItems: 'center', backgroundColor: '#F1F5F9' },
  backButton: { paddingVertical: s(12), paddingHorizontal: s(32), borderRadius: ms(16), backgroundColor: '#F1F5F9' },
  secondaryText: { color: colors.textInk, fontWeight: '700', fontSize: fs(16) },
  disabled: { opacity: 0.5 },
});
