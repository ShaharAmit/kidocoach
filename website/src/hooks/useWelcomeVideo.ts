import { RefObject, useEffect, useState } from 'react';
import {
  fetchSiteConfig,
  readCachedPosterUrl,
  resolveWelcomeCaptionUrl,
  resolveWelcomePosterUrl,
  resolveWelcomeVideoUrl,
  SiteConfig,
} from '../services/siteConfig';
import { getCaptionTrackSource, type CaptionTrackSource } from '../services/captionTrack';
import { getCachedVideoSource, getCachedImageSource, extractPosterFrame, getPosterFromCache, CachedVideoSource } from '../services/videoCache';

type UseWelcomeVideoOptions = {
  videoRef: RefObject<HTMLVideoElement | null>;
  fallbackConfig: SiteConfig;
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallbackValue: T): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallbackValue), timeoutMs);
    }),
  ]);
}

export function useWelcomeVideo({
  videoRef,
  fallbackConfig,
}: UseWelcomeVideoOptions) {
  const [siteConfig, setSiteConfig] = useState<SiteConfig>(fallbackConfig);
  const [loading, setLoading] = useState(true);
  const [videoSrc, setVideoSrc] = useState('');

  const [videoError, setVideoError] = useState('');
  const [videoFinished, setVideoFinished] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [posterSrc, setPosterSrc] = useState(() => readCachedPosterUrl(fallbackConfig.welcomeVideoUrl));
  const [captionSrc, setCaptionSrc] = useState('');

  useEffect(() => {
    let mounted = true;
    let releaseCachedVideo: (() => void) | undefined;
    let releaseCachedPoster: (() => void) | undefined;
    let releaseCachedCaptions: (() => void) | undefined;

    async function loadConfig() {
      try {
        const config = await withTimeout(fetchSiteConfig(), 4000, fallbackConfig);

        let resolvedVideoUrl = await withTimeout(
          resolveWelcomeVideoUrl(config.welcomeVideoUrl),
          5000,
          ''
        );
        if (!resolvedVideoUrl && config.welcomeVideoUrl !== fallbackConfig.welcomeVideoUrl) {
          resolvedVideoUrl = await withTimeout(
            resolveWelcomeVideoUrl(fallbackConfig.welcomeVideoUrl),
            4000,
            ''
          );
        }

        // Stable key for canvas-poster cache (strip rotating Firebase token)
        const stableKey = resolvedVideoUrl.indexOf('?alt=media') !== -1
          ? resolvedVideoUrl.substring(0, resolvedVideoUrl.indexOf('?alt=media'))
          : resolvedVideoUrl;

        // Fetch video, captions, and poster URL in parallel.
        // Poster is awaited here so posterSrc is set in the same render as loading→false.
        // This prevents the mobile shimmer from persisting after loading completes.
        const [cachedVideo, cachedPoster, cachedCaptions] = await Promise.all([
          withTimeout(getCachedVideoSource(resolvedVideoUrl), 5000, { src: resolvedVideoUrl }),
          withTimeout(
            resolveWelcomePosterUrl(config.welcomeVideoUrl)
              .then(url => url ? getCachedImageSource(url) : Promise.resolve({ src: '' } as CachedVideoSource)),
            6000,
            { src: '' } as CachedVideoSource
          ),
          withTimeout(
            resolveWelcomeCaptionUrl(config.welcomeVideoUrl)
              .then(url => url ? getCaptionTrackSource(url) : Promise.resolve({ src: '' } as CaptionTrackSource)),
            4000,
            { src: '' } as CaptionTrackSource
          ),
        ]);

        // Sync canvas read as fallback for desktop return visits (zero cost if present)
        const posterUrl = cachedPoster.src || getPosterFromCache(stableKey);

        if (mounted) {
          setSiteConfig(config);
          setVideoSrc(cachedVideo.src);
          setPosterSrc(posterUrl);
          setCaptionSrc(cachedCaptions.src);
          setVideoError('');
          setVideoFinished(false);
          setHasStarted(false);
        }

        // Desktop-only: extract canvas poster for future visits if storage poster is absent
        if (!cachedPoster.src) {
          extractPosterFrame(cachedVideo.src, stableKey).then((dataUrl) => {
            if (mounted && dataUrl) setPosterSrc((prev) => prev || dataUrl);
          }).catch(() => {});
        }

        releaseCachedVideo = cachedVideo.release;
        releaseCachedPoster = cachedPoster.release;
        releaseCachedCaptions = cachedCaptions.release;
      } catch (error) {
        console.warn('Failed to load site config from Firestore', error);
        if (mounted) {
          setVideoSrc('');
          setPosterSrc('');
          setCaptionSrc('');
          setVideoError('Welcome video failed to load from config.');
          setVideoFinished(true);
          setHasStarted(false);
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    loadConfig();

    return () => {
      mounted = false;
      if (releaseCachedVideo) releaseCachedVideo();
      if (releaseCachedPoster) releaseCachedPoster();
      if (releaseCachedCaptions) releaseCachedCaptions();
    };
  }, [fallbackConfig]);

  async function handleStartVideo() {
    const videoElement = videoRef.current;
    if (!videoElement) {
      return;
    }

    try {
      // iOS Safari is more reliable when playback starts muted, then unmutes.
      videoElement.muted = true;
      await videoElement.play();
      videoElement.muted = false;
      setHasStarted(true);
    } catch (error) {
      try {
        videoElement.muted = false;
        await videoElement.play();
        setHasStarted(true);
      } catch (secondError) {
        console.warn('Manual video playback failed', secondError ?? error);
      }
    }
  }

  function handleVideoEnded() {
    setVideoFinished(true);
  }

  function handleVideoPause() {
    // intentional pause by user — no state change needed beyond what caller tracks
  }

  function handleVideoPlay() {
    setVideoFinished(false);
    setHasStarted(true);
  }

  function handleVideoError() {
    setVideoError('Welcome video is unavailable. Check public_site/config.welcomeVideoUrl.');
    setVideoSrc('');
    setVideoFinished(true);
    setHasStarted(false);
  }

  return {
    siteConfig,
    loading,
    videoSrc,
    posterSrc,
    captionSrc,
    videoError,
    videoFinished,
    hasStarted,
    shouldShowSignup: videoFinished || (!loading && (!videoSrc || !!videoError)),
    handleStartVideo,
    handleVideoEnded,
    handleVideoPlay,
    handleVideoPause,
    handleVideoError,
  };
}