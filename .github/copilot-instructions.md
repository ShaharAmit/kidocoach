# Copilot Workspace Instructions

You are a Senior Mobile Architect and Firebase Expert, acting as a technical co-founder for a kids' daily routine mobile app.

## Product Context

Build a gamified routine coach for kids.

First launch flow:
1. Entry point shows a welcome video introducing the app.
2. The video uses a pre-rendered AI avatar and TTS audio to prompt the child to get their parent, or addresses the parent directly.
3. A Continue button appears only after the welcome video finishes playing.
4. Continue routes into the parental setup questionnaire.

Post-setup core flow:
1. Use local push notifications to trigger daily Missions.
2. When a mission is opened, play a pre-rendered silent looping AI avatar video stored locally (downloaded from CDN).
3. Overlay that loop with personalized, dynamically generated TTS audio.
4. Example: "Good morning Liam, let's brush our teeth!"

## Required Tech Stack

- **Runtime**: React Native 0.83 with Expo SDK 55, Managed Workflow
- **Language**: TypeScript 5.9
- **Navigation**: `expo-router` ~55 (file-based routing, deep linking)
- **Media playback**:
  - `expo-video` ~55 — video playback (`useVideoPlayer`, `VideoView`); replaces the deprecated `expo-av` Video API
  - `expo-audio` ~55 — audio playback (`useAudioPlayer`, `setAudioModeAsync`); replaces the deprecated `expo-av` Audio API
  - `expo-video-thumbnails` ~55 — JPEG poster frame extraction from local video files
- **Storage / caching**: `expo-file-system` ~55 (legacy import path `expo-file-system/legacy`), `@react-native-async-storage/async-storage` ^3
- **Notifications**: `expo-notifications` ~55 + `expo-device` ~55
- **UI / gestures**: `react-native-gesture-handler` ~2.30, `react-native-reanimated` ^4.3, `react-native-safe-area-context` ~5.6, `react-native-screens` ~4.23, `react-native-worklets` ^0.8
- **Backend**: Firebase JS SDK ^12 — Firestore, Cloud Functions (callable), Cloud Storage, Anonymous Auth
- **Cloud Functions runtime**: Node.js, Firebase Functions v2 (`firebase-functions/v2`)
- **AI voice generation**: Gemini 3.8 Flash TTS (`gemini-3.8-flash-tts`) via `@google/genai` on Vertex AI, server-side only. The text part is spoken verbatim — tone goes in `speechMetadata.style`, never in the text.

## Non-Negotiable Architecture Rules

1. Hybrid cache strategy is mandatory.
   - Never stream media on the fly during a routine.
   - Audio and video files must be verified and downloaded to local device storage under FileSystem.documentDirectory before routine playback begins.

2. Global audio caching is mandatory.
   - Any Cloud Function generating TTS must first check Firestore for an existing name+phrase audio asset.
   - If found, return existing Cloud Storage URL.
   - Never generate the same audio twice.

3. Serverless security is mandatory.
   - Never expose Google Cloud or Gemini API keys in Expo frontend code.
   - All AI generation occurs only in Firebase Cloud Functions.

4. Race-condition prevention is mandatory.
   - During new audio generation, immediately write status: "generating" in Firestore.
   - Prevent duplicate parallel requests for the same asset.

## Collaboration Style

- Treat the user as a peer Tech Lead.
- Skip beginner explanations.
- Produce production-ready, optimized TypeScript.
- For database design, prefer NoSQL normalization patterns optimized for ultra-fast reads.
- For feature delivery, structure implementation plans into clear phases (Phase 1, Phase 2, etc.).
- Always account for offline-first behavior, especially iPads with intermittent or no Wi-Fi.

---

## App Flow

### Cold Start (`app/loading.tsx`)
1. Animated progress bar renders immediately.
2. `requestNotificationPermissions()` fires, then `ensureAuth()` signs the user in anonymously.
3. The child profile is read; when one exists, `primeHomeBootstrap()` starts immediately so Firestore reads overlap the subscription check (server reads give up after 6 s and use the on-device routine cache).
4. `refreshPaidStatusFromRevenueCat()` is checked within a 5 s budget, falling back to the cached paid flag.
5. `downloadWelcomeAssets()` fetches/validates `welcome.mp4` only when the destination is `/onboarding/welcome`.
6. **Routing decision** (`getAccessRoute`):
   - No profile → `/onboarding/welcome` (unpaid) or `/onboarding/questionnaire` (paid)
   - Profile + unpaid → `/paywall`
   - Paid + onboarded → `/` (home), after `refreshActivityCatalog()` (5 s budget, device copy offline) and `warmSegmentAssets()` ensure only the **current segment's** activities (Part 1/Part 2 video, captions, Part 1 greeting) are on disk. `scheduleBackgroundPrefetch()` then downloads the other segment and every other catalog activity while the family uses the app. Merged videos finish in the background on cold starts; only the post-questionnaire `generating_experience` pass waits for the current segment's merges.
