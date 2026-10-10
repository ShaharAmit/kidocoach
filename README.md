# KidoCoach

An iOS/Android app built with **Expo (React Native)** + **Firebase** that guides children through sequential daily routines using animated avatar loops and personalised AI-generated voice audio.

For the original Gemini/Aoede -> HeyGen authoring workflow and the current
two-part personalized media pipeline, see [TTS, HeyGen, and app playback](docs/TTS_HEYGEN_PIPELINE.md).

## ✨ Features

| Phase | Description |
|-------|-------------|
| **Phase 1** | Scheduled push notifications (expo-notifications) deep-link directly to the active routine screen via expo-router |
| **Phase 2** | Firebase Cloud Function calls Google Cloud TTS to generate child-specific `.mp3` audio for every activity step |
| **Phase 3** | Pre-routine asset sync pipeline downloads all `.mp4` avatar loops and `.mp3` audio tracks to the device before the alarm fires |
| **Phase 4** | Activity Stack Player — fullscreen step-by-step screen with looping silent video + personalised audio + a giant "Mission Complete" button |

## 🗂 Project Structure

```
kidocoach/
├── app/                          # expo-router screens
│   ├── _layout.tsx               # Root layout: notification deep-link handler
│   ├── index.tsx                 # Home screen: routine list
│   ├── routine/[id].tsx          # Active routine screen (Phase 4)
│   └── parent/create.tsx         # Parent: create/schedule a routine
├── components/
│   ├── ActivityPlayer.tsx        # Video + Audio player per step
│   └── RoutineCard.tsx           # Routine list card
├── services/
│   ├── firebase.ts               # Firebase app init
│   ├── notifications.ts          # Schedule/cancel local notifications (Phase 1)
│   ├── assetSync.ts              # Local asset download pipeline (Phase 3)
│   └── tts.ts                    # Firebase Function caller for TTS (Phase 2)
├── hooks/
│   └── useRoutine.ts             # Firestore real-time hooks
├── constants/
│   └── activities.ts             # Activity metadata (prompts, emoji, colors)
├── types/
│   └── index.ts                  # TypeScript interfaces
├── functions/                    # Firebase Cloud Functions
│   └── src/index.ts              # generateRoutineAudio + cleanup trigger
├── firestore.rules               # Security rules
├── storage.rules                 # Storage security rules
└── firebase.json                 # Firebase project config
```

## 🚀 Getting Started

### Prerequisites
- Node.js 22.13+ on the 22.x release line, or Node.js 24.3+ (Cloud Functions deploy on Node.js 22)
- Xcode 26.4+ and iOS 16.4+ for the mobile iOS app
- Expo CLI is included locally: use `npx expo` (do not install the deprecated global `expo-cli`)
- Firebase CLI: `npm install -g firebase-tools`
- A Firebase project with Firestore, Storage, and Cloud Functions enabled
- Google Cloud Text-to-Speech API enabled on your Firebase project

### 1. Clone & Install

```bash
git clone https://github.com/ShaharAmit/kidocoach.git
cd kidocoach
npm install
```

### Website (kidocoach.app)

The repository also includes a dedicated web landing site under `website/`.

```bash
cd website
cp .env.example .env
npm install
npm run dev
```

Website deployment target is configured in `firebase.json` as `hosting:website`.
Before first deploy, map the hosting target to your Firebase Hosting site:

```bash
firebase target:apply hosting website <your-hosting-site-id>
firebase deploy --only hosting:website
```

### Dependency compatibility

The mobile app uses **Expo SDK 57**, **React Native 0.86.3**, **React 19.2.8**, and **TypeScript 6.0.3**. Expo modules and native animation/gesture libraries use the SDK 57-compatible releases. The website uses the same React version with matching React DOM, Vite 8, and its React plugin 6. Cloud Functions use Firebase Admin 13, which satisfies both Firebase Functions 7 and `firebase-functions-test` 3; Admin 14 is not yet supported by that test package.

Use a **native development/production build**, not Expo Go, for the full app. AsyncStorage 3.1 is required by the existing `createAsyncStorage`/`removeMany` APIs. Reanimated 4.5.1 and Worklets 0.10.1 are pinned to Expo's supported pair for React Native 0.86. Only AsyncStorage and the newer React/React DOM 19.2 patches are deliberately excluded from Expo's bundled-version checks in `package.json`; all other Expo version checks remain enabled. Keep these constraints intact when updating packages.

