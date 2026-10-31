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

## ADR-014: Generated schedules are anchored on wake-up time and bedtime (2026-10)

**Decision.** The questionnaire's last step asks for the child's wake-up time and bedtime (preset chips). The profile stores them as `scheduledTime` (wake-up) and `bedtime`. `utils/routineSchedule.ts` turns them into step times:

- Ordinary activities share one **30-min window**, split evenly. An activity with catalog `scheduleMinutes` (1–240, e.g. `eat_dinner: 60`) gets its own slot on top of the window.
- Morning runs forward from wake-up. Evening is planned backwards so the last step ends at bedtime, and it never starts before 16:00 (`EVENING_START_MINUTES`), so every step stays on the evening panel.
- Each routine's reminder fires at its first step. Like ADR-003, answering the questionnaire again doesn't re-time existing routines.
- `scheduleMinutes` is catalog data (ADR-002): deploy the Storage triggers before uploading details JSONs that use it. Older builds ignore it.


## ADR-015: Offline after first launch; stars sync later; editing activities needs a connection (2026-10)

**Decision.** After one online launch, the app starts and plays routines from the device (ADR-006 fallbacks). `expo-network` is the only connectivity signal (`hooks/useIsOnline.ts`, optimistic until the first reading). There's no offline write queue except the one for stars.

- **Stars:** completions queue in AsyncStorage (`pending_step_awards_{uid}`) and are flushed by `flushPendingStepStars` on Home mount, on foreground, after each completion and when the connection returns. Totals are shown as `getDisplayedTotalStars()`: the last known server total plus pending stars.
- **Editing activities:** the Home "+" / "Create Routine" buttons, the Settings "Activity Manager" card and the Activity Manager Save button are disabled offline. New activities need a Firestore write and media downloads, so they never run offline.
- **Profile (account):** the Profile tab and the "Parent sign in" links on Loading/Welcome are disabled offline. If the connection drops while Profile is open, its cards are grayed and untappable. Linking, sign-in, backup and deletion all need the server.
- **Boot:** `warmSegmentAssets` skips download retries and doesn't wait for artwork when offline, so a partly cached segment launches immediately with what's on disk.
- Known gap: the first online launch only blocks on the current segment. The other segment is ready offline only after the background prefetch finishes.

## ADR-016: Web billing shares Firebase identity; affiliate evidence is server-owned (2026-10)

> Checkout, affiliate and webhook parts superseded by ADR-018 (Paddle Billing) and ADR-019 (in-house affiliates).

**Decision.** Website `/subscribe` uses RevenueCat Billing with the same Firebase Auth UID and
RevenueCat project/full-access entitlement as iOS and Android. A parent must sign in before
checkout; existing guest families link their account in mobile Profile first. Native store
payments remain native; web checkout is not linked from the child-facing app.

- Web discount codes are applied and validated by RevenueCat, never by local price arithmetic.
- Affiliate URLs use `ref`; a server callable validates active partners, rejects self-referrals,
  and records immutable first-account attribution. Production initial purchases within 30 days
  of that claim are candidates only, never earned commissions.
- An authenticated RevenueCat webhook stores deduplicated, environment-separated billing evidence
  in server-only collections. SDK CustomerInfo remains the entitlement authority; cancellation
  events alone never revoke access. Offline native cached access is preserved.
- Commission calculation, refund reconciliation, affiliate portals and payouts require separate
  business rules and are not automated by this integration. Setup lives in `website/README.md`.

## ADR-017: Web Profile gates affiliate navigation and shares native customer setup (2026-10)

> Affiliate membership/report parts superseded by ADR-018; the shared questionnaire setup still applies.

**Decision.** Website navigation exposes Profile, never an affiliate report link. Profile uses
Firebase sign-in; `getAccountMembership` derives affiliate access only from server-owned
`affiliates/{code}.ownerUid`. Client-written user roles, purchases and referral codes cannot
grant affiliate access. Reports remain counts-only and reject customers without assigned codes.

- Customers without a child profile complete the native seven-step questionnaire before web
  checkout. Native and web share `utils/questionnaire.ts`, catalog parsing, composition, schedule,
  and profile normalization. Shared catalog types live in `types/activityDefinition.ts`.
