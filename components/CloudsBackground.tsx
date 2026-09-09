import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, Image, ImageSourcePropType, StyleSheet, useWindowDimensions, View } from 'react-native';
import { colors, s, vs } from '../theme';
import { retryLocalImage, useLocalImage } from '../utils/localImages';
import { CLOUD_IMAGE as CLOUD } from '../constants/images';


interface CloudConfig {
  top: number;
  size: number;
  duration: number;
  delay: number;
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
  const translateX = useRef(new Animated.Value(-config.size)).current;

  useEffect(() => {
    const travel = screenWidth + config.size * 2;
    const animate = () => {
      translateX.setValue(-config.size);
      Animated.timing(translateX, {
        toValue: travel,
        duration: config.duration,
        delay: config.delay,
        easing: Easing.linear,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) animate();
      });
    };
    animate();
    return () => translateX.stopAnimation();
  }, [config, screenWidth, translateX]);

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

export default function CloudsBackground({ children }: { children?: React.ReactNode }) {
  const { width } = useWindowDimensions();
  const cloudSource = useLocalImage(CLOUD);

  const clouds = useMemo<CloudConfig[]>(
    () => [
      { top: vs(70), size: s(150), duration: 34000, delay: 0, opacity: 0.95 },
      { top: vs(50), size: s(80), duration: 30000, delay: 3000, opacity: 0.6 },
      { top: vs(120), size: s(95), duration: 46000, delay: 6000, opacity: 0.8 },
      { top: vs(50), size: s(80), duration: 24000, delay: 9000, opacity: 0.6 },
      { top: vs(30), size: s(110), duration: 40000, delay: 12000, opacity: 0.7 },
      { top: vs(100), size: s(70), duration: 52000, delay: 15000, opacity: 0.6 },
    ],
    []
  );

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
