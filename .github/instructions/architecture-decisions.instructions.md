---
applyTo: '**'
---

# Architecture Decisions

Decisions that are already made. Don't undo them without the user's agreement. Add new entries at the bottom, using the same format.

## ADR-001: Routines are composed from catalog rules, not static templates (2026-10)

**Decision.** Onboarding routines come from `composeRoutine()` (`utils/routineComposer.ts`). It takes the child's age and the questionnaire answers and uses per-activity `tags` + `routine` levels. There are no hardcoded per-age activity lists.

- `routine.{morning|evening} = { position, levels: { "<fromAge>": 0|1|2|3 } }`. The entry with the highest age ≤ the child's age applies. 1 = survival (always), 2 = recommended, 3 = independence, 0 = never auto-added.
- `pickMorningTier()` maps the answers to a tier (the POC "smart bundles" table: ages 2–3 / 4–5 / 6+). "Slow and dreamy" then caps the result at tier 2, overriding answers that would pick independence. The evening always uses tier 2.
- Stuck points (`STUCK_POINT_TAGS`) pull in age-eligible activities with matching tags at any level, in the morning **and** the evening.
- Mastered activities (`MASTERED_TASK_TAGS`) leave out level 2–3 activities with matching tags. Level 1 is never dropped, and parents can still add any activity manually.
- Only `selectable` activities (complete media) are composed.

**Why not an LLM.** Results stay the same every time, it works offline (iPads without Wi-Fi), it can be unit tested (`tests/routineComposer.test.cjs` locks in the POC table), and it costs no latency or money. A new activity joins generated routines by adding data, with no app release. AI may later *suggest* tags at publish time, but never at runtime.

## ADR-002: Firebase is the single source of routine composition data (2026-10)

**Decision.** `tags` and `routine` live **only** in Firestore `catalog/activities`, which is written by the Storage triggers from `catalog/activities/{key}.json` or by the seed script. The app bundles none (see ADR-013).

- The questionnaire calls `refreshActivityCatalog()` before composing. It falls back to the AsyncStorage copy. If there's still nothing to compose, it shows a "No connection" alert and doesn't save an empty routine.
- The server validator (`functions/src/catalogModel.ts` `validateCatalogMetadata`) and the client parser (`parseRoutineRules` / `parseActivityTags`) must accept the same shape. The seed JSON (`functions/scripts/activity-catalog.seed.json`) carries the values for re-seeding.
- **Changing the catalog shape:** deploy `onCatalogAssetFinalized` / `onCatalogAssetDeleted` *before* uploading details JSONs that use new fields. The old validator silently drops unknown fields, and `applyMetadata` replaces the entry's metadata.
- To edit live values without re-uploading, use field-level Firestore updates (`activities.{key}.tags` / `.routine`). Never overwrite other metadata.

## ADR-003: Multi-select questionnaire answers use new field names (2026-10)

**Decision.** "Where do mornings get stuck" (`stuckPoints`) and "Which activities does {name} already handle like a pro" (`masteredTasks`) are multi-select arrays. `everything_negotiation` / `none_yet` are exclusive options. The other questions stay single-select, because each maps to one setting (e.g. motivation → TTS tone).

- The arrays are stored under **new** keys. The legacy single `morningStuck` / `masteredTask` values are migrated on read in `normalizeChildProfile()`. Older app builds reject unknown values on *known* keys but ignore unknown keys, so reusing the old names would make older builds treat cloud profiles as invalid.
- Re-answering the questionnaire does not rebuild existing routines (`saveRoutineIfMissing`).

## ADR-004: Activities are cloud data, so adding one needs no app release (2026-10)

**Decision.** An activity is published by uploading files to Firebase Storage (`avatars/{avatarId}/{key}_p1.mp4`, `{key}.mp4`, `{key}_captions.json`, `catalog/activities/{key}.json` + artwork). The Storage triggers `onCatalogAssetFinalized` / `onCatalogAssetDeleted` keep the single Firestore doc `catalog/activities` in sync. On every foreground the app refreshes it and applies it in place to the registry in `constants/activities.ts`. A new activity appears, auto-joins composed routines (ADR-001/002) and starts prefetching on the next app open. See `docs/ADDING_ACTIVITIES.md` and the `publish-activity` skill.

