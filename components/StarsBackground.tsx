import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, Image, ImageSourcePropType, StyleSheet, useWindowDimensions, View } from 'react-native';
import { colors, s, vs } from '../theme';
import { retryLocalImage, useLocalImage } from '../utils/localImages';
import { STAR_IMAGE as STAR } from '../constants/images';


interface StarConfig {
  top: number;
  size: number;
  duration: number;
  initialProgress: number;
  opacity: number;
  twinkleDuration: number;
}

function DriftingStar({
  config,
  screenWidth,
  source,
}: {
  config: StarConfig;
  screenWidth: number;
  source: ImageSourcePropType;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const twinkle = useRef(new Animated.Value(config.opacity)).current;

  useEffect(() => {
    let isMounted = true;
    const startX = -(config.size + 10);
    const endX = screenWidth + 10;
    const travel = endX - startX;

    const p0 = Math.max(0, Math.min(0.99, config.initialProgress ?? 0));
    const initialX = startX + p0 * travel;
    const remainingDuration = Math.max(100, Math.round(config.duration * (1 - p0)));

    translateX.setValue(initialX);

    const loop = () => {
      if (!isMounted) return;
      translateX.setValue(startX);
      Animated.timing(translateX, {
        toValue: endX,
        duration: config.duration,
        easing: Easing.linear,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished && isMounted) {
          loop();
        }
      });
    };

    Animated.timing(translateX, {
      toValue: endX,
      duration: remainingDuration,
      easing: Easing.linear,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && isMounted) {
        loop();
      }
    });

    return () => {
      isMounted = false;
      translateX.stopAnimation();
    };
  }, [config.duration, config.initialProgress, config.size, screenWidth, translateX]);

  useEffect(() => {
    const minOpacity = Math.max(0.15, config.opacity - 0.5);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(twinkle, {
          toValue: minOpacity,
          duration: config.twinkleDuration,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(twinkle, {
          toValue: config.opacity,
          duration: config.twinkleDuration,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [config.opacity, config.twinkleDuration, twinkle]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.star,
        {
          top: config.top,
          opacity: twinkle,
          transform: [{ translateX }],
        },
      ]}
    >
      <Image
        source={source}
        style={{ width: config.size, height: config.size }}
        resizeMode="contain"
        onError={() => retryLocalImage(STAR)}
      />
    </Animated.View>
  );
}

export interface StarsBackgroundProps {
  children?: React.ReactNode;
  /** When true, stars fill the entire screen height. Defaults to true. */
  fillScreen?: boolean;
}

export default function StarsBackground({ children, fillScreen = true }: StarsBackgroundProps) {
  const { width, height } = useWindowDimensions();
  const screenHeight = height || 844;
  const starSource = useLocalImage(STAR);

  const stars = useMemo<StarConfig[]>(() => {
    if (fillScreen) {
      return [
        { top: screenHeight * 0.03, size: s(50), duration: 44000, initialProgress: 0.10, opacity: 0.95, twinkleDuration: 1800 },
        { top: screenHeight * 0.06, size: s(32), duration: 52000, initialProgress: 0.55, opacity: 0.70, twinkleDuration: 2400 },
        { top: screenHeight * 0.09, size: s(42), duration: 48000, initialProgress: 0.85, opacity: 0.85, twinkleDuration: 2100 },
        { top: screenHeight * 0.13, size: s(60), duration: 42000, initialProgress: 0.30, opacity: 0.90, twinkleDuration: 1900 },
        { top: screenHeight * 0.16, size: s(36), duration: 50000, initialProgress: 0.72, opacity: 0.65, twinkleDuration: 2600 },
        { top: screenHeight * 0.20, size: s(48), duration: 46000, initialProgress: 0.05, opacity: 0.80, twinkleDuration: 2200 },
        { top: screenHeight * 0.24, size: s(34), duration: 54000, initialProgress: 0.45, opacity: 0.60, twinkleDuration: 2800 },
        { top: screenHeight * 0.27, size: s(56), duration: 43000, initialProgress: 0.92, opacity: 0.95, twinkleDuration: 1700 },
        { top: screenHeight * 0.31, size: s(40), duration: 49000, initialProgress: 0.20, opacity: 0.75, twinkleDuration: 2300 },
        { top: screenHeight * 0.35, size: s(62), duration: 41000, initialProgress: 0.65, opacity: 0.85, twinkleDuration: 2000 },
        { top: screenHeight * 0.39, size: s(35), duration: 53000, initialProgress: 0.88, opacity: 0.65, twinkleDuration: 2500 },
        { top: screenHeight * 0.43, size: s(46), duration: 47000, initialProgress: 0.38, opacity: 0.80, twinkleDuration: 2100 },
        { top: screenHeight * 0.47, size: s(54), duration: 44000, initialProgress: 0.12, opacity: 0.90, twinkleDuration: 1800 },
        { top: screenHeight * 0.51, size: s(32), duration: 51000, initialProgress: 0.78, opacity: 0.60, twinkleDuration: 2700 },
        { top: screenHeight * 0.55, size: s(44), duration: 48000, initialProgress: 0.50, opacity: 0.75, twinkleDuration: 2200 },
        { top: screenHeight * 0.59, size: s(58), duration: 42000, initialProgress: 0.25, opacity: 0.85, twinkleDuration: 1900 },
        { top: screenHeight * 0.63, size: s(36), duration: 52000, initialProgress: 0.82, opacity: 0.70, twinkleDuration: 2400 },
        { top: screenHeight * 0.67, size: s(50), duration: 45000, initialProgress: 0.08, opacity: 0.90, twinkleDuration: 2000 },
        { top: screenHeight * 0.71, size: s(34), duration: 55000, initialProgress: 0.60, opacity: 0.65, twinkleDuration: 2600 },
        { top: screenHeight * 0.75, size: s(48), duration: 46000, initialProgress: 0.35, opacity: 0.80, twinkleDuration: 2100 },
        { top: screenHeight * 0.79, size: s(56), duration: 43000, initialProgress: 0.95, opacity: 0.85, twinkleDuration: 1800 },
        { top: screenHeight * 0.83, size: s(38), duration: 50000, initialProgress: 0.18, opacity: 0.70, twinkleDuration: 2500 },
        { top: screenHeight * 0.86, size: s(45), duration: 47000, initialProgress: 0.70, opacity: 0.75, twinkleDuration: 2300 },
        { top: screenHeight * 0.10, size: s(30), duration: 56000, initialProgress: 0.40, opacity: 0.55, twinkleDuration: 2900 },
        { top: screenHeight * 0.22, size: s(38), duration: 48000, initialProgress: 0.75, opacity: 0.70, twinkleDuration: 2200 },
        { top: screenHeight * 0.45, size: s(30), duration: 53000, initialProgress: 0.98, opacity: 0.55, twinkleDuration: 2800 },
      ];
    }

    return [
      { top: vs(25), size: s(50), duration: 44000, initialProgress: 0.10, opacity: 0.95, twinkleDuration: 1800 },
      { top: vs(50), size: s(36), duration: 50000, initialProgress: 0.55, opacity: 0.70, twinkleDuration: 2400 },
      { top: vs(80), size: s(44), duration: 46000, initialProgress: 0.85, opacity: 0.85, twinkleDuration: 2000 },
      { top: vs(110), size: s(56), duration: 42000, initialProgress: 0.30, opacity: 0.90, twinkleDuration: 1900 },
      { top: vs(140), size: s(34), duration: 52000, initialProgress: 0.70, opacity: 0.65, twinkleDuration: 2600 },
      { top: vs(40), size: s(40), duration: 48000, initialProgress: 0.05, opacity: 0.80, twinkleDuration: 2200 },
      { top: vs(95), size: s(32), duration: 54000, initialProgress: 0.45, opacity: 0.60, twinkleDuration: 2800 },
      { top: vs(125), size: s(48), duration: 45000, initialProgress: 0.92, opacity: 0.85, twinkleDuration: 2100 },
    ];
  }, [fillScreen, screenHeight]);

  return (
    <View style={styles.root} pointerEvents="none">
      {stars.map((config, index) => (
        <DriftingStar key={index} config={config} screenWidth={width} source={starSource} />
      ))}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.eveningBg,
    overflow: 'hidden',
  },
  star: {
    position: 'absolute',
    left: 0,
  },
});