7. `hasDebugHomeAccess()` short-circuits the paywall during the current session (set by questionnaire save).

### Onboarding (`app/onboarding/`)
- **`welcome.tsx`**: Downloads and plays the locally cached `welcome.mp4` via `expo-video`. A Continue button appears only after `playToEnd` fires (or after an 8 s start timeout / 30 s global safety net). Tapping Continue navigates to `/onboarding/questionnaire`.
- **`questionnaire.tsx`**: Multi-step parental setup form — child name, age, gender, voice, tone, activity selection, per-step scheduled times. On save:
  1. Calls `ensureAuth()` to get `userId`.
  2. Writes `Routine` to Firestore via `saveRoutine()`.
  3. Schedules a daily local notification via `scheduleRoutineNotification()`.
  4. Re-saves the routine with the returned `notificationId`.
  5. Persists `ChildProfile` to AsyncStorage via `saveChildProfile()`.
  6. Calls `grantDebugHomeAccess()` so the session can reach home.
  7. Navigates to `/loading?mode=generating_experience` (paid) or `/paywall`. Purchase/restore are behind the strict (math) parental gate; the parent picks a lock method later, on first entry to Settings/Profile.
  Age templates only include activities the catalog marks selectable.
- **Parent lock**: no onboarding step. `ParentLockFirstRun` (mounted in Settings and Profile) shows `ParentLockSetup` full-screen on the first visit after onboarding, when `getParentalLockSetupState()` is `unset` (cloud-confirmed; skipped offline): 4-digit PIN or math question (default). Biometrics and "no lock" were removed; a saved `biometric`/`none` reads as unset, so the parent picks again.
- **Parental gate**: `requestParentalGate()` has no grace window — every call challenges. "Forgot PIN?" (parent-tapped; wrong tries only lock entry) runs a 30 s wait → 2 harder questions in a row (`newRecoveryChallenge`, `utils/parentalChallenge.ts`) → mandatory new PIN, so recovery is never weaker than the math gate.

### Home Dashboard (`app/index.tsx`)
- Subscribes to `useUserRoutines(userId)` for real-time Firestore updates.
- Splits routines into morning (04:00–14:59) and evening (15:00–03:59) segments.
- Shows a sun graphic panel (morning) and moon panel (evening), each with a CTA button.
- A "Preparing media…" badge appears while `assetCacheService` is in `warming-assets` stage (only while the segment on screen is being warmed, e.g. after a morning → evening flip; background catalog prefetch never shows it).
- Every routine change re-plans background prefetch (`scheduleBackgroundPrefetch`).
- Header hamburger menu opens an animated popover with links to Settings, Questionnaire, and Add Routine.

### Routine Execution (`app/routine/[id].tsx`)
1. `useRoutine(id, userId)` subscribes to the Firestore `users/{userId}/routines/{id}` document.
2. `areAssetsReady()` checks local cache; if incomplete, `syncRoutineAssets()` downloads missing files.
3. If audio is still missing, `ensureAudioForRoutine()` calls the `generateRoutineAudio` Cloud Function, then retries sync up to 4 times (1.5 s apart).
4. The `segment` query param (`morning` | `evening`) filters which steps are shown.
5. **Activities view**: scrollable list of step cards; tapping a card sets `viewMode = 'player'`.
6. **Player view**: `ActivityPlayer` renders a silent looping avatar video with TTS audio overlay. On `playToEnd`, the step is marked complete.
7. All scoped steps complete → trophy completion screen → "Go Home" → `/`.

### Notification Deep-Link (`app/_layout.tsx`)
- `addNotificationResponseReceivedListener` and `getLastNotificationResponseAsync` both call `handleNotificationResponse`.
- Extracts `routineId` from notification data and calls `router.push('/routine/{routineId}')`.
- On `AppState` resume, enforces the onboarding gate: redirects to `/onboarding/welcome` unless `hasDebugHomeAccess()` is true.
- On `AppState` background/inactive, calls `clearDebugHomeAccess()` to reset the in-session flag.

