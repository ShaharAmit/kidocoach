/**
 * On-device video merge pipeline (via `react-native-video-trim`, which bundles FFmpegKit).
 *
 * Produces ONE physical MP4 per (activityKey, avatarId, childName, tone, voice) combo:
 *   [Part 1 video, padded with a frozen last-frame if the personalized TTS outlasts it]
 *   + [that same span, muted, with the TTS dubbed in]
 *   + [Part 2 video, unchanged]
 * merged back-to-back into a single file, so `ActivityPlayer` can play one continuous
 * video instead of juggling two players + a manual "idle hold" pause/timer at runtime.
 *
 * This runs during the asset-preload phase ("just before run"), never during a live routine —
 * consistent with the app's hybrid-cache rule of never generating/encoding media on the fly.
 * Merged output is cached to `FileSystem.documentDirectory`, keyed by a signature of its
 * source files, so it is only rebuilt when Part 1, Part 2, or the TTS audio actually changes.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { merge, mixAudio, trim, isValidFile, cleanFiles, getFrameAt } from 'react-native-video-trim';
import { ActivityKey, ToneOption, VoiceOption } from '../types';
import { isValidCachedVideo } from './assetSync';
import { getReadyPart1AudioPath, ensurePart1AudioReady } from './part1Audio';
import {
  getPart1TimingInfo,
  buildAndCacheMergedCaptions,
  invalidateMergedCaptions,
  localPart1VideoPath,
  localPart2VideoPath,
} from './twoPartVideoService';

const MERGED_VIDEO_DIR = `${FileSystem.documentDirectory}videos/merged/`;
// Scratch space we fully own. Every native op's output is moved here under a unique name
// immediately after it completes — see `claimNativeOutput` for why that is mandatory.
const MERGE_TEMP_DIR = `${MERGED_VIDEO_DIR}tmp/`;
// ~2-3 frames at typical 25-30fps source footage. Long enough to guarantee at least one full,
// complete GOP for `enablePreciseTrimming`'s re-encode to produce a valid, playable mp4 (a
// slice shorter than one frame interval risks "moov atom not found" / a corrupt output that
// poisons every downstream merge) while still short enough that repeating it reads as a frozen
// last frame rather than as slow-motion motion. react-native-video-trim has no image-to-video
// primitive, so this is the closest approximation to a still end-frame achievable with its
// headless trim/merge API.
const FREEZE_FRAME_SLICE_MS = 100;

function sanitize(value: string, fallback: string): string {
  return (value || fallback).toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '_') || fallback;
}

async function ensureMergedDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(MERGED_VIDEO_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(MERGED_VIDEO_DIR, { intermediates: true });
  }
}

async function ensureMergeTempDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(MERGE_TEMP_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(MERGE_TEMP_DIR, { intermediates: true });
  }
}

export function localMergedVideoPath(
  activityKey: ActivityKey | string,
  avatarId: string,
  childName: string
): string {
  const safeActivity = sanitize(activityKey, 'activity');
  const safeAvatar = sanitize(avatarId, 'becky');
  const safeName = sanitize(childName, 'child');
  return `${MERGED_VIDEO_DIR}${safeAvatar}_${safeActivity}_${safeName}_merged.mp4`;
}

function signaturePath(mergedPath: string): string {
  return `${mergedPath}.sig.json`;
}

async function fileSignature(path: string): Promise<string | null> {
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return null;
    const size = 'size' in info && typeof info.size === 'number' ? info.size : 0;
    const mtime = 'modificationTime' in info && typeof info.modificationTime === 'number' ? info.modificationTime : 0;
    return `${size}:${mtime}`;
  } catch {
    return null;
  }
}

// Bump whenever the merge pipeline changes in a way that invalidates previously cached output.
// v2: fixed native-output filename collisions that could bake corrupt/Part-1-only files.
// v3: measure the real Part 1 duration instead of falling back to the 1.1s default, which was
//     baking a bogus freeze-frame pad (visible as a stuttering 3-frame loop) into every merge.
const MERGE_PIPELINE_VERSION = 3;

async function computeSourceSignature(p1Path: string, p2Path: string, audioPath: string): Promise<string> {
  const [p1Sig, p2Sig, audioSig] = await Promise.all([
    fileSignature(p1Path),
    fileSignature(p2Path),
    fileSignature(audioPath),
  ]);
  return `v${MERGE_PIPELINE_VERSION}|${p1Sig}|${p2Sig}|${audioSig}`;
}

type StoredSignature = { signature: string; decodeVerified: boolean };

async function readStoredSignature(mergedPath: string): Promise<StoredSignature | null> {
  try {
    const raw = await FileSystem.readAsStringAsync(signaturePath(mergedPath));
    const parsed = JSON.parse(raw);
    if (typeof parsed?.signature !== 'string') return null;
    return { signature: parsed.signature, decodeVerified: parsed.decodeVerified === true };
  } catch {
    return null;
  }
}

/** Only call after the merged file passed a full-timeline decode check. */
async function writeStoredSignature(mergedPath: string, signature: string): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(
      signaturePath(mergedPath),
      JSON.stringify({ signature, decodeVerified: true })
    );
  } catch {
    // Best-effort — worst case we just rebuild the merged file next time.
  }
}