- Web saves a recoverable child profile and missing morning/evening routine/activity documents
  transactionally, preserving existing routines and other user fields. Device notifications and
  media preparation stay in the mobile app. Affiliate-only accounts need no child setup.
- Affiliate membership and customer subscription are independent; one account may have both.
  Referral counts are not earnings. Commission terms and payouts remain separately configured,
  never inferred from a customer-paid RevenueCat entitlement.

## ADR-017: One phone design, scaled per device and centered on tablets (2026-10)

**Decision.** iPhone and iPad share one layout. `theme/responsive.ts` is the only place that decides phone vs tablet sizing:

- **Size** (`s`/`vs`/`ms`/`fs`) is fixed per device from its portrait dimensions (shorter side → width scale, longer side → height scale, capped at 1.6×). Rotating, Split View and Stage Manager never change it. iPads measure the full screen, so a launch in a small window still gets tablet sizes.
- **Layout width**: every screen's content goes in `contentColumn` (max `CONTENT_MAX_WIDTH`, centered). On phones the cap is wider than the screen, so it has no effect. On iPads, backgrounds stay full-bleed and content stops stretching edge to edge. New screens must spread `contentColumn` into their scroll content / card wrapper.
- Anything sized from the window (e.g. the activity video) uses `useWindowDimensions` / `useContentWidth`, never module-level `Dimensions.get`, so it re-fits on rotation.
- Portrait 9:16 videos shown with `cover` are fitted with `fitCoverBox` (at most 20% crop), so a wide window never crops the avatar to a face strip.
- iPad keeps all four orientations (Expo default with `supportsTablet`). Tests: `tests/responsive.test.cjs`.

## ADR-018: Web pays through Paddle Billing; RevenueCat is the one entitlement; Tolt owns affiliates (2026-10)

> Affiliate part (Tolt) superseded by ADR-019 (in-house affiliates). Billing and entitlement parts still apply.

