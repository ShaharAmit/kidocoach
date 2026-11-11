import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useVisibility } from '../hooks/useVisibility';
import { useWelcomeVideo } from '../hooks/useWelcomeVideo';
import { usePartnerMenuLink } from '../hooks/usePartnerMenuLink';
import { openPrivacyChoices, trackEvent } from '../services/analytics';
import { submitEarlyAccessLead } from '../services/earlyAccess';
import { DEFAULT_WELCOME_VIDEO_URL, SiteConfig, SampleClipConfig } from '../services/siteConfig';
import InteractiveRoutinePreview, { SampleClipSwitcher } from '../components/InteractiveRoutinePreview';
import '../styles/home.css';

const FALLBACK: SiteConfig = {
  welcomeVideoUrl: DEFAULT_WELCOME_VIDEO_URL,
  appStoreUrl: 'https://apps.apple.com/',
  playStoreUrl: 'https://play.google.com/store',
};

// Keep in sync with the VideoObject JSON-LD and static copy in index.html and llms.txt (vite.config.ts).
const WELCOME_VIDEO_TRANSCRIPT =
  "Late for work again because the morning routine fell apart? Bedtime turning into a negotiation? Hi, I'm Becky. We're building a gamified coach that turns your kids' daily routines into fun, independent adventures. We're opening early access soon. Drop your email below to reserve your founder's pass, locking in an exclusive lifetime early adopter discount. Let's get your mornings back.";

const SAMPLE_TRANSCRIPTS = [
  { name: 'Jonathan', activity: 'Morning Wake-Up', text: 'Good morning, Jonathan! The sun is up, and a brand new adventure is waiting for us!' },
  { name: 'Maya', activity: 'Brush Teeth', text: "Toothbrush time, Maya! Let's make those teeth sparkle!" },
  { name: 'Leo', activity: 'Get Dressed', text: "Let's get dressed, Leo! Time to put on comfy clothes and get ready for an amazing day." },
  { name: 'Emma', activity: 'Bedtime Wind-Down', text: "Time to transform for the night, Emma! Let's put on our cozy pajamas." },
];

