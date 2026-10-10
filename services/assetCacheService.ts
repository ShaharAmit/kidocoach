import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDownloadURL, getMetadata, ref } from 'firebase/storage';
import { storage } from './firebase';
import { ensureAudioForRoutine } from './tts';
import { ensureRoutinePart1AudioReady } from './part1Audio';
import { Routine } from '../types';
import { clearAllRoutineAssets, syncRoutineAssets, areAssetsReady } from './assetSync';
import { clearHomeBootstrap, markRoutineWarmed } from './homeBootstrap';
import { clearAllMergedVideos, ensureRoutineMergedVideosReady } from './videoMerge';

const WELCOME_VIDEO_STORAGE_PATH = 'avatars/default/welcome.mp4';

const WELCOME_DIR = `${FileSystem.documentDirectory}welcome/`;
const WELCOME_VIDEO_PATH = `${WELCOME_DIR}welcome.mp4`;
const MIN_WELCOME_VIDEO_FILE_BYTES = 16 * 1024;
const WELCOME_VIDEO_META_KEY = 'welcome_video_meta_v1';

type WelcomeVideoMetadata = {
  generation?: string;
  etag?: string;
  updated?: string;
  size?: string | number;
};

let isWarmupRunning = false;

type CacheProgressStage = 'idle' | 'downloading-welcome' | 'warming-assets' | 'done';

type CacheStatus = {
  stage: CacheProgressStage;
  total: number;
  ready: number;
};

const status: CacheStatus = {
  stage: 'idle',
  total: 0,
  ready: 0,
};

const listeners = new Set<(next: CacheStatus) => void>();

function emitStatus() {
  listeners.forEach((listener) => listener({ ...status }));
}

async function ensureWelcomeDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(WELCOME_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(WELCOME_DIR, { intermediates: true });
  }
}

async function isValidCachedWelcomeVideo(localPath: string): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(localPath);
  if (!info.exists) return false;

  const size = 'size' in info && typeof info.size === 'number' ? info.size : 0;
  return size >= MIN_WELCOME_VIDEO_FILE_BYTES;
}

