import * as FileSystem from 'expo-file-system/legacy';
import { httpsCallable } from 'firebase/functions';
import { getDownloadURL, ref } from 'firebase/storage';
import { functions, storage, ensureAuth } from './firebase';
import { localAudioPath } from './assetSync';
import { ActivityKey, Routine, ToneOption, VoiceOption } from '../types';
import { getActivityDefinition } from '../constants/activities';
import { normalizeNameToken } from '../utils/nameToken';

interface GenerateRoutinePart1AudioRequest {
  childName: string;
  activityKeys: string[];
  tone?: ToneOption;
  voice?: VoiceOption;
}

interface GenerateRoutinePart1AudioResponse {
  results: Array<{
    activityKey: string;
    storagePath: string | null;
    cacheKey: string;
    status: 'ready' | 'generating';
  }>;
}

const MIN_AUDIO_BYTES = 1024;
// Mirrors MAX_ACTIVITY_KEYS_PER_BATCH in functions/src/index.ts.
const MAX_KEYS_PER_BATCH = 20;
const AUDIO_DIR = `${FileSystem.documentDirectory}audio/`;

async function ensureAudioDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(AUDIO_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(AUDIO_DIR, { intermediates: true });
  }
}

export function buildPart1AudioKey(
  activityKey: ActivityKey | string,
  childName: string,
  tone?: ToneOption,
  voice?: VoiceOption
): string {
  const normalizedName = normalizeNameToken((childName || 'child').toString()) || 'child';
  const normalizedActivity = (activityKey || 'activity').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '_') || 'activity';
  const definition = getActivityDefinition(activityKey || 'activity');
  const selectedTone = tone ?? definition.part1Tone;
  const selectedVoice = voice ?? 'woman';
  // Version 1 keeps the original key so clips cached before greeting versioning stay valid.
  const versionSuffix = definition.part1Version > 1 ? `_v${definition.part1Version}` : '';
  // MUST stay identical to `buildPart1AudioKey` in functions/src/index.ts.
  return `p1_${normalizedActivity}_${normalizedName}_${selectedTone}_${selectedVoice}${versionSuffix}`;
}

export function localPart1AudioPath(
  activityKey: ActivityKey | string,
  childName: string,
  tone?: ToneOption,
  voice?: VoiceOption
): string {
  return localAudioPath(buildPart1AudioKey(activityKey || 'activity', childName || 'child', tone, voice));
}

async function audioFileExists(localPath: string): Promise<boolean> {
  if (!localPath) return false;
  try {
    const info = await FileSystem.getInfoAsync(localPath);
    if (!info.exists) return false;
    const size = 'size' in info && typeof info.size === 'number' ? info.size : 0;
    if (size < MIN_AUDIO_BYTES) return false;
    return !(await isBrokenPromptClip(localPath));
  } catch {
    return false;
  }
}

// base64("RIFF") at byte 44, i.e. a WAV nested inside the data chunk.
const NESTED_RIFF_BASE64 = 'UklGRg==';

/**
 * Clips synthesized by gemini-3.8-flash-tts before the speechMetadata fix spoke the style prompt
 * aloud, and were all double-wrapped (the model's own WAV header sits at byte 44). Treating them as
 * missing makes the device re-fetch only those clips; the server regenerates them exactly once.
 */
async function isBrokenPromptClip(localPath: string): Promise<boolean> {
  try {
    const bytes = await FileSystem.readAsStringAsync(localPath, {
      encoding: FileSystem.EncodingType.Base64,
      position: 44,
      length: 4,
    });
    return bytes === NESTED_RIFF_BASE64;
  } catch {
    return false;
  }
}

/** Clips are private Storage objects; an authenticated getDownloadURL is the only way to fetch them. */
async function downloadPart1Audio(localPath: string, storagePath: string): Promise<boolean> {
  await ensureAudioDir();

  // If already exists and valid, skip download
  if (await audioFileExists(localPath)) {
    return true;
  }

  const existing = await FileSystem.getInfoAsync(localPath);
  if (existing.exists) {
    await FileSystem.deleteAsync(localPath, { idempotent: true });
  }

  const audioUrl = await getDownloadURL(ref(storage, storagePath));
  const downloadResult = await FileSystem.downloadAsync(audioUrl, localPath);
  const status = (downloadResult as { status?: number }).status;
  if (typeof status === 'number' && status >= 400) {
    await FileSystem.deleteAsync(localPath, { idempotent: true });
    return false;
  }

  const ok = await audioFileExists(localPath);
  if (!ok) {
    await FileSystem.deleteAsync(localPath, { idempotent: true });
  }
  return ok;
}

