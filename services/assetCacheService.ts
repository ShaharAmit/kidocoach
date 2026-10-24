import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDownloadURL, getMetadata, ref } from 'firebase/storage';
import { storage } from './firebase';
import {
  ensurePart1AudioForActivities,
  ensurePart1AudioReady,
  getReadyPart1AudioPath,
  localPart1AudioPath,
  prunePart1Audio,
} from './part1Audio';
import { ActivityKey, Routine } from '../types';
import {
  clearAllRoutineAssets,
  isActivityMediaReady,
  primeActivityImages,
  pruneLocalAssets,
  subscribeAssetUpdates,
  syncActivityImage,
  syncActivityMedia,
} from './assetSync';
import { clearHomeBootstrap, isRoutineWarmed, markRoutineWarmed } from './homeBootstrap';
import {
  clearAllMergedVideos,
  discardMergedActivityVideo,
  ensureMergedActivityVideo,
  ensureRoutineMergedVideosReady,
  localMergedVideoPath,
  pruneMergedVideos,
} from './videoMerge';
import {
  getCatalogActivityKeys,
  getCatalogAssetRef,
  getPrefetchableActivityKeys,
  hasServerCatalog,
  refreshActivityCatalog,
  startActivityCatalogListener,
  subscribeActivityCatalog,
} from './activityCatalog';
import { createPrefetchQueue } from './prefetchQueue';
import { getCurrentSegment, isMorningTime, type DaySegment } from '../utils/timeOfDay';
import { DEFAULT_CATALOG_AVATAR_ID } from '../utils/activityCatalogModel';

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

// ---------------------------------------------------------------------------------------------
// Routine media: critical path + background prefetch
// ---------------------------------------------------------------------------------------------

const PRIORITY = {
  /** Something the parent/child is about to use right now. */
  NOW: 0,
  /** Activities of the segment on screen (merges, artwork). */
  CURRENT_SEGMENT: 1,
  /** The other segment of the child's routines. */
  OTHER_SEGMENT: 2,
  /** Every other catalog activity, so adding it to a routine later is instant. */
  CATALOG: 3,
} as const;

const CRITICAL_VERIFY_ATTEMPTS = 4;
const CRITICAL_RETRY_DELAY_MS = 1500;
const CATALOG_RESCHEDULE_DEBOUNCE_MS = 1000;

const queue = createPrefetchQueue({ concurrency: 2 });
let prefetchRoutines: Routine[] = [];
let prunedThisSession = false;
let stopCatalogListener: (() => void) | null = null;
let rescheduleTimer: ReturnType<typeof setTimeout> | null = null;

type Child = Pick<Routine, 'childName' | 'avatarId' | 'tone' | 'voice'>;

