import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { db, storage, ensureAuth } from './firebase';
import { doc, getDoc } from 'firebase/firestore';
import { getDownloadURL, getMetadata, ref } from 'firebase/storage';
import { Routine, ActivityKey, CaptionCue } from '../types';
import { TTS_AUDIO_ENABLED } from '../constants/featureFlags';
import { getCatalogAssetRef, getCatalogImageRef } from './activityCatalog';
import { base64Md5ToHex, CatalogAssetKind, CatalogAssetRef } from '../utils/activityCatalogModel';

const VIDEO_DIR = `${FileSystem.documentDirectory}videos/`;
const AUDIO_DIR = `${FileSystem.documentDirectory}audio/`;
const CAPTIONS_DIR = `${FileSystem.documentDirectory}captions/`;
const IMAGES_DIR = `${FileSystem.documentDirectory}activity_images/`;
const MIN_VIDEO_FILE_BYTES = 16 * 1024;
const MIN_AUDIO_FILE_BYTES = 4 * 1024;
const MIN_IMAGE_FILE_BYTES = 512;
const TEMP_SUFFIX = '.download';
// Keyed by the document-relative local path (absolute iOS container paths change across updates);
// value is `${remotePath}#${generation}` of the bytes currently on disk.
const ASSET_VERSION_KEY_PREFIX = 'asset_version_v2_';
// Pre-catalog markers (remote path → generation); read once so existing files are not re-fetched.
const LEGACY_VIDEO_GENERATION_KEY_PREFIX = 'video_generation_v1_';

/** Ensure local cache directories exist */
async function ensureDirs(): Promise<void> {
  for (const dir of [VIDEO_DIR, AUDIO_DIR, CAPTIONS_DIR, IMAGES_DIR]) {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
  }
}

function relativeKey(localPath: string): string {
  const base = FileSystem.documentDirectory ?? '';
  return localPath.startsWith(base) ? localPath.slice(base.length) : localPath;
}