/**
 * Fast, generation-free lookup for the player: only returns a path when a valid merged file exists
 * AND it was baked from the sources currently on disk.
 */
export async function getReadyMergedVideoPath(
  activityKey: ActivityKey | string,
  childName: string,
  avatarId: string,
  tone?: ToneOption,
  voice?: VoiceOption
): Promise<string | null> {
  const safeName = (childName || 'friend').toString().trim() || 'friend';
  const safeAvatarId = (avatarId || 'becky').toString().trim() || 'becky';
  const path = localMergedVideoPath(activityKey, safeAvatarId, safeName);
  if (!(await isValidCachedVideo(path))) return null;
  // Reject output baked by an older pipeline or from since-replaced sources (e.g. a re-fetched
  // Part 1 clip). The file stays byte-valid either way, so an existence check alone would keep
  // serving the stale merge until the background rebuild replaces it; the caller then joins that
  // rebuild or falls back to Part 2 instead.
  const [stored, audioPath] = await Promise.all([
    readStoredSignature(path),
    getReadyPart1AudioPath(activityKey, safeName, tone, voice),
  ]);
  if (!stored || !audioPath) return null;
  const current = await computeSourceSignature(
    localPart1VideoPath(activityKey, safeAvatarId),
    localPart2VideoPath(activityKey as ActivityKey, safeAvatarId),
    audioPath
  );
  return stored.signature === current ? path : null;
}

async function cleanupTempFiles(paths: string[]): Promise<void> {
  await Promise.allSettled(
    paths.map(async (p) => {
      try {
        await FileSystem.deleteAsync(p, { idempotent: true });
      } catch {
        // Scratch cleanup is best-effort; the OS reclaims it under pressure anyway.
      }
    })
  );
}

/**
 * Serializes every native FFmpegKit invocation across the whole app.
 *
 * `react-native-video-trim` derives its output filename purely from `Int(Date().timeIntervalSince1970)`
 * (e.g. `trimmedVideo_merged_1786966915.mp4`) in the shared Caches directory. Two operations that
 * complete within the same wall-clock *second* therefore target the identical path, and ffmpeg is
 * invoked with `-y` — so one job truncates a file another job is still writing to or reading from.
 * That is what produced the "moov atom not found" / "Invalid NAL unit size" failures when merging
 * several activities via `Promise.allSettled`. Running one native op at a time (combined with
 * `claimNativeOutput` below) removes the collision window entirely.
 */
let nativeOpQueue: Promise<unknown> = Promise.resolve();

