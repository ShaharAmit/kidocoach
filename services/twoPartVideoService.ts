import * as FileSystem from 'expo-file-system/legacy';
import { ActivityKey, CaptionCue, ToneOption, VoiceOption } from '../types';
import {
  ensureCaptionsData,
  localCaptionsPath,
  localVideoPath,
  localPart1VideoPath as sanitizedLocalPart1VideoPath,
} from './assetSync';
import { localPart1AudioPath } from './part1Audio';

const CAPTIONS_DIR = `${FileSystem.documentDirectory}captions/`;
const DEFAULT_PART1_VIDEO_DURATION_SECONDS = 1.1; // Default fallback for HeyGen part 1 clips

export interface Part1TimingInfo {
  audioDuration: number;
  videoDuration: number;
  effectivePart1Duration: number;
  idleHoldDuration: number;
  isAudioLonger: boolean;
}

/** Returns the local file path for Part 1 video — reuses assetSync's sanitized path builder so
 * download and playback always resolve to the exact same file (previously this file had its own
 * unsanitized copy, which could diverge from the sanitized path used when downloading). */
export function localPart1VideoPath(activityKey: ActivityKey | string, avatarId: string): string {
  return sanitizedLocalPart1VideoPath(activityKey, avatarId);
}

/** Returns the local file path for Part 2 (main) video */
export function localPart2VideoPath(activityKey: ActivityKey, avatarId: string): string {
  return localVideoPath(activityKey, avatarId);
}

/** Returns the local file path for merged captions */
export function localMergedCaptionsPath(
  activityKey: ActivityKey | string,
  avatarId: string,
  childName: string
): string {
  const safeActivity = (activityKey || 'activity').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '_') || 'activity';
  const safeName = (childName || 'child').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '_') || 'child';
  return `${CAPTIONS_DIR}${avatarId}_${safeActivity}_merged_${safeName}.json`;
}

/**
 * Calculates audio duration in seconds from a local WAV file.
 * Reads WAV RIFF header if available or estimates from byte size at 24kHz 16-bit mono (48,000 bytes/sec).
 */
export async function getWavAudioDuration(localPath: string): Promise<number> {
  if (!localPath) return 0;
  try {
    const info = await FileSystem.getInfoAsync(localPath);
    if (!info.exists || !('size' in info) || typeof info.size !== 'number' || info.size <= 44) {
      return 0;
    }

    const fileSize = info.size;

    // Read first 44 bytes to parse header
    const base64Header = await FileSystem.readAsStringAsync(localPath, {
      encoding: FileSystem.EncodingType.Base64,
      position: 0,
      length: 44,
    });

    if (typeof atob === 'function') {
      const binary = atob(base64Header);
      if (binary.length >= 44 && binary.substring(0, 4) === 'RIFF') {
        const byteRate =
          binary.charCodeAt(28) |
          (binary.charCodeAt(29) << 8) |
          (binary.charCodeAt(30) << 16) |
          (binary.charCodeAt(31) << 24);

        const dataSize =
          binary.charCodeAt(40) |
          (binary.charCodeAt(41) << 8) |
          (binary.charCodeAt(42) << 16) |
          (binary.charCodeAt(43) << 24);

        const effectiveDataSize =
          dataSize > 0 && dataSize <= fileSize ? dataSize : Math.max(0, fileSize - 44);
        const effectiveByteRate = byteRate > 0 ? byteRate : 48000;
        return Number((effectiveDataSize / effectiveByteRate).toFixed(3));
      }
    }

    // Fallback: standard 24kHz 16-bit mono PCM is 48,000 bytes/sec
    return Number(((fileSize - 44) / 48000).toFixed(3));
  } catch (err) {
    console.warn('[TwoPartVideo] Failed to calculate WAV duration:', err);
    return 0;
  }
}

/**
 * Pre-checks timing between Part 1 video and Part 1 TTS audio.
 * If audio is longer than video, calculates the idle hold duration needed for the last frame.
 */
export async function getPart1TimingInfo(
  activityKey: ActivityKey | string,
  childName: string,
  avatarId: string,
  tone?: ToneOption,
  voice?: VoiceOption,
  knownVideoDuration?: number
): Promise<Part1TimingInfo> {
  if (!activityKey) {
    return {
      audioDuration: 0,
      videoDuration: 0,
      effectivePart1Duration: 0,
      idleHoldDuration: 0,
      isAudioLonger: false,
    };
  }

  const safeName = (childName || 'friend').toString().trim() || 'friend';
  const audioPath = localPart1AudioPath(activityKey, safeName, tone, voice);
  const audioDuration = await getWavAudioDuration(audioPath);

  const videoDuration =
    typeof knownVideoDuration === 'number' && knownVideoDuration > 0
      ? knownVideoDuration
      : DEFAULT_PART1_VIDEO_DURATION_SECONDS;

  const effectivePart1Duration = Math.max(videoDuration, audioDuration);
  const idleHoldDuration = Math.max(0, Number((audioDuration - videoDuration).toFixed(3)));
  const isAudioLonger = audioDuration > videoDuration;

  return {
    audioDuration,
    videoDuration,
    effectivePart1Duration,
    idleHoldDuration,
    isAudioLonger,
  };
}

