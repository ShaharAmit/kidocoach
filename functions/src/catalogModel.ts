/**
 * Pure model for the Firestore `catalog/activities` document — no Firebase imports, so the Storage
 * triggers, the seed script (via lib/catalogModel.js) and unit tests all share one implementation.
 * The client-side reader is utils/activityCatalogModel.ts; keep the shapes in sync.
 *
 * Storage layout that feeds the catalog:
 *   avatars/{avatarId}/{key}_p1.mp4         Part 1 greeting clip            → assets[avatar].p1
 *   avatars/{avatarId}/{key}.mp4            Part 2 activity clip            → assets[avatar].p2
 *   avatars/{avatarId}/{key}_p2.mp4         Part 2 alias (used only if {key}.mp4 is absent)
 *   avatars/{avatarId}/{key}_captions.json  authored caption cues           → assets[avatar].captions
 *   catalog/activities/{key}.json           label, stars, timing, Part 1 text, …
 *   catalog/activities/{key}.png|jpg|webp   picker/home artwork             → image
 */

export type Tone = 'cheerful' | 'encouraging' | 'calm';
export type AssetKind = 'p1' | 'p2' | 'captions';

export interface AssetRef {
  path: string;
  generation: string;
  md5?: string;
  size?: number;
}

export interface CatalogPart1 {
  text: string;
  tone: Tone;
  version: number;
}

export interface CatalogEntry {
  key: string;
  label?: string;
  emoji?: string;
  subtitle?: string;
  timeOfDay?: 'morning' | 'evening' | 'general';
  timerSeconds?: number;
  durationMode?: 'fixed' | 'variable';
  stars?: 0 | 1 | 2;
  order?: number;
  enabled?: boolean;
  minAppVersion?: string;
  promptText?: string;
  part1?: CatalogPart1;
  image?: AssetRef;
  assets?: Record<string, Partial<Record<AssetKind, AssetRef>>>;
}

export type CatalogActivities = Record<string, CatalogEntry>;

export type CatalogMetadata = Omit<CatalogEntry, 'key' | 'image' | 'assets' | 'part1'> & {
  part1?: { text: string; tone?: Tone; version?: number };
};

export type CatalogObject =
  | { type: 'media'; activityKey: string; avatarId: string; kind: AssetKind; isAlias: boolean }
  | { type: 'metadata'; activityKey: string }
  | { type: 'image'; activityKey: string };

export const ACTIVITY_KEY_PATTERN = /^[a-z0-9_]{1,48}$/;
const AVATAR_ID_PATTERN = /^[a-z0-9_-]{1,32}$/;
/** Avatar folders that hold non-activity media. */
const RESERVED_AVATAR_FOLDERS = new Set(['default', 'public_site']);
/** Files in avatar folders that look like activities but are not. */
const RESERVED_KEYS = new Set(['welcome']);
const TONES: Tone[] = ['cheerful', 'encouraging', 'calm'];