function childOf(routine: Routine): Child {
  return {
    childName: routine.childName,
    avatarId: routine.avatarId || DEFAULT_CATALOG_AVATAR_ID,
    tone: routine.tone,
    voice: routine.voice,
  };
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Unique activity keys of `routines` whose step time falls in `segment` (all steps if omitted). */
export function routineActivityKeys(routines: Routine[], segment?: DaySegment): ActivityKey[] {
  const keys = new Set<ActivityKey>();
  for (const routine of routines) {
    routine.activityStack.forEach((step, index) => {
      if (segment) {
        const time = routine.stepTimes?.[index] ?? routine.scheduledTime;
        if (isMorningTime(time) !== (segment === 'morning')) return;
      }
      step.forEach((key) => key && keys.add(key));
    });
  }
  return Array.from(keys);
}

function hasPart1(activityKey: ActivityKey, avatarId: string): boolean {
  return getCatalogAssetRef(activityKey, avatarId, 'p1') !== null;
}

/** Media on disk and (when the activity has a Part 1 clip) the personalized greeting too. */
async function isActivityPlayable(activityKey: ActivityKey, child: Child): Promise<boolean> {
  if (!(await isActivityMediaReady(activityKey, child.avatarId))) return false;
  if (!child.childName.trim() || !hasPart1(activityKey, child.avatarId)) return true;
  return (await getReadyPart1AudioPath(activityKey, child.childName, child.tone, child.voice)) !== null;
}

function segmentWarmKey(routineId: string, segment: DaySegment): string {
  return `${routineId}:${segment}`;
}

/** Whether `warmSegmentAssets` already confirmed this routine's segment is playable offline. */
export function isSegmentWarmed(routineId: string, segment: DaySegment): boolean {
  return isRoutineWarmed(segmentWarmKey(routineId, segment));
}

function setStage(stage: CacheProgressStage, total = status.total, ready = status.ready) {
  status.stage = stage;
  status.total = total;
  status.ready = ready;
  emitStatus();
}

/**
 * Blocks until every activity of `segment` in `routines` can play from disk (videos, captions,
 * personalized greeting, card artwork) or the retry budget runs out (offline). This is the only media the
 * loading screen waits for; everything else is prefetched in the background afterwards.
 */
export async function warmSegmentAssets(
  routines: Routine[],
  segment: DaySegment,
  onProgress?: (stageText: string, progressPercent: number) => void,
  options: { awaitMergedVideos?: boolean } = {}
): Promise<boolean> {
  const work = routines.flatMap((routine) =>
    routineActivityKeys([routine], segment).map((activityKey) => ({ routine, activityKey, child: childOf(routine) }))
  );
  if (work.length === 0) {
    routines.forEach((routine) => markRoutineWarmed(segmentWarmKey(routine.id, segment), true));
    return true;
  }

  setStage('warming-assets', work.length, 0);
  // Card artwork is cloud-only, so fetch the segment's artwork now (a stat when up to date).
  const artwork = Promise.all(
    [...new Set(work.map((item) => item.activityKey))].map((key) => syncActivityImage(key).catch(() => undefined))
  );
  const report = async (label: string, floor: number, span: number) => {
    const ready = await Promise.all(work.map((item) => isActivityPlayable(item.activityKey, item.child)));
    const readyCount = ready.filter(Boolean).length;
    setStage('warming-assets', work.length, readyCount);
    onProgress?.(label, Math.round(floor + (span * readyCount) / work.length));
    return readyCount === work.length;
  };

  let allReady = await report('Checking your routine...', 55, 40);

  for (let attempt = 0; !allReady && attempt < CRITICAL_VERIFY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await wait(CRITICAL_RETRY_DELAY_MS);
    onProgress?.(attempt === 0 ? 'Downloading your routine...' : 'Finishing your routine...', 60);
    await Promise.all([
      ...work.map((item) => syncActivityMedia(item.activityKey, item.child.avatarId)),
      ...routines.map((routine) =>
        ensurePart1AudioForActivities(routineActivityKeys([routine], segment), routine.childName, routine.tone, routine.voice)
      ),
    ]);
    allReady = await report('Downloading your routine...', 60, 35);
  }

  if (options.awaitMergedVideos) {
    onProgress?.('Finalizing experience on device...', 95);
    for (const routine of routines) {
      const child = childOf(routine);
      await ensureRoutineMergedVideosReady(
        routineActivityKeys([routine], segment),
        child.childName,
        child.avatarId,
        child.tone,
        child.voice
      );
    }
  }

  await artwork;
  routines.forEach((routine) => markRoutineWarmed(segmentWarmKey(routine.id, segment), allReady));
  setStage('done', work.length, allReady ? work.length : status.ready);
  if (!allReady) console.warn('[AssetCache] Segment assets incomplete after retries (offline?).');
  return allReady;
}

function enqueueActivity(activityKey: ActivityKey, child: Child, priority: number, withMerge: boolean) {
  const id = `${child.avatarId}:${activityKey}:${withMerge ? 'routine' : 'catalog'}`;
  queue.enqueue({
    id,
    priority,
    run: async () => {
      await syncActivityMedia(activityKey, child.avatarId);
      await syncActivityImage(activityKey);
      if (child.childName.trim() && hasPart1(activityKey, child.avatarId)) {
        await ensurePart1AudioReady(activityKey, child.childName, child.tone, child.voice);
      }
      if (withMerge && child.childName.trim()) {
        await ensureMergedActivityVideo(activityKey, child.childName, child.avatarId, child.tone, child.voice);
      }
    },
  });
}

/**
 * (Re)schedules background work for the given routines: current segment first, then the other
 * segment, then every remaining catalog activity. Cheap to call repeatedly — up-to-date assets
 * cost a file stat, and duplicate jobs collapse in the queue.
 */
export function scheduleBackgroundPrefetch(routines: Routine[]): void {
  prefetchRoutines = routines;
  if (routines.length === 0) return;

  const segment = getCurrentSegment();
  const other: DaySegment = segment === 'morning' ? 'evening' : 'morning';
  const inRoutine = new Set<ActivityKey>();

  for (const routine of routines) {
    const child = childOf(routine);
    for (const key of routineActivityKeys([routine], segment)) {
      inRoutine.add(key);
      enqueueActivity(key, child, PRIORITY.CURRENT_SEGMENT, true);
    }
    for (const key of routineActivityKeys([routine], other)) {
      inRoutine.add(key);
      enqueueActivity(key, child, PRIORITY.OTHER_SEGMENT, true);
    }
  }

  const child = childOf(routines[0]);
  for (const key of getPrefetchableActivityKeys()) {
    if (!inRoutine.has(key)) enqueueActivity(key, child, PRIORITY.CATALOG, false);
  }

  primeActivityImages(getCatalogActivityKeys()).catch(() => undefined);
}

/**
 * Jumps the queue for activities a parent just picked or saved, so they are ready by the time
 * the child opens them. Pass the routine when it is not yet in the prefetch set.
 */
export function prioritizeActivityAssets(activityKeys: ActivityKey[], routine?: Routine): void {
  const source = routine ?? prefetchRoutines[0];
  if (!source) return;
  const child = childOf(source);
  for (const key of activityKeys) enqueueActivity(key, child, PRIORITY.NOW, true);
}

/** Lets the player know whether the background queue still has routine work to do. */
export function whenPrefetchIdle(): Promise<void> {
  return queue.whenIdle();
}

subscribeAssetUpdates(({ activityKey, avatarId, kind }) => {
  if (kind === 'image') return;
  for (const routine of prefetchRoutines) {
    const child = childOf(routine);
    if (child.avatarId !== avatarId || !routineActivityKeys([routine]).includes(activityKey)) continue;
    discardMergedActivityVideo(activityKey, avatarId, child.childName)
      .catch(() => undefined)
      .finally(() => enqueueActivity(activityKey, child, PRIORITY.CURRENT_SEGMENT, true));
  }
});

subscribeActivityCatalog(() => {
  if (rescheduleTimer) clearTimeout(rescheduleTimer);
  rescheduleTimer = setTimeout(() => {
    rescheduleTimer = null;
    scheduleBackgroundPrefetch(prefetchRoutines);
  }, CATALOG_RESCHEDULE_DEBOUNCE_MS);
});

queue.onIdle(() => {
  if (prunedThisSession || !hasServerCatalog() || prefetchRoutines.length === 0) return;
  prunedThisSession = true;
  pruneUnusedAssets(prefetchRoutines).catch((err) => console.warn('[AssetCache] Prune failed:', err));
});

/**
 * Deletes media the app no longer needs: activities removed from the catalog and every routine,
 * superseded artwork, greetings for an old name/tone/version, and merges nothing will play.
 */
async function pruneUnusedAssets(routines: Routine[]): Promise<void> {
  const routineKeys = routineActivityKeys(routines);
  const keepKeys = Array.from(new Set([...getCatalogActivityKeys(), ...routineKeys]));
  const avatarIds = Array.from(new Set([DEFAULT_CATALOG_AVATAR_ID, ...routines.map((r) => childOf(r).avatarId)]));
  const voiceKeys = Array.from(new Set([...getPrefetchableActivityKeys(), ...routineKeys]));

  const audioPaths: string[] = [];
  const mergedPaths: string[] = [];
  for (const routine of routines) {
    const child = childOf(routine);
    for (const key of voiceKeys) audioPaths.push(localPart1AudioPath(key, child.childName, child.tone, child.voice));
    for (const key of routineActivityKeys([routine])) {
      mergedPaths.push(localMergedVideoPath(key, child.avatarId, (child.childName || 'friend').trim() || 'friend'));
    }
  }

  const [media, audio, merged] = await Promise.all([
    pruneLocalAssets({ activityKeys: keepKeys, avatarIds }),
    // Without a child name every wanted path would be the "child" placeholder; skip rather than
    // wipe real greetings.
    routines.every((routine) => routine.childName.trim()) ? prunePart1Audio(audioPaths) : Promise.resolve(0),
    pruneMergedVideos(mergedPaths),
  ]);
  if (media + audio + merged > 0) {
    console.log(`[AssetCache] Pruned ${media} media, ${audio} greetings, ${merged} merged videos.`);
  }
}

/**
 * Every app entry (cold start after boot, and each return to the foreground): pull the catalog
 * from the server, keep a live listener while foregrounded, and re-check every asset against it.
 * New activities, replaced videos/captions and changed greetings are picked up here.
 */
export async function onAppEnteredForeground(): Promise<void> {
  if (!stopCatalogListener) stopCatalogListener = startActivityCatalogListener();
  const { ok } = await refreshActivityCatalog();
  if (ok) prunedThisSession = false;
  scheduleBackgroundPrefetch(prefetchRoutines);
}

/** Starts the live catalog listener once boot has already refreshed the catalog. */
export function ensureCatalogListener(): void {
  if (!stopCatalogListener) stopCatalogListener = startActivityCatalogListener();
}

export function onAppLeftForeground(): void {
  stopCatalogListener?.();
  stopCatalogListener = null;
}

/**
 * Clears all locally cached media and metadata.
 */
export async function clearAllLocalCachedAssets(): Promise<void> {
  queue.clear();
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