**Decision.** The website sells subscriptions through **Paddle Billing** (merchant of record; Stripe doesn't accept Israeli businesses). Cloud Functions (`functions/src/billing.ts`, raw REST, `Paddle-Version: 1`) create the transaction; the site only opens Paddle's overlay (`@paddle/paddle-js`, client-side token). Each Paddle subscription is imported into **RevenueCat** (`POST /v1/receipts`, `X-Platform: paddle`) under the parent's Firebase UID, the App User ID the native apps use. One family = one UID = one entitlement on every platform.

- `createPaddleCheckout` checks RevenueCat (secret key) and refuses checkout when the UID already has access from any store (App Store, Google Play or Paddle). It also imports the UID's existing live Paddle subscriptions first.
- Transactions carry `custom_data.app_user_id`, which RevenueCat's Paddle notifications read, so purchases sync even if the page closes. `syncPaddlePurchases` verifies the transaction belongs to the caller's UID before importing.
- `billing_customers/{uid}` (server-only) maps the UID to a Paddle customer, stored only after a paid server-created transaction. Portal sessions and `deleteAccount` cancellation act only on subscriptions whose `custom_data.app_user_id` is this UID (a Paddle customer is keyed by email and may be shared).
- Coupons are Paddle discount codes resolved server-side (`?discount_code=` / `?coupon=`). Prices come from Paddle (`PADDLE_PRICE_IDS`), never hardcoded in the site.
- **Affiliates:** Tolt (Rewardful supports only Paddle Classic). `window.tolt_referral` is sent as `custom_data.tolt_referral`; Tolt computes commissions and pays partners. The homegrown `affiliates` / `billing_attributions` / report / RevenueCat webhook were removed. Only web purchases are attributable.
- No Paddle API key or RevenueCat secret is in the website; `@revenuecat/purchases-js` is not used on the web.

## ADR-019: In-house affiliates on Paddle webhooks replace Tolt (2026-10)

**Decision.** Partner tracking, commissions and payouts are our own server code (`functions/src/affiliates.ts`, pure rules in `affiliateModel.ts`). Tolt was dropped: ~$49+/month and it couldn't connect to the Paddle sandbox. Paddle (payments) and RevenueCat (entitlement) are unchanged (ADR-018).

- **Data (server-only, rules deny all clients):** `affiliates/{code}` (name, email, status `active|disabled`, `commissionRateBps` default 1500, `recurringMonths` default 12, optional `ownerUid`, optional partner `discountCode`, `payoutEmail`); `affiliate_attributions/{uid}`; `affiliate_commissions/{transactionId}`; `paddle_events/{eventId}` (dedupe, 90-day TTL). Partners are created with `functions/scripts/affiliate-admin.js`, never by the app.
- **Capture:** the website saves `?ref={code}` in localStorage for 60 days (first touch) and calls `claimAffiliateReferral` after sign-in. The attribution is **first-touch and immutable**. Self-referrals (partner UID or email), disabled/unknown codes and families that already bought on the web (`billing_customers/{uid}`) are refused. A checkout with a partner's coupon attributes an unattributed family too.
- **Checkout:** `createPaddleCheckout` stamps `custom_data.affiliate_code` **from the server attribution only** (the client's `referral` is just a claim hint), and only within 60 days of the claim. Affiliate errors never block a purchase. Paddle copies custom_data to the subscription and its renewals.
- **Commissions:** the `paddleWebhook` (HMAC `Paddle-Signature`, 5-min replay window, secret `PADDLE_WEBHOOK_SECRET`) handles `transaction.completed` → `rate × (total − tax)`, i.e. pre-tax after discounts. It requires the stamped code to match the attribution and the payment to be after the claim; renewals earn for `recurringMonths` after the first paid charge. $0 trials earn nothing. Approved `adjustment.*` refunds/chargebacks reverse commission proportionally (once per adjustment id); `chargeback_reverse` restores it. Each event commits atomically with its dedupe marker.
- **Payouts:** commissions are held 30 days, then `approveAffiliateCommissions` (daily) approves them, conditional on the doc being unchanged. Monthly, `npm run affiliates -- report` lists what each partner is owed (refunds after a payout appear as negative clawbacks) and `mark-paid --amount` settles exactly that total after paying manually (PayPal/Wise), in one transaction that aborts if anything changed since the report. No automatic money movement.
- Partners with `ownerUid` see counts and totals (no customer PII) on `/profile` via `getAffiliateSummary`.
- Only web (Paddle) purchases are attributable; App Store / Google Play purchases are invisible to the program. Account deletion removes the attribution; commission records stay for accounting.

## ADR-020: Partners sign up and track their own sales at /partners (2026-10)

**Decision.** Like Rewardful / Tolt / Amazon Associates, anyone with a (non-anonymous) account joins the affiliate program themselves at `kidocoach.app/partners` and gets a dashboard there. Commission rules, attribution and payouts are unchanged (ADR-019).

- **Join:** the partner picks their own link code (`checkAffiliateCode` live check; `selfServeCodeProblem` reserves brand/route words), name and payout email, and accepts the partner terms (`/terms#partners`). `createAffiliateAccount` creates an **active** partner on the default rate/months (auto-approval; payouts are still manual after the 30-day hold, so abuse is caught before money moves). One code per account (`affiliate_owners/{uid}` in the same transaction); codes are never renamed or reused.
- **Payout method:** the partner picks `paypal` (default) or `wise` plus a payout email; both providers can pay an email address without a prior account (the recipient claims it). `report` lists `payout_method` and `payout_email`. No bank details are stored by us.
- **Self-service limits:** partners may edit only name, payout method and payout email (`updateAffiliateSettings`). Rate, recurring months, coupon and status stay admin-only (`affiliate-admin.js`).
- **Tracking:** `trackAffiliateClick` counts link visits per day (`affiliate_clicks/{code}_{day}`; the site sends at most one per browser, code and day; inactive codes aren't counted). `getAffiliateSummary` returns clicks, sign-ups, paying families, earnings, the last 50 sales (date, type, sale, commission, status, never a family identifier) and payouts (`affiliate_payouts`, written by `mark-paid`).
- Account deletion pauses the partner's code and clears `ownerUid`; ledger records stay.

