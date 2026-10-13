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

`gemini-3.8-flash-tts` speaks its text input verbatim, so never prefix the
line with a direction like "Say in a cheerful tone:" — it would be read aloud
and baked into the render. Send only the spoken line as the text part and put
the delivery in `speechMetadata.style` (see `synthesizeWithGeminiTts`).

- **Part 1:** use the activity's greeting template (`part1.text` in the catalog
  details file, or `PART1_TEMPLATES` in
  [`functions/src/index.ts`](../functions/src/index.ts) for older activities) with
  a sample name, and the template's tone (`encouraging`, `cheerful` or `calm`). Example:
  > text: `Good morning, Jonathan!` · style: `energetic, cheerful and motivating morning tone`
- **Part 2:** the activity instructions, with no name. Example:
  > text: `The sun is up, and a brand new adventure is waiting for us! Let's stretch those arms high to the sky, open those eyes, and get this day started! I'm ready when you are!` · style: `enthusiastic, uplifting morning tone`
- **Pace:** for long Part 2 scripts (≈40 s+), slow the delivery down so a
  young child can follow, e.g. style `encouraging and supportive, speaking
  warmly to a young child, at a slightly slower, relaxed pace with short pauses
  between sentences` (`pack_backpack`: 45 s → 50 s).

The model returns a complete WAV, so save it as-is (don't wrap it in another
WAV header).

Save as separate WAVs, e.g. `sound/{activityKey}_part1.wav` and
`sound/{activityKey}_part2.wav`.

## Step 2: Render the two clips (HeyGen)

The avatar must be **clean**: exactly the Becky character (same outfit, hair,
framing, background), eyes open from the first frame, bare empty hands, no added
objects, gloves, jewelry or text. Its lips are driven by **our** TTS audio (never
a HeyGen script/voice), and it moves **dynamically** with that speech: head,
face, and natural hand gestures.

Render the clips **one after the other**, not in parallel. Part 1's closing
frame is the reference for Part 2's opening frame.

1. Upload each WAV as a HeyGen asset (create upload → PUT bytes → complete).
2. Render Part 1 with `create_video_from_avatar`:
   - `avatarId`: the Becky gesture avatar `6a9c3f4eaab4239be0bab3ee340fa6e5`
     ("becky tidy_room 720x1280 api", a photo avatar made from a 720 × 1280
     Becky still)
   - `audioAssetId`: Part 1's WAV asset
   - `engine: { type: "avatar_v" }`, `aspectRatio: 9:16`, `resolution: 1080p`,
     `background: { type: "color", value: "#f6f6fc" }`
   - **no** `motionPrompt` and no `expressiveness` (Avatar V rejects both here).
     Avatar V animates head, face, expression **and hand gestures** from the
     audio, with bare hands and no invented props.

   Gestures depend on the source still, not on a prompt. On the older Becky
   look `976f0236235e4a1fb4f3875f2c297071`, or a photo avatar made from a tight
   Part 1 frame, Avatar V gives head motion only and the hands never enter the
   shot. To make a new gesture avatar, run `create_photo_avatar` on a 720 × 1280
   still that shows the character down to mid-torso, wait until its status is
   `completed` (about 10 min), then render. Create it **through the API**: the
   web-app photo avatar `ddf2ec92b5e54e20a1904d0182462c2c` (same image) lists
   `avatar_v` but the API rejects it ("does not support Avatar V").
3. Wait for Part 1 to finish, download it and extract its final frame
   (`ffmpeg -sseof -0.1 -i part1.mp4 -update 1 -frames:v 1 part1_last_frame.png`).