/**
 * Builds and caches merged caption cues on device. The downloaded `{activityKey}_captions.json`
 * file already contains the full authored transcript — cue[0] is the Part 1 greeting line
 * (spanning its authored/recorded Part 1 video duration) and the remaining cues are the Part 2
 * narration (already timed relative to cue[0].end). Since the personalized Part 1 audio can run
 * longer than the authored greeting video (idle-hold), we only need to shift cues by the *delta*
 * between the effective (audio-driven) Part 1 duration and the authored one — not by the full
 * effective duration, which would double-count and duplicate the greeting caption.
 */
export async function buildAndCacheMergedCaptions(
  activityKey: ActivityKey,
  childName: string,
  avatarId: string,
  effectivePart1Duration: number
): Promise<CaptionCue[]> {
  const trimmedName = (childName ?? '').trim() || 'friend';
  const rawCues = await ensureCaptionsData(activityKey, avatarId);

  const interpolate = (text: string) =>
    text.replace(/\{\{\s*name\s*\}\}/gi, trimmedName).replace(/\{name\}/gi, trimmedName);

  if (!rawCues || rawCues.length === 0) {
    // No authored captions for this activity — nothing to merge.
    return [];
  }

  const [rawPart1Cue, ...rawPart2Cues] = rawCues;
  const authoredPart1Duration = Math.max(0, rawPart1Cue.end - rawPart1Cue.start);
  const resolvedEffectiveDuration =
    effectivePart1Duration > 0 ? effectivePart1Duration : authoredPart1Duration;
  const delta = Number((resolvedEffectiveDuration - authoredPart1Duration).toFixed(3));

  const part1Cue: CaptionCue = {
    start: 0,
    end: Number(resolvedEffectiveDuration.toFixed(3)),
    text: interpolate(rawPart1Cue.text),
  };

  const adjustedPart2Cues: CaptionCue[] = rawPart2Cues.map((cue) => ({
    start: Number((cue.start + delta).toFixed(3)),
    end: Number((cue.end + delta).toFixed(3)),
    text: interpolate(cue.text),
  }));

  const mergedCues: CaptionCue[] = [part1Cue, ...adjustedPart2Cues];

  // Cache to device storage
  try {
    const localMergedPath = localMergedCaptionsPath(activityKey, avatarId, trimmedName);
    await FileSystem.writeAsStringAsync(localMergedPath, JSON.stringify(mergedCues));
  } catch (err) {
    console.warn('[TwoPartVideo] Failed to write merged captions to cache:', err);
  }

  return mergedCues;
}

/**
 * Drops the cached merged caption track for a child + activity.
 *
 * `getOrBuildMergedCaptions` returns the cached file whenever one exists and ignores the
 * `effectivePart1Duration` it was handed, so a track written against a stale Part 1 span would
 * otherwise keep mistiming every Part 2 cue forever. Call this whenever the merged video that the
 * track was timed against is discarded or rebuilt.
 */
export async function invalidateMergedCaptions(
  activityKey: ActivityKey | string,
  avatarId: string,
  childName: string
): Promise<void> {
  try {
    await FileSystem.deleteAsync(localMergedCaptionsPath(activityKey, avatarId, childName), {
      idempotent: true,
    });
  } catch {
    // Best-effort: worst case the next merge overwrites it anyway.
  }
}

/**
 * Loads cached merged captions if already generated, otherwise builds them.
 */
export async function getOrBuildMergedCaptions(
  activityKey: ActivityKey,
  childName: string,
  avatarId: string,
  effectivePart1Duration: number
): Promise<CaptionCue[]> {
  const localMergedPath = localMergedCaptionsPath(activityKey, avatarId, childName);
  try {
    const info = await FileSystem.getInfoAsync(localMergedPath);
    if (info.exists) {
      const raw = await FileSystem.readAsStringAsync(localMergedPath);
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as CaptionCue[];
      }
    }
  } catch {
    // If cache read fails, rebuild.
  }

  return buildAndCacheMergedCaptions(activityKey, childName, avatarId, effectivePart1Duration);
}
