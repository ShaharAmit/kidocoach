import * as FileSystem from 'expo-file-system/legacy';
import { httpsCallable } from 'firebase/functions';
import { getDownloadURL, ref } from 'firebase/storage';
import { functions, storage, ensureAuth } from './firebase';
import { localAudioPath } from './assetSync';
import { ActivityKey, Routine, ToneOption, VoiceOption } from '../types';
import { normalizeNameToken } from '../utils/nameToken';

interface GeneratePart1AudioRequest {
  childName: string;
  activityKey: string;
  tone?: ToneOption;
  voice?: VoiceOption;
}

interface GeneratePart1AudioResponse {
  storagePath: string | null;
  cacheKey: string;
  status: 'ready' | 'generating';
}

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
const AUDIO_DIR = `${FileSystem.documentDirectory}audio/`;

const PART1_DEFAULT_TONES: Record<string, ToneOption> = {
  wake_up: 'encouraging',
  make_bed: 'encouraging',
  brush_teeth: 'encouraging',
  eat_breakfast: 'encouraging',
  get_dressed: 'encouraging',
  put_shoes_on: 'encouraging',
  comb_hair: 'encouraging',
  drink_water: 'encouraging',
  homework: 'encouraging',
  eat_dinner: 'calm',
  tidy_room: 'encouraging',
  put_on_pajamas: 'calm',
  bedtime_story: 'calm',
  go_to_sleep: 'calm',
};

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
  const selectedTone = tone ?? (activityKey ? PART1_DEFAULT_TONES[activityKey] : undefined) ?? 'encouraging';
  const selectedVoice = voice ?? 'woman';
  return `p1_${normalizedActivity}_${normalizedName}_${selectedTone}_${selectedVoice}`;
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
    return size >= MIN_AUDIO_BYTES;
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

    await ensureAuth();

    // The callable is the only cache lookup: it returns existing clips without regenerating
    // and refreshes their server-side retention (audio_cache is not client-readable).
    const generatePart1Audio = httpsCallable<GeneratePart1AudioRequest, GeneratePart1AudioResponse>(
      functions,
      'generatePart1Audio'
    );
    const result = await generatePart1Audio({
      childName: name,
      activityKey: actKey,
      tone,
      voice,
    });
    const { storagePath, status } = result.data;

    if (status === 'ready' && storagePath) {
      const ok = await downloadPart1Audio(localPath, storagePath);
      return ok ? localPath : null;
    }

    return null;
  } catch (err) {
    console.warn(`[Part1Audio] Failed to ensure audio for ${actKey} / "${name}":`, err);
    return null;
  }
}

/**
 * Preloads Part 1 greeting audio for all activities in a routine in batch.
 * Skips generation and downloads for any audio files that already exist on device.
 */
export async function ensureRoutinePart1AudioReady(routine: Routine): Promise<void> {
  const childName = (routine.childName ?? '').trim();
  if (!childName) return;

  const rawKeys = routine.activityStack.flat();
  const uniqueKeys = Array.from(new Set(rawKeys));
  if (uniqueKeys.length === 0) return;

  // Filter out activities that already have valid audio cached on device
  const missingKeys: string[] = [];
  for (const activityKey of uniqueKeys) {
    const localPath = localPart1AudioPath(activityKey, childName, routine.tone, routine.voice);
    const exists = await audioFileExists(localPath);
    if (!exists) {
      missingKeys.push(activityKey);
    }
  }

  // If everything is already cached locally, no need to call Cloud Function
  if (missingKeys.length === 0) return;

  try {
    await ensureAuth();

    const generateRoutinePart1Audio = httpsCallable<
      GenerateRoutinePart1AudioRequest,
      GenerateRoutinePart1AudioResponse
    >(functions, 'generateRoutinePart1Audio');

    const result = await generateRoutinePart1Audio({
      childName,
      activityKeys: missingKeys,
      tone: routine.tone,
      voice: routine.voice,
    });

    const downloads = result.data.results.map(async (item) => {
      if (item.status === 'ready' && item.storagePath) {
        const localPath = localAudioPath(item.cacheKey);
        if (await audioFileExists(localPath)) return;
        await downloadPart1Audio(localPath, item.storagePath);
      }
    });

    await Promise.allSettled(downloads);
  } catch (err) {
    console.warn('[Part1Audio] Failed batch preload for routine:', err);
  }
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