function serializeNativeOp<T>(fn: () => Promise<T>): Promise<T> {
  const result = nativeOpQueue.then(fn, fn);
  nativeOpQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

let tempFileSeq = 0;

/**
 * Moves a freshly produced native output out of the library's shared, timestamp-named cache slot
 * into our own uniquely named scratch file.
 *
 * Serialization alone is not sufficient: a *later* op that happens to run in the same second would
 * still pick the same output name as an earlier op's result, and since intermediate results are
 * used as inputs to subsequent steps (tail slice → filler → padded → mixed → final), ffmpeg would
 * end up overwriting its own input mid-read. Claiming the file immediately makes every intermediate
 * immutable for the rest of the pipeline.
 */
async function claimNativeOutput(outputPath: string, label: string): Promise<string> {
  await ensureMergeTempDir();
  const ext = outputPath.split('?')[0].split('.').pop() || 'mp4';
  tempFileSeq += 1;
  const unique = `${MERGE_TEMP_DIR}${Date.now()}_${tempFileSeq}_${sanitize(label, 'op')}.${ext}`;
  await FileSystem.moveAsync({ from: outputPath, to: unique });
  return unique;
}

/**
 * Evenly spaced probe offsets across a clip, inset from both edges.
 *
 * Density matters: `AVAssetImageGenerator` seeks with a ±0.1 s tolerance, so a sparse sample can
 * snap onto an intact keyframe and miss a damaged span entirely. Measured against real corrupt
 * merges, 3 samples missed the damage while 10 caught it.
 */
function probeTimesMs(startMs: number, endMs: number, count = 10): number[] {
  const from = Math.max(0, startMs);
  const to = Math.max(from + 1, endMs);
  const span = to - from;
  return Array.from({ length: count }, (_, i) => from + (span * (i + 0.5)) / count);
}

/**
 * Decodes real frames at the given offsets to prove the stream is intact there.
 *
 * `isValidFile` only reads the container: a merge whose H.264 bitstream is corrupt still reports
 * `isValid: true` with the correct total duration, and then plays Part 1 and stalls at the splice
 * — exactly the "only Part 1 plays" symptom. `AVAssetImageGenerator` (behind `getFrameAt`) actually
 * decodes, so it throws on the broken NAL units that a container-level check sails past.
 */
async function assertRegionDecodes(path: string, label: string, timesMs: number[]): Promise<void> {
  for (const time of timesMs) {
    const at = Math.max(0, Math.round(time));
    let frame: { outputPath: string };
    try {
      frame = await getFrameAt(path, { time: at, maxWidth: 64 });
    } catch (err) {
      throw new Error(`${label} could not decode a frame at ${at}ms: ${String(err)}`);
    }
    try {
      await FileSystem.deleteAsync(frame.outputPath, { idempotent: true });
    } catch {
      // Probe thumbnails are tiny and live in OS-managed cache; cleanup is best-effort.
    }
  }
}

/** Verifies a native output actually decodes, rather than merely existing on disk. */
async function assertPlayable(path: string, label: string): Promise<number> {
  const sizeOk = await isValidCachedVideo(path);
  if (!sizeOk) throw new Error(`${label} produced a missing/undersized output`);
  try {
    const validation = await isValidFile(path);
    if (!validation?.isValid || !(validation.duration > 0)) {
      throw new Error(`${label} produced an undecodable output (duration ${validation?.duration})`);
    }
    return validation.duration;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(label)) throw err;
    throw new Error(`${label} output validation failed: ${String(err)}`);
  }
}

/**
 * Reads a local clip's real duration in **seconds** (`isValidFile` reports milliseconds).
 *
 * Returns `undefined` rather than throwing so callers can degrade to their own default: a
 * failed probe should not abort an otherwise buildable merge.
 */
async function probeDurationSeconds(path: string): Promise<number | undefined> {
  try {
    const validation = await isValidFile(path);
    const ms = validation?.duration;
    return typeof ms === 'number' && ms > 0 ? ms / 1000 : undefined;
  } catch {
    return undefined;
  }
}

type NativeMediaResult = { outputPath: string; duration?: number };

/**
 * Runs one native media op: serialized, retried, output claimed to a unique path, and validated.
 *
 * Retries remain useful on top of the collision fix because the iOS Simulator's
 * `h264_videotoolbox` encoder is software-emulated and can still intermittently emit corrupt
 * output under load. Real devices use hardware encoders and do not show that flakiness.
 */
