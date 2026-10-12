# Uploading an activity

Upload the files below to Firebase Storage. The app picks the activity up the next time it's opened. No app release needed.

## 1. Files

`feed_dog` is an example key. Keys use lowercase letters, digits and `_`. Never rename a key once it's live.

| Upload to | Required | What |
|---|---|---|
| `avatars/becky/feed_dog_p1.mp4` | ✅ | Part 1: short greeting clip (~2–4 s). Its audio is replaced by the child's personalized greeting. |
| `avatars/becky/feed_dog.mp4` | ✅ | Part 2: the activity, narration included |
| `avatars/becky/feed_dog_captions.json` | | Subtitles |
| `catalog/activities/feed_dog.json` | ✅ | Activity details |
| `catalog/activities/feed_dog.png` | | Artwork for cards (`.jpg` / `.webp` also accepted) |

**Videos:** MP4, H.264, 720×1280 portrait, 25 fps, AAC 48 kHz (same as the existing clips).

**Captions:** times in seconds on the combined Part 1 + Part 2 timeline. The first cue is the greeting. Use `{{name}}` for the child's name.

```json
[
  { "start": 0.0, "end": 2.3,  "text": "Doggy time, {{name}}!" },
  { "start": 2.3, "end": 7.8,  "text": "Let's fill the bowl with crunchy food." },
  { "start": 7.8, "end": 12.0, "text": "Fresh water too. Good job!" }
]
```

## 2. Details file (`feed_dog.json`)

```json
{
  "label": "Feed the Dog",
  "part1": { "text": "Doggy time, {name}!", "tone": "encouraging" },
  "emoji": "🐶",
  "subtitle": "Breakfast for our furry friend!",
  "timeOfDay": "morning",
  "timerSeconds": 120,
  "durationMode": "variable",
  "stars": 1,
  "order": 20
}
```

| Field | Values |
|---|---|
| `label` **(required)** | Name shown in the app |
| `part1.text` **(required)** | Greeting spoken by the AI voice; must contain `{name}` |
| `part1.tone` | `encouraging` (default) · `cheerful` · `calm` |
| `emoji`, `subtitle` | Shown on cards and in the picker |
| `timeOfDay` | `morning` · `evening` · `general` (both, default) |
| `timerSeconds` | Step length, 10–10800 |
| `durationMode` | `fixed` (wait the full timer) · `variable` (can finish early) |
| `stars` | `0` · `1` · `2` |
| `order` | Position in the picker (existing activities use 0–16) |
| `enabled` | `false` hides it from the picker |
| `minAppVersion` | e.g. `"1.2.0"`: hidden from older app builds |

## 3. Upload

Use the Firebase console (Storage → folder → *Upload file*), or the CLI:

```bash
B=gs://kids-routine-coach-app.firebasestorage.app
gcloud storage cp feed_dog_p1.mp4 feed_dog.mp4 feed_dog_captions.json $B/avatars/becky/
gcloud storage cp feed_dog.json feed_dog.png $B/catalog/activities/
```

You can upload the files in any order. The activity appears in the app once both videos and the details file are uploaded.

**Check:** Firestore → `catalog/activities` → `activities.feed_dog` should list `p1`, `p2` and `captions`. If the details file was rejected, the reason is in `firebase functions:log --only onCatalogAssetFinalized`.

## Updating

Upload a new file **with the same name** to replace it. Devices download only what changed.

- **Video or captions:** replaced on the next app open. The new file must be valid; otherwise devices keep the old one.
- **Greeting text or tone:** re-upload the details file. Every child gets a newly generated greeting.
- **Remove captions:** delete the captions file. They disappear from devices.
- **Hide an activity:** set `"enabled": false`, or delete the details file.