Expo Router 57 owns its navigation implementation: import navigation hooks from `expo-router` or `expo-router/react-navigation`, not external `@react-navigation/*` packages. The legacy `expo-file-system/legacy` cache API remains supported; all routine media must still be downloaded and validated locally before playback.

SDK 57's ESLint preset adds React Compiler diagnostics. The `refs` and `set-state-in-effect` rules report warnings for existing animation/effect patterns rather than blocking this dependency migration; the existing hook correctness rules remain enabled. The native splash screen is configured through `expo-splash-screen`, replacing the removed top-level `splash` config.

After changing native packages, rebuild with `npx expo run:ios` / `npx expo run:android`, or create fresh EAS builds. SDK 57's `npx expo prebuild` regenerates native folders by default; use `--no-clean` only when deliberately preserving native customizations. The ignored native folders in this managed project should be regenerated when upgrading SDKs. An OTA JavaScript update alone does not update native modules.

```bash
npx expo install --check
npm run typecheck
npm test
npm run build --prefix functions
npm run build --prefix website
```

### 2. Configure Firebase

Copy the env template and fill in your Firebase config:

```bash
cp .env.example .env
# Edit .env with your Firebase project values
```

### Parent authentication configuration

Parent accounts use the existing **Firebase JavaScript SDK** auth instance, not React Native Firebase. Email/password works without native provider modules; Google is hidden on web, in Expo Go, in old binaries without its native module, and until client IDs/native configuration are supplied. Apple is offered only on iOS when `AppleAuthentication.isAvailableAsync()` succeeds. Internet access is required for registration, login, and password reset; local routines remain an offline feature.