4. Render Part 2 the same way (same look, `avatar_v`, Part 2's WAV asset) and
   request an SRT sidecar (`caption: { file_format: "srt" }`); its timings feed
   Step 3. Both clips start from the same still, so Part 2's first frame lines
   up with `part1_last_frame.png`. Check the seam:
   `ffmpeg -i part1_last_frame.png -i part2_first.png -lavfi ssim -f null -`
   (aim for All ≥ 0.8, and compare the two frames side by side). With gestures,
   Part 2 can open mid-gesture (a hand rising into the frame), which lowers the
   score; `pack_backpack` shipped at 0.76 after a visual check showed only the
   hand differed.
5. Transcode both renders to the published spec (see
   [`ADDING_ACTIVITIES.md`](ADDING_ACTIVITIES.md)): 720 × 1280, 25 fps, H.264
   High, AAC 48 kHz stereo, `+faststart`. Use the transcoded Part 1 duration for
   the captions.

Part 1 should end on a calm, near-still pose. When a child's greeting is longer
than the original, the app extends Part 1 by holding its last ~100 ms.

### Engines to avoid

Both of these were tried on `pack_backpack` and rejected:

- **Avatar IV** (the default engine when `engine` is omitted, and the only engine
  `create_video_from_image` uses). It is generative: Part 1 opened with closed
  eyes and clasped hands even with a motion prompt saying "eyes open from the
  first frame". Part 2, rendered from Part 1's closing-frame image, added gloves
  and props from the script. Don't animate the closing-frame image; use it only
  as the seam reference.
- **Avatar IV Custom Motion** (`motionPrompt` + `expressiveness`): gives
  gestures, but every take (low/medium/high expressiveness, look or image input,
  negative "no watches" or positive "bare skin" phrasing) added bracelets or a
  watch for a few seconds. Rerolls with identical inputs produce near-identical
  motion (there is no seed), so retrying doesn't fix it.
- **Avatar III**: lip-sync only, with almost no motion.

If a `motionPrompt` is ever needed on Avatar V, the avatar's group must contain
a digital twin. Keep the prompt free of script objects (backpack, toothbrush…),
even as negatives, and repeat the QA below.

### QA before transcoding (reject and re-render on any failure)

Run `kidocoach-assets/video/qa_check.sh <render.mp4> [part1_last_frame.png]` on
every render. It writes `<render>_qa/` next to the video:

- `full.png`: the whole frame every 1.5 s. Check that the eyes are open, the
  outfit, hair and framing are unchanged, and there's no text.
- `hands_N.png`: the lower half every 0.5 s, 25 s per sheet. Check for bare,
  empty hands: no gloves, jewelry, watches or held objects. Hallucinated
  accessories often last only 2–3 s, so a coarser sheet misses them.
- `first.png`: the first frame. When given Part 1's last frame, the script
  prints the seam SSIM (aim ≥ 0.8).

Also spot-check a few seconds with sound to confirm the mouth follows the audio.

## Step 3: Author the captions JSON

Generate captions with the `generate-activity-captions` skill
(`.github/skills/generate-activity-captions/`). It force-aligns the published
clips' audio to word level and writes this file, plus `.srt`/`.vtt` and a review player.

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

Upload the three files to the paths listed under Deliverables, then the details
file per [`ADDING_ACTIVITIES.md`](ADDING_ACTIVITIES.md).

- **Videos:** overwriting an existing path is picked up automatically. The app
  compares the Storage object `generation` and downloads the file again.
- **Captions:** versioned by `generation` like the videos (see `syncActivityMedia`
  in [`services/assetSync.ts`](../services/assetSync.ts)). Overwriting the file
  refreshes devices on the next app open, and deleting it removes captions.
- Captions are optional (a missing file is non-fatal), but without them the
  activity plays with no subtitles.

## Step 5: Archive the sources in `kidocoach-assets/routines`

Keep every authored routine in the local assets workspace
(`~/workspace/kidocoach-assets/routines`), one folder per activity and script
option. The folder name is the canonical `activityKey`:

```
routines/{activityKey}/option_{a|b}/
  part1.wav, part2.wav              Step 1 TTS output
  part1.mp4, part2.mp4              Step 2 transcoded clips (as uploaded)
  part1_last_frame.png              Part 1's final frame (Part 2 seam reference)
  part1.srt, part1.vtt              greeting with the sample name (Jonathan)
  part2.srt, part2.vtt              Part 2 cues, timed from 0
  captions_combined.srt, .vtt       Part 1 + Part 2 on one timeline, sample name
  captions.json                     exactly what was uploaded as {key}_captions.json ({{name}})
  player.html                       local preview: plays part1 → part2 with captions
  takes/                            every raw HeyGen render and unused WAV, never deleted
```

Back up **every** render in `takes/` as soon as it downloads, named
`part{1|2}_v{N}_{engine/avatar}_{outcome}.mp4`, where the outcome is the failure
reason (`_gloves`, `_watch`, `_closed_eyes`, `_no_gestures`), `_PUBLISHED`, or
`_superseded` for a take that was published and later replaced.

Other variants in the same activity folder:

- `current/`: full-length renders whose text matches
  [`routines_manifest.json`](routines_manifest.json) (`full_{child}.mp4` + `.mp3`).
- `legacy/`: older full-length renders whose script matches no current text.
- `routines/_duplicates/`: byte-identical copies kept out of the way.

When adding a video, transcribe it and match the text against
`routines_manifest.json` and the `part*.srt` files to choose the folder; never
guess from the file name.

## Checklist

- [ ] Part 1 greeting text = the activity's `part1.text` template (with a sample name)
- [ ] Part 2 contains no name
- [ ] Same TTS model and voice in Part 1, Part 2, and the runtime generator
- [ ] Part 2's first frame matches Part 1's final frame (SSIM ≥ 0.8, checked visually)
- [ ] Both clips rendered on Avatar V from the Becky gesture avatar with our TTS
      audio; eyes open on frame 1, hand gestures with bare hands, no added props,
      gloves or jewelry, lips in sync
- [ ] Every take backed up in `takes/`
- [ ] Both clips transcoded to 720 × 1280, 25 fps, H.264, AAC 48 kHz
- [ ] `cues[0].end` = Part 1 video duration; Part 2 cues are offset by that duration
- [ ] Greeting cue uses `{name}`
- [ ] Files uploaded under canonical `avatars/{avatarId}/{activityKey}…` names
- [ ] Sources archived in `kidocoach-assets/routines/{activityKey}/option_x/`
