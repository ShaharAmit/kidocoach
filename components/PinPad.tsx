import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { colors, fs, ms, s, vs } from '../theme';
import { PIN_LENGTH } from '../services/parentalLock';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'] as const;

interface PinPadProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

/** Custom keypad so PIN entry looks identical on iPhone/iPad and never shows the system keyboard. */
export default function PinPad({ value, onChange, disabled }: PinPadProps) {
  const press = (key: (typeof KEYS)[number]) => {
    if (disabled) return;
    if (key === 'del') onChange(value.slice(0, -1));
    else if (key && value.length < PIN_LENGTH) onChange(value + key);
  };

  return (
    <View style={styles.root}>
      <View style={styles.dots} accessibilityLabel={`${value.length} of ${PIN_LENGTH} digits entered`}>
        {Array.from({ length: PIN_LENGTH }).map((_, index) => (
          <View key={index} style={[styles.dot, index < value.length && styles.dotFilled]} />
        ))}
      </View>
      <View style={styles.grid}>
        {KEYS.map((key, index) =>
          key === '' ? (
            <View key={index} style={styles.key} />
          ) : (
            <TouchableOpacity
              key={index}
              style={[styles.key, styles.keyButton, disabled && styles.disabled]}
              onPress={() => press(key)}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel={key === 'del' ? 'Delete' : key}
            >
              <Text style={styles.keyText}>{key === 'del' ? '⌫' : key}</Text>
            </TouchableOpacity>
          ),
        )}
      </View>
    </View>
  );
}

const KEY_SIZE = ms(64);

const styles = StyleSheet.create({
  root: { alignItems: 'center', gap: vs(16) },
  dots: { flexDirection: 'row', gap: s(16) },
  dot: { width: ms(16), height: ms(16), borderRadius: ms(8), borderWidth: 2, borderColor: colors.textMuted },
  dotFilled: { backgroundColor: colors.textInk, borderColor: colors.textInk },
  grid: { flexDirection: 'row', flexWrap: 'wrap', width: KEY_SIZE * 3 + s(16) * 2, gap: s(16), justifyContent: 'center' },
  key: { width: KEY_SIZE, height: KEY_SIZE, alignItems: 'center', justifyContent: 'center' },
  keyButton: { borderRadius: KEY_SIZE / 2, backgroundColor: '#F1F5F9' },
  keyText: { fontSize: fs(24), fontWeight: '700', color: colors.textInk },
  disabled: { opacity: 0.4 },
});