async function readVersionMarker(localPath: string, remotePath: string, generation: string): Promise<boolean> {
  try {
    const marker = await AsyncStorage.getItem(ASSET_VERSION_KEY_PREFIX + relativeKey(localPath));
    if (marker !== null) return marker === `${remotePath}#${generation}`;
    const legacy = await AsyncStorage.getItem(LEGACY_VIDEO_GENERATION_KEY_PREFIX + remotePath);
    if (legacy === generation) {
      await writeVersionMarker(localPath, remotePath, generation);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function writeVersionMarker(localPath: string, remotePath: string, generation: string): Promise<void> {
  try {
    await AsyncStorage.setItem(ASSET_VERSION_KEY_PREFIX + relativeKey(localPath), `${remotePath}#${generation}`);
  } catch {
    // Best-effort — worst case the asset is re-downloaded once.
  }
}

function isObjectNotFound(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'storage/object-not-found';
}

/** `downloaded` = first copy on device; `updated` = an older cached copy was replaced. */
export type AssetSyncResult = 'fresh' | 'downloaded' | 'updated' | 'missing' | 'failed';

export type AssetUpdateEvent = {
  activityKey: ActivityKey;
  avatarId: string;
  kind: CatalogAssetKind | 'image';
};

const updateListeners = new Set<(event: AssetUpdateEvent) => void>();

/** Fires after a cached asset was replaced by a newer remote version (not on first download). */
export function subscribeAssetUpdates(listener: (event: AssetUpdateEvent) => void): () => void {
  updateListeners.add(listener);
  return () => {
    updateListeners.delete(listener);
  };
}

type RemoteAssetSpec = {
  localPath: string;
  /** Conventional Storage path, used only when the catalog has no entry for this asset. */
  fallbackRemotePath: string;
  /** `undefined` → no catalog on device; `null` → catalog says the asset does not exist. */
  catalogRef: CatalogAssetRef | null | undefined;
  validate: (path: string) => Promise<boolean>;
  /** Delete the local copy when the catalog says the remote file is gone (e.g. captions). */
  removeWhenAbsent?: boolean;
};

const syncInFlight = new Map<string, Promise<AssetSyncResult>>();
// Without a catalog every check costs a Storage metadata request; re-schedules within this window
// reuse the last answer instead (the catalog path needs no network and is never throttled).
const METADATA_RECHECK_MS = 10 * 60 * 1000;
const metadataCheckedAt = new Map<string, { at: number; result: AssetSyncResult }>();

/**
 * Brings one cached file in line with its remote object. Never deletes a playable file until a
 * verified replacement is ready: bytes land in `<path>.download`, are size/format/MD5 checked,
 * and only then moved over the old copy. Up to date → no network at all when the catalog
 * supplies the version; otherwise one Storage metadata request.
 */
function syncRemoteAsset(spec: RemoteAssetSpec): Promise<AssetSyncResult> {
  const existing = syncInFlight.get(spec.localPath);
  if (existing) return existing;
  const task = runAssetSync(spec).finally(() => syncInFlight.delete(spec.localPath));
  syncInFlight.set(spec.localPath, task);
  return task;
}

async function runAssetSync(spec: RemoteAssetSpec): Promise<AssetSyncResult> {
  const { localPath, validate, catalogRef } = spec;
  const hasValidLocal = await validate(localPath);
  if (catalogRef === null) {
    if (spec.removeWhenAbsent && hasValidLocal) {
      await FileSystem.deleteAsync(localPath, { idempotent: true });
      await AsyncStorage.removeItem(ASSET_VERSION_KEY_PREFIX + relativeKey(localPath)).catch(() => undefined);
      return 'updated';
    }
    return hasValidLocal ? 'fresh' : 'missing';
  }

  const remotePath = catalogRef?.path ?? spec.fallbackRemotePath;
  let generation = catalogRef?.generation;
  let md5 = catalogRef?.md5;
  if (!generation) {
    const recent = metadataCheckedAt.get(localPath);
    if (recent && Date.now() - recent.at < METADATA_RECHECK_MS && (hasValidLocal || recent.result === 'missing')) {
      return recent.result;
    }
    try {
      const meta = await getMetadata(ref(storage, remotePath));
      generation = meta.generation;
      md5 = meta.md5Hash;
    } catch (err) {
      if (isObjectNotFound(err)) {
        const result: AssetSyncResult = hasValidLocal ? 'fresh' : 'missing';
        metadataCheckedAt.set(localPath, { at: Date.now(), result });
        return result;
      }
      // Offline: a valid local copy keeps working; nothing to compare against.
      return hasValidLocal ? 'fresh' : 'failed';
    }
    metadataCheckedAt.set(localPath, { at: Date.now(), result: 'fresh' });
  }

  if (hasValidLocal && generation && (await readVersionMarker(localPath, remotePath, generation))) {
    return 'fresh';
  }

  const tempPath = `${localPath}${TEMP_SUFFIX}`;
  try {
    await FileSystem.deleteAsync(tempPath, { idempotent: true });
    const remoteUrl = await getDownloadURL(ref(storage, remotePath));
    const result = await FileSystem.downloadAsync(remoteUrl, tempPath);
    if (typeof result.status === 'number' && result.status >= 400) {
      throw new Error(`HTTP ${result.status}`);
    }
    if (!(await validate(tempPath))) {
      throw new Error('downloaded file failed validation');
    }
    const expectedMd5 = md5 ? base64Md5ToHex(md5) : null;
    if (expectedMd5) {
      const info = await FileSystem.getInfoAsync(tempPath, { md5: true });
      const actual = info.exists ? info.md5?.toLowerCase() : undefined;
      if (actual && actual !== expectedMd5) throw new Error('MD5 mismatch');
    }

    await FileSystem.deleteAsync(localPath, { idempotent: true });
    await FileSystem.moveAsync({ from: tempPath, to: localPath });
    if (generation) await writeVersionMarker(localPath, remotePath, generation);
    return hasValidLocal ? 'updated' : 'downloaded';
  } catch (err) {
    await FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => undefined);
    if (isObjectNotFound(err)) return hasValidLocal ? 'fresh' : 'missing';
    console.warn(`[AssetSync] Download failed for ${remotePath}:`, err);
    return 'failed';
  }
}

/** Returns the local file path for a video asset (Part 2 / main) */
export function localVideoPath(activityKey: ActivityKey | string, avatarId: string): string {
  const safeActivity = (activityKey || 'activity').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '_') || 'activity';
  const safeAvatar = (avatarId || 'becky').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '_') || 'becky';
  return `${VIDEO_DIR}${safeAvatar}_${safeActivity}.mp4`;
}

/** Returns the local file path for Part 1 video */
export function localPart1VideoPath(activityKey: ActivityKey | string, avatarId: string): string {
  const safeActivity = (activityKey || 'activity').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '_') || 'activity';
  const safeAvatar = (avatarId || 'becky').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '_') || 'becky';
  return `${VIDEO_DIR}${safeAvatar}_${safeActivity}_p1.mp4`;
}

