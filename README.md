# KidoCoach

An iOS/Android app built with **Expo (React Native)** + **Firebase** that guides children through sequential daily routines using animated avatar loops and personalised AI-generated voice audio.

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
- Node.js 20+
- Expo CLI: `npm install -g expo-cli`
- Firebase CLI: `npm install -g firebase-tools`
- A Firebase project with Firestore, Storage, and Cloud Functions enabled
- Google Cloud Text-to-Speech API enabled on your Firebase project

### 1. Clone & Install

```bash
git clone https://github.com/ShaharAmit/kidocoach.git
cd kidocoach
npm install

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
```

### 2. Configure Firebase

Copy the env template and fill in your Firebase config:

```bash
cp .env.example .env
# Edit .env with your Firebase project values
```

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

## 🔒 Security

- Firestore rules restrict routine access to the owning user
- Audio cache writes are blocked from the client (admin SDK only)
- Storage audio files require authentication to read
- All TTS text is sanitized (max 500 chars) in the Cloud Function
- Firebase HTTPS Callable functions require authentication

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