async function runNativeMediaOp(
  label: string,
  fn: () => Promise<NativeMediaResult>,
  options: { attempts?: number; validate?: (claimedPath: string, duration: number) => Promise<void> } = {}
): Promise<{ outputPath: string; duration: number }> {
  const { attempts = 3, validate } = options;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let claimed: string | null = null;
    try {
      const result = await serializeNativeOp(fn);
      if (!result?.outputPath) throw new Error(`${label} returned no output path`);
      claimed = await claimNativeOutput(result.outputPath, label);
      const probedDuration = await assertPlayable(claimed, label);
      const duration = result.duration ?? probedDuration;
      // Runs outside the serialized section on purpose: the hook itself issues native calls,
      // and re-entering the queue from inside a queued op would deadlock.
      if (validate) await validate(claimed, duration);
      return { outputPath: claimed, duration };
    } catch (err) {
      lastErr = err;
      if (claimed) await cleanupTempFiles([claimed]);
      console.warn(`[VideoMerge] ${label} failed (attempt ${attempt}/${attempts}):`, err);
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      }
    }
  }
  throw lastErr;
}

// Keyed by merged output path: the background preload and an on-demand player request for the
// same activity must share one build instead of racing to write the same file.
const mergeInFlight = new Map<string, Promise<string | null>>();

/**
 * Builds (or reuses the cached) merged single-file video for one activity + child, and keeps
 * the merged caption track in sync with it. Returns `null` if source assets aren't downloaded
 * yet, or if the on-device merge fails for any reason — callers should treat that as "not ready"
 * and fall back to runtime two-part playback rather than failing the routine.
 */
export function ensureMergedActivityVideo(
  activityKey: ActivityKey,
  childName: string,
  avatarId: string,
  tone?: ToneOption,
  voice?: VoiceOption
): Promise<string | null> {
  const safeName = (childName || 'friend').toString().trim() || 'friend';
  const safeAvatarId = (avatarId || 'becky').toString().trim() || 'becky';
  const mergedPath = localMergedVideoPath(activityKey, safeAvatarId, safeName);

  const existing = mergeInFlight.get(mergedPath);
  if (existing) return existing;

  const promise = buildMergedActivityVideo(activityKey, safeName, safeAvatarId, mergedPath, tone, voice)
    .finally(() => {
      if (mergeInFlight.get(mergedPath) === promise) mergeInFlight.delete(mergedPath);
    });
  mergeInFlight.set(mergedPath, promise);
  return promise;
}