export async function isValidCachedVideo(localPath: string): Promise<boolean> {
  if (!localPath) return false;
  try {
    const info = await FileSystem.getInfoAsync(localPath);
    if (!info.exists) return false;

    // A tiny file is typically an HTML error page or partial download, not a playable MP4.
    const size = 'size' in info && typeof info.size === 'number' ? info.size : 0;
    return size >= MIN_VIDEO_FILE_BYTES;
  } catch {
    return false;
  }
}

/** Returns the local file path for a TTS audio file */
export function localAudioPath(cacheKey: string): string {
  const safeKey = (cacheKey || 'cache').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '_') || 'cache';
  return `${AUDIO_DIR}${safeKey}.wav`;
}

/** Returns the local file path for a caption cue JSON file */
export function localCaptionsPath(activityKey: ActivityKey | string, avatarId: string): string {
  const safeActivity = (activityKey || 'activity').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '_') || 'activity';
  const safeAvatar = (avatarId || 'becky').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '_') || 'becky';
  return `${CAPTIONS_DIR}${safeAvatar}_${safeActivity}.json`;
}

async function isValidCachedAudio(localPath: string): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(localPath);
  if (!info.exists) return false;

  const size = 'size' in info && typeof info.size === 'number' ? info.size : 0;
  if (size < MIN_AUDIO_FILE_BYTES) return false;

  try {
    // Validate RIFF/WAVE header so stale raw PCM files are not treated as playable WAV.
    const riffHeader = await FileSystem.readAsStringAsync(localPath, {
      encoding: FileSystem.EncodingType.Base64,
      position: 0,
      length: 4,
    });
    const waveHeader = await FileSystem.readAsStringAsync(localPath, {
      encoding: FileSystem.EncodingType.Base64,
      position: 8,
      length: 4,
    });
    return riffHeader === 'UklGRg==' && waveHeader === 'V0FWRQ==';
  } catch {
    return false;
  }
}

/** Build the Firestore audio_cache document ID */
export function buildAudioCacheKey(
  childName: string,
  activityKey: ActivityKey,
  avatarId: string,
  tone?: Routine['tone'],
  voice?: Routine['voice']
): string {
  const normalizedName = childName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const toneKey = tone ?? 'cheerful';
  const voiceKey = voice ?? 'woman';
  return `${normalizedName}_${activityKey}_${avatarId}_${toneKey}_${voiceKey}`;
}

function remoteAvatarPath(activityKey: ActivityKey, avatarId: string, suffix: string): string {
  return `avatars/${avatarId}/${activityKey}${suffix}`;
}

async function isValidCaptionsFile(localPath: string): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(localPath);
    if (!info.exists || !('size' in info) || !info.size) return false;
    return Array.isArray(JSON.parse(await FileSystem.readAsStringAsync(localPath)));
  } catch {
    return false;
  }
}

async function isValidImageFile(localPath: string): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(localPath);
    return info.exists && 'size' in info && typeof info.size === 'number' && info.size >= MIN_IMAGE_FILE_BYTES;
  } catch {
    return false;
  }
}

function mediaSpec(activityKey: ActivityKey, avatarId: string, kind: CatalogAssetKind): RemoteAssetSpec {
  const catalogRef = getCatalogAssetRef(activityKey, avatarId, kind);
  switch (kind) {
    case 'p1':
      return {
        localPath: localPart1VideoPath(activityKey, avatarId),
        fallbackRemotePath: remoteAvatarPath(activityKey, avatarId, '_p1.mp4'),
        catalogRef,
        validate: isValidCachedVideo,
      };
    case 'p2':
      return {
        localPath: localVideoPath(activityKey, avatarId),
        fallbackRemotePath: remoteAvatarPath(activityKey, avatarId, '.mp4'),
        catalogRef,
        validate: isValidCachedVideo,
      };
    case 'captions':
      return {
        localPath: localCaptionsPath(activityKey, avatarId),
        fallbackRemotePath: remoteAvatarPath(activityKey, avatarId, '_captions.json'),
        catalogRef,
        validate: isValidCaptionsFile,
        // Captions removed in the cloud must disappear from devices too (videos are kept so an
        // activity already in a routine keeps playing).
        removeWhenAbsent: true,
      };
  }
}

export type ActivityMediaSyncResult = Record<CatalogAssetKind, AssetSyncResult>;

