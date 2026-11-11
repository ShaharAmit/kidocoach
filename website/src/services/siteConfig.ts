import { doc, getDoc } from 'firebase/firestore';
import { getDownloadURL, ref } from 'firebase/storage';
import { db, storage } from './firebase';

export type SampleClipConfig = {
  id: string;
  name: string;
  activityLabel: string;
  videoUrl: string;
  posterUrl?: string;
};

export type SiteConfig = {
  welcomeVideoUrl: string;
  appStoreUrl: string;
  playStoreUrl: string;
  sampleClips?: SampleClipConfig[];
};

const DEFAULT_SAMPLE_CLIPS: SampleClipConfig[] = [
  {
    id: 'jonathan',
    name: 'Jonathan',
    activityLabel: 'Morning Wake-Up',
    videoUrl: '/samples/jonathan.mp4',
  },
  {
    id: 'maya',
    name: 'Maya',
    activityLabel: 'Brush Teeth',
    videoUrl: '/samples/maya.mp4',
  },
  {
    id: 'leo',
    name: 'Leo',
    activityLabel: 'Get Dressed',
    videoUrl: '/samples/leo.mp4',
  },
  {
    id: 'emma',
    name: 'Emma',
    activityLabel: 'Bedtime Wind-Down',
    videoUrl: '/samples/emma.mp4',
  },
];

/**
 * Website media is hosted with the site (`website/public/videos`, `website/public/samples`), not in
 * Cloud Storage. Same as the live `public_site/config.welcomeVideoUrl`, so first visits start loading
 * before Firestore answers. The poster (`.jpg`) and captions (`.srt`) sit next to the video.
 */
export const DEFAULT_WELCOME_VIDEO_URL = '/videos/becky-welcome.mp4';

const DEFAULT_CONFIG: SiteConfig = {
  welcomeVideoUrl: DEFAULT_WELCOME_VIDEO_URL,
  appStoreUrl: 'https://apps.apple.com/',
  playStoreUrl: 'https://play.google.com/store',
  sampleClips: DEFAULT_SAMPLE_CLIPS,
};

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

const CONFIG_CACHE_KEY = 'kidocoach:siteConfig:v3';
const CONFIG_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export function readCachedConfig(): SiteConfig | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CONFIG_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ts: number; config: SiteConfig };
    if (Date.now() - parsed.ts > CONFIG_TTL_MS) return null;
    return parsed.config;
  } catch {
    return null;
  }
}

function writeCachedConfig(config: SiteConfig): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify({ ts: Date.now(), config }));
  } catch {
    // ignore quota/private-mode errors
  }
}

function readSampleClips(value: unknown): SampleClipConfig[] {
  if (!Array.isArray(value)) return DEFAULT_SAMPLE_CLIPS;
  const parsed: SampleClipConfig[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const id = readString(rec.id, '');
    const name = readString(rec.name, '');
    const activityLabel = readString(rec.activityLabel, 'Routine Step');
    const videoUrl = readString(rec.videoUrl, '');
    const posterUrl = readString(rec.posterUrl, '');
    if (id && name && videoUrl) {
      parsed.push({ id, name, activityLabel, videoUrl, ...(posterUrl ? { posterUrl } : {}) });
    }
  }
  return parsed.length > 0 ? parsed : DEFAULT_SAMPLE_CLIPS;
}

export async function fetchSiteConfig(): Promise<SiteConfig> {
  const cached = readCachedConfig();
  if (cached) return { ...cached, sampleClips: cached.sampleClips ?? DEFAULT_SAMPLE_CLIPS };

  const docRef = doc(db, 'public_site', 'config');
  const snapshot = await getDoc(docRef);
  if (!snapshot.exists()) {
    return DEFAULT_CONFIG;
  }

  const data = snapshot.data() as Record<string, unknown>;
  const config: SiteConfig = {
    welcomeVideoUrl: readString(data.welcomeVideoUrl, DEFAULT_CONFIG.welcomeVideoUrl),
    appStoreUrl: readString(data.appStoreUrl, DEFAULT_CONFIG.appStoreUrl),
    playStoreUrl: readString(data.playStoreUrl, DEFAULT_CONFIG.playStoreUrl),
    sampleClips: readSampleClips(data.sampleClips),
  };
  writeCachedConfig(config);
  return config;
}

/**
 * Public partner sign-up switch (`public_site/config.partnerProgram`, ADR-021). Read fresh, not
 * from the 4 h config cache, so flipping it takes effect on the next page load. Off when missing
 * or unreadable; invited emails and existing partners are handled by the server instead.
 */