async function buildMergedActivityVideo(
  activityKey: ActivityKey,
  safeName: string,
  safeAvatarId: string,
  mergedPath: string,
  tone?: ToneOption,
  voice?: VoiceOption
): Promise<string | null> {
  const p1Path = localPart1VideoPath(activityKey, safeAvatarId);
  const p2Path = localPart2VideoPath(activityKey, safeAvatarId);

  const [p1Exists, p2Exists] = await Promise.all([
    isValidCachedVideo(p1Path),
    isValidCachedVideo(p2Path),
  ]);
  // No Part 1 clip authored for this activity — nothing to merge; player falls back to
  // playing Part 2 alone, exactly as it already does today.
  if (!p1Exists || !p2Exists) return null;

  let audioPath = await getReadyPart1AudioPath(activityKey, safeName, tone, voice);
  if (!audioPath) {
    audioPath = await ensurePart1AudioReady(activityKey, safeName, tone, voice);
  }
  if (!audioPath) return null; // TTS still generating — retry on a later preload pass

  const signature = await computeSourceSignature(p1Path, p2Path, audioPath);
  const [mergedExists, stored] = await Promise.all([
    isValidCachedVideo(mergedPath),
    readStoredSignature(mergedPath),
  ]);
  if (mergedExists && stored?.signature === signature) {
    // Files written by this pipeline were decode-verified before the signature was stored, so a
    // matching signature is trusted as-is. Re-decoding ~10 frames per activity on every preload
    // made each cold start pay seconds of native work for files that never change.
    if (stored.decodeVerified) return mergedPath;
    // Legacy entries (no verification marker) may carry a damaged bitstream from an earlier,
    // buggy pass — verify once, then mark so later passes take the fast path above.
    try {
      const duration = await assertPlayable(mergedPath, `cached ${activityKey}`);
      await assertRegionDecodes(mergedPath, `cached ${activityKey}`, probeTimesMs(0, duration));
      await writeStoredSignature(mergedPath, signature);
      return mergedPath;
    } catch (err) {
      console.warn(`[VideoMerge] Cached merge for ${activityKey} failed re-validation, rebuilding:`, err);
      await FileSystem.deleteAsync(mergedPath, { idempotent: true });
      await FileSystem.deleteAsync(signaturePath(mergedPath), { idempotent: true });
      await invalidateMergedCaptions(activityKey, safeAvatarId, safeName);
    }
  }

  const tempOutputs: string[] = [];

  try {
    // Measure the Part 1 clip rather than letting `getPart1TimingInfo` fall back to its
    // DEFAULT_PART1_VIDEO_DURATION_SECONDS (1.1s) placeholder. That fallback is far shorter than
    // any real greeting clip (2.1–4.2s), so `idleHoldDuration = audio - 1.1` came out positive for
    // *every* activity and baked a freeze-frame pad into every merge — even though the TTS is in
    // fact shorter than the video and no hold is needed at all. The pad is built by repeating a
    // ~3-frame tail slice, so it played back as a visible stutter loop between the greeting and
    // Part 2, and it desynced the captions by the same amount.
    const measuredPart1Duration = await probeDurationSeconds(p1Path);
    const timing = await getPart1TimingInfo(
      activityKey,
      safeName,
      safeAvatarId,
      tone,
      voice,
      measuredPart1Duration
    );

    let paddedPart1Path = p1Path;

    if (timing.idleHoldDuration > 0) {
      const videoDurationMs = Math.max(1, Math.round(timing.videoDuration * 1000));
      const sliceMs = Math.min(FREEZE_FRAME_SLICE_MS, videoDurationMs);
      const tailStart = Math.max(0, videoDurationMs - sliceMs);

      const tailClip = await runNativeMediaOp(`trim ${activityKey} tail-slice`, () =>
        trim(p1Path, {
          startTime: tailStart,
          endTime: videoDurationMs,
          // Critical: the default fast path (stream-copy, `-c copy`) can only cut at keyframes,
          // and for a slice this short there's often no complete GOP to copy — it silently
          // produces a corrupt/truncated output ("moov atom not found") that then poisons every
          // downstream merge. Forcing a real re-encode here is the only way to reliably get a
          // valid, frame-accurate mp4 out of such a tiny clip.
          enablePreciseTrimming: true,
        })
      );
      tempOutputs.push(tailClip.outputPath);

      const neededMs = Math.round(timing.idleHoldDuration * 1000);
      // Repeat based on what the trim *actually* produced, not the requested slice length. A
      // 100ms request lands on whole frames (~120ms at 25fps), so counting in nominal slices
      // overshot the hold by ~20% every time.
      const actualSliceMs = tailClip.duration > 0 ? tailClip.duration : sliceMs;
      const repeatCount = Math.max(1, Math.ceil(neededMs / actualSliceMs));
      const fillerInputs = Array.from({ length: repeatCount }, () => tailClip.outputPath);

      const filler =
        fillerInputs.length > 1
          ? await runNativeMediaOp(`merge ${activityKey} filler`, () => merge(fillerInputs))
          : tailClip;
      if (fillerInputs.length > 1) tempOutputs.push(filler.outputPath);

      const padded = await runNativeMediaOp(`merge ${activityKey} padded part1`, () =>
        merge([p1Path, filler.outputPath])
      );
      tempOutputs.push(padded.outputPath);
      paddedPart1Path = padded.outputPath;
    }

    // Dub the personalized TTS over the (possibly padded) Part 1 clip, replacing its
    // original audio entirely (Part 1 ships muted/silent in the source assets).
    const part1WithAudio = await runNativeMediaOp(`mixAudio ${activityKey}`, () =>
      mixAudio(paddedPart1Path, audioPath, {
        originalAudioVolume: 0,
        backgroundAudioVolume: 1,
      })
    );
    tempOutputs.push(part1WithAudio.outputPath);

    // Wrap the final merge + sanity check together so a retry gets a completely fresh
    // ffmpeg invocation (not just a re-check of a possibly-corrupt cached result) if the
    // encoder silently drops Part 2 (observed as a 0ms/undersized output on Simulator).
    const finalMerge = await runNativeMediaOp(
      `merge ${activityKey} final`,
      async () => {
        const result = await merge([part1WithAudio.outputPath, p2Path]);
        if (result.duration <= part1WithAudio.duration + 200) {
          throw new Error(
            `Merged output (${result.duration}ms) is not longer than Part 1 alone (${part1WithAudio.duration}ms) — Part 2 was likely not included.`
          );
        }
        return result;
      },
      {
        // Sample densely across the whole timeline. A container-valid but bitstream-corrupt merge
        // decodes Part 1 fine and dies partway through, which is precisely the failure the player
        // surfaces as "only Part 1 plays".
        validate: async (claimedPath, duration) => {
          await assertRegionDecodes(
            claimedPath,
            `merge ${activityKey} final`,
            probeTimesMs(0, duration)
          );
        },
      }
    );
    tempOutputs.push(finalMerge.outputPath);

    await ensureMergedDir();
    const existing = await FileSystem.getInfoAsync(mergedPath);
    if (existing.exists) {
      await FileSystem.deleteAsync(mergedPath, { idempotent: true });
    }
    await FileSystem.copyAsync({ from: finalMerge.outputPath, to: mergedPath });

    try {
      const duration = await assertPlayable(mergedPath, `merged ${activityKey}`);
      await assertRegionDecodes(mergedPath, `merged ${activityKey}`, probeTimesMs(0, duration));
    } catch (err) {
      console.warn(`[VideoMerge] Discarding unplayable merged file for ${activityKey}:`, err);
      await FileSystem.deleteAsync(mergedPath, { idempotent: true });
      await FileSystem.deleteAsync(signaturePath(mergedPath), { idempotent: true });
      await invalidateMergedCaptions(activityKey, safeAvatarId, safeName);
      return null;
    }

    await writeStoredSignature(mergedPath, signature);

    // Keep the merged caption track (used by ActivityPlayer to overlay subtitles) in lockstep
    // with the exact Part 1 span baked into this merged file. Use the *measured* duration of the
    // dubbed Part 1 segment rather than `timing.effectivePart1Duration`: freeze-frame padding is
    // built from whole-frame slices, so the encoded result rarely lands exactly on the predicted
    // value, and any drift shifts every Part 2 subtitle.
    const bakedPart1Duration =
      part1WithAudio.duration > 0 ? part1WithAudio.duration / 1000 : timing.effectivePart1Duration;
    await buildAndCacheMergedCaptions(activityKey, safeName, safeAvatarId, bakedPart1Duration);

    return mergedPath;
  } catch (err) {
    console.warn(`[VideoMerge] Failed to build merged video for ${activityKey} / "${safeName}":`, err);
    return null;
  } finally {
    await cleanupTempFiles(tempOutputs);
  }
}

