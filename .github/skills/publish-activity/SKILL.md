---
name: publish-activity
description: Publish, update, hide or remove a KidoCoach activity through Firebase Storage. Covers the Part 1/Part 2 videos, captions, the catalog details JSON and the artwork, then verifies that the catalog/activities Firestore doc picked them up. Use it to add a new activity, replace a video/captions/greeting, or hide or delete an activity without an app release.
---

# Publish an activity

Source of truth: `docs/ADDING_ACTIVITIES.md`. Read it first and keep it in sync. Storage triggers (`onCatalogAssetFinalized` / `onCatalogAssetDeleted` in `functions/src/index.ts`, logic in `functions/src/catalogModel.ts`) mirror uploads into Firestore `catalog/activities`. Apps read that doc and download only changed generations on the next open.

```bash
B=gs://kids-routine-coach-app.firebasestorage.app
P=kids-routine-coach-app
```

Use `gcloud storage` (`gsutil -m` hangs on macOS). **Always confirm with the user before uploading, overwriting or deleting live objects.**

## Files

| Path | Required | Notes |
|---|---|---|
| `avatars/becky/KEY_p1.mp4` | ✅ | Greeting clip ~2–4 s. Its audio is replaced by the child's personalized greeting. |
| `avatars/becky/KEY.mp4` | ✅ | Part 2 with narration, no name |
| `avatars/becky/KEY_captions.json` | | `[{start,end,text}]` on the p1+p2 timeline. `cues[0]` = `[0, p1 duration]` with `{{name}}`. Build with **generate-activity-captions**. |
| `catalog/activities/KEY.json` | ✅ | Details (below) |
| `catalog/activities/KEY.png` | | Card artwork (`.jpg`/`.webp` OK) |

`KEY` is `[a-z0-9_]+` and is **never renamed** once live. Videos must be MP4 H.264, 720×1280, 25 fps, AAC 48 kHz. Pre-flight check:

```bash
for f in KEY_p1.mp4 KEY.mp4; do ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,sample_rate:format=duration -of compact $f; done
```

## Details JSON (`KEY.json`)

```json
{ "label": "Feed the Dog", "part1": { "text": "Doggy time, {name}!", "tone": "encouraging" },
  "emoji": "🐶", "subtitle": "Breakfast for our furry friend!", "timeOfDay": "morning",
  "timerSeconds": 120, "durationMode": "variable", "stars": 1, "order": 20 }
```

Validate before upload:
- `label` is required. `part1.text` is required and contains `{name}`.
- `part1.tone` ∈ `encouraging|cheerful|calm`.
- `timeOfDay` ∈ `morning|evening|general`. `timerSeconds` is an integer from 10 to 10800. `durationMode` ∈ `fixed|variable`.
- `stars` ∈ 0/1/2. `order` is a number (existing activities use 0–16). Optional: `enabled: false`, `minAppVersion: "x.y.z"`.
- Optional `tags`: up to 12 `[a-z0-9_]` category keys. Optional `routine`: `{ "morning"?: { "position": n, "levels": { "<fromAge>": 0|1|2|3 } }, "evening"?: … }`. Without `routine` the activity is never auto-added to new routines, only picked manually. See docs/ADDING_ACTIVITIES.md for the tag vocabulary and levels.

The parser of record is `functions/src/catalogModel.ts`. Check it when a field is ambiguous.

## Upload

```bash
gcloud storage cp KEY_p1.mp4 KEY.mp4 $B/avatars/becky/
gcloud storage cp --content-type=application/json KEY_captions.json $B/avatars/becky/
gcloud storage cp --content-type=application/json KEY.json $B/catalog/activities/
gcloud storage cp KEY.png $B/catalog/activities/
```

The order doesn't matter. The activity appears once both videos and the details file exist.

**Overwriting** an existing object: back it up **locally** first, never under `avatars/` or `catalog/` in the bucket, because that would fire catalog triggers. Preserve the Firebase download token:

```bash
TOKEN=$(gcloud storage objects describe $B/PATH --format='value(metadata.firebaseStorageDownloadTokens)')
gcloud storage cp ${TOKEN:+--custom-metadata=firebaseStorageDownloadTokens=$TOKEN} LOCAL_FILE $B/PATH
```

## Verify

```bash
curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://firestore.googleapis.com/v1/projects/$P/databases/(default)/documents/catalog/activities" > /tmp/catalog.json
gcloud storage objects describe $B/avatars/becky/KEY.mp4 --format='value(generation)'
```

- `activities.KEY` exists with the details fields and `assets.becky.{p1,p2,captions}` = `{path, generation, md5, size}`. Each `generation` must equal the Storage object's generation.
- If the details file was rejected or assets are missing: `firebase functions:log --only onCatalogAssetFinalized`.
- If refs drifted, rebuild them from the bucket listing with `functions/scripts/seed-activity-catalog.js`.

## Updating / removing

- **Video or captions**: overwrite with the same name and the app re-downloads it on the next open. An invalid file is ignored and devices keep the old one. When Part 1 changes, rebuild the captions (cue 0 = the new p1 duration).
- **Greeting text/tone**: re-upload `KEY.json`. Every child gets a regenerated greeting (the cache key includes the part1 version).
- **Remove captions**: delete `KEY_captions.json`. They disappear from devices.
- **Hide**: `"enabled": false` in `KEY.json`, or delete the details file. Existing routines still render the activity, but it can't be selected.
- Never rename or reuse a key for different content.