async function readStoredWelcomeVideoMeta(): Promise<WelcomeVideoMetadata | null> {
  try {
    const raw = await AsyncStorage.getItem(WELCOME_VIDEO_META_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WelcomeVideoMetadata;
    return parsed;
  } catch {
    return null;
  }
}

async function writeStoredWelcomeVideoMeta(meta: WelcomeVideoMetadata): Promise<void> {
  try {
    await AsyncStorage.setItem(WELCOME_VIDEO_META_KEY, JSON.stringify(meta));
  } catch {
    // Ignore storage write failures; asset can still play.
  }
}

function isSameRemoteVersion(
  localMeta: WelcomeVideoMetadata | null,
  remoteMeta: WelcomeVideoMetadata
): boolean {
  if (!localMeta) return false;

  if (localMeta.generation && remoteMeta.generation) {
    return localMeta.generation === remoteMeta.generation;
  }

  if (localMeta.etag && remoteMeta.etag) {
    return localMeta.etag === remoteMeta.etag;
  }

  if (localMeta.updated && remoteMeta.updated) {
    return localMeta.updated === remoteMeta.updated;
  }

  return false;
}

async function downloadOrRepairWelcomeVideo(remotePath: string, localPath: string): Promise<void> {
  const hasValidCachedVideo = await isValidCachedWelcomeVideo(localPath);

  let remoteMeta: WelcomeVideoMetadata | null = null;
  const remoteRef = ref(storage, remotePath);
  try {
    const remoteMetaResponse = await getMetadata(remoteRef);
    remoteMeta = {
      generation: remoteMetaResponse.generation,
      etag: remoteMetaResponse.md5Hash,
      updated: remoteMetaResponse.updated,
      size: remoteMetaResponse.size,
    };
  } catch (err) {
    // If offline or network error, keep using the valid cached video on device
    if (hasValidCachedVideo) {
      return;
    }
    throw err;
  }

  const storedMeta = await readStoredWelcomeVideoMeta();

  const localInfo = await FileSystem.getInfoAsync(localPath);
  const localSize = 'size' in localInfo && typeof localInfo.size === 'number' ? localInfo.size : undefined;
  const remoteSize = remoteMeta?.size !== undefined ? Number(remoteMeta.size) : undefined;
  const sizeMatches =
    typeof localSize === 'number' && typeof remoteSize === 'number'
      ? localSize === remoteSize
      : true;

  const remoteUnchanged = remoteMeta ? isSameRemoteVersion(storedMeta, remoteMeta) : false;
  if (hasValidCachedVideo && remoteUnchanged && sizeMatches) {
    return;
  }

  const existing = await FileSystem.getInfoAsync(localPath);
  if (existing.exists) {
    await FileSystem.deleteAsync(localPath, { idempotent: true });
  }

  const remoteUrl = await getDownloadURL(remoteRef);
  const downloadResult = await FileSystem.downloadAsync(remoteUrl, localPath);

  const status = (downloadResult as { status?: number }).status;
  if (typeof status === 'number' && status >= 400) {
    await FileSystem.deleteAsync(localPath, { idempotent: true });
    throw new Error(`[WelcomeAssets] download failed (${status}) for ${remoteUrl}`);
  }

  const isValid = await isValidCachedWelcomeVideo(localPath);
  if (!isValid) {
    await FileSystem.deleteAsync(localPath, { idempotent: true });
    throw new Error(`[WelcomeAssets] downloaded video is invalid or too small: ${remoteUrl}`);
  }

  if (remoteMeta) {
    await writeStoredWelcomeVideoMeta(remoteMeta);
  }
}

export async function downloadWelcomeAssets(): Promise<{
  videoPath: string;
}> {
  status.stage = 'downloading-welcome';
  emitStatus();

  await ensureWelcomeDir();
  await downloadOrRepairWelcomeVideo(WELCOME_VIDEO_STORAGE_PATH, WELCOME_VIDEO_PATH);

  status.stage = 'done';
  emitStatus();

  return {
    videoPath: WELCOME_VIDEO_PATH,
  };
}

export function getWelcomeAssetPaths() {
  return {
    videoPath: WELCOME_VIDEO_PATH,
  };
}

export function subscribeAssetCacheStatus(listener: (next: CacheStatus) => void) {
  listeners.add(listener);
  listener({ ...status });
  return () => listeners.delete(listener);
}

export async function preloadRoutineAssetsInBackground(routine: Routine): Promise<void> {
  if (isWarmupRunning) return;
  isWarmupRunning = true;
  markRoutineWarmed(routine.id, false);
  status.stage = 'warming-assets';
  status.total = routine.activityStack.flat().length;
  status.ready = 0;
  emitStatus();

  try {
    await Promise.allSettled([
      ensureAudioForRoutine(routine),
      ensureRoutinePart1AudioReady(routine),
    ]);
    const result = await syncRoutineAssets(routine);
    status.ready = status.total - result.missingAudioKeys.length;
    markRoutineWarmed(routine.id, result.missingAudioKeys.length === 0);

    // Build merged single-file videos (Part 1 [+ freeze-frame pad] + dubbed TTS + Part 2) for
    // every activity now that sources are on disk. Best-effort — the player falls back to
    // runtime two-part playback for any activity this doesn't finish in time.
    const uniqueActivityKeys = Array.from(new Set(routine.activityStack.flat()));
    ensureRoutineMergedVideosReady(
      uniqueActivityKeys,
      routine.childName,
      routine.avatarId,
      routine.tone,
      routine.voice
    ).catch(() => {});
  } catch {
    status.ready = 0;
    markRoutineWarmed(routine.id, false);
  } finally {
    status.stage = 'done';
    emitStatus();
    isWarmupRunning = false;
  }
}

/**
 * Fully warms and downloads all assets for given routine(s) to completion before proceeding.
 * Does not resolve until all videos, captions, and Part 1 audio files exist on device storage.
 * Skips redundant operations if all required assets already exist on device.
 */
export async function warmAllRoutineAssetsToCompletion(
  routines: Routine[],
  onProgress?: (stageText: string, progressPercent: number) => void,
  options: { awaitMergedVideos?: boolean } = {}
): Promise<void> {
  if (!routines || routines.length === 0) return;
  const { awaitMergedVideos = true } = options;

  status.stage = 'warming-assets';
  emitStatus();

  // Builds (or reuses) the merged single-file videos for every activity in every routine.
  // Cheap when they're already current — `ensureMergedActivityVideo` short-circuits on a matching
  // source signature — but essential to run on *every* path, including the fast path below:
  // `areAssetsReady` only inspects the raw sources (videos/audio/captions) and knows nothing about
  // merged output, so an early return would leave a stale or missing merge in place indefinitely
  // (e.g. after a MERGE_PIPELINE_VERSION bump invalidates previously cached files).
  const buildMergedVideos = async () => {
    for (const r of routines) {
      const uniqueActivityKeys = Array.from(new Set(r.activityStack.flat()));
      await ensureRoutineMergedVideosReady(uniqueActivityKeys, r.childName, r.avatarId, r.tone, r.voice);
    }
  };
  // Merges are a playback optimization over sources that are already on disk (ActivityPlayer
  // joins an in-flight build or falls back to Part 2), so cold starts don't wait on FFmpeg work.
  const finishMergedVideos = async () => {
    if (awaitMergedVideos) {
      await buildMergedVideos();
      return;
    }
    buildMergedVideos().catch((err) => {
      console.warn('[AssetCache] Background merged-video build failed:', err);
    });
  };

  // Fast-path: Check if everything is already ready on disk
  const readinessChecks = await Promise.all(routines.map((r) => areAssetsReady(r)));
  const allAlreadyReady = readinessChecks.every(Boolean);

  if (allAlreadyReady) {
    await finishMergedVideos();
    for (const r of routines) {
      markRoutineWarmed(r.id, true);
    }
    status.stage = 'done';
    emitStatus();
    onProgress?.('Ready!', 100);
    return;
  }

  onProgress?.('Generating personalized voice...', 60);

  // 1. Request and wait for Part 1 greeting audio across all routines (skips cached keys)
  await Promise.all(routines.map((r) => ensureRoutinePart1AudioReady(r)));

  onProgress?.('Downloading routine videos and animations...', 75);

  // 2. Download all missing routine assets (videos, captions, audio)
  await Promise.all(routines.map((r) => syncRoutineAssets(r)));

  onProgress?.('Finalizing experience on device...', 90);

  // 3. Verification & retry loop (up to 4 attempts)
  for (let attempt = 0; attempt < 4; attempt++) {
    let allReady = true;
    for (const r of routines) {
      const ready = await areAssetsReady(r);
      if (!ready) {
        allReady = false;
        await syncRoutineAssets(r);
      }
    }
    if (allReady) break;
    await new Promise((res) => setTimeout(res, 1200));
  }

  // 4. Build merged single-file videos for every activity so the routine plays with zero
  // on-the-fly encoding. Best-effort — a routine whose merge isn't finished yet simply falls
  // back to runtime two-part playback in ActivityPlayer.
  await finishMergedVideos();

  for (const r of routines) {
    markRoutineWarmed(r.id, true);
  }

  status.stage = 'done';
  emitStatus();
  onProgress?.('Ready!', 100);
}

/**
 * Clears all locally cached media and metadata.
 */
export async function clearAllLocalCachedAssets(): Promise<void> {
  await clearAllRoutineAssets();
  await clearAllMergedVideos();

  const welcomeDirInfo = await FileSystem.getInfoAsync(WELCOME_DIR);
  if (welcomeDirInfo.exists) {
    await FileSystem.deleteAsync(WELCOME_DIR, { idempotent: true });
  }

  await AsyncStorage.removeItem(WELCOME_VIDEO_META_KEY);
  clearHomeBootstrap();

  status.stage = 'idle';
  status.total = 0;
  status.ready = 0;
  emitStatus();
}