/** Batch-builds merged videos for every unique activity in a routine. Best-effort, non-blocking
 * per activity — one failure/not-ready activity never blocks the others. */
export async function ensureRoutineMergedVideosReady(
  activityKeys: ActivityKey[],
  childName: string,
  avatarId: string,
  tone?: ToneOption,
  voice?: VoiceOption
): Promise<void> {
  const uniqueKeys = Array.from(new Set(activityKeys));
  await Promise.allSettled(
    uniqueKeys.map((key) => ensureMergedActivityVideo(key, childName, avatarId, tone, voice))
  );
  // Drop any scratch files left behind by an aborted/failed pass so the temp dir can't grow
  // unbounded across preloads — but never while another build (e.g. the player's on-demand
  // merge) is still using it.
  if (mergeInFlight.size > 0) return;
  try {
    await FileSystem.deleteAsync(MERGE_TEMP_DIR, { idempotent: true });
  } catch {
    // Best-effort.
  }
}

/**
 * Deletes a routine's cached merged videos + signatures (e.g. on "Clear Cached Assets"), plus
 * every scratch file `react-native-video-trim` has ever emitted.
 *
 * `cleanFiles()` matters because headless `trim` writes its output straight into the app's
 * Documents root (and `merge`/`mixAudio` into Caches) under library-owned `trimmedVideo_*` names.
 * A crashed/aborted merge pass can leave those behind where nothing else would ever reclaim them.
 */
export async function clearAllMergedVideos(): Promise<void> {
  const info = await FileSystem.getInfoAsync(MERGED_VIDEO_DIR);
  if (info.exists) {
    await FileSystem.deleteAsync(MERGED_VIDEO_DIR, { idempotent: true });
  }
  try {
    await cleanFiles();
  } catch {
    // Best-effort — leftover scratch is harmless now that every op claims its own output.
  }
}
