import React, { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Dimensions,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { VideoView, useVideoPlayer, VideoSize } from 'expo-video';
import { setAudioModeAsync } from 'expo-audio';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActivityKey, ActivityStep, CaptionCue } from '../types';
import { ACTIVITIES } from '../constants/activities';
import { isValidCachedVideo, ensureActivityVideoReady } from '../services/assetSync';
import { getOrBuildMergedCaptions, localPart2VideoPath } from '../services/twoPartVideoService';
import { getReadyMergedVideoPath, ensureMergedActivityVideo } from '../services/videoMerge';
import { colors, fs, ms, s, vs } from '../theme';

type DaySegment = 'morning' | 'evening';

interface ActivityPlayerProps {
  activityStep: ActivityStep;
  childName: string;
  avatarId: string;
  segment: DaySegment;
  /**
   * 1-based progress position within the segment, derived from how many activities are actually
   * done (this in-progress one included) rather than the card's position in the list. Keeps the
   * dots and the "Step X of Y" counter consistent with `isFinalRemainingStep`.
   */
  stepNumber: number;
  totalSteps: number;
  /**
   * Whether finishing this step completes every remaining activity in the segment. Derived from
   * actual completion state, not list position, so an out-of-order step never claims to be last.
   */
  isFinalRemainingStep: boolean;
  showCaptions?: boolean;
  onComplete: () => void;
}

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const CONTAINER_WIDTH = SCREEN_WIDTH * 0.8;
const MAX_CONTAINER_HEIGHT = SCREEN_HEIGHT * 0.55;
const DEFAULT_ASPECT_RATIO = 9 / 16;

const ACTIVITY_TIMER_SECONDS: Record<ActivityKey, number> = {
  wake_up: 60,
  brush_teeth: 120,
  wash_face: 90,
  comb_hair: 120,
  get_dressed: 180,
  put_shoes_on: 90,
  pack_backpack: 180,
  drink_water: 30,
  tidy_room: 300,
  make_bed: 180,
  eat_breakfast: 600,
  homework: 900,
  read_book: 600,
  put_on_pajamas: 180,
  eat_dinner: 900,
  bedtime_story: 600,
  go_to_sleep: 300,
};

