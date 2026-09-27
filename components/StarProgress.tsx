import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { ms } from '../theme';

const STAR_COUNT = 10;

interface StarProgressProps {
  progress: number;
}

export default function StarProgress({ progress }: StarProgressProps) {
  const [rowWidth, setRowWidth] = useState(0);
  const starSize = rowWidth ? Math.min(ms(34), rowWidth / STAR_COUNT) : ms(24);
  const filledStars = Math.min(Math.max(progress, 0), 1) * STAR_COUNT;

  return (
    <View
      style={styles.row}
      onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}
      accessible
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(filledStars * 10) }}
    >
      {Array.from({ length: STAR_COUNT }, (_, index) => {
        const fill = Math.min(Math.max(filledStars - index, 0), 1);
        return (
          <View key={index} style={styles.slot}>
            <View style={{ width: starSize, height: starSize }}>
              <MaterialCommunityIcons name="star" size={starSize} color="#BEC5D0" />
              {fill > 0 ? (
                <View style={[styles.fill, { width: `${fill * 100}%` }]}>
                  <MaterialCommunityIcons name="star" size={starSize} color="#FFC247" />
                </View>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    width: '100%',
  },
  slot: {
    flex: 1,
    alignItems: 'center',
  },
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    height: '100%',
    overflow: 'hidden',
  },
});