1. In **Firebase Console → Authentication → Sign-in method**, keep **Anonymous** enabled and enable **Email/Password**, **Apple**, and **Google** as needed. Configure your password policy and password-reset email template. Email registration and provider connection call `linkWithCredential` on the anonymous user, preserving the UID and its Firestore routines. They reject already-registered sessions and never log in to another account on a linking conflict. The separate Log In actions explicitly switch Firebase identity; the caller handles profile recovery. Like standard Firebase provider sign-in, provider login can create an account if that provider has never been used.
2. **Apple:** register `com.kidocoach.app` in Apple Developer and Firebase, enable Sign in with Apple, and configure the Apple provider's Service ID, Team ID, key ID, and private key in Firebase Console according to [Firebase's Apple setup](https://firebase.google.com/docs/auth/ios/apple). Keep Apple private keys/server credentials out of Expo env variables and source control. Configure the private email relay if Firebase emails must reach Hide My Email addresses. `app.json` already enables `ios.usesAppleSignIn` and the `expo-apple-authentication` plugin. Every request uses 32 cryptographically random bytes from `expo-crypto`: Apple receives the SHA-256 hex digest; Firebase receives the original nonce alongside the identity token to prevent replay. Render Apple's native `AppleAuthenticationButton`, not a custom Apple-branded button, and obtain consent before connecting guest data to Apple identity.
3. **Google:** enable the provider in the same Firebase project and set `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` to the OAuth client ID of type **Web application** (not the Android client ID). Register Android package `com.kidocoach.app` and SHA-1/SHA-256 fingerprints for every signing certificate used (development, EAS release, and Play App Signing). Register the iOS bundle identifier and its OAuth client. Client IDs are public; never include OAuth client secrets.
   - **iOS:** set `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` to the iOS OAuth client ID. `app.config.ts` automatically adds the Google plugin with its derived reversed URL scheme: for `123-abc.apps.googleusercontent.com`, the scheme is `com.googleusercontent.apps.123-abc`. Set the same env values when building locally or through EAS. Missing iOS client ID omits the plugin entirely, so builds without Google configuration remain valid; malformed IDs fail configuration with a clear error. Google remains hidden on iOS until both web and iOS client IDs are present in a compatible native build.
   - **Android:** the Google native module is autolinked from the installed dependency without a config plugin. Only the web client ID, registered package, and correct signing fingerprints are required; the iOS client ID is optional.
   - This Firebase JS SDK setup needs neither `GoogleService-Info.plist` nor `google-services.json`, and does not use RN Firebase. Do not add a bare Google plugin entry to `app.json`: that plugin mode expects native Firebase configuration files. No native Firebase config files or real client IDs are shipped here.
4. **Rebuild native apps** after installing providers or changing entitlements, URL schemes, or native config files. If local native directories already exist, apply the plugins first with `npx expo prebuild --platform ios` or `npx expo prebuild --platform android`, then run `npx expo run:ios` / `npx expo run:android`. Fresh EAS builds regenerate ignored native directories automatically. Use a real iOS device to validate Apple sign-in; Google requires a native development/production build, not Expo Go. Runtime public env changes also require restarting Metro or deploying a new compatible bundle.

`services/accountAuth.ts` returns Firebase users and exposes friendly errors/cancellation detection; it does not save profiles, navigate, merge accounts, or clear local data. `signOutParent()` signs out **Firebase only**, without revoking Apple/Google permissions. If connection reports an existing account, ask the parent to explicitly choose Log In; guest data is not automatically merged. Firebase identity is **separate from family-setup recovery via purchases**: restoring App Store/Play purchases does not recover a Firebase child profile. Paid access, however, follows the Firebase UID: `services/purchases.ts` calls RevenueCat `logIn(firebaseUid)` before every entitlement check, purchase, and restore, so linking keeps access (same UID) and signing in to a linked parent account on another device restores access without Restore Purchases. The first `logIn` aliases the previous RevenueCat anonymous ID, carrying earlier purchases over. `startPaidStatusSync()` (root layout) re-checks on every Firebase UID change and on RevenueCat customer-info pushes; downgrades are only applied after a server-confirmed check, and offline checks keep the cached flag. Keep RevenueCat's **Restore behavior** (Project settings) in mind: with the default "transfer to new App User ID", Restore Purchases from a different family moves the subscription to that family.

### Family recovery and access flow

The **Profile** tab sits alongside Routines, Rewards, and Settings. Parent sign-in is also accessible from the welcome screen and paywall, without requiring a subscription first. Registration/provider connection backs up the current setup before linking the anonymous Firebase UID; existing-account sign-in explicitly switches families rather than merging them.

| Family state | Route |
| --- | --- |
| New, unpaid, no setup | Welcome video → questionnaire → paywall → app after purchase |
| Saved setup, unpaid | Paywall → app after purchase |
| Saved setup, paid | App |
| Restored active purchase, no recoverable setup | Questionnaire → app, without another purchase |

`users/{uid}.childProfile` stores the complete validated questionnaire, preferences, and schedule; activities are wrapped as `{ activities: string[] }` maps because Firestore does not support nested arrays. Existing routine/activity subcollections stay under the same UID. New-device sign-in recovers the complete profile, loads those routines, and schedules reminders locally without reusing another device's notification IDs. Legacy user documents containing only name/age/voice are not complete recoverable profiles; the parent must link/back up from the original device or complete setup again.

Existing local profiles and downloaded routine media remain usable offline. Authentication and cross-device recovery require a connection; recovery errors offer retry instead of silently treating network failure as missing setup. Switching families clears the shared local completion state and routine reminders; the cached purchase flag is then re-checked against RevenueCat for the newly signed-in UID. Resetting the questionnaire leaves paid access intact.

Deploy the updated ownership-scoped rules with `firebase deploy --only firestore:rules` before release: family data must only be readable/writable by its Firebase UID. Account-flow regression checks use the installed TypeScript compiler and Node's built-in runner: `node --test tests/accountFlow.test.cjs`.

### 3. Deploy Firebase Functions

```bash
cd functions
npm install
npm run build
cd ..
firebase deploy --only functions,firestore:rules,storage:rules
```

### 4. Run the App

```bash
# iOS Simulator
npm run ios

# Android Emulator
npm run android

# Development build (physical device)
npx expo start
```

## 🗄 Firestore Schema

### `users/{userId}/routines` collection

```json
{
  "id": "liam_routine_1234567890",
  "userId": "firebase_auth_uid",
  "childName": "Liam",
  "avatarId": "becky",
  "scheduledTime": "08:00",
  "activityStack": ["brush_teeth", "get_dressed", "eat_breakfast"],
  "notificationId": "expo-notification-id"
}
```

### `users/{userId}/trophies` collection

Document ID: `{YYYY-MM-DD}_{segment}`

```json
{
  "userId": "firebase_auth_uid",
  "date": "2026-06-20",
  "segment": "morning",
  "routineId": "routine_firebase_auth_uid",
  "childName": "Liam",
  "completedAt": "Firestore Timestamp"
}
```

### `users/{userId}/stats/main` document

```json
{
  "userId": "firebase_auth_uid",
  "totalStars": 12,
  "updatedAt": "Firestore Timestamp"
}
```

### `audio_cache` collection

Document ID: `{normalizedChildName}_{activityKey}_{avatarId}`

```json
{
  "id": "liam_brush_teeth_becky",
  "audioUrl": "https://storage.googleapis.com/.../liam_brush_teeth_becky.mp3",
  "status": "ready",
  "createdAt": "Firestore Timestamp"
}
```

## 📱 Deep Linking

The app registers the `kidocoach://` scheme. Tapping a push notification navigates to:

```
kidocoach://routine/{routineId}
```

expo-router intercepts this URL and renders `app/routine/[id].tsx` directly, even when the app is cold-started.

## 🎬 Avatar Videos

Place `.mp4` silent avatar loop files in Firebase Storage under:
```
avatars/{avatarId}/{activityKey}.mp4
```

Example: `avatars/becky/brush_teeth.mp4`

## 🔒 Security & privacy

- Firestore rules restrict family data (`users/{uid}/**`) to the owning UID.
- `audio_cache` and `rate_limits` are server-only; clients resolve clips exclusively through the authenticated `generatePart1Audio` / `generateRoutinePart1Audio` callables.
- Storage is private by default: only `avatars/default/welcome.mp4` (pre-auth welcome video) and `avatars/public_site/**` (website) are public. Everything else is `get`-only for signed-in users, with no listing. Generated audio is never made public; the app downloads it via `getDownloadURL`.
- TTS callables require auth, validate name (1–30 letters), tone, voice and activity keys, cap batches at 20 keys, enforce a per-UID daily generation quota (`DAILY_GENERATION_LIMIT_PER_USER`), and run with `maxInstances` limits. Cache hits never consume quota.
- Audio cache docs carry `expireAt`; a Firestore TTL policy deletes clips no device has requested for 12 months (`onAudioCacheDocDeleted` removes the Storage object). Docs store no plain-text child name.
- `deleteAccount` removes `users/{uid}` recursively and the Auth user; the app also revokes the Google grant and wipes local data. Store subscriptions are not cancelled by deletion.
- Sign in with Apple revocation happens server-side without a prompt: on Apple sign-in/connect the app sends the one-time authorization code to `registerAppleAuthorization`, which stores a refresh token in server-only `apple_tokens/{uid}`. `deleteAccount` revokes it before deleting. With no usable stored token (accounts linked before this, or a failed exchange), `deleteAccount` returns `failed-precondition` / `apple-reauth-required`, and the app shows Apple's sheet once, revokes via Firebase, then retries. Configure before deploying functions: `firebase functions:secrets:set APPLE_SIGN_IN_PRIVATE_KEY` (the `.p8` contents of a key with Sign in with Apple enabled), plus `APPLE_TEAM_ID` and `APPLE_KEY_ID` (prompted on deploy or set in `functions/.env.<projectId>`). `APPLE_CLIENT_ID` defaults to the bundle ID `com.kidocoach.app`.
- Purchases, restores, external links and parent areas (Profile, Settings, Activity Manager) sit behind a parental gate (`components/ParentalGate.tsx`).
- After deploying these rules/functions, run `node functions/scripts/lock-audio-cache.js --apply --purge-legacy` once to make previously public audio private, backfill TTLs and strip stored names (dry run without `--apply`).

## 🧪 Testing

```bash
npm test
```

For Cloud Functions local testing:
```bash
cd functions && npm run serve
```

## 📦 Key Dependencies

| Package | Purpose |
|---------|---------|
| `expo-notifications` | Schedule local push notifications |
| `expo-router` | File-based routing + deep linking |
| `expo-av` | TTS audio playback |
| `expo-video` | Avatar video loops |
| `expo-file-system` | Local asset caching |
| `firebase` | Firestore + Storage client |
| `@google-cloud/text-to-speech` | TTS synthesis (in Cloud Functions) |
