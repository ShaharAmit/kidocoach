import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, Image, ImageSourcePropType, StyleSheet, useWindowDimensions, View } from 'react-native';
import { colors, s, vs } from '../theme';
import { retryLocalImage, useLocalImage } from '../utils/localImages';
import { CLOUD_IMAGE as CLOUD } from '../constants/images';


interface CloudConfig {
  top: number;
  size: number;
  duration: number;
  initialProgress: number;
  opacity: number;
}

function DriftingCloud({
  config,
  screenWidth,
  source,
}: {
  config: CloudConfig;
  screenWidth: number;
  source: ImageSourcePropType;
}) {
  const translateX = useRef(new Animated.Value(0)).current;

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

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.cloud,
        {
          top: config.top,
          opacity: config.opacity,
          transform: [{ translateX }],
        },
      ]}
    >
      <Image
        source={source}
        style={{ width: config.size, height: config.size * 0.45 }}
        resizeMode="contain"
        onError={() => retryLocalImage(CLOUD)}
      />
    </Animated.View>
  );
}

export interface CloudsBackgroundProps {
  children?: React.ReactNode;
  /** When true, clouds fill the entire screen height. Defaults to true. */
  fillScreen?: boolean;
}

export default function CloudsBackground({ children, fillScreen = true }: CloudsBackgroundProps) {
  const { width, height } = useWindowDimensions();
  const screenHeight = height || 844;
  const cloudSource = useLocalImage(CLOUD);

  const clouds = useMemo<CloudConfig[]>(() => {
    if (fillScreen) {
      return [
        { top: screenHeight * 0.04, size: s(130), duration: 32000, initialProgress: 0.12, opacity: 0.85 },
        { top: screenHeight * 0.11, size: s(80), duration: 38000, initialProgress: 0.68, opacity: 0.6 },
        { top: screenHeight * 0.18, size: s(105), duration: 42000, initialProgress: 0.38, opacity: 0.75 },
        { top: screenHeight * 0.26, size: s(150), duration: 30000, initialProgress: 0.82, opacity: 0.9 },
        { top: screenHeight * 0.35, size: s(90), duration: 45000, initialProgress: 0.22, opacity: 0.65 },
        { top: screenHeight * 0.44, size: s(125), duration: 34000, initialProgress: 0.58, opacity: 0.8 },
        { top: screenHeight * 0.53, size: s(85), duration: 40000, initialProgress: 0.04, opacity: 0.7 },
        { top: screenHeight * 0.62, size: s(140), duration: 36000, initialProgress: 0.46, opacity: 0.75 },
        { top: screenHeight * 0.71, size: s(95), duration: 44000, initialProgress: 0.88, opacity: 0.6 },
        { top: screenHeight * 0.80, size: s(115), duration: 38000, initialProgress: 0.28, opacity: 0.65 },
        { top: screenHeight * 0.15, size: s(70), duration: 48000, initialProgress: 0.94, opacity: 0.5 },
        { top: screenHeight * 0.48, size: s(75), duration: 46000, initialProgress: 0.76, opacity: 0.55 },
      ];
    }

    return [
      { top: vs(30), size: s(130), duration: 34000, initialProgress: 0.15, opacity: 0.85 },
      { top: vs(60), size: s(85), duration: 38000, initialProgress: 0.70, opacity: 0.6 },
      { top: vs(90), size: s(110), duration: 42000, initialProgress: 0.40, opacity: 0.75 },
      { top: vs(45), size: s(140), duration: 32000, initialProgress: 0.85, opacity: 0.9 },
      { top: vs(120), size: s(95), duration: 46000, initialProgress: 0.25, opacity: 0.7 },
      { top: vs(150), size: s(80), duration: 40000, initialProgress: 0.55, opacity: 0.6 },
    ];
  }, [fillScreen, screenHeight]);

  return (
    <View style={styles.root} pointerEvents="none">
      {clouds.map((config, index) => (
        <DriftingCloud key={index} config={config} screenWidth={width} source={cloudSource} />
      ))}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.morningBg,
    overflow: 'hidden',
  },
  cloud: {
    position: 'absolute',
    left: 0,
  },
});