export default function HomePage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const heroStageRef = useRef<HTMLElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const partnerMenuLink = usePartnerMenuLink();
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
    siteConfig,
    loading,
    videoSrc,
    posterSrc,
    captionSrc,
    videoError,
    hasStarted,
    shouldShowSignup,
    handleStartVideo,
    handleVideoEnded,
    handleVideoPlay,
    handleVideoError,
    handleVideoPause,
  } = useWelcomeVideo({ videoRef, fallbackConfig: FALLBACK });

  const [activeSample, setActiveSample] = useState<{ clip: SampleClipConfig; url: string } | null>(null);
  const currentVideoSrc = activeSample ? activeSample.url : videoSrc;

  const isVideoFullyVisible = useVisibility(heroStageRef, 0.75);

  useEffect(() => {
    setIsVideoReady(false);
    // A newly selected sample should start as soon as it's ready; the welcome video waits for a tap.
    setPendingPlay(Boolean(activeSample));
    setIsPaused(true);
    if (readyFallbackRef.current) clearTimeout(readyFallbackRef.current);
  }, [currentVideoSrc]);

  // iOS often won't fire canplay/loadeddata for blob URLs without play().
  // Force-ready after 2.5s so the loading cover never stays forever.
  useEffect(() => {
    if (!currentVideoSrc || loading || isVideoReady) return;
    if (readyFallbackRef.current) clearTimeout(readyFallbackRef.current);
    readyFallbackRef.current = setTimeout(() => setIsVideoReady(true), 2500);
    return () => {
      if (readyFallbackRef.current) clearTimeout(readyFallbackRef.current);
    };
  }, [currentVideoSrc, loading, isVideoReady]);

  useEffect(() => {
    if (!pendingPlay || !currentVideoSrc || !isVideoReady || (!activeSample && (hasStarted || shouldShowSignup))) {
      return;
    }

    handleStartVideo();
    setPendingPlay(false);
  }, [activeSample, hasStarted, isVideoReady, pendingPlay, shouldShowSignup, currentVideoSrc, handleStartVideo]);

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
    if (!currentVideoSrc || (!activeSample && shouldShowSignup) || !isVideoReady) {
      if (!isVideoReady && currentVideoSrc && (activeSample || !shouldShowSignup)) setPendingPlay(true);
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
          <Link to="/profile" onClick={() => setMenuOpen(false)}>
            Profile
          </Link>
          {partnerMenuLink && (
            <Link to="/partners" onClick={() => setMenuOpen(false)}>
              {partnerMenuLink}
            </Link>
          )}
          <Link to="/terms" onClick={() => setMenuOpen(false)}>
            Terms and Conditions
          </Link>
          <Link to="/privacy" onClick={() => setMenuOpen(false)}>
            Privacy Policy
          </Link>
          <button type="button" onClick={() => { setMenuOpen(false); openPrivacyChoices(); }}>
            Privacy choices
          </button>
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
          <div className="hero-cta-row">
            <Link to="/profile" className="hero-cta-primary">Get started / Profile</Link>
            <a href="#how-it-works" className="hero-cta-secondary">How it works</a>
          </div>
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

          {currentVideoSrc ? (
            <>
            <video
              ref={videoRef}
              key={currentVideoSrc}
              className="welcome-video"
              src={currentVideoSrc}
              poster={!activeSample ? posterSrc || undefined : undefined}
              playsInline
              preload="auto"
              controls={false}
              onEnded={() => (activeSample ? setActiveSample(null) : handleVideoEnded())}
              onPlay={() => { if (!activeSample) handleVideoPlay(); setIsPaused(false); }}
              onPause={() => setIsPaused(true)}
              onError={() => (activeSample ? setActiveSample(null) : handleVideoError())}
              onLoadedData={() => setIsVideoReady(true)}
              onCanPlay={() => setIsVideoReady(true)}
            >
              {/* Not `default`: the welcome video already has captions burned into the picture. */}
              {!activeSample && captionSrc ? (
                <track kind="captions" srcLang="en" label="English" src={captionSrc} />
              ) : null}
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

        <SampleClipSwitcher
          clips={siteConfig.sampleClips ?? []}
          activeClipId={activeSample?.clip.id ?? null}
          onSelectClip={(clip, resolvedUrl) => {
            if (!clip || !resolvedUrl) {
              setActiveSample(null);
              return;
            }
            setActiveSample({ clip, url: resolvedUrl });
            setPendingPlay(true);
          }}
        />
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
            src="/badge-app-store.svg"
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
            src="/badge-google-play.svg"
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

      <section className="info-sections" aria-label="About KidoCoach">
        <InteractiveRoutinePreview />

        <section id="how-it-works" className="info-block">
          <p className="eyebrow">How It Works</p>
          <h2 className="section-title">Turn Daily Nagging Into Playful Independence</h2>
          <p className="section-lead">
            Designed for kids ages 2 to 12, KidoCoach guides your child step by step through
            morning and bedtime routines using an encouraging animated avatar coach that speaks
            their name.
          </p>
          <div className="feature-grid">
            <article className="feature-card">
              <span className="feature-step">1</span>
              <h3>Personalize in 2 Minutes</h3>
              <p>
                Set your child&apos;s name, age, wake-up and bedtime schedule, and where mornings
                usually get stuck—on the web or in the mobile app.
              </p>
            </article>
            <article className="feature-card">
              <span className="feature-step">2</span>
              <h3>Guided Avatar Coaching</h3>
              <p>
                At routine time, a friendly animated coach calls your child by name and walks them
                through each task—brushing teeth, getting dressed, eating breakfast, and winding down.
              </p>
            </article>
            <article className="feature-card">
              <span className="feature-step">3</span>
              <h3>Mission Complete!</h3>
              <p>
                Kids tap the giant &quot;Mission Complete&quot; button after each step and earn stars
                for building calm, consistent habits without parent nagging.
              </p>
            </article>
          </div>
        </section>

        <section id="why-kidocoach" className="info-block">
          <p className="eyebrow">Built for Real Families</p>
          <h2 className="section-title">Why Parents &amp; Kids Love KidoCoach</h2>
          <div className="benefit-grid">
            <article className="benefit-card">
              <h3>Speaks Your Child&apos;s Name</h3>
              <p>
                Personalized voice prompts keep kids engaged and focused on the current activity
                instead of getting distracted.
              </p>
            </article>
            <article className="benefit-card">
              <h3>Visual &amp; Step-by-Step Pacing</h3>
              <p>
                One clear visual task at a time with gentle timers reduces morning overwhelm and
                helps slow, dreamy, or easily distracted kids stay on track.
              </p>
            </article>
            <article className="benefit-card">
              <h3>Works Offline at Routine Time</h3>
              <p>
                The mobile app pre-downloads your child&apos;s routine videos and personalized voice
                tracks so mornings run smoothly even without Wi-Fi.
              </p>
            </article>
            <article className="benefit-card">
              <h3>One Account Across All Devices</h3>
              <p>
                Set up or subscribe on the web or mobile. Your family subscription unlocks access
                across iOS, Android, and web with a single parent login.
              </p>
            </article>
          </div>
        </section>

        <section id="faq" className="info-block faq-block">
          <p className="eyebrow">Questions &amp; Answers</p>
          <h2 className="section-title">Frequently Asked Questions</h2>
          <div className="faq-list">
            <details className="faq-item" open>
              <summary>What is KidoCoach and how does it help with kids&apos; routines?</summary>
              <p>
                KidoCoach is a daily routine app for kids (ages 2–12) that replaces parent nagging
                with a playful animated routine coach. It guides children through sequential morning
                and bedtime habits—like getting out of bed, getting dressed, brushing teeth, and
                putting toys away—using visual avatar loops, personalized voice audio that says your
                child&apos;s name, and a rewarding &quot;Mission Complete&quot; flow.
              </p>
            </details>
            <details className="faq-item">
              <summary>What age group is KidoCoach designed for?</summary>
              <p>
                KidoCoach is tailored for children ages 2 to 12. During the 7-step setup, the routine
                adapts to your child&apos;s age, natural morning pace, and how much independence or
                step-by-step support they need.
              </p>
            </details>
            <details className="faq-item">
              <summary>Which platforms does KidoCoach support?</summary>
              <p>
                KidoCoach is built for iOS (iPhone and iPad) and Android, with web account setup and
                subscription management at kidocoach.app/profile. One parent subscription unlocks the
                app across all of your family&apos;s devices.
              </p>
            </details>
            <details className="faq-item">
              <summary>How does KidoCoach help kids who get easily distracted or overwhelmed?</summary>
              <p>
                Instead of overwhelming kids with a long wall of chores, KidoCoach presents one visual,
                timed activity at a time with encouraging voice cues and immediate positive feedback,
                making transitions easier for slow, dreamy, or easily distracted mornings. (KidoCoach
                is an educational habit-building tool for families, not a medical or clinical device.)
              </p>
            </details>
            <details className="faq-item">
              <summary>How do I get started or join Early Access?</summary>
              <p>
                You can create your parent account and configure your child&apos;s routine right now on
                our <Link to="/profile">Profile &amp; Setup page</Link>, or click &quot;Early Access
                Signup&quot; to reserve your Founder&apos;s Pass and receive launch updates.
              </p>
            </details>
            <details className="faq-item" id="video-transcripts">
              <summary>What does Becky say in the videos? (Transcripts)</summary>
              <p>
                <strong>Meet Becky:</strong> {WELCOME_VIDEO_TRANSCRIPT}
              </p>
              {SAMPLE_TRANSCRIPTS.map(sample => (
                <p key={sample.name}>
                  <strong>{sample.name}, {sample.activity}:</strong> &ldquo;{sample.text}&rdquo;
                </p>
              ))}
            </details>
          </div>
        </section>

        <footer className="home-footer">
          <div className="home-footer-brand">
            <img className="brand-mark" src="/logo.png?v=9e729603" alt="" aria-hidden="true" />
            <span>KidoCoach — Daily Routine App for Kids</span>
          </div>
          <nav className="home-footer-links" aria-label="Footer navigation">
            <Link to="/morning-routine-for-kids">Morning Routines</Link>
            <Link to="/bedtime-routine-for-kids">Bedtime Routines</Link>
            <Link to="/visual-routine-schedule-for-kids">Visual Schedules</Link>
            <Link to="/profile">Get Started / Profile</Link>
            <Link to="/terms">Terms &amp; Conditions</Link>
            <Link to="/privacy">Privacy Policy</Link>
            <button type="button" className="footer-link-btn" onClick={openPrivacyChoices}>
              Privacy Choices
            </button>
          </nav>
        </footer>
      </section>

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

              <p className="signup-consent">
                By joining, you agree that KidoCoach may email you launch updates and the launch-rate
                offer. Unsubscribe anytime with the link in every email.{' '}
                <Link to="/privacy">Privacy Policy</Link>
              </p>

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