/** Classifies a Storage object path; `null` for anything that is not catalog input. */
export function parseCatalogObjectPath(name: string): CatalogObject | null {
  const media = /^avatars\/([^/]+)\/([a-z0-9_]+?)(_p1|_p2|_captions)?\.(mp4|json)$/.exec(name);
  if (media) {
    const [, avatarId, activityKey, suffix, ext] = media;
    if (!AVATAR_ID_PATTERN.test(avatarId) || RESERVED_AVATAR_FOLDERS.has(avatarId)) return null;
    if (!ACTIVITY_KEY_PATTERN.test(activityKey) || RESERVED_KEYS.has(activityKey)) return null;
    if (ext === 'json') {
      return suffix === '_captions' ? { type: 'media', activityKey, avatarId, kind: 'captions', isAlias: false } : null;
    }
    if (suffix === '_p1') return { type: 'media', activityKey, avatarId, kind: 'p1', isAlias: false };
    if (suffix === '_p2') return { type: 'media', activityKey, avatarId, kind: 'p2', isAlias: true };
    if (!suffix) return { type: 'media', activityKey, avatarId, kind: 'p2', isAlias: false };
    return null;
  }

  const catalog = /^catalog\/activities\/([a-z0-9_]+)\.(json|png|jpe?g|webp)$/.exec(name);
  if (catalog) {
    const [, activityKey, ext] = catalog;
    if (!ACTIVITY_KEY_PATTERN.test(activityKey)) return null;
    return ext === 'json' ? { type: 'metadata', activityKey } : { type: 'image', activityKey };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(raw: Record<string, unknown>, field: string, max: number, errors: string[]): string | undefined {
  const value = raw[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    errors.push(`${field} must be a non-empty string of at most ${max} characters`);
    return undefined;
  }
  return value.trim();
}

/** Validates a `catalog/activities/{key}.json` payload. */
export function validateCatalogMetadata(raw: unknown): { ok: true; value: CatalogMetadata } | { ok: false; errors: string[] } {
  if (!isRecord(raw)) return { ok: false, errors: ['metadata must be a JSON object'] };
  const errors: string[] = [];
  const value: CatalogMetadata = {};

  value.label = optionalString(raw, 'label', 60, errors);
  if (!value.label) errors.push('label is required');
  value.emoji = optionalString(raw, 'emoji', 16, errors);
  value.subtitle = optionalString(raw, 'subtitle', 200, errors);
  value.promptText = optionalString(raw, 'promptText', 300, errors);
  value.minAppVersion = optionalString(raw, 'minAppVersion', 20, errors);
  if (value.minAppVersion && !/^\d+(\.\d+){0,3}$/.test(value.minAppVersion)) {
    errors.push('minAppVersion must look like 1.2.3');
  }

  if (raw.timeOfDay !== undefined) {
    if (raw.timeOfDay === 'morning' || raw.timeOfDay === 'evening' || raw.timeOfDay === 'general') {
      value.timeOfDay = raw.timeOfDay;
    } else errors.push('timeOfDay must be morning, evening or general');
  }
  if (raw.durationMode !== undefined) {
    if (raw.durationMode === 'fixed' || raw.durationMode === 'variable') value.durationMode = raw.durationMode;
    else errors.push('durationMode must be fixed or variable');
  }
  if (raw.timerSeconds !== undefined) {
    const t = raw.timerSeconds;
    if (typeof t === 'number' && Number.isInteger(t) && t >= 10 && t <= 3 * 60 * 60) value.timerSeconds = t;
    else errors.push('timerSeconds must be an integer between 10 and 10800');
  }
  if (raw.stars !== undefined) {
    if (raw.stars === 0 || raw.stars === 1 || raw.stars === 2) value.stars = raw.stars;
    else errors.push('stars must be 0, 1 or 2');
  }
  if (raw.order !== undefined) {
    if (typeof raw.order === 'number' && Number.isFinite(raw.order)) value.order = raw.order;
    else errors.push('order must be a number');
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') value.enabled = raw.enabled;
    else errors.push('enabled must be a boolean');
  }

  if (raw.part1 !== undefined) {
    if (!isRecord(raw.part1)) {
      errors.push('part1 must be an object');
    } else {
      const text = raw.part1.text;
      const tone = raw.part1.tone;
      const version = raw.part1.version;
      if (typeof text !== 'string' || !text.includes('{name}') || text.length > 200) {
        errors.push('part1.text must contain {name} and be at most 200 characters');
      } else if (tone !== undefined && !TONES.includes(tone as Tone)) {
        errors.push('part1.tone must be cheerful, encouraging or calm');
      } else if (version !== undefined && !(typeof version === 'number' && Number.isInteger(version) && version >= 1)) {
        errors.push('part1.version must be a positive integer');
      } else {
        value.part1 = { text: text.trim(), tone: tone as Tone | undefined, version: version as number | undefined };
      }
    }
  }

  for (const key of Object.keys(value) as (keyof CatalogMetadata)[]) {
    if (value[key] === undefined) delete value[key];
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

function generationNumber(ref: AssetRef | undefined): number {
  return ref ? Number(ref.generation) || 0 : 0;
}

function clone(entry: CatalogEntry | undefined, key: string): CatalogEntry {
  return entry ? JSON.parse(JSON.stringify(entry)) : { key };
}

/**
 * Records an uploaded media file. Returns `null` when nothing changes: an older generation
 * delivered out of order, or a `_p2` alias while the canonical `{key}.mp4` is registered.
 */
export function applyAssetUpload(
  entry: CatalogEntry | undefined,
  key: string,
  avatarId: string,
  kind: AssetKind,
  ref: AssetRef,
  isAlias: boolean
): CatalogEntry | null {
  const current = entry?.assets?.[avatarId]?.[kind];
  if (current) {
    const currentIsAlias = kind === 'p2' && current.path.endsWith('_p2.mp4');
    if (isAlias && !currentIsAlias) return null;
    if (current.path === ref.path && generationNumber(current) >= generationNumber(ref)) return null;
  }
  const next = clone(entry, key);
  next.assets = next.assets ?? {};
  next.assets[avatarId] = { ...(next.assets[avatarId] ?? {}), [kind]: ref };
  return next;
}

/**
 * Forgets a deleted media file, but only if the catalog still points at that exact object
 * generation — overwriting a file also emits a delete for the previous generation, which must
 * not remove the new upload's ref.
 */
export function applyAssetDeletion(
  entry: CatalogEntry | undefined,
  avatarId: string,
  kind: AssetKind,
  path: string,
  generation: string
): CatalogEntry | null {
  const current = entry?.assets?.[avatarId]?.[kind];
  if (!entry || !current || current.path !== path || current.generation !== generation) return null;
  const next = clone(entry, entry.key);
  delete next.assets![avatarId][kind];
  if (Object.keys(next.assets![avatarId]).length === 0) delete next.assets![avatarId];
  return next;
}

export function applyImageUpload(entry: CatalogEntry | undefined, key: string, ref: AssetRef): CatalogEntry | null {
  if (entry?.image && entry.image.path === ref.path && generationNumber(entry.image) >= generationNumber(ref)) return null;
  const next = clone(entry, key);
  next.image = ref;
  return next;
}

export function applyImageDeletion(entry: CatalogEntry | undefined, path: string, generation: string): CatalogEntry | null {
  if (!entry?.image || entry.image.path !== path || entry.image.generation !== generation) return null;
  const next = clone(entry, entry.key);
  delete next.image;
  return next;
}

/**
 * Metadata file deleted: hide the activity but keep media refs and the Part 1 version history,
 * so re-uploading the same greeting text can never resurrect an older cached clip key.
 */
export function clearMetadata(entry: CatalogEntry | undefined): CatalogEntry | null {
  if (!entry) return null;
  const next: CatalogEntry = { key: entry.key, enabled: false };
  if (entry.assets) next.assets = JSON.parse(JSON.stringify(entry.assets));
  if (entry.image) next.image = { ...entry.image };
  if (entry.part1) next.part1 = { ...entry.part1 };
  return next;
}

/**
 * Replaces the entry's metadata with the uploaded file (the JSON is the source of truth; media
 * refs are kept). The Part 1 version auto-increments whenever the greeting text or tone changes,
 * which changes the audio cache key, so every device fetches the new greeting.
 */
export function applyMetadata(entry: CatalogEntry | undefined, key: string, meta: CatalogMetadata): CatalogEntry {
  const { part1, ...fields } = meta;
  const next: CatalogEntry = { key, ...JSON.parse(JSON.stringify(fields)) };
  if (entry?.assets) next.assets = JSON.parse(JSON.stringify(entry.assets));
  if (entry?.image) next.image = { ...entry.image };
  if (part1) {
    const previous = entry?.part1;
    const tone = part1.tone ?? previous?.tone ?? 'encouraging';
    const changed = !previous || previous.text !== part1.text || previous.tone !== tone;
    const baseVersion = previous?.version ?? 1;
    const version = Math.max(part1.version ?? 1, changed && previous ? baseVersion + 1 : baseVersion);
    next.part1 = { text: part1.text, tone, version };
  }
  return next;
}
