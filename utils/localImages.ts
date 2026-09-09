import { useEffect, useSyncExternalStore } from 'react';
import { ImageSourcePropType } from 'react-native';
import { Asset } from 'expo-asset';

/**
 * Bundled images (`require('../assets/images/x.png')`) resolve to a packager-served HTTP URI in
 * dev builds and to a bundled resource in release builds. The HTTP variant stops resolving once
 * the dev server becomes unreachable (laptop asleep, IP change), which is why activity icons and
 * sky decorations render blank after the app has been open overnight — remounting the <Image>
 * only re-requests the same dead URL.
 *
 * Resolving each module through expo-asset once gives a stable `file://` URI (in release builds
 * the already-bundled resource path), so rendering no longer depends on the packager staying up.
 */

type ImageModule = number;

const localUris = new Map<ImageModule, string>();
const inFlight = new Map<ImageModule, Promise<string | null>>();
const listeners = new Set<() => void>();

let revision = 0;

function notify() {
  revision += 1;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getRevision() {
  return revision;
}

export async function ensureLocalImage(mod: ImageModule): Promise<string | null> {
  const cached = localUris.get(mod);
  if (cached) return cached;

  const pending = inFlight.get(mod);
  if (pending) return pending;

  const task = (async () => {
    try {
      const asset = Asset.fromModule(mod);
      if (!asset.localUri) {
        await asset.downloadAsync();
      }
      const uri = asset.localUri ?? null;
      if (uri) {
        localUris.set(mod, uri);
        notify();
      }
      return uri;
    } catch (err) {
      console.warn('[localImages] Failed to resolve bundled image:', err);
      return null;
    } finally {
      inFlight.delete(mod);
    }
  })();

  inFlight.set(mod, task);
  return task;
}

export function preloadLocalImages(mods: ImageModule[]): Promise<(string | null)[]> {
  return Promise.all(mods.map((mod) => ensureLocalImage(mod)));
}

/** Local file source when resolved, otherwise the original module so nothing regresses. */
export function localImageSource(mod: ImageModule): ImageSourcePropType {
  const uri = localUris.get(mod);
  return uri ? { uri } : mod;
}

/** Drop a bad resolution (e.g. an <Image> onError) and try to resolve it again. */
export function retryLocalImage(mod: ImageModule): void {
  if (localUris.delete(mod)) {
    notify();
  }
  ensureLocalImage(mod).catch(() => undefined);
}

/**
 * Re-renders the caller whenever a module finishes resolving. Use together with
 * `localImageSource()` when the set of images is dynamic (e.g. inside a list render).
 */
export function useLocalImagesRevision(mods?: ImageModule[]): number {
  useEffect(() => {
    if (mods?.length) {
      preloadLocalImages(mods).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mods?.length]);

  return useSyncExternalStore(subscribe, getRevision, getRevision);
}

/** Single-image convenience wrapper. */
export function useLocalImage(mod: ImageModule): ImageSourcePropType {
  useSyncExternalStore(subscribe, getRevision, getRevision);

  useEffect(() => {
    ensureLocalImage(mod).catch(() => undefined);
  }, [mod]);

  return localImageSource(mod);
}