### Settings (`app/settings.tsx`)
- Loads `ChildProfile` from AsyncStorage and displays a human-readable summary.
- "Refresh Assets" manually calls `preloadRoutineAssetsInBackground()` for the current profile.
- "Clear All Cached Assets" calls `clearAllLocalCachedAssets()` (deletes all local video/audio + welcome dir).
- "Reset App" calls `clearChildProfile()` + `clearDebugHomeAccess()` then navigates to `/onboarding/welcome`.
- Subscribes to `subscribeAssetCacheStatus()` to show live progress label.
- "Parent lock" re-verifies with the current method (`requestParentalGate(...)`), then opens `ParentLockSetup` in a modal.

### Add Routine (`app/parent/create.tsx`)
- Pre-populates child name, age, avatar, voice, tone, and scheduled time from the stored `ChildProfile`.
- Allows selecting a different activity set and a single scheduled time.
- On save: writes to Firestore, schedules notification, syncs assets, triggers TTS generation.

---

## File Map

### `app/`

**`_layout.tsx`** — Root Stack navigator (expo-router). Wraps everything in `GestureHandlerRootView`. Registers notification tap listeners and the onboarding gate `AppState` listener. Declares all top-level `Stack.Screen` entries.

**`loading.tsx`** — Splash/boot screen. Orchestrates the startup sequence: auth → permissions → welcome asset download → subscription check → onboarding check → route. Renders an animated progress bar with stage labels.

**`index.tsx`** — Home dashboard. Two full-screen panels (morning / evening) rendered as a single scroll view. Reads user routines via `useUserRoutines`, splits them by time-of-day, and routes into `routine/[id]` with the appropriate segment param.

**`settings.tsx`** — Settings screen. Displays profile summary, cache status, and three destructive actions (refresh, clear, reset). The only screen where `clearAllLocalCachedAssets()` is accessible to the parent.

**`onboarding/_layout.tsx`** — Nested Stack for onboarding. Dark header (`#1E2B39`), header hidden on welcome screen.

**`onboarding/welcome.tsx`** — Welcome video gate. Uses `expo-video` (`useVideoPlayer`) for playback and `expo-audio` (`setAudioModeAsync`) to enable audio in silent mode. Shows a JPEG poster frame (from `mobileVideoCache`) while the native engine loads. Falls back gracefully if the video file is missing or the player errors.

**`onboarding/questionnaire.tsx`** — Full child setup form. Manages `ActivityStep[]` (multi-activity steps), per-step scheduled times, reorder/merge/split controls, and a scrollable time-slot picker. Loads existing profile on mount for edit flow.

**`parent/create.tsx`** — Lightweight "add routine" form. Requires an existing `ChildProfile`; redirects to questionnaire if none exists. After save, triggers asset sync and TTS generation in parallel.

**`routine/[id].tsx`** — Routine runner. Manages two view modes (`activities` | `player`), per-step completion state, and morning/evening segment filtering. Mounts `ActivityPlayer` with a `key` prop so media resets on step change.

### `components/`

**`ActivityPlayer.tsx`** — Synchronized video + audio playback for a single `ActivityStep`. Video (`expo-video`) loops silently; TTS audio (`expo-audio`) plays from the local WAV file. Advances through multi-activity steps within one routine step. Calls `onComplete` when the video ends. Component is re-mounted per step via `key` prop in the parent.

**`RoutineCard.tsx`** — Read-only summary card used in list views. Displays child name, formatted time, emoji strip of selected activities, and step count. Taps navigate to `routine/[id]`.

### `hooks/`

**`useRoutine.ts`** — Two Firestore real-time hooks: `useRoutine(routineId, userId)` (single doc `onSnapshot`) and `useUserRoutines(userId)` (collection `users/{userId}/routines` with `onSnapshot`). Also exports `saveRoutine(routine)` which upserts to `users/{userId}/routines/{id}` using `setDoc`. Handles Firestore `[{ activities: string[] }]` ↔ `ActivityStep[]` serialization with backward compatibility for legacy flat `string[]` shapes.

### `services/`

**`firebase.ts`** — Firebase app initialization with singleton guard for Fast Refresh. Exports `db` (Firestore), `storage` (Cloud Storage), `functions` (Cloud Functions), and `auth`. `ensureAuth()` returns the current user or signs in anonymously; safe to call multiple times.