/** Single entry point for greeting generation: `generateRoutinePart1Audio` with 1–20 keys. */
async function requestPart1Audio(
  activityKeys: string[],
  childName: string,
  tone?: ToneOption,
  voice?: VoiceOption
): Promise<GenerateRoutinePart1AudioResponse['results']> {
  await ensureAuth();
  const generateRoutinePart1Audio = httpsCallable<
    GenerateRoutinePart1AudioRequest,
    GenerateRoutinePart1AudioResponse
  >(functions, 'generateRoutinePart1Audio');
  const result = await generateRoutinePart1Audio({ childName, activityKeys, tone, voice });
  return result.data.results;
}

/**
 * Ensure Part 1 greeting audio for an activity is downloaded and cached locally.
 */
export async function ensurePart1AudioReady(
  activityKey: ActivityKey | string,
  childName: string,
  tone?: ToneOption,
  voice?: VoiceOption
): Promise<string | null> {
  const name = (childName ?? '').trim() || 'child';
  const actKey = (activityKey ?? '').trim();
  if (!actKey) return null;

  const cacheKey = buildPart1AudioKey(actKey, name, tone, voice);
  const localPath = localAudioPath(cacheKey);

  try {
    if (await audioFileExists(localPath)) {
      return localPath;
    }

    // The callable is the only cache lookup: it returns existing clips without regenerating
    // and refreshes their server-side retention (audio_cache is not client-readable).
    const [item] = await requestPart1Audio([actKey], name, tone, voice);
    // A server whose catalog is a version behind would hand back the previous greeting; storing it
    // under the new key would pin the old audio forever, so only accept an exact key match.
    if (item?.status === 'ready' && item.storagePath && item.cacheKey === cacheKey) {
      const ok = await downloadPart1Audio(localPath, item.storagePath);
      return ok ? localPath : null;
    }

    return null;
  } catch (err) {
    console.warn(`[Part1Audio] Failed to ensure audio for ${actKey} / "${name}":`, err);
    return null;
  }
}

/**
 * Batch-ensures Part 1 greeting audio for `activityKeys` (one callable round-trip for everything
 * not yet on device). Clips the server is still generating are left for a later pass.
 */
export async function ensurePart1AudioForActivities(
  activityKeys: ActivityKey[],
  childName: string,
  tone?: ToneOption,
  voice?: VoiceOption
): Promise<void> {
  const name = (childName ?? '').trim();
  if (!name) return;

  const missingKeys: string[] = [];
  for (const activityKey of Array.from(new Set(activityKeys)).filter(Boolean)) {
    if (!(await audioFileExists(localPart1AudioPath(activityKey, name, tone, voice)))) {
      missingKeys.push(activityKey);
    }
  }
  if (missingKeys.length === 0) return;

  try {
    for (let i = 0; i < missingKeys.length; i += MAX_KEYS_PER_BATCH) {
      const results = await requestPart1Audio(missingKeys.slice(i, i + MAX_KEYS_PER_BATCH), name, tone, voice);
      // Only keep clips whose server key matches ours: if either side's catalog is a greeting
      // version behind, the clip is skipped and re-requested on a later pass.
      await Promise.allSettled(
        results.map(async (item) => {
          if (item.status !== 'ready' || !item.storagePath) return;
          if (item.cacheKey !== buildPart1AudioKey(item.activityKey, name, tone, voice)) return;
          await downloadPart1Audio(localAudioPath(item.cacheKey), item.storagePath);
        })
      );
    }
  } catch (err) {
    console.warn('[Part1Audio] Failed batch preload:', err);
  }
}

/** Preloads Part 1 greeting audio for all activities in a routine. */
export async function ensureRoutinePart1AudioReady(routine: Routine): Promise<void> {
  await ensurePart1AudioForActivities(routine.activityStack.flat(), routine.childName, routine.tone, routine.voice);
}

/** Deletes greeting clips that no longer match any wanted (activity, name, tone, voice, version). */
export async function prunePart1Audio(keepPaths: string[]): Promise<number> {
  const keep = new Set(keepPaths.map((path) => path.slice(path.lastIndexOf('/') + 1)));
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(AUDIO_DIR);
  } catch {
    return 0;
  }
  const stale = names.filter((name) => name.startsWith('p1_') && !keep.has(name));
  await Promise.allSettled(stale.map((name) => FileSystem.deleteAsync(`${AUDIO_DIR}${name}`, { idempotent: true })));
  return stale.length;
}

/**
 * Fast presence check for cached Part 1 audio on device.
 */
export async function getReadyPart1AudioPath(
  activityKey: ActivityKey | string,
  childName: string,
  tone?: ToneOption,
  voice?: VoiceOption
): Promise<string | null> {
  const name = (childName ?? '').trim();
  if (!name || !activityKey) return null;
  const localPath = localPart1AudioPath(activityKey, name, tone, voice);
  return (await audioFileExists(localPath)) ? localPath : null;
}
