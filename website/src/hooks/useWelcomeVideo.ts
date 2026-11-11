import { RefObject, useEffect, useRef, useState } from 'react';
import {
  fetchSiteConfig,
  readCachedConfig,
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
  const [siteConfig, setSiteConfig] = useState<SiteConfig>(() => readCachedConfig() ?? fallbackConfig);
  const [loading, setLoading] = useState(true);
  const [videoSrc, setVideoSrc] = useState('');

  const [videoError, setVideoError] = useState('');
  const [videoFinished, setVideoFinished] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [posterSrc, setPosterSrc] = useState(() => readCachedPosterUrl(fallbackConfig.welcomeVideoUrl));
  const [captionSrc, setCaptionSrc] = useState('');

  // Set when playback starts, so a late config answer never swaps the video under the viewer.
  const startedRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    let shownPath = '';
    const releases: Array<() => void> = [];
    const keep = (release?: () => void) => {
      if (!release) return;
      if (mounted) releases.push(release);
      else release();
    };

    async function showVideo(videoPath: string): Promise<boolean> {
      const videoUrl = await withTimeout(resolveWelcomeVideoUrl(videoPath), 5000, '');
      if (!videoUrl || !mounted) return false;

      // Stable key for canvas-poster cache (strip rotating Firebase token)
      const tokenIndex = videoUrl.indexOf('&token=');
      const stableKey = tokenIndex !== -1 ? videoUrl.substring(0, tokenIndex) : videoUrl;

      // Cache hits are blob URLs; misses return the network URL immediately (streamed).
      const [cachedVideo, cachedPoster] = await Promise.all([
        withTimeout(getCachedVideoSource(videoUrl), 3000, { src: videoUrl } as CachedVideoSource),
        withTimeout(
          resolveWelcomePosterUrl(videoPath)
            .then(url => url ? getCachedImageSource(url) : Promise.resolve({ src: '' } as CachedVideoSource)),
          3000,
          { src: '' } as CachedVideoSource
        ),
      ]);
      keep(cachedVideo.release);
      keep(cachedPoster.release);
      if (!mounted) return false;

      shownPath = videoPath;
      setVideoSrc(cachedVideo.src);
      setPosterSrc(cachedPoster.src || getPosterFromCache(stableKey));
      setCaptionSrc('');
      setVideoError('');
      setVideoFinished(false);
      setHasStarted(false);
      setLoading(false);

      // Desktop-only: extract canvas poster for future visits if storage poster is absent
      if (!cachedPoster.src) {
        extractPosterFrame(cachedVideo.src, stableKey).then((dataUrl) => {
          if (mounted && dataUrl) setPosterSrc((prev) => prev || dataUrl);
        }).catch(() => {});
      }

      // Captions are optional and never hold up the video.
      void withTimeout(
        resolveWelcomeCaptionUrl(videoPath)
          .then(url => url ? getCaptionTrackSource(url) : Promise.resolve({ src: '' } as CaptionTrackSource)),
        6000,
        { src: '' } as CaptionTrackSource
      ).then((captions) => {
        keep(captions.release);
        if (mounted && shownPath === videoPath) setCaptionSrc(captions.src);
      });
      return true;
    }

    async function load() {
      const initialConfig = readCachedConfig() ?? fallbackConfig;
      const configPromise = withTimeout<SiteConfig | null>(fetchSiteConfig(), 4000, null).catch((error) => {
        console.warn('Failed to load site config from Firestore', error);
        return null;
      });

      // Start the known video right away; Firestore usually agrees with the cached/default path.
      await showVideo(initialConfig.welcomeVideoUrl);

      const config = await configPromise;
      if (!mounted) return;
      if (config) {
        setSiteConfig(config);
        if (config.welcomeVideoUrl !== shownPath && !startedRef.current) {
          await showVideo(config.welcomeVideoUrl);
        }
      }

      if (mounted && !shownPath) {
        setVideoSrc('');
        setPosterSrc('');
        setCaptionSrc('');
        setVideoError('Welcome video failed to load from config.');
        setVideoFinished(true);
        setHasStarted(false);
      }
      if (mounted) setLoading(false);
    }

    void load();

    return () => {
      mounted = false;
      releases.forEach((release) => release());
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
      startedRef.current = true;
      setHasStarted(true);
    } catch (error) {
      try {
        videoElement.muted = false;
        await videoElement.play();
        startedRef.current = true;
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
    startedRef.current = true;
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