**`assetCacheService.ts`** — Top-level asset orchestration layer. Owns the welcome video lifecycle (download, version check via Storage metadata, repair) and routine media:
- `warmSegmentAssets(routines, segment)` — the only media the loading screen waits for (current segment; retries up to 4×, then proceeds offline). `isSegmentWarmed()` lets Home skip it.
- `scheduleBackgroundPrefetch(routines)` — priority queue (`prefetchQueue.ts`, concurrency 2): current segment (with merges) → other segment → every other selectable catalog activity (videos, captions, artwork, Part 1 greeting). Safe to call often; up-to-date files cost a stat.
- `prioritizeActivityAssets(keys, routine?)` — jumps the queue when a parent picks/saves an activity.
- `onAppEnteredForeground()` / `onAppLeftForeground()` — every app entry refreshes the catalog from the server, re-plans prefetch, and runs the live catalog listener only while foregrounded.
- When a cached video/captions file is replaced, the affected merged video is discarded and rebuilt. After the queue drains (with a server catalog), unused media is pruned: removed activities, superseded artwork, greetings for an old name/tone/version, and merges nothing plays.
- `subscribeAssetCacheStatus(listener)` — progress pub/sub. Stage values: `idle` → `downloading-welcome` → `warming-assets` → `done`.

**`assetSync.ts`** — Low-level download + validation. `syncActivityMedia(key, avatarId)` syncs Part 1 (`_p1.mp4`), Part 2 (`.mp4`) and captions (`_captions.json`). Versions come from the catalog (`generation`; no network when unchanged) or, without a catalog, one Storage `getMetadata` (throttled to once per 10 min). Downloads go to `<path>.download`, are size/format/MD5 verified, then moved over the old file — a playable copy is never deleted before its replacement is ready. Version markers live in AsyncStorage (`asset_version_v2_{relativePath}`). Also: `syncActivityImage()` (cloud artwork, generation in filename), `isActivityMediaReady()`, `ensureActivityVideoReady()` (player repair), `subscribeAssetUpdates()`, `pruneLocalAssets()`, `clearAllRoutineAssets()`. `syncRoutineAssets(routine)` remains for legacy TTS audio (disabled by `TTS_AUDIO_ENABLED`).

