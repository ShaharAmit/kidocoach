import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  useWindowDimensions,
} from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import { setAudioModeAsync } from 'expo-audio';
import Animated, { FadeIn } from 'react-native-reanimated';
import * as FileSystem from 'expo-file-system/legacy';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { downloadWelcomeAssets, getWelcomeAssetPaths } from '../../services/assetCacheService';
import { getOrExtractMobilePoster } from '../../services/mobileVideoCache';
import { colors, fs, ms, s, vs } from '../../theme';
import { requestParentalGate } from '../../components/ParentalGate';

type WelcomeVideoPlayerProps = {
  videoPath: string;
  posterUri?: string;
  height: number;
  onEnded: () => void;
};

// If the video hasn't started rendering within this many ms, skip it.
const VIDEO_START_TIMEOUT_MS = 8_000;

function WelcomeVideoPlayer({ videoPath, posterUri, height, onEnded }: WelcomeVideoPlayerProps) {
  const [isVideoReady, setIsVideoReady] = useState(false);

  const videoPlayer = useVideoPlayer(videoPath, (player) => {
    player.loop = false;
    player.muted = false;
  });

  useEffect(() => {
    let videoSub: { remove: () => void } | null = null;
    let statusSub: { remove: () => void } | null = null;
    // Safety: if video never starts rendering, move on.
    const startTimer = setTimeout(() => {
      console.warn('[Welcome] video start timeout — skipping');
      onEnded();
    }, VIDEO_START_TIMEOUT_MS);

    async function startPlayback() {
      await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false });

      videoSub = videoPlayer.addListener('playToEnd', () => {
        clearTimeout(startTimer);
        onEnded();
      });

      // Track readiness for poster removal + detect hard player errors.
      statusSub = videoPlayer.addListener('statusChange', (status) => {
        const s = status as any;
        if (s?.status === 'readyToPlay') {
          setIsVideoReady(true);
          clearTimeout(startTimer);
        } else if (s?.error || s?.status === 'error') {
          console.warn('[Welcome] video player error — skipping', status);
          clearTimeout(startTimer);
          onEnded();
        }
      });

      videoPlayer.play();
    }

    startPlayback().catch((err) => {
      console.warn('[Welcome] playback init failed:', err);
      clearTimeout(startTimer);
      onEnded();
    });

    return () => {
      clearTimeout(startTimer);
      if (videoSub) videoSub.remove();
      if (statusSub) statusSub.remove();
      try {
        if (videoPlayer?.playing) {
          videoPlayer.pause();
        }
      } catch {
        // no-op
      }
    };
  }, [onEnded, videoPlayer]);

  return (
    <View style={[styles.videoContainer, { height }]}>
      <VideoView
        player={videoPlayer}
        style={styles.video}
        contentFit="contain"
        nativeControls={false}
        allowsVideoFrameAnalysis={false}
      />
      {/* Poster overlay: sits above the video until the native engine has painted its first frame. */}
      {!isVideoReady && posterUri ? (
        <Image
          source={{ uri: posterUri }}
          style={styles.posterOverlay}
          resizeMode="contain"
        />
      ) : null}
    </View>
  );
}

const DOWNLOAD_TIMEOUT_MS = 8_000;
const MAX_VIDEO_WAIT_MS = 30_000; // outer safety net: 8s download + ~2s setup + 20s max play window
const MIN_VIDEO_BYTES = 16 * 1024; // same threshold as assetCacheService

