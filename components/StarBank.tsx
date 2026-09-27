import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { STAR_LEVELS, getStarLevel, getStarsToNextLevel } from '../types';
import { colors, fs, ms, s, vs } from '../theme';
import StarProgress from './StarProgress';

interface StarBankProps {
  totalStars: number;
}

export default function StarBank({ totalStars }: StarBankProps) {
  const level = getStarLevel(totalStars);
  const starsToNext = getStarsToNextLevel(totalStars);
  const nextLevel = STAR_LEVELS.find((l) => l.minStars > level.maxStars) ?? level;

  const progress = (totalStars - level.minStars) / (level.maxStars - level.minStars + 1);

  return (
    <View style={styles.container}>
      {/* Star bank display */}
      <View style={styles.bankSection}>
        <Text style={styles.starCount}>{totalStars}</Text>
        <Text style={styles.starLabel}>⭐ Stars</Text>
      </View>

      {/* Current level badge */}
      <View style={styles.levelSection}>
        <View style={styles.levelBadge}>
          <Text style={styles.levelEmoji}>{level.emoji}</Text>
          <View>
            <Text style={styles.levelName}>{level.level}</Text>
          </View>
        </View>

        {/* Progress to next level */}
        {level.level !== 'Superstar' && (
          <View style={styles.nextLevelInfo}>
            <Text style={styles.nextLevelLabel}>Next: {nextLevel.emoji} {nextLevel.level}</Text>
            <StarProgress progress={progress} />
            <Text style={styles.starsNeeded}>
              {starsToNext} star{starsToNext !== 1 ? 's' : ''} to next level
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#FFF',
    borderRadius: ms(16),
    padding: ms(20),
    marginBottom: vs(16),
    borderWidth: 2,
    borderColor: '#FFE8B6',
    shadowColor: '#000',
    shadowOffset: { width: s(0), height: vs(2) },
    shadowOpacity: 0.08,
    shadowRadius: ms(4),
    elevation: 3,
  },
  bankSection: {
    alignItems: 'center',
    marginBottom: vs(16),
  },
  starCount: {
    fontSize: fs(48),
    fontWeight: '800',
    color: colors.star,
    lineHeight: fs(52),
  },
  starLabel: {
    fontSize: fs(16),
    fontWeight: '600',
    color: colors.textDark,
    marginTop: vs(4),
  },
  levelSection: {
    borderTopWidth: 1,
    borderTopColor: '#F0F0F0',
    paddingTop: vs(16),
  },
  levelBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8F9FB',
    borderRadius: ms(12),
    padding: ms(12),
    marginBottom: vs(12),
  },
  levelEmoji: {
    fontSize: fs(32),
    marginRight: s(12),
  },
  levelName: {
    fontSize: fs(16),
    fontWeight: '700',
    color: colors.textDark,
  },
  nextLevelInfo: {
    marginTop: vs(8),
  },
  nextLevelLabel: {
    fontSize: fs(13),
    fontWeight: '600',
    color: colors.textSlate,
    marginBottom: vs(8),
  },
  starsNeeded: {
    fontSize: fs(12),
    fontWeight: '600',
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: vs(8),
  },
});
