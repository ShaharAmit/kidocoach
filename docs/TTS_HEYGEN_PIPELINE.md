# Offline asset pipeline: Gemini TTS → HeyGen → Firebase Storage

Steps to author and publish one activity's media so the app can personalize and
play it. Everything here is done once per activity/avatar. Personalization
(greeting audio per child, dubbing, padding, merging, caption shifting) is done by
the app and Cloud Functions at runtime; no per-child video is produced offline.

## Deliverables per activity

| Storage object | Content |
| --- | --- |
| `avatars/{avatarId}/{activityKey}_p1.mp4` | Part 1: short greeting ending with a name. Visuals are reused; the app replaces its audio. |
| `avatars/{avatarId}/{activityKey}.mp4` | Part 2: name-independent instructions with narration baked in. |
| `avatars/{avatarId}/{activityKey}_captions.json` | Captions for Part 1 + Part 2, with the name templated as `{name}`. |

- `activityKey` must be the canonical app key (`wake_up`, `brush_teeth`, …), not
  an authoring name like `wakeup_optA`.
- `avatarId` is lowercase (`becky` is the default).

## Step 1: Generate the two audio clips (Gemini TTS)

Use the same model and voice as the runtime greeting generator so the dubbed
greeting and the baked-in narration sound like one speaker: model
`gemini-3.8-flash-tts` (`geminiModel` in `functions/src/index.ts`),
voice **Aoede** for `woman`/default or **Kore** for `man`.

- **Part 1:** use the activity's greeting template from `PART1_TEMPLATES` in
  [`functions/src/index.ts`](../functions/src/index.ts) with a sample name, and
  the template's tone (`encouraging` or `calm`). Example:
  > Say in an energetic, cheerful, and motivating morning tone: Good morning, Jonathan!
- **Part 2:** the activity instructions, with no name. Example:
  > Say in an enthusiastic, uplifting morning tone: The sun is up, and a brand new adventure is waiting for us! Let's stretch those arms high to the sky, open those eyes, and get this day started! I'm ready when you are!

Save as separate WAVs, e.g. `sound/{activityKey}_part1.wav` and
`sound/{activityKey}_part2.wav`.

## Step 2: Render the two clips (HeyGen)

1. Upload each WAV as a HeyGen asset (create upload → PUT bytes → complete).
2. Render Part 1 from the avatar with Part 1's audio asset.
3. Download Part 1 and extract its final frame.
4. Render Part 2 with Part 2's audio asset, ideally starting from Part 1's final
   frame or composition so the cut is seamless. Continuity is not guaranteed;
   check it visually.
5. Download both clips: portrait 9:16, 1080 × 1920, H.264 MP4.

Part 1 should end on a calm, near-still pose. When a child's greeting is longer
than the original, the app extends Part 1 by holding its last ~100 ms.

## Step 3: Author the captions JSON

A single JSON array of `{ start, end, text }` (seconds) covering the combined
sequence (Part 1, then Part 2):

```json
[
  { "start": 0,    "end": 2.28, "text": "Good morning, {name}!" },
  { "start": 2.28, "end": 6.10, "text": "The sun is up, and a brand new adventure is waiting for us!" },
  { "start": 6.10, "end": 9.40, "text": "Let's stretch those arms high to the sky, open those eyes," },
  { "start": 9.40, "end": 12.48, "text": "and get this day started! I'm ready when you are!" }
]
```

Rules:

1. **`cues[0]` is the greeting only** and spans exactly the rendered Part 1 video:
   `start: 0`, `end: <Part 1 video duration>`.
2. **Part 2 cues are offset by the Part 1 video duration**, so their timings are
   relative to the start of the combined sequence. Generate them from Part 2's
   own timing and add the Part 1 duration.
3. Replace the sample name with `{name}` (`{{name}}` also works). The greeting
   text must match the activity's `textTemplate` so the caption matches what
   the child hears.

The app interpolates the name, resizes `cues[0]` to the actual personalized
greeting length, and shifts the remaining cues by the difference only. Do not
pre-shift for any specific child.

## Step 4: Upload to Firebase Storage

Upload the three files to the paths listed under Deliverables.

- **Videos:** overwriting an existing path is picked up automatically. The app
  compares the Storage object `generation` and downloads the file again.
- **Captions:** cached on the device once downloaded and **not** checked for
  changes. To correct a published captions file, clear the cache on devices
  (Settings → Clear All Cached Assets) or add a version check to
  `syncCaptions` in [`services/assetSync.ts`](../services/assetSync.ts).
- Captions are optional (a missing file is non-fatal), but without them the
  activity plays with no subtitles.

## Checklist

- [ ] Part 1 greeting text = `PART1_TEMPLATES[activityKey].textTemplate` (with a sample name)
- [ ] Part 2 contains no name
- [ ] Same TTS model and voice in Part 1, Part 2, and the runtime generator
- [ ] Both clips are 9:16, 1080 × 1920, H.264 MP4
- [ ] `cues[0].end` = Part 1 video duration; Part 2 cues are offset by that duration
- [ ] Greeting cue uses `{name}`
- [ ] Files uploaded under canonical `avatars/{avatarId}/{activityKey}…` names