/**
 * Downloads (or refreshes) one activity's Part 1 video, Part 2 video, and captions. Idempotent and
 * cheap when everything is current; concurrent callers for the same file share one download.
 */
export async function syncActivityMedia(activityKey: ActivityKey, avatarId: string): Promise<ActivityMediaSyncResult> {
  await ensureDirs();
  try {
    await ensureAuth();
  } catch {
    // Offline / auth failure — downloads fail fast and report what is already on disk.
  }
  const kinds: CatalogAssetKind[] = ['p1', 'p2', 'captions'];
  const results = await Promise.all(kinds.map((kind) => syncRemoteAsset(mediaSpec(activityKey, avatarId, kind))));
  const summary = { p1: results[0], p2: results[1], captions: results[2] };
  for (const kind of kinds) {
    if (summary[kind] === 'updated') {
      updateListeners.forEach((listener) => listener({ activityKey, avatarId, kind }));
    }
  }
  return summary;
}

/**
 * Whether an activity can play from disk: Part 2 must exist, and Part 1 too unless the catalog
 * says this activity has no Part 1 clip.
 */
export async function isActivityMediaReady(activityKey: ActivityKey, avatarId: string): Promise<boolean> {
  const [p2Ready, p1Ready] = await Promise.all([
    isValidCachedVideo(localVideoPath(activityKey, avatarId)),
    isValidCachedVideo(localPart1VideoPath(activityKey, avatarId)),
  ]);
  if (!p2Ready) return false;
  return p1Ready || getCatalogAssetRef(activityKey, avatarId, 'p1') === null;
}

/**
 * On-demand, single-activity readiness check + repair, used by the player right before playback
 * in case background prefetch has not reached this activity yet.
 */
export async function ensureActivityVideoReady(
  activityKey: ActivityKey | string,
  avatarId: string
): Promise<{ p1Ready: boolean; p2Ready: boolean }> {
  await syncActivityMedia(activityKey, avatarId);
  const [p1Ready, p2Ready] = await Promise.all([
    isValidCachedVideo(localPart1VideoPath(activityKey, avatarId)),
    isValidCachedVideo(localVideoPath(activityKey, avatarId)),
  ]);
  return { p1Ready, p2Ready };
}

// The generation is part of the filename so a replaced image gets a new URI (no stale RN image
// cache) and the superseded file is reclaimed by `pruneLocalAssets`.
function localImagePath(activityKey: ActivityKey, imageRef: CatalogAssetRef): string {
  const ext = /\.(png|jpe?g|webp)$/i.exec(imageRef.path)?.[0]?.toLowerCase() ?? '.png';
  return `${IMAGES_DIR}${activityKey.replace(/[^a-z0-9_]/g, '_')}_${imageRef.generation}${ext}`;
}

const readyImageUris = new Map<ActivityKey, string>();
const imageListeners = new Set<() => void>();
let imageRevision = 0;

function setReadyImage(activityKey: ActivityKey, uri: string | null) {
  const current = readyImageUris.get(activityKey) ?? null;
  if (current === uri) return;
  if (uri) readyImageUris.set(activityKey, uri);
  else readyImageUris.delete(activityKey);
  imageRevision += 1;
  imageListeners.forEach((listener) => listener());
}

/** Downloads the catalog's cloud artwork for an activity (if it has one). */
export async function syncActivityImage(activityKey: ActivityKey): Promise<void> {
  const imageRef = getCatalogImageRef(activityKey);
  if (!imageRef) {
    setReadyImage(activityKey, null);
    return;
  }
  await ensureDirs();
  const localPath = localImagePath(activityKey, imageRef);
  await syncRemoteAsset({
    localPath,
    fallbackRemotePath: imageRef.path,
    catalogRef: imageRef,
    validate: isValidImageFile,
  });
  setReadyImage(activityKey, (await isValidImageFile(localPath)) ? localPath : null);
}

/** Registers already-downloaded cloud artwork without touching the network. */
export async function primeActivityImages(activityKeys: ActivityKey[]): Promise<void> {
  await Promise.all(
    activityKeys.map(async (activityKey) => {
      const imageRef = getCatalogImageRef(activityKey);
      if (!imageRef) return;
      const localPath = localImagePath(activityKey, imageRef);
      if (await isValidImageFile(localPath)) setReadyImage(activityKey, localPath);
    })
  );
}

/** Local URI of downloaded cloud artwork, or `null` to use bundled artwork. */
export function getReadyActivityImageUri(activityKey: ActivityKey): string | null {
  return readyImageUris.get(activityKey) ?? null;
}

