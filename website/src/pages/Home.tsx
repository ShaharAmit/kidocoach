import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useVisibility } from '../hooks/useVisibility';
import { useWelcomeVideo } from '../hooks/useWelcomeVideo';
import { trackEvent } from '../services/analytics';
import { submitEarlyAccessLead } from '../services/earlyAccess';
import { SiteConfig } from '../services/siteConfig';
import '../styles/home.css';

const FALLBACK: SiteConfig = {
  welcomeVideoUrl: 'avatars/default/welcome.mp4',
  appStoreUrl: 'https://apps.apple.com/',
  playStoreUrl: 'https://play.google.com/store',
};

export default function HomePage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const heroStageRef = useRef<HTMLElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isSignupOpen, setIsSignupOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [submitState, setSubmitState] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [submitMessage, setSubmitMessage] = useState('');
  const [isVideoReady, setIsVideoReady] = useState(false);
  const [pendingPlay, setPendingPlay] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  // 'play' | 'pause' | null — which icon to flash briefly
  const [flashIcon, setFlashIcon] = useState<'play' | 'pause' | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readyFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTouchRef = useRef(0);

  const {
    loading,
    videoSrc,
    posterSrc,
    videoError,
    hasStarted,
    shouldShowSignup,
    handleStartVideo,
    handleVideoEnded,
    handleVideoPlay,
    handleVideoError,
    handleVideoPause,
  } = useWelcomeVideo({ videoRef, fallbackConfig: FALLBACK });

  const isVideoFullyVisible = useVisibility(heroStageRef, 0.75);

  useEffect(() => {
    setIsVideoReady(false);
    setPendingPlay(false);
    if (readyFallbackRef.current) clearTimeout(readyFallbackRef.current);
  }, [videoSrc]);

  // iOS often won't fire canplay/loadeddata for blob URLs without play().
  // Force-ready after 2.5s so the loading cover never stays forever.
  useEffect(() => {
    if (!videoSrc || loading || isVideoReady) return;
    if (readyFallbackRef.current) clearTimeout(readyFallbackRef.current);
    readyFallbackRef.current = setTimeout(() => setIsVideoReady(true), 2500);
    return () => {
      if (readyFallbackRef.current) clearTimeout(readyFallbackRef.current);
    };
  }, [videoSrc, loading, isVideoReady]);

  useEffect(() => {
    if (!pendingPlay || !videoSrc || !isVideoReady || hasStarted || shouldShowSignup) {
      return;
    }

    handleStartVideo();
    setPendingPlay(false);
  }, [hasStarted, isVideoReady, pendingPlay, shouldShowSignup, videoSrc, handleStartVideo]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (window.innerWidth <= 780) {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
  }, []);

  // Force iOS Safari to paint the first frame without playing
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!isVideoReady || hasStarted || !videoEl) return;
    if (videoEl.readyState >= 2 && videoEl.currentTime === 0) {
      videoEl.currentTime = 0.001;
    }
  }, [isVideoReady, hasStarted]);

  function openSignupModal(source: 'ios_badge' | 'android_badge' | 'floating_button') {
    setIsSignupOpen(true);
    trackEvent('early_access_modal_open', { source });
  }

  function closeSignupModal() {
    setIsSignupOpen(false);
    trackEvent('early_access_modal_close');
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalizedEmail = email.trim().toLowerCase();
    const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail);
    if (!isValidEmail) {
      setSubmitState('error');
      setSubmitMessage('Enter a valid email address to reserve early access.');
      trackEvent('early_access_submit_invalid_email');
      return;
    }

    try {
      setSubmitState('submitting');
      setSubmitMessage('');
      trackEvent('early_access_submit_attempt');
      const result = await submitEarlyAccessLead(normalizedEmail);

      if (result.status === 'exists') {
        setSubmitState('success');
        setSubmitMessage('That email is already on the early access list.');
        trackEvent('early_access_submit_exists');
        return;
      }

      setSubmitState('success');
      setSubmitMessage("You're on the list. We'll reach out before early access opens.");
      setEmail('');
      trackEvent('early_access_submit_success');
    } catch (error) {
      console.warn('Failed to submit early access lead', error);
      setSubmitState('error');
      setSubmitMessage('Could not save your email right now. Please try again.');
      trackEvent('early_access_submit_error');
    }
  }

  function handleJumpToVideo() {
    const stageNode = heroStageRef.current;
    if (!stageNode || typeof window === 'undefined') {
      return;
    }

    const stageTop = stageNode.getBoundingClientRect().top + window.scrollY;
    const targetTop = Math.max(stageTop - 24, 0);

    // Keep this cue directional: it should only move the user downward toward the video.
    if (window.scrollY >= targetTop) {
      return;
    }

    window.scrollTo({ top: targetTop, behavior: 'smooth' });
  }

  function triggerFlash(icon: 'play' | 'pause') {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setFlashIcon(icon);
    flashTimerRef.current = setTimeout(() => setFlashIcon(null), 500);
  }

  function handleVideoAreaActivate(e?: React.SyntheticEvent) {
    // Suppress the synthetic click that iOS fires ~300ms after touchstart
    if (e?.type === 'click' && Date.now() - lastTouchRef.current < 600) return;
    if (e?.type === 'touchstart') lastTouchRef.current = Date.now();
    if (!videoSrc || shouldShowSignup || !isVideoReady) {
      if (!isVideoReady && videoSrc && !shouldShowSignup) setPendingPlay(true);
      return;
    }

    const videoEl = videoRef.current;

    if (!hasStarted) {
      // First play
      handleStartVideo();
      triggerFlash('pause');
      setIsPaused(false);
      return;
    }

    if (videoEl && !videoEl.paused) {
      videoEl.pause();
      handleVideoPause();
      triggerFlash('play');
      setIsPaused(true);
    } else if (videoEl) {
      videoEl.play().catch(() => {});
      triggerFlash('pause');
      setIsPaused(false);
    }
  }

  return (
    <main className="home-shell">
      <header className="top-bar">
        <div className="brand-lockup" aria-label="KidoCoach brand">
          <img className="brand-mark" src="/logo.png?v=9e729603" alt="" aria-hidden="true" />
          <span className="brand-name">KidoCoach</span>
        </div>

        <button
          className={`burger ${menuOpen ? 'open' : ''}`}
          type="button"
          aria-label="Open legal links"
          onClick={() => setMenuOpen((current) => !current)}
        >
          <span />
          <span />
          <span />
        </button>

        <nav className={`menu-sheet ${menuOpen ? 'visible' : ''}`}>
          <Link to="/terms" onClick={() => setMenuOpen(false)}>
            Terms and Conditions
          </Link>
          <Link to="/privacy" onClick={() => setMenuOpen(false)}>
            Privacy Policy
          </Link>
        </nav>
      </header>

      <section className="hero-layout">
        <div className="hero-copy">
          <p className="eyebrow">Morning Calm, Built In</p>
          <h1 className="hero-title">Meet Your Child&apos;s New Routine Coach</h1>
          <p className="hero-subtitle">
            Kidocoach is a daily routine app for kids built for morning routines, bedtime
            routines, and daily habits, helping parents raise independent children with a
            playful routine experience.
          </p>
        </div>

        <section
          ref={heroStageRef}
          className={`hero-stage ${videoSrc && !loading && !shouldShowSignup ? 'tappable' : ''}`}
          aria-label="Welcome video"
          onClick={(e) => handleVideoAreaActivate(e)}
          onTouchStart={(e) => handleVideoAreaActivate(e)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              handleVideoAreaActivate();
            }
          }}
          role={videoSrc && !loading && !shouldShowSignup ? 'button' : undefined}
          tabIndex={videoSrc && !loading && !shouldShowSignup ? 0 : undefined}
        >
          {loading ? <p className="state-label">Loading welcome video...</p> : null}
          {!loading && videoError ? <p className="state-label error">{videoError}</p> : null}

          {videoSrc ? (
            <>
            <video
              ref={videoRef}
              key={videoSrc}
              className="welcome-video"
              src={videoSrc}
              poster={posterSrc || undefined}
              playsInline
              preload="auto"
              controls={false}
              onEnded={handleVideoEnded}
              onPlay={() => { handleVideoPlay(); setIsPaused(false); }}
              onPause={() => setIsPaused(true)}
              onError={handleVideoError}
              onLoadedData={() => setIsVideoReady(true)}
              onCanPlay={() => setIsVideoReady(true)}
            >
            </video>

            {/* Shimmer: show while loading, OR while no poster AND neither the video engine
                 nor the 2.5s fallback timer has declared ready yet.
                 The isVideoReady guard prevents infinite shimmer when the Storage poster
                 isn't uploaded yet (e.g. welcome.jpg missing from Firebase Storage). */}
            {(loading || (!hasStarted && !posterSrc && !isVideoReady)) ? (
              <div className="video-loading-cover" aria-label="Preparing welcome experience">
                <img
                  className="video-loading-image"
                  src="/video-placeholder.svg"
                  alt="Welcome loading preview"
                />
                <div className="video-loading-overlay" aria-hidden="true" />
              </div>
            ) : null}
            </>
          ) : (
            loading
              ? (
                <div className="video-loading-cover" aria-label="Preparing welcome experience">
                  <img
                    className="video-loading-image"
                    src="/video-placeholder.svg"
                    alt="Welcome loading preview"
                  />
                  <div className="video-loading-overlay" aria-hidden="true" />
                </div>
              )
              : <div className="video-filler unavailable" aria-label="Video unavailable" />
          )}

          {/* Persistent play circle — visible when paused/not yet started */}
          {videoSrc && !loading && !shouldShowSignup && (!hasStarted || isPaused) ? (
            <div className="video-play-circle" aria-hidden="true">
              <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="24" cy="24" r="23" fill="rgba(0,0,0,0.52)" stroke="rgba(255,255,255,0.85)" strokeWidth="1.5"/>
                <polygon points="19,14 36,24 19,34" fill="white"/>
              </svg>
            </div>
          ) : null}

          {/* Flash icon — briefly shown on tap, YouTube style */}
          {flashIcon ? (
            <div className={`video-flash-icon video-flash-icon--${flashIcon}`} aria-hidden="true">
              {flashIcon === 'pause' ? (
                <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="24" cy="24" r="23" fill="rgba(0,0,0,0.52)" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5"/>
                  <rect x="15" y="13" width="6" height="22" rx="2" fill="white"/>
                  <rect x="27" y="13" width="6" height="22" rx="2" fill="white"/>
                </svg>
              ) : (
                <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="24" cy="24" r="23" fill="rgba(0,0,0,0.52)" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5"/>
                  <polygon points="19,14 36,24 19,34" fill="white"/>
                </svg>
              )}
            </div>
          ) : null}

          {videoSrc && !hasStarted && !shouldShowSignup && isVideoReady ? (
            <p className="video-tap-hint">Tap to play</p>
          ) : null}

          {shouldShowSignup ? (
            <p className="signup-ready-hint">Early access is open now</p>
          ) : null}
        </section>
      </section>

      <div className="floating-store-links" role="navigation" aria-label="Store links">
        <button
          className="store-badge-link pseudo-badge"
          type="button"
          onClick={() => openSignupModal('ios_badge')}
          aria-label="Join early access for iOS"
        >
          <img
            className="store-badge ios"
            src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg"
            alt="Coming soon to the App Store"
          />
        </button>
        <button
          className="store-badge-link pseudo-badge android-link"
          type="button"
          onClick={() => openSignupModal('android_badge')}
          aria-label="Join early access for Android"
        >
          <img
            className="store-badge android"
            src="https://upload.wikimedia.org/wikipedia/commons/7/78/Google_Play_Store_badge_EN.svg"
            alt="Coming soon to Google Play"
          />
        </button>
        <button
          className="floating-signup-button"
          type="button"
          onClick={() => openSignupModal('floating_button')}
        >
          Early Access Signup
        </button>
      </div>

      {!isVideoFullyVisible ? (
        <button
          className="scroll-cue"
          type="button"
          aria-label="Scroll to welcome video"
          onClick={handleJumpToVideo}
        >
          <span className="scroll-cue-text">Scroll</span>
          <span className="scroll-cue-arrow" aria-hidden="true">↓</span>
        </button>
      ) : null}

      {isSignupOpen ? (
        <div className="signup-modal-backdrop" onClick={closeSignupModal}>
          <div
            className="signup-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Early access signup"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="signup-modal-close"
              type="button"
              aria-label="Close signup"
              onClick={closeSignupModal}
            >
              Close
            </button>

            <div className="signup-panel" aria-live="polite">
              <p className="signup-kicker">Early Access</p>
              <h2 className="signup-title">Reserve your Founder&apos;s Pass</h2>
              <p className="signup-copy">
                Enter your email to lock in early access updates and the launch-rate offer.
              </p>

              <form className="signup-form" onSubmit={handleSubmit}>
                <label className="signup-label" htmlFor="early-access-email">
                  Email address
                </label>
                <input
                  id="early-access-email"
                  className="signup-input"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    if (submitState !== 'idle') {
                      setSubmitState('idle');
                      setSubmitMessage('');
                    }
                  }}
                  disabled={submitState === 'submitting' || submitState === 'success'}
                  required
                />
                <button
                  className="signup-button"
                  type="submit"
                  disabled={submitState === 'submitting' || submitState === 'success'}
                >
                  {submitState === 'submitting' ? 'Saving...' : submitState === 'success' ? 'Saved' : 'Join Early Access'}
                </button>
              </form>

              {submitMessage ? (
                <p className={`signup-message ${submitState}`}>{submitMessage}</p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