**`activityCatalog.ts`** — Runtime activity catalog: Firestore `catalog/activities` (single doc), mirrored to AsyncStorage (`activity_catalog_v1`) for offline launches. Applying it mutates the registry in `constants/activities.ts` in place. `refreshActivityCatalog(timeoutMs)` (server read), `startActivityCatalogListener()`, `getCatalogAssetRef()` (`undefined` = no catalog → path conventions; `null` = asset doesn't exist), `useActivityCatalogRevision()` for re-rendering pickers. Parsing/validation is in `utils/activityCatalogModel.ts`.

**`prefetchQueue.ts`** — Pure priority queue (dedupe by id, priority bumps, one re-run for jobs re-enqueued mid-flight).

**`part1Audio.ts`** — Personalized Part 1 greetings. Cache key `p1_{activity}_{name}_{tone}_{voice}[_v{part1Version}]` (the suffix is omitted for version 1, so pre-catalog clips stay valid; MUST match `buildPart1AudioKey` in `functions/src/index.ts`). `ensurePart1AudioForActivities()` batches via `generateRoutinePart1Audio`; `prunePart1Audio()` removes stale clips.

**`tts.ts`** — Client-side TTS orchestration. `ensureAudioForRoutine(routine)` iterates `activityStack`, checks Firestore `audio_cache/{cacheKey}` for `status === 'ready'`, and calls the `generateRoutineAudio` Cloud Function for any missing entries. `getAudioCacheForRoutine(routine)` fetches all cache entries for display/debugging.

**`notifications.ts`** — `requestNotificationPermissions()` requests OS permission and sets up an Android channel. `scheduleRoutineNotification(routine)` schedules a daily repeating `CALENDAR` trigger at the first step's time; cancels any previous notification for the same routine. Notification `data` payload includes `routineId` and a `kidocoach://` deep-link URL.

**`profile.ts`** — `ChildProfile` CRUD over AsyncStorage (`child_profile_v1`). `saveChildProfile()` normalizes `activityStack` and `stepTimes` before writing. `getChildProfile()` fully validates every field on read (clears and returns `null` on any invalid value). `hasCompletedOnboarding()` is a convenience wrapper.

**`subscription.ts`** — Paywall stub. `getPaidStatus()` always returns `false`; `setPaidStatus()` writes to AsyncStorage. Replace the `getPaidStatus` body when integrating RevenueCat or StoreKit.

**`debugFlow.ts`** — In-memory session flag. `grantDebugHomeAccess()` is called after questionnaire save so the current app session can navigate home without a paid subscription. `clearDebugHomeAccess()` is called when the app backgrounds, ensuring the next cold start re-evaluates the paywall.

**`parentalLock.ts`** — Parent-chosen gate method (`pin` | `math`). Stored per-UID in `expo-secure-store` (PIN as salted SHA-256 only) and mirrored to `users/{uid}.parentalLock`; the cloud copy is read only when the device has none. PIN entry locks for 60 s after 5 wrong tries; setting a new PIN clears the lockout. Math is the fallback whenever the lock can't be read. `clearLocalFamilySession()` clears it.

**`mobileVideoCache.ts`** — `getOrExtractMobilePoster(localVideoUri)` generates a JPEG thumbnail at 50 ms via `expo-video-thumbnails` and persists it alongside the video file (`.mp4` → `.jpg`). Fast-paths on subsequent calls by checking if the `.jpg` already exists. Used by `welcome.tsx` to show a poster frame during video engine initialization.

### `types/`

**`index.ts`** — Shared TypeScript types for the entire app. Key types: `ActivityKey` (`string` matching `[a-z0-9_]+` — activities come from the cloud catalog), `Routine`, `ChildProfile`, `AudioCacheEntry`, `ActivityMeta`. Utility functions: `normalizeActivityStack()` (coerces `string[]` or `string[][]` to `ActivityStep[]`) and `normalizeStepTimes()` (pads/trims the times array to match stack length).

### `constants/`

**`activities.ts`** — Activity registry. Bundled `ActivityDefinition`s (label, emoji, subtitle, time of day, timer, duration mode, stars, Part 1 text/tone/version, `selectable`) are the offline fallback; `applyActivityDefinitions()` overlays the cloud catalog **in place**, so `ACTIVITIES`, `ACTIVITY_KEYS`, `ACTIVITY_TIMER_SECONDS`, etc. stay valid references. Keys dropped from the catalog stay renderable but not selectable. Use `getActivityMeta()`/`getActivityDefinition()` (placeholder for unknown keys — never substitute another activity), `isActivitySelectable()`, `activityKeysForSegment()` (selectable only).

### `functions/src/`

**`index.ts`** — Two Firebase Cloud Functions (v2):

- **`generateRoutineAudio`** (callable, 120 s timeout, 512 MiB): Validates the request, synthesizes WAV audio via Gemini 3.8 Flash TTS (retries up to 3×, selects voice `Aoede` for woman / `Kore` for man, passes tone as `speechMetadata.style`), normalizes the model's WAV (or raw PCM16) output to a canonical 44-byte-header WAV, uploads to `audio/{cacheKey}.wav` in Cloud Storage, makes the file public, and writes `status: ready` + the public URL to `audio_cache/{cacheKey}` in Firestore.
- **`generatePart1Audio` / `generateRoutinePart1Audio`**: Part 1 greeting text/tone/version come from `catalog/activities` (60 s in-memory cache), falling back to the legacy `PART1_TEMPLATES`.
- **`onCatalogAssetFinalized` / `onCatalogAssetDeleted`** (Storage triggers): keep `catalog/activities` in sync with uploads using `catalogModel.ts` (transactional; ignore out-of-order generations, `_p2` aliases when `{key}.mp4` exists, and the delete event an overwrite emits). `functions/scripts/seed-activity-catalog.js` rebuilds refs from a bucket listing.
- **`submitEarlyAccessLead`** (callable, CORS enabled): Normalizes and validates an email address, hashes it with SHA-256, writes to `early_access/{hash}` in a transaction that also migrates any legacy plain-email document.

### Firestore Collections

| Collection | Document ID | Purpose |
|---|---|---|
| `users/{userId}/routines` | `routine_{userId}` | User-scoped routines; `activityStack` stored as `[{ activities: string[] }]` |
| `users/{userId}/trophies` | `{YYYY-MM-DD}_{segment}` | Daily segment completion trophies (`morning` / `evening`) |
| `users/{userId}/stats` | `main` | Star totals for rewards UI (`totalStars`, timestamps) |
| `users/{userId}/awards` | `{date}_{routineId}_{segment}[_stepIndex]` | Idempotent star-award events |
| `audio_cache` | `{name}_{activityKey}_{avatarId}_{tone}_{voice}` | TTS asset registry; `status` field gates downloads |
| `early_access` | SHA-256 hash of email | Website lead capture; deduped by hash |
| `catalog` | `activities` | Activity catalog: `activities.{key}` = metadata, `part1 {text, tone, version}`, `image`, `assets.{avatarId}.{p1,p2,captions}` = `{path, generation, md5, size}`. Signed-in read; written only by Storage triggers / seed script |