export default function WelcomeScreen() {
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const scrollRef = React.useRef<ScrollView>(null);
  const [videoDone, setVideoDone] = useState(false);
  const [isPreparing, setIsPreparing] = useState(true);
  const [assetsReady, setAssetsReady] = useState(false);
  const [posterUri, setPosterUri] = useState<string | undefined>(undefined);
  const forceShowContinue = useCallback(() => setVideoDone(true), []);

  const { videoPath } = useMemo(() => getWelcomeAssetPaths(), []);

  useEffect(() => {
    let mounted = true;
    // Safety net: no matter what happens, show Continue after MAX_VIDEO_WAIT_MS.
    const maxWaitTimer = setTimeout(() => {
      if (mounted) forceShowContinue();
    }, MAX_VIDEO_WAIT_MS);

    async function prepareAssets() {
      setIsPreparing(true);

      try {
        await Promise.race([
          downloadWelcomeAssets(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('download timeout')), DOWNLOAD_TIMEOUT_MS)
          ),
        ]);
      } catch (err) {
        console.warn('[Welcome] failed to sync welcome assets:', err);
      }

      const videoInfo = await FileSystem.getInfoAsync(videoPath);
      if (!mounted) return;

      const videoSize = videoInfo.exists && 'size' in videoInfo ? (videoInfo.size ?? 0) : 0;
      const isPlayable = videoInfo.exists && videoSize >= MIN_VIDEO_BYTES;

      if (!isPlayable) {
        setAssetsReady(false);
        setVideoDone(true);
        setIsPreparing(false);
        return;
      }

      setAssetsReady(true);
      setVideoDone(false);
      setIsPreparing(false);

      // Non-blocking: generate + cache the poster frame natively.
      // On return visits the JPEG is read straight from disk — no generation needed.
      getOrExtractMobilePoster(videoPath).then((uri) => {
        if (mounted && uri) setPosterUri(uri);
      }).catch(() => {});
    }

    prepareAssets().catch((err) => {
      console.warn('[Welcome] prepare failed:', err);
      setVideoDone(true);
      setIsPreparing(false);
    });

    return () => {
      mounted = false;
      clearTimeout(maxWaitTimer);
    };
  }, [videoPath, forceShowContinue]);

  useEffect(() => {
    if (!videoDone) return;

    const timer = setTimeout(() => {
      scrollRef.current?.scrollTo({ y: screenHeight, animated: true });
    }, 50);

    return () => clearTimeout(timer);
  }, [screenHeight, videoDone]);

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
      bounces={false}
    >
      {isPreparing ? (
        <View style={[styles.fallback, { height: screenHeight }]}>
          <ActivityIndicator size="large" color="#FFFFFF" />
          <Text style={styles.preparingText}>Preparing welcome video...</Text>
        </View>
      ) : assetsReady ? (
        <WelcomeVideoPlayer
          videoPath={videoPath}
          posterUri={posterUri}
          height={screenHeight}
          onEnded={forceShowContinue}
        />
      ) : (
        <View style={[styles.fallback, { height: screenHeight }]}>
          <Text style={styles.fallbackEmoji}>🧑‍🏫</Text>
        </View>
      )}

      {videoDone ? (
        <Animated.View
          entering={FadeIn.duration(300)}
          style={[styles.buttonWrap, { paddingTop: vs(28), paddingBottom: vs(16) + insets.bottom }]}
        >
          <TouchableOpacity
            style={styles.button}
            onPress={() => router.replace('/onboarding/questionnaire' as never)}
            activeOpacity={0.85}
          >
            <Text style={styles.buttonText}>Continue To Questionnaire</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { void requestParentalGate().then((passed) => { if (passed) router.replace('/profile'); }); }} style={{ paddingVertical: vs(18) }}>
            <Text style={[styles.buttonText, { fontSize: fs(16) }]}>Already connected? Parent sign in</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.replace('/paywall')} style={{ paddingVertical: vs(12) }}>
            <Text style={[styles.buttonText, { fontSize: fs(16) }]}>Restore a purchase</Text>
          </TouchableOpacity>
        </Animated.View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: '#000',
  },
  scrollContent: {
    backgroundColor: '#000',
  },
  container: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoContainer: {
    width: '100%',
    height: '100%',
  },
  video: {
    ...StyleSheet.absoluteFill,
  },
  posterOverlay: {
    ...StyleSheet.absoluteFill,
    zIndex: 10,
  },
  fallback: {
    width: '100%',
    height: '100%',
    backgroundColor: '#111',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fallbackEmoji: {
    fontSize: fs(72),
    color: '#FFF',
  },
  preparingText: {
    marginTop: vs(14),
    fontSize: fs(15),
    fontWeight: '600',
    color: '#FFF',
  },
  waitingSpacer: {
    height: vs(56),
  },
  buttonWrap: {
    width: '100%',
    paddingHorizontal: s(20),
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: ms(16),
    paddingVertical: vs(16),
    alignItems: 'center',
  },
  buttonText: {
    color: '#FFF',
    fontSize: fs(17),
    fontWeight: '800',
  },
});
