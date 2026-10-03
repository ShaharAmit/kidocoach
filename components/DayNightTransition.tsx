import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View, useWindowDimensions } from 'react-native';
import CloudsBackground from './CloudsBackground';
import StarsBackground from './StarsBackground';
import { colors, s, vs } from '../theme';
import { retryLocalImage, useLocalImage } from '../utils/localImages';
import { MOON_IMAGE as MOON, SUN_IMAGE as SUN } from '../constants/images';


const DAY_HOLD_MS = 1200;
const TRANSITION_MS = 2600;

interface DayNightTransitionProps {
  children?: React.ReactNode;
  /** Loop day -> night -> day continuously while the screen is mounted. */
  loop?: boolean;
}

export default function DayNightTransition({ children, loop = true }: DayNightTransitionProps) {
  const { height } = useWindowDimensions();
  const sunSource = useLocalImage(SUN);
  const moonSource = useLocalImage(MOON);
  // 0 = full day, 1 = full night
  const cycle = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const toNight = Animated.timing(cycle, {
      toValue: 1,
      duration: TRANSITION_MS,
      delay: DAY_HOLD_MS,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: false,
    });

    const toDay = Animated.timing(cycle, {
      toValue: 0,
      duration: TRANSITION_MS,
      delay: DAY_HOLD_MS,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: false,
    });

    const animation = loop
      ? Animated.loop(Animated.sequence([toNight, toDay]))
      : toNight;

    animation.start();
    return () => animation.stop();
  }, [cycle, loop]);

  const arcHeight = vs(70);
  const offscreen = height * 0.35;

  const nightOpacity = cycle.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });

  const sunTranslateY = cycle.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0, arcHeight * 0.4, offscreen],
  });
  const sunOpacity = cycle.interpolate({
    inputRange: [0, 0.45, 0.75],
    outputRange: [1, 0.8, 0],
    extrapolate: 'clamp',
  });
  const sunScale = cycle.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0.7],
  });

  const moonTranslateY = cycle.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [offscreen, arcHeight * 0.4, 0],
  });
  const moonOpacity = cycle.interpolate({
    inputRange: [0.25, 0.55, 1],
    outputRange: [0, 0.8, 1],
    extrapolate: 'clamp',
  });
  const moonScale = cycle.interpolate({
    inputRange: [0, 1],
    outputRange: [0.7, 1],
  });

  return (
    <View style={styles.root}>
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <CloudsBackground fillScreen />
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: nightOpacity }]}>
          <StarsBackground fillScreen />
        </Animated.View>
      </View>

      <View style={styles.skyLayer} pointerEvents="none">
        <Animated.Image
          source={sunSource}
          resizeMode="contain"
          style={[
            styles.celestial,
            {
              opacity: sunOpacity,
              transform: [{ translateY: sunTranslateY }, { scale: sunScale }],
            },
          ]}
          onError={() => retryLocalImage(SUN)}
        />
        <Animated.Image
          source={moonSource}
          resizeMode="contain"
          style={[
            styles.celestial,
            {
              opacity: moonOpacity,
              transform: [{ translateY: moonTranslateY }, { scale: moonScale }],
            },
          ]}
          onError={() => retryLocalImage(MOON)}
        />
      </View>

      <View style={styles.content}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.morningBg,
  },
  skyLayer: {
    position: 'absolute',
    top: vs(90),
    left: 0,
    right: 0,
    height: s(140),
    alignItems: 'center',
    justifyContent: 'center',
  },
  celestial: {
    position: 'absolute',
    width: s(130),
    height: s(130),
  },
  content: {
    flex: 1,
  },
});
