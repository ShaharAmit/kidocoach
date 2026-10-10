/**
 * Temporary feature flags for gating work-in-progress or paused functionality.
 */

/**
 * Personalized Gemini TTS audio overlay (per-child name, dynamically generated).
 * Currently disabled: the avatar videos already contain baked-in narration audio,
 * so we rely on that instead of generating/playing a separate TTS track.
 * Flip back to `true` once personalized narration is ready to re-enable. NOTE: the
 * `generateRoutineAudio` Cloud Function and client `audio_cache` reads were removed when
 * TTS was locked down — re-enabling needs an authenticated, quota-checked callable first.
 */
export const TTS_AUDIO_ENABLED = false;
