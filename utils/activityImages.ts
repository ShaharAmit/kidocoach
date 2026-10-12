import { useCallback, useSyncExternalStore } from 'react';
import {
  getActivityImagesRevision,
  getReadyActivityImageUri,
  subscribeActivityImages,
} from '../services/assetSync';
import { ActivityKey } from '../types';

/**
 * Returns a lookup for downloaded cloud artwork (catalog `image`), re-rendering the caller when
 * artwork finishes downloading. `null` means "use the bundled image".
 */
export function useActivityCloudImageUri(): (activityKey: ActivityKey) => string | null {
  const revision = useSyncExternalStore(subscribeActivityImages, getActivityImagesRevision, getActivityImagesRevision);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((activityKey: ActivityKey) => getReadyActivityImageUri(activityKey), [revision]);
}
