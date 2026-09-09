import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, Image, ImageSourcePropType, StyleSheet, useWindowDimensions, View } from 'react-native';
import { colors, s, vs } from '../theme';
import { retryLocalImage, useLocalImage } from '../utils/localImages';
import { STAR_IMAGE as STAR } from '../constants/images';


interface StarConfig {
  top: number;
  size: number;
  duration: number;
  delay: number;
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
  const translateX = useRef(new Animated.Value(-config.size)).current;
  const twinkle = useRef(new Animated.Value(config.opacity)).current;

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

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(twinkle, {
          toValue: Math.max(0.2, config.opacity - 0.5),
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
  }, [config, twinkle]);

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

export default function StarsBackground({ children }: { children?: React.ReactNode }) {
  const { width } = useWindowDimensions();
  const starSource = useLocalImage(STAR);

  const stars = useMemo<StarConfig[]>(
    () => [
      
      { top: vs(30), size: s(70), duration: 48000, delay: 0, opacity: 0.95, twinkleDuration: 1600 },
      { top: vs(70), size: s(60), duration: 48000, delay: 5000, opacity: 0.7, twinkleDuration: 2200 },
      { top: vs(40), size: s(65), duration: 48000, delay: 10000, opacity: 0.85, twinkleDuration: 1900 },
      { top: vs(100), size: s(60), duration: 48000, delay: 15000, opacity: 0.6, twinkleDuration: 2600 },
      { top: vs(55), size: s(65), duration: 48000, delay: 20000, opacity: 0.8, twinkleDuration: 2000 },
      { top: vs(80), size: s(70), duration: 48000, delay: 25000, opacity: 0.65, twinkleDuration: 2400 },
      { top: vs(30), size: s(70), duration: 48000, delay: 30000, opacity: 0.95, twinkleDuration: 2400 },
      { top: vs(70), size: s(65), duration: 48000, delay: 35000, opacity: 0.8, twinkleDuration: 1900 },
      { top: vs(110), size: s(60), duration: 48000, delay: 40000, opacity: 0.65, twinkleDuration: 2200 },
    ],
    []
  );

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