export async function fetchPartnerProgramOpen(): Promise<boolean> {
  try {
    const snapshot = await getDoc(doc(db, 'public_site', 'config'));
    return snapshot.data()?.partnerProgram === true;
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function isLocalAssetUrl(value: string): boolean {
  return value.startsWith('/');
}

function normalizeStoragePath(value: string): string {
  return value.replace(/^gs:\/\/[^/]+\//, '').replace(/^\/+/, '');
}

/**
 * Objects that storage.rules make world-readable can be fetched without a download token, so their
 * URL is known synchronously (no `getDownloadURL` round trip before the welcome video can load).
 */
function isPublicStoragePath(objectPath: string): boolean {
  return objectPath.startsWith('avatars/public_site/')
    || /^avatars\/default\/welcome\.(mp4|jpg|srt|vtt)$/.test(objectPath);
}

function publicStorageUrl(objectPath: string): string {
  const bucket = storage.app.options.storageBucket;
  if (!bucket || !isPublicStoragePath(objectPath)) return '';
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(objectPath)}?alt=media`;
}

function getResolvedVideoUrlCacheKey(objectPath: string): string {
  return `kidocoach:welcomeVideoDownloadUrl:${objectPath}`;
}

function readCachedResolvedVideoUrl(objectPath: string): string {
  if (typeof window === 'undefined') return '';
  try {
    const raw = window.localStorage.getItem(getResolvedVideoUrlCacheKey(objectPath));
    return raw && raw.trim().length > 0 ? raw : '';
  } catch {
    return '';
  }
}

function writeCachedResolvedVideoUrl(objectPath: string, resolvedUrl: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(getResolvedVideoUrlCacheKey(objectPath), resolvedUrl);
  } catch {
    // ignore storage quota/private mode errors
  }
}

export async function resolveWelcomeVideoUrl(rawValue: string): Promise<string> {
  const value = rawValue.trim();
  if (!value) return '';

  if (isHttpUrl(value) || isLocalAssetUrl(value)) {
    return value;
  }

  const objectPath = normalizeStoragePath(value);
  if (!objectPath) {
    return '';
  }

  const publicUrl = publicStorageUrl(objectPath);
  if (publicUrl) {
    return publicUrl;
  }

  const cachedResolvedUrl = readCachedResolvedVideoUrl(objectPath);
  if (cachedResolvedUrl) {
    return cachedResolvedUrl;
  }

  try {
    const resolvedUrl = await getDownloadURL(ref(storage, objectPath));
    writeCachedResolvedVideoUrl(objectPath, resolvedUrl);
    return resolvedUrl;
  } catch {
    return '';
  }
}

export async function resolveStorageAssetUrl(rawValue: string): Promise<string> {
  const value = rawValue.trim();
  if (!value) return '';

  if (isHttpUrl(value)) {
    return value;
  }

  if (isLocalAssetUrl(value)) {
    return value;
  }

  const objectPath = normalizeStoragePath(value);
  if (!objectPath) {
    return '';
  }

  const publicUrl = publicStorageUrl(objectPath);
  if (publicUrl) {
    return publicUrl;
  }

  try {
    return await getDownloadURL(ref(storage, objectPath));
  } catch {
    return '';
  }
}

// ── Poster URL (first-frame preview image alongside the video in Storage) ──

function swapExtension(path: string, extension: string): string {
  return path.replace(/\.[^./?#]+$/, extension);
}

/** Poster/captions of a site-hosted video live next to it, so their URL needs no lookup. */
function siblingLocalAsset(videoRawValue: string, extension: string): string {
  const value = videoRawValue.trim();
  return isLocalAssetUrl(value) ? swapExtension(value, extension) : '';
}

function derivePosterObjectPath(videoRawValue: string): string {
  const value = videoRawValue.trim();
  if (!value || isHttpUrl(value) || isLocalAssetUrl(value)) return '';
  const objectPath = normalizeStoragePath(value);
  return objectPath.replace(/\.[^./?#]+$/, '.jpg');
}

function getPosterUrlCacheKey(objectPath: string): string {
  return `kidocoach:welcomePosterDownloadUrl:${objectPath}`;
}

/** Synchronous — safe to call before rendering to avoid a second-render flash. */
export function readCachedPosterUrl(videoRawValue: string): string {
  if (typeof window === 'undefined') return '';
  const localPoster = siblingLocalAsset(videoRawValue, '.jpg');
  if (localPoster) return localPoster;
  const objectPath = derivePosterObjectPath(videoRawValue);
  if (!objectPath) return '';
  const publicUrl = publicStorageUrl(objectPath);
  if (publicUrl) return publicUrl;
  try {
    const raw = window.localStorage.getItem(getPosterUrlCacheKey(objectPath));
    return raw && raw.trim().length > 0 ? raw : '';
  } catch {
    return '';
  }
}

/**
 * Resolves the poster image URL for the welcome video.
 * Derives the Storage path by replacing the video extension with `.jpg`
 * (e.g. avatars/default/welcome.mp4 → avatars/default/welcome.jpg).
 * Returns '' if the file does not exist — caller must handle gracefully.
 */
export async function resolveWelcomePosterUrl(videoRawValue: string): Promise<string> {
  const localPoster = siblingLocalAsset(videoRawValue, '.jpg');
  if (localPoster) return localPoster;
  const objectPath = derivePosterObjectPath(videoRawValue);
  if (!objectPath) return '';

  const publicUrl = publicStorageUrl(objectPath);
  if (publicUrl) return publicUrl;

  const cacheKey = getPosterUrlCacheKey(objectPath);
  try {
    const cached = typeof window !== 'undefined'
      ? window.localStorage.getItem(cacheKey)
      : null;
    if (cached && cached.trim().length > 0) return cached;
  } catch { /* ignore */ }

  try {
    const url = await getDownloadURL(ref(storage, objectPath));
    try { window.localStorage.setItem(cacheKey, url); } catch { /* quota */ }
    return url;
  } catch {
    // File not found or network error — not an error condition
    return '';
  }
}

export async function resolveWelcomeCaptionUrl(videoRawValue: string): Promise<string> {
  const localCaptions = siblingLocalAsset(videoRawValue, '.srt');
  if (localCaptions) return localCaptions;
  const value = videoRawValue.trim();
  if (!value || isHttpUrl(value)) return '';
  const objectPath = swapExtension(normalizeStoragePath(value), '.srt');
  if (!objectPath) return '';
  const publicUrl = publicStorageUrl(objectPath);
  if (publicUrl) return publicUrl;

  try {
    return await getDownloadURL(ref(storage, objectPath));
  } catch {
    return '';
  }
}