export function subscribeActivityImages(listener: () => void): () => void {
  imageListeners.add(listener);
  return () => {
    imageListeners.delete(listener);
  };
}

export function getActivityImagesRevision(): number {
  return imageRevision;
}

/**
 * Fetch and cache audio file from Firebase Storage URL.
 */
async function syncAudio(cacheKey: string, audioUrl: string): Promise<void> {
  const localPath = localAudioPath(cacheKey);
  const hasValidCachedAudio = await isValidCachedAudio(localPath);
  if (hasValidCachedAudio) return;

  const existing = await FileSystem.getInfoAsync(localPath);
  if (existing.exists) {
    await FileSystem.deleteAsync(localPath, { idempotent: true });
  }

  console.log(`[AssetSync] Downloading audio: ${audioUrl}`);
  const downloadResult = await FileSystem.downloadAsync(audioUrl, localPath);

  const status = (downloadResult as { status?: number }).status;
  if (typeof status === 'number' && status >= 400) {
    await FileSystem.deleteAsync(localPath, { idempotent: true });
    throw new Error(`[AssetSync] Audio download failed (${status}) for ${audioUrl}`);
  }

  const isPlayable = await isValidCachedAudio(localPath);
  if (!isPlayable) {
    await FileSystem.deleteAsync(localPath, { idempotent: true });
    throw new Error(`[AssetSync] Downloaded audio is invalid or too small: ${audioUrl}`);
  }
}

/**
 * Ensure a single activity's caption cues are downloaded and return the parsed data, or `null`
 * if no captions exist for that activity (or the download fails). Called on-demand by the
 * player, so captions never depend solely on background prefetch having finished.
 */
export async function ensureCaptionsData(
  activityKey: ActivityKey,
  avatarId: string
): Promise<CaptionCue[] | null> {
  await ensureDirs();
  const localPath = localCaptionsPath(activityKey, avatarId);

  if (!(await isValidCaptionsFile(localPath))) {
    try {
      await ensureAuth();
    } catch {
      // Offline — the sync below fails fast.
    }
    await syncRemoteAsset(mediaSpec(activityKey, avatarId, 'captions'));
  }

  try {
    const cues = JSON.parse(await FileSystem.readAsStringAsync(localPath));
    return Array.isArray(cues) ? (cues as CaptionCue[]) : null;
  } catch {
    return null;
  }
}

/**
 * Syncs every activity in a routine (videos + captions, plus legacy TTS audio when enabled).
 *
 * @returns Object with any missing audio keys (still being generated)
 */
export async function syncRoutineAssets(
  routine: Routine
): Promise<{ missingAudioKeys: string[] }> {
  await ensureDirs();

  const missingAudioKeys: string[] = [];
  const activityKeys = Array.from(new Set(routine.activityStack.flat())).filter(Boolean);

  await Promise.allSettled(
    activityKeys.map(async (activityKey) => {
      await syncActivityMedia(activityKey, routine.avatarId);

      // Legacy full-narration TTS (skipped while disabled — see featureFlags.ts).
      if (!TTS_AUDIO_ENABLED) return;

      const cacheKey = buildAudioCacheKey(
        routine.childName,
        activityKey,
        routine.avatarId,
        routine.tone,
        routine.voice
      );
      if (await isValidCachedAudio(localAudioPath(cacheKey))) return;
      try {
        const audioDoc = await getDoc(doc(db, 'audio_cache', cacheKey));
        if (audioDoc.exists() && audioDoc.data()?.status === 'ready') {
          await syncAudio(cacheKey, audioDoc.data()!.audioUrl as string);
        } else {
          missingAudioKeys.push(cacheKey);
        }
      } catch (err) {
        console.warn(`[AssetSync] Failed to sync audio for ${cacheKey}:`, err);
        missingAudioKeys.push(cacheKey);
      }
    })
  );

  return { missingAudioKeys };
}

/**
 * Check whether every activity in a routine can play from disk (Part 1 + Part 2 videos).
 */
export async function areAssetsReady(routine: Routine): Promise<boolean> {
  const activityKeys = Array.from(new Set(routine.activityStack.flat())).filter(Boolean);
  const ready = await Promise.all(activityKeys.map((key) => isActivityMediaReady(key, routine.avatarId)));
  return ready.every(Boolean);
}

/**
 * Delete all cached assets for a routine (e.g. when routine is deleted).
 */