function clampContainerHeight(aspectRatio: number): number {
  const idealHeight = CONTAINER_WIDTH / aspectRatio;
  return Math.min(idealHeight, MAX_CONTAINER_HEIGHT);
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

/**
 * What this step will actually play.
 *
 * `merged` is the intended path for every authored activity: one pre-built file containing the
 * personalized Part 1 greeting (dubbed with this child's TTS) immediately followed by the Part 2
 * activity clip. `single` is the degraded path used only when no Part 1 clip is authored (or the
 * merge genuinely failed) — Part 2 alone, which carries its own baked-in narration.
 */
type ResolvedSource =
  | { kind: 'merged'; uri: string }
  | { kind: 'single'; uri: string }
  | { kind: 'unavailable' };

interface VideoStageProps {
  uri: string;
  showCaptions: boolean;
  captionCues: CaptionCue[] | null;
  videoEnded: boolean;
  timerSecondsRemaining: number | null;
  accentColor: string;
  onRetry: () => void;
  onEnded: () => void;
}

/**
 * Owns exactly one `expo-video` player bound to exactly one file for its entire lifetime.
 *
 * This component is always mounted with a `key` derived from `uri`, so a different source
 * produces a brand new component instance and therefore a brand new native player whose
 * *initial* source is already the file we want. That is deliberate and load-bearing: swapping a
 * live player's source via `replaceAsync()` was the cause of the "audio plays but the picture is
 * frozen on the previous clip's last frame" bug. After a swap the native player kept reporting
 * the previous item's state — `duration` returned the old asset's length, `playToEnd` fired
 * immediately for the old item, and the attached surface never redrew (remounting just the
 * VideoView did not help, because the stale object is the player, not the view). Creating the
 * player already pointed at the right file avoids that failure mode entirely.
 */
function VideoStage({
  uri,
  showCaptions,
  captionCues,
  videoEnded,
  timerSecondsRemaining,
  accentColor,
  onRetry,
  onEnded,
}: VideoStageProps) {
  const [aspectRatio, setAspectRatio] = useState(DEFAULT_ASPECT_RATIO);
  const [currentTime, setCurrentTime] = useState(0);

  const onEndedRef = useRef(onEnded);
  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);

  const player = useVideoPlayer(uri, (p: ReturnType<typeof useVideoPlayer>) => {
    p.loop = false;
    // The merged file carries the dubbed greeting AND the Part 2 narration on a single audio
    // track; the Part-2-only fallback carries its own narration. Either way: never muted, and
    // never a second audio player to keep in sync.
    p.muted = false;
    p.timeUpdateEventInterval = 0.05;
    p.play();
  });

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false }).catch((err) =>
      console.warn('[ActivityPlayer] Failed to set audio mode:', err)
    );
  }, []);

  useEffect(() => {
    const endSub = player.addListener('playToEnd', () => {
      console.log('[ActivityPlayer] playToEnd', uri);
      onEndedRef.current();
    });

    const statusSub = player.addListener('statusChange', (status) => {
      const st = status as unknown as { status?: string; error?: unknown };
      if (st?.error || st?.status === 'error') {
        console.warn('[ActivityPlayer] video error:', status);
      }
    });

    const trackSub = player.addListener('videoTrackChange', ({ videoTrack }) => {
      const size = videoTrack?.size as VideoSize | undefined;
      if (size && size.width > 0 && size.height > 0) {
        setAspectRatio(size.width / size.height);
      }
    });

    const timeSub = player.addListener('timeUpdate', ({ currentTime: t }) => {
      setCurrentTime(t);
    });

    return () => {
      endSub.remove();
      statusSub.remove();
      trackSub.remove();
      timeSub.remove();
      try {
        player.pause();
      } catch {
        // Player already released by the time this instance unmounted.
      }
    };
  }, [player, uri]);

  // The merged captions track was built against this exact file during the merge, so raw player
  // time maps straight onto its cue offsets — no Part 1 duration correction needed.
  const activeCaptionText = useMemo(() => {
    if (!captionCues) return null;
    return (
      captionCues.find((cue) => currentTime >= cue.start && currentTime < cue.end)?.text ?? null
    );
  }, [captionCues, currentTime]);

  return (
    <View
      style={[
        styles.videoContainer,
        { width: CONTAINER_WIDTH, height: clampContainerHeight(aspectRatio) },
      ]}
    >
      <VideoView
        player={player}
        style={styles.video}
        contentFit="cover"
        nativeControls={false}
        allowsVideoFrameAnalysis={false}
      />

      {videoEnded ? (
        <TouchableOpacity
          style={[styles.retryButton, { backgroundColor: accentColor }]}
          onPress={onRetry}
          activeOpacity={0.85}
          accessibilityLabel="Replay video"
        >
          <MaterialCommunityIcons name="replay" size={ms(30)} color={colors.white} />
        </TouchableOpacity>
      ) : null}

      {timerSecondsRemaining !== null ? (
        <View style={styles.timerOverlay} pointerEvents="none">
          <Text style={styles.timerText}>{formatCountdown(timerSecondsRemaining)}</Text>
        </View>
      ) : null}

      {showCaptions && activeCaptionText ? (
        <View style={styles.captionBar} pointerEvents="none">
          <Text style={styles.captionText}>{activeCaptionText}</Text>
        </View>
      ) : null}
    </View>
  );
}

