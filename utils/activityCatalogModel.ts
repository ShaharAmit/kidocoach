import type { ActivityDefinition, ActivityTimeOfDay } from '../constants/activities';
import type { ActivityKey, DurationMode, ToneOption } from '../types';
import { parseActivityTags, parseRoutineRules } from './routineComposer';

/**
 * Pure model for the Firestore `catalog/activities` document (no Firebase imports, so it is unit
 * testable). The document is maintained by the `onCatalogAssetFinalized/Deleted` Cloud Functions
 * from Storage uploads; see functions/src/catalogModel.ts for the server-side writer.
 */

export const ACTIVITY_KEY_PATTERN = /^[a-z0-9_]{1,48}$/;
export const DEFAULT_CATALOG_AVATAR_ID = 'becky';

export type CatalogAssetKind = 'p1' | 'p2' | 'captions';

export interface CatalogAssetRef {
  path: string;
  /** Storage object generation — changes on every overwrite, so it doubles as a version. */
  generation: string;
  /** Base64 MD5 as reported by Cloud Storage, used to verify downloads. */
  md5?: string;
  size?: number;
}

export interface ParsedCatalog {
  definitions: ActivityDefinition[];
  /** `assets[activityKey][avatarId][kind]` */
  assets: Record<ActivityKey, Record<string, Partial<Record<CatalogAssetKind, CatalogAssetRef>>>>;
  images: Record<ActivityKey, CatalogAssetRef>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown, max = 200): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value.trim() : undefined;
}

function parseAssetRef(value: unknown): CatalogAssetRef | undefined {
  if (!isRecord(value)) return undefined;
  const path = str(value.path, 512);
  const generation = typeof value.generation === 'number' ? String(value.generation) : str(value.generation, 64);
  if (!path || !generation) return undefined;
  return {
    path,
    generation,
    md5: str(value.md5, 64),
    size: typeof value.size === 'number' && Number.isFinite(value.size) ? value.size : undefined,
  };
}

const TONES: ToneOption[] = ['cheerful', 'encouraging', 'calm'];
const TIMES: ActivityTimeOfDay[] = ['morning', 'evening', 'general'];
const MODES: DurationMode[] = ['fixed', 'variable'];

/** Numeric dotted-version compare; missing segments count as 0 ("1.2" === "1.2.0"). */
export function compareAppVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => parseInt(part, 10) || 0);
  const pb = b.split('.').map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** Greeting shown for an entry that has no `part1` yet (it can't be selected anyway). */
const FALLBACK_PART1_TEXT = 'All right, {name}!';

/**
 * Builds the activity definitions from the remote catalog alone (the app bundles none). An
 * activity is selectable only when it is enabled, supported by this app build, and has Part 1 +
 * Part 2 videos for `avatarId` — so a half-finished upload never shows up as a broken option.
 */
export function parseActivityCatalog(
  raw: unknown,
  options: { appVersion: string; avatarId?: string }
): ParsedCatalog | null {
  if (!isRecord(raw) || !isRecord(raw.activities)) return null;
  const avatarId = options.avatarId ?? DEFAULT_CATALOG_AVATAR_ID;

  const definitions: ActivityDefinition[] = [];
  const assets: ParsedCatalog['assets'] = {};
  const images: ParsedCatalog['images'] = {};

  for (const [key, entry] of Object.entries(raw.activities)) {
    if (!ACTIVITY_KEY_PATTERN.test(key) || !isRecord(entry)) continue;
    const part1 = isRecord(entry.part1) ? entry.part1 : {};

    const entryAssets: ParsedCatalog['assets'][string] = {};
    if (isRecord(entry.assets)) {
      for (const [avatar, kinds] of Object.entries(entry.assets)) {
        if (!isRecord(kinds)) continue;
        const parsed: Partial<Record<CatalogAssetKind, CatalogAssetRef>> = {};
        for (const kind of ['p1', 'p2', 'captions'] as CatalogAssetKind[]) {
          const ref = parseAssetRef(kinds[kind]);
          if (ref) parsed[kind] = ref;
        }
        entryAssets[avatar] = parsed;
      }
    }
    assets[key] = entryAssets;
    const image = parseAssetRef(entry.image);
    if (image) images[key] = image;

    const label = str(entry.label, 60);
    // The server only speaks greetings it finds in the catalog, so selectability requires the
    // entry's own greeting text.
    const remotePart1Text = str(part1.text);
    const part1Text = remotePart1Text ?? FALLBACK_PART1_TEXT;
    const minAppVersion = str(entry.minAppVersion, 20);
    const supported = !minAppVersion || compareAppVersions(options.appVersion, minAppVersion) >= 0;
    const media = entryAssets[avatarId];
    const stars = entry.stars;
    const timer = entry.timerSeconds;
    const slot = entry.scheduleMinutes;

    if (!label) continue;

    definitions.push({
      key,
      label,
      emoji: str(entry.emoji, 16) ?? '⭐',
      subtitle: str(entry.subtitle) ?? "Let's do it together!",
      timeOfDay: TIMES.includes(entry.timeOfDay as ActivityTimeOfDay)
        ? (entry.timeOfDay as ActivityTimeOfDay)
        : 'general',
      timerSeconds: typeof timer === 'number' && Number.isInteger(timer) && timer >= 10 && timer <= 3 * 60 * 60
        ? timer
        : 120,
      ...(typeof slot === 'number' && Number.isInteger(slot) && slot >= 1 && slot <= 240
        ? { scheduleMinutes: slot }
        : {}),
      durationMode: MODES.includes(entry.durationMode as DurationMode)
        ? (entry.durationMode as DurationMode)
        : 'variable',
      stars: stars === 0 || stars === 1 || stars === 2 ? stars : 1,
      order: typeof entry.order === 'number' && Number.isFinite(entry.order) ? entry.order : 1000,
      part1Text,
      part1Tone: TONES.includes(part1.tone as ToneOption) ? (part1.tone as ToneOption) : 'encouraging',
      part1Version: typeof part1.version === 'number' && Number.isInteger(part1.version) && part1.version >= 1
        ? part1.version
        : 1,
      promptText: str(entry.promptText, 300) ?? part1Text,
      selectable: entry.enabled !== false && supported && Boolean(remotePart1Text && media?.p1 && media?.p2),
      tags: parseActivityTags(entry.tags) ?? [],
      routine: parseRoutineRules(entry.routine) ?? {},
    });
  }

  return { definitions, assets, images };
}

/** Converts Cloud Storage's base64 MD5 into the lowercase hex digest expo-file-system reports. */
export function base64Md5ToHex(base64: string): string | null {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = base64.replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  let hex = '';
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) return null;
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      hex += ((value >> bits) & 0xff).toString(16).padStart(2, '0');
    }
  }
  return hex.length === 32 ? hex : null;
}
