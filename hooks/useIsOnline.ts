import { useNetworkState } from 'expo-network';

/** Optimistic until the first native reading arrives, so online buttons don't flash disabled. */
export function useIsOnline(): boolean {
  const { isInternetReachable, isConnected } = useNetworkState();
  return isInternetReachable ?? isConnected ?? true;
}