- `ActivityKey` is any `[a-z0-9_]+` string, not a union type. Keys are never renamed once live.
- An activity is `selectable` only when both videos and the details file exist. `enabled: false` hides it. `minAppVersion` hides it from older builds, so new catalog fields can ship safely.
- Keys dropped from the catalog stay renderable in existing routines, using a placeholder. Never substitute another activity.
- Catalog writes come only from the triggers or `functions/scripts/seed-activity-catalog.js`, never from the app. The triggers are transactional and ignore out-of-order generations.
- Updates use the same filename. Devices compare the catalog `generation`/`md5`, so they download only what changed.
- The app bundles no activity definitions (ADR-013).

## ADR-005: Pre-rendered two-part avatar videos; personalization is greeting audio only (2026-10)

**Decision.** No per-child video is rendered. Each activity has **Part 1** (a short greeting ending on a calm pose, whose audio the app replaces with the child's personalized greeting) and **Part 2** (name-independent instructions with the narration baked in). On the device, the app merges and pads them and shifts the caption timings (`services/twoPartVideoService.ts`, `services/videoMerge.ts`). If the greeting is longer than the clip, Part 1 is extended by holding its last ~100 ms.

- Greeting cache key `p1_{activity}_{name}_{tone}_{voice}[_v{version}]` must match `buildPart1AudioKey` in `functions/src/index.ts`. Bumping `part1.version` regenerates the greeting for every child.
- Full-routine TTS overlays (`generateRoutineAudio`) are kept but switched off with `TTS_AUDIO_ENABLED` (`constants/featureFlags.ts`), because Part 2 already carries its narration.

## ADR-006: Offline-first hybrid cache with priority prefetch (2026-10)

**Decision.** Media is never streamed during a routine. Everything plays from `documentDirectory`.

- On a cold start the app waits only for the **current segment** (`warmSegmentAssets`). Everything else goes through `scheduleBackgroundPrefetch` (priority queue, concurrency 2): current segment → other segment → the rest of the catalog. When a parent picks an activity, `prioritizeActivityAssets` moves it to the front.
- Downloads go to `<path>.download`, are verified (size, format, MD5), then moved over the old file. A playable copy is never deleted before its replacement is ready.
- The loading screen has a time budget for each network step (auth, RevenueCat 5 s, catalog 5 s, Firestore 6 s). When a step runs out, it falls back to the cached copy, so iPads without Wi-Fi still launch.
- Unused media is pruned only after the queue drains with a **server** catalog. An offline catalog never deletes files.

## ADR-007: All AI generation is server-side, cached globally, and deduplicated (2026-10)

**Decision.** Gemini TTS (`gemini-3.8-flash-tts` via `@google/genai` on Vertex AI) runs only in Cloud Functions, and no keys ship in the app. Before generating, each function checks Firestore (`audio_cache/{key}`) and returns any existing URL. A new generation first writes `status: "generating"`, so parallel requests don't create duplicates.

- The text part is spoken verbatim. Tone goes only in `speechMetadata.style`.
- Voices: **Aoede** for woman/default, **Kore** for man. The offline renders use the same model and voice, so the dubbed greeting and the baked-in narration sound like one speaker.

## ADR-008: Avatar media pipeline: Gemini TTS → HeyGen Avatar V on the Becky gesture avatar (2026-10)

**Decision.** Renders use `engine: avatar_v` on the API-created photo avatar `6a9c3f4eaab4239be0bab3ee340fa6e5`, lip-synced to **our** TTS WAV. They use no `motionPrompt` and no HeyGen voice. The full process is in `docs/TTS_HEYGEN_PIPELINE.md` and the `activity-media-pipeline` skill.

- Rejected: Avatar IV (renders opened with closed eyes and invented props) and Avatar IV Custom Motion (it always added a watch or bracelets, and retries don't change the result because there is no seed). Avatar III barely moves.
- Hand gestures come from the source still (mid-torso framing), not from prompts.
- Render Part 1, then Part 2, one at a time. Part 1's last frame is the seam reference (SSIM ≥ 0.8; `pack_backpack` shipped at 0.76 after a visual check).
- `qa_check.sh` must pass before transcoding: eyes open, bare hands, no props or text. Keep every take as a backup and archive the sources in `kidocoach-assets/routines`.
- Alternatives (Hedra, OmniHuman, Runway Act-Two plus lip-sync) were evaluated but not adopted.

## ADR-009: Word-aligned captions on the combined timeline (2026-10)

**Decision.** Captions are built with Whisper plus wav2vec2 forced alignment (`generate-activity-captions` skill). Cue 0 is the Part 1 greeting and spans exactly `[0, Part 1 duration]`. Part 2 cues are offset by the Part 1 duration. The name is templated, and the app shifts cues by the difference between the baked and authored greeting lengths.

- Known gap: devices that already have captions don't re-check them for updates until the cache is cleared.

## ADR-010: Anonymous-first identity; restoring a purchase is separate from recovering data (2026-10)

**Decision.** Every install signs in anonymously (`ensureAuth`). Paid access comes from the RevenueCat entitlement, with a cached flag as the offline fallback. Restore Purchases confirms entitlement only and never identifies the family. To keep data across devices, the parent explicitly links Apple, Google or email to the anonymous account from Profile (`services/accountAuth.ts`, `linkWithCredential`). The profile is mirrored to `users/{uid}.childProfile` and recovered after sign-in.

- Routing (`utils/accessRoute.ts`): no profile + unpaid → welcome; no profile + paid → questionnaire (never pay twice); profile + unpaid → paywall; paid with a profile → home.

## ADR-011: Parent lock is a PIN or a math question, with no bypass (2026-10)

**Decision.** The parent chooses a lock on the first visit to Settings/Profile (`ParentLockFirstRun`), not during onboarding. The options are a 4-digit PIN (salted SHA-256 in SecureStore, mirrored to `users/{uid}.parentalLock` and read only when the device has no copy) or a math question (the default and the fallback).

- Biometrics and "no lock" were removed (kids often know the device passcode). A saved `biometric`/`none` reads as unset.
- No grace window: every gated action challenges. Five wrong PINs → 60 s lockout.
- "Forgot PIN?" requires a 30 s wait → 2 harder questions → a mandatory new PIN, so recovery is never weaker than the math gate. Purchases, restores and outside links are always gated (store requirement).

## ADR-012: Stack baseline (2026-10)

**Decision.** Expo SDK 57 (managed), React Native 0.86, React 19.2, Firebase JS SDK 12; Cloud Functions on Node 22 with `firebase-functions` 7 (v2 APIs). Media uses `expo-video` / `expo-audio` (no `expo-av`). Upgrades must keep every native package on the SDK-compatible version (`npx expo install --check`). Read the matching versioned Expo docs before writing code.

## ADR-013: The app bundles no activities; the catalog is the only source (2026-10)

**Decision.** `constants/activities.ts` holds no activity data. The registry starts empty and is filled only from Firestore `catalog/activities` or its AsyncStorage copy (`activity_catalog_v1`). `parseActivityCatalog()` merges nothing from the app, so every entry needs its own `label`. Omitted fields use generic defaults, and an entry with no `part1.text` renders but can't be selected.

- **No catalog on the device and no connection:** `app/loading.tsx` stops with "Connect to the internet" and a Try again button. With a cached copy, the app launches offline as before.
- Routine keys that aren't in the registry render with the placeholder from `getActivityMeta()`. Reminders are still scheduled for them, with a placeholder label.
- Tests build their definitions from `functions/scripts/activity-catalog.seed.json` through the real parser.
- Card artwork is cloud-only too (`catalog/activities/{key}.png`, about 640 px). `warmSegmentAssets` fetches the current segment's artwork. Without artwork a card shows the sun fallback. Originals are archived in `kidocoach-assets/artwork/`.
- The server hardcodes no activities either. Part 1 greetings come only from `catalog/activities` (`PART1_TEMPLATES` was removed), and an unreadable catalog returns `unavailable`.