export default function ActivityPlayer({
  activityStep,
  childName,
  avatarId,
  segment,
  stepNumber,
  totalSteps,
  isFinalRemainingStep,
  showCaptions = false,
  onComplete,
}: ActivityPlayerProps) {
  const insets = useSafeAreaInsets();
  const [activityIndex, setActivityIndex] = useState(0);
  const [videoEnded, setVideoEnded] = useState(false);
  const [timerSecondsRemaining, setTimerSecondsRemaining] = useState<number | null>(null);
  const [captionCues, setCaptionCues] = useState<CaptionCue[] | null>(null);
  const [resolved, setResolved] = useState<ResolvedSource | null>(null);
  // Bumped by "Retry Video". Because it is part of the VideoStage key, retrying tears the player
  // down and builds a fresh one on the same file rather than seeking a possibly-stale instance.
  const [retryNonce, setRetryNonce] = useState(0);

  const normalizedSteps = useMemo(() => {
    if (Array.isArray(activityStep)) {
      return activityStep.filter((k): k is ActivityKey => typeof k === 'string' && k.length > 0);
    }
    if (typeof activityStep === 'string' && (activityStep as string).length > 0) {
      return [activityStep as ActivityKey];
    }
    return [] as ActivityKey[];
  }, [activityStep]);

  const currentActivityKey = normalizedSteps[activityIndex] ?? normalizedSteps[0] ?? 'brush_teeth';
  const activity = ACTIVITIES[currentActivityKey] ?? ACTIVITIES['brush_teeth'];
  const safeChildName = (childName || 'friend').trim() || 'friend';
  const safeAvatarId = (avatarId || 'becky').trim() || 'becky';

  // Resolve the single file this activity will play BEFORE any player exists. The merge normally
  // ran during asset preload (assetCacheService -> ensureRoutineMergedVideosReady), so the first
  // lookup is just a cache hit; ensureMergedActivityVideo() is the on-demand catch-up for a step
  // opened before preload finished.
  useEffect(() => {
    let cancelled = false;
    setResolved(null);
    setCaptionCues(null);
    setVideoEnded(false);
    setTimerSecondsRemaining(null);

    async function resolveSource() {
      let mergedUri = await getReadyMergedVideoPath(
        currentActivityKey,
        safeChildName,
        safeAvatarId
      );
      if (cancelled) return;

      if (!mergedUri) {
        console.log(
          `[ActivityPlayer] merged video not cached for ${currentActivityKey} — building now`
        );
        try {
          mergedUri = await ensureMergedActivityVideo(
            currentActivityKey,
            safeChildName,
            safeAvatarId
          );
        } catch (err) {
          console.warn(`[ActivityPlayer] on-demand merge failed for ${currentActivityKey}:`, err);
          mergedUri = null;
        }
        if (cancelled) return;
      }

      if (mergedUri) {
        console.log(`[ActivityPlayer] playing merged video for ${currentActivityKey}: ${mergedUri}`);
        setResolved({ kind: 'merged', uri: mergedUri });
      } else {
        // No merge available (activity has no authored Part 1, or the merge failed). Fall back to
        // the Part 2 clip on its own — it has baked-in narration, so it is still a usable step.
        const p2Uri = localPart2VideoPath(currentActivityKey, safeAvatarId);
        let p2Ready = await isValidCachedVideo(p2Uri);
        if (!p2Ready) {
          const repaired = await ensureActivityVideoReady(currentActivityKey, safeAvatarId);
          p2Ready = repaired.p2Ready;
        }
        if (cancelled) return;
        console.warn(
          `[ActivityPlayer] no merged video for ${currentActivityKey} — falling back to Part 2 only (ready=${p2Ready})`
        );
        setResolved(p2Ready ? { kind: 'single', uri: p2Uri } : { kind: 'unavailable' });
      }

      const cues = await getOrBuildMergedCaptions(
        currentActivityKey,
        safeChildName,
        safeAvatarId,
        0
      );
      if (!cancelled) setCaptionCues(cues);
    }

    resolveSource();

    return () => {
      cancelled = true;
    };
  }, [currentActivityKey, safeChildName, safeAvatarId]);

  const handleVideoEnded = useCallback(() => {
    setVideoEnded(true);
  }, []);

  useEffect(() => {
    if (!videoEnded) {
      setTimerSecondsRemaining(null);
      return;
    }

    setTimerSecondsRemaining(ACTIVITY_TIMER_SECONDS[currentActivityKey]);
    const timer = setInterval(() => {
      setTimerSecondsRemaining((remaining) =>
        remaining === null ? null : Math.max(0, remaining - 1)
      );
    }, 1000);

    return () => clearInterval(timer);
  }, [currentActivityKey, videoEnded]);

  const handleRetryVideo = useCallback(() => {
    setVideoEnded(false);
    setTimerSecondsRemaining(null);
    setRetryNonce((n) => n + 1);
  }, []);

  const handleComplete = useCallback(() => {
    if (!videoEnded || timerSecondsRemaining !== 0) return;

    if (activityIndex < normalizedSteps.length - 1) {
      setVideoEnded(false);
      setTimerSecondsRemaining(null);
      setActivityIndex((prev) => prev + 1);
      return;
    }
    onComplete();
  }, [
    activityIndex,
    normalizedSteps.length,
    onComplete,
    timerSecondsRemaining,
    videoEnded,
  ]);

  if (!activity) return null;

  return (
    <ScrollView
      style={[styles.scrollView, { backgroundColor: activity.color + '22' }]}
      contentContainerStyle={styles.container}
      showsVerticalScrollIndicator={false}
    >
      {/* Progress indicator */}
      <View style={styles.progressRow}>
        {Array.from({ length: totalSteps }).map((_, i) => (
          <View
            key={i}
            style={[
              styles.progressDot,
              { backgroundColor: i < stepNumber ? activity.color : '#DDD' },
            ]}
          />
        ))}
      </View>

      {/* Step counter */}
      <Text style={styles.stepCounter}>
        Step {stepNumber} of {totalSteps}
      </Text>

      {normalizedSteps.length > 1 ? (
        <Text style={styles.subCounter}>
          Part {activityIndex + 1} of {normalizedSteps.length}
        </Text>
      ) : null}

      {/* Activity emoji + label */}
      <Text
        style={[styles.emoji, { top: insets.top + vs(12), right: s(16) }]}
        accessibilityLabel={`${activity.label} activity icon`}
      >
        {activity.emoji}
      </Text>
      <Text
        style={[
          styles.activityLabel,
          segment === 'evening' && styles.activityLabelEvening,
        ]}
      >
        {activity.label}
      </Text>

      {/* Avatar video — one player, one file, created already pointed at that file */}
      {resolved && resolved.kind !== 'unavailable' ? (
        <VideoStage
          key={`${resolved.uri}#${retryNonce}`}
          uri={resolved.uri}
          showCaptions={showCaptions}
          captionCues={captionCues}
          videoEnded={videoEnded}
          timerSecondsRemaining={timerSecondsRemaining}
          accentColor={activity.color}
          onRetry={handleRetryVideo}
          onEnded={handleVideoEnded}
        />
      ) : (
        <View
          style={[
            styles.videoContainer,
            styles.videoPlaceholder,
            { width: CONTAINER_WIDTH, height: clampContainerHeight(DEFAULT_ASPECT_RATIO) },
          ]}
        >
          {resolved?.kind === 'unavailable' ? (
            <Text style={styles.placeholderText}>Video unavailable</Text>
          ) : (
            <>
              <ActivityIndicator size="large" color={activity.color} />
              <Text style={styles.placeholderText}>Getting your video ready…</Text>
            </>
          )}
        </View>
      )}

      {/* Personalized prompt text */}
      <Text style={[styles.promptText, segment === 'evening' && styles.promptTextEvening]}>
        {activity.promptTemplate(childName)}
      </Text>

      {/* Done / Next Mission Complete button */}
      {videoEnded && timerSecondsRemaining === 0 ? (
        <TouchableOpacity
          style={[styles.doneButton, { backgroundColor: activity.color }]}
          onPress={handleComplete}
          activeOpacity={0.85}
        >
          <Text style={styles.doneButtonText}>
            {activityIndex < normalizedSteps.length - 1
              ? '➡️ Next Activity'
              : isFinalRemainingStep
                ? '🎉 All Done!'
                : 'Complete Mission!'}
          </Text>
        </TouchableOpacity>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: s(24),
    paddingTop: vs(56),
    paddingBottom: vs(40),
  },
  progressRow: {
    flexDirection: 'row',
    gap: s(8),
    marginBottom: vs(12),
  },
  progressDot: {
    width: s(12),
    height: s(12),
    borderRadius: ms(6),
  },
  stepCounter: {
    fontSize: fs(14),
    color: '#888',
    marginBottom: vs(8),
    fontWeight: '500',
  },
  subCounter: {
    fontSize: fs(13),
    color: '#666',
    marginBottom: vs(6),
    fontWeight: '600',
  },
  emoji: {
    position: 'absolute',
    fontSize: fs(56),
  },
  activityLabel: {
    fontSize: fs(28),
    fontWeight: '800',
    marginBottom: vs(20),
    textAlign: 'center',
    color: '#1F4A52',
  },
  activityLabelEvening: {
    color: colors.eveningTitle,
  },
  videoContainer: {
    borderRadius: ms(24),
    overflow: 'hidden',
    backgroundColor: '#F0F0F0',
    marginBottom: vs(24),
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: ms(12),
    shadowOffset: { width: s(0), height: vs(4) },
  },
  videoPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: vs(12),
  },
  placeholderText: {
    fontSize: fs(15),
    color: '#777',
    fontWeight: '600',
    textAlign: 'center',
  },
  video: {
    width: '100%',
    height: '100%',
  },
  captionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: s(14),
    paddingVertical: vs(8),
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  timerOverlay: {
    position: 'absolute',
    left: '18%',
    right: '18%',
    bottom: '18%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: vs(10),
    borderRadius: ms(18),
    backgroundColor: 'rgba(0,0,0,0.52)',
  },
  timerText: {
    color: colors.white,
    fontSize: fs(36),
    fontWeight: '900',
    letterSpacing: 1,
  },
  captionText: {
    color: colors.white,
    fontSize: fs(16),
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: fs(20),
  },
  retryButton: {
    position: 'absolute',
    alignSelf: 'center',
    top: '50%',
    marginTop: -ms(26),
    width: ms(52),
    height: ms(52),
    borderRadius: ms(26),
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 5,
  },
  promptText: {
    fontSize: fs(18),
    color: '#5E8A86',
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: fs(26),
    marginBottom: vs(32),
    paddingHorizontal: s(8),
  },
  promptTextEvening: {
    color: colors.eveningSubtitle,
  },
  doneButton: {
    paddingVertical: vs(18),
    paddingHorizontal: s(40),
    borderRadius: ms(50),
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: ms(8),
    shadowOffset: { width: s(0), height: vs(3) },
  },
  doneButtonText: {
    color: colors.white,
    fontSize: fs(20),
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: 0.5,
  },
});
