import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { doc, getDocFromServer, onSnapshot } from 'firebase/firestore';
import { useSyncExternalStore } from 'react';
import { db } from './firebase';
import {
  ACTIVITY_KEYS,
  applyActivityDefinitions,
  isActivitySelectable,
} from '../constants/activities';
import { ActivityKey } from '../types';
import {
  CatalogAssetKind,
  CatalogAssetRef,
  DEFAULT_CATALOG_AVATAR_ID,
  ParsedCatalog,
  parseActivityCatalog,
} from '../utils/activityCatalogModel';

/**
 * Runtime activity catalog: Firestore `catalog/activities` (one document, one read) mirrored to
 * AsyncStorage for offline launches. It is the app's only source of activities (none are
 * bundled): applying it updates the shared registry in constants/activities.ts, so pickers, the
 * player, and asset sync all see new or changed activities without an app release.
 */

const STORAGE_KEY = 'activity_catalog_v1';
const DEFAULT_REFRESH_TIMEOUT_MS = 5000;

type CatalogSource = 'none' | 'device' | 'server';

let parsed: ParsedCatalog | null = null;
let source: CatalogSource = 'none';
let signature = '';
let revision = 0;
let cacheLoad: Promise<void> | null = null;
const listeners = new Set<() => void>();

function appVersion(): string {
  return Constants.expoConfig?.version ?? '0.0.0';
}

function notify() {
  revision += 1;
  listeners.forEach((listener) => listener());
}

/** Applies a raw catalog payload; returns whether the visible catalog changed. */
function applyRaw(raw: unknown, nextSource: CatalogSource): boolean {
  const activities = raw && typeof raw === 'object' ? (raw as { activities?: unknown }).activities : undefined;
  if (!activities || typeof activities !== 'object') return false;
  const json = JSON.stringify(activities);
  if (json === signature) {
    if (nextSource === 'server') source = 'server';
    return false;
  }

  const next = parseActivityCatalog({ activities }, {
    appVersion: appVersion(),
    avatarId: DEFAULT_CATALOG_AVATAR_ID,
  });
  if (!next) return false;

  parsed = next;
  signature = json;
  source = nextSource;
  applyActivityDefinitions(next.definitions);
  notify();

  if (nextSource === 'server') {
    AsyncStorage.setItem(STORAGE_KEY, json).catch(() => undefined);
  }
  return true;
}

/** Restores the last server catalog from disk. Safe to call repeatedly. */
export function loadCachedActivityCatalog(): Promise<void> {
  if (!cacheLoad) {
    cacheLoad = (async () => {
      try {
        const json = await AsyncStorage.getItem(STORAGE_KEY);
        if (json && source !== 'server') applyRaw({ activities: JSON.parse(json) }, 'device');
      } catch (err) {
        console.warn('[ActivityCatalog] Failed to read cached catalog:', err);
      }
    })();
  }
  return cacheLoad;
}

/**
 * Fetches the catalog from the server (never the Firestore cache). Resolves within `timeoutMs`
 * even on a dead connection, leaving the device copy in place.
 */
export async function refreshActivityCatalog(
  timeoutMs = DEFAULT_REFRESH_TIMEOUT_MS
): Promise<{ ok: boolean; changed: boolean }> {
  await loadCachedActivityCatalog();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snap = await Promise.race([
      getDocFromServer(doc(db, 'catalog', 'activities')),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Catalog refresh timed out.')), timeoutMs);
      }),
    ]);
    if (!snap.exists()) return { ok: true, changed: false };
    return { ok: true, changed: applyRaw(snap.data(), 'server') };
  } catch (err) {
    console.warn('[ActivityCatalog] Refresh failed, using device copy:', err);
    return { ok: false, changed: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Live updates while the app is in the foreground. Returns an unsubscribe function. */
export function startActivityCatalogListener(): () => void {
  return onSnapshot(
    doc(db, 'catalog', 'activities'),
    (snap) => {
      if (snap.metadata.fromCache || !snap.exists()) return;
      applyRaw(snap.data(), 'server');
    },
    (err) => console.warn('[ActivityCatalog] Listener error:', err)
  );
}

/** Whether any catalog (server or on-device copy) is loaded. Without one the app has no activities. */
export function hasActivityCatalog(): boolean {
  return parsed !== null;
}

export function hasServerCatalog(): boolean {
  return source === 'server' && parsed !== null;
}

/**
 * `undefined` → no catalog on this device yet (callers fall back to path conventions + Storage
 * metadata); `null` → the catalog says this asset does not exist.
 */
export function getCatalogAssetRef(
  activityKey: ActivityKey,
  avatarId: string,
  kind: CatalogAssetKind
): CatalogAssetRef | null | undefined {
  if (!parsed) return undefined;
  return parsed.assets[activityKey]?.[avatarId]?.[kind] ?? null;
}

export function getCatalogImageRef(activityKey: ActivityKey): CatalogAssetRef | null | undefined {
  if (!parsed) return undefined;
  return parsed.images[activityKey] ?? null;
}

/** Every activity the app should hold media for (selectable ones, in catalog order). */
export function getPrefetchableActivityKeys(): ActivityKey[] {
  return ACTIVITY_KEYS.filter((key) => isActivitySelectable(key));
}

/** Every activity key the catalog references (selectable or not) — used for cache cleanup. */
export function getCatalogActivityKeys(): ActivityKey[] {
  return parsed ? Object.keys(parsed.assets) : [...ACTIVITY_KEYS];
}

export function subscribeActivityCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getRevision() {
  return revision;
}

/** Re-renders the caller whenever the catalog changes. */
export function useActivityCatalogRevision(): number {
  return useSyncExternalStore(subscribeActivityCatalog, getRevision, getRevision);
}