export async function clearRoutineAssets(routine: Routine): Promise<void> {
  for (const activityKey of routine.activityStack.flat()) {
    const p1VideoPath = localPart1VideoPath(activityKey, routine.avatarId);
    const p1VideoInfo = await FileSystem.getInfoAsync(p1VideoPath);
    if (p1VideoInfo.exists) {
      await FileSystem.deleteAsync(p1VideoPath, { idempotent: true });
    }

    const videoPath = localVideoPath(activityKey, routine.avatarId);
    const videoInfo = await FileSystem.getInfoAsync(videoPath);
    if (videoInfo.exists) {
      await FileSystem.deleteAsync(videoPath, { idempotent: true });
    }

    const captionsPath = localCaptionsPath(activityKey, routine.avatarId);
    const captionsInfo = await FileSystem.getInfoAsync(captionsPath);
    if (captionsInfo.exists) {
      await FileSystem.deleteAsync(captionsPath, { idempotent: true });
    }

    const cacheKey = buildAudioCacheKey(
      routine.childName,
      activityKey,
      routine.avatarId,
      routine.tone,
      routine.voice
    );
    const audioPath = localAudioPath(cacheKey);
    const audioInfo = await FileSystem.getInfoAsync(audioPath);
    if (audioInfo.exists) {
      await FileSystem.deleteAsync(audioPath, { idempotent: true });
    }
  }
}

/**
 * Delete all cached routine media assets (video/audio/captions/images) on device.
 */
export async function clearAllRoutineAssets(): Promise<void> {
  for (const dir of [VIDEO_DIR, AUDIO_DIR, CAPTIONS_DIR, IMAGES_DIR]) {
    const info = await FileSystem.getInfoAsync(dir);
    if (info.exists) {
      await FileSystem.deleteAsync(dir, { idempotent: true });
    }
  }
  readyImageUris.clear();
  metadataCheckedAt.clear();
  imageRevision += 1;
  imageListeners.forEach((listener) => listener());

  // Drop the version markers too, otherwise a re-downloaded file would be compared against the
  // marker of the deleted copy.
  try {
    const keys = await AsyncStorage.getAllKeys();
    const markerKeys = keys.filter(
      (key) => key.startsWith(ASSET_VERSION_KEY_PREFIX) || key.startsWith(LEGACY_VIDEO_GENERATION_KEY_PREFIX)
    );
    await AsyncStorage.removeMany(markerKeys);
  } catch {
    // Best-effort — a stale marker only costs one extra download.
  }
}

async function pruneDirectory(dir: string, keep: Set<string>, skip: (name: string) => boolean): Promise<number> {
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const path = `${dir}${name}`;
    if (skip(name) || keep.has(name)) continue;
    if (name.endsWith(TEMP_SUFFIX) && syncInFlight.has(path.slice(0, -TEMP_SUFFIX.length))) continue;
    try {
      const info = await FileSystem.getInfoAsync(path);
      if (!info.exists || info.isDirectory) continue;
      await FileSystem.deleteAsync(path, { idempotent: true });
      await AsyncStorage.removeItem(ASSET_VERSION_KEY_PREFIX + relativeKey(path)).catch(() => undefined);
      removed += 1;
    } catch {
      // Best-effort.
    }
  }
  return removed;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Deletes downloaded videos, captions, artwork and abandoned partial downloads for activities
 * that are no longer in the catalog or any routine. Merged videos/captions are owned by
 * videoMerge.ts and pruned there.
 */
export async function pruneLocalAssets(keep: { activityKeys: ActivityKey[]; avatarIds: string[] }): Promise<number> {
  const videos = new Set<string>();
  const captions = new Set<string>();
  const images = new Set<string>();
  for (const activityKey of keep.activityKeys) {
    for (const avatarId of keep.avatarIds) {
      videos.add(basename(localVideoPath(activityKey, avatarId)));
      videos.add(basename(localPart1VideoPath(activityKey, avatarId)));
      captions.add(basename(localCaptionsPath(activityKey, avatarId)));
    }
    const imageRef = getCatalogImageRef(activityKey);
    if (imageRef) images.add(basename(localImagePath(activityKey, imageRef)));
  }

  const counts = await Promise.all([
    pruneDirectory(VIDEO_DIR, videos, (name) => name === 'merged'),
    pruneDirectory(CAPTIONS_DIR, captions, (name) => name.includes('_merged_')),
    pruneDirectory(IMAGES_DIR, images, () => false),
  ]);
  return counts.reduce((sum, count) => sum + count, 0);
}
