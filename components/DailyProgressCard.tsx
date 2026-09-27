import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { DailyProgress } from '../types';
import { colors, fs, ms, s, vs } from '../theme';
import StarProgress from './StarProgress';

interface DailyProgressCardProps {
  segment: 'morning' | 'evening';
  progress: DailyProgress;
}

export default function DailyProgressCard({ segment, progress }: DailyProgressCardProps) {
  const isSegmentMorning = segment === 'morning';
  const completed = isSegmentMorning ? progress.morningCompleted : progress.eveningCompleted;
  const total = isSegmentMorning ? progress.morningTotal : progress.eveningTotal;
  const completion = total === 0 ? 0 : completed / total;
  const isComplete = completed === total && total > 0;

  const emoji = isSegmentMorning ? '🌅' : '🌙';
  const label = isSegmentMorning ? 'Morning' : 'Evening';
  const bgColor = isSegmentMorning ? '#FFF8E6' : '#E6F2FF';

  return (
    <View style={[styles.container, { backgroundColor: bgColor }]}>
      <View style={styles.header}>
        <Text style={styles.emoji}>{emoji}</Text>
        <Text style={styles.label}>{label} Activities</Text>
        {isComplete && <Text style={styles.badge}>✓ Complete!</Text>}
      </View>

      <View style={styles.progressSection}>
        <StarProgress progress={completion} />
        <Text style={styles.statsText}>
          <Text style={styles.statsBold}>{completed}</Text> / {total} completed
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: ms(12),
    padding: ms(14),
    marginBottom: vs(10),
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: vs(12),
  },
  emoji: {
    fontSize: fs(24),
    marginRight: s(10),
  },
  label: {
    fontSize: fs(16),
    fontWeight: '700',
    color: colors.textDark,
    flex: 1,
  },
  badge: {
    fontSize: fs(12),
    fontWeight: '600',
    color: '#10B981',
    backgroundColor: '#ECFDF5',
    paddingHorizontal: s(8),
    paddingVertical: vs(4),
    borderRadius: ms(6),
  },
  progressSection: {
    gap: s(10),
  },
  statsText: {
    fontSize: fs(13),
    color: colors.textSlate,
  },
  statsBold: {
    fontWeight: '700',
    color: colors.textDark,
  },
});
