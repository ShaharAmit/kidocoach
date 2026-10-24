---
name: activity-media-pipeline
description: Produce the media for a KidoCoach activity from a text paragraph. Adds the script to docs/routines_manifest.json, then generates Part 1 (greeting) and Part 2 (narration) audio with Gemini TTS, renders both on the Becky HeyGen Avatar V gesture avatar, runs QA, transcodes, builds captions and archives the sources. Use it to create a new activity from text or to re-render activity videos.
---

# Activity media pipeline (Gemini TTS → HeyGen → captions)

Source of truth: `docs/TTS_HEYGEN_PIPELINE.md`. Read it before starting, and update it when the process changes. The steps below are the executable summary. Publishing is a separate skill (`publish-activity`).

Deliverables per activity `KEY`: `KEY_p1.mp4` (greeting, ~2–4 s), `KEY.mp4` (Part 2, no name), `KEY_captions.json`, plus the archive folder.

MCP tools are deferred. Load them with the tool search before use (`gemini-tts-generate_tts`, `heygen-create_asset_upload`, `heygen-complete_asset_upload`, `heygen-create_video_from_avatar`, `heygen-get_video`, `heygen-create_photo_avatar`, `heygen-get_avatar_creation_status`).

## Step 0: Script the activity in `docs/routines_manifest.json` (always first)

The manifest is the **single source of text** for the activity. TTS, captions and the catalog details JSON all read from it, so the voice, the subtitles and the greeting can't drift apart. Turn the user's paragraph into an entry with the helper (it validates the input and keeps the file's format):

```bash
M=.github/skills/activity-media-pipeline/scripts/manifest.py
python3 $M add --id feed_dog --title "Feed the Dog" --prompt Encouraging \
  --p1 "Doggy time, {name}!" \
  --p2 "Let's fill the bowl with crunchy food. ..."
```

- `--p2` is the user's paragraph, edited only to make it speakable: it's read **verbatim**, so remove stage directions, emoji, bullets and the child's name, and expand symbols ("&" → "and"). Show the user the final text if you changed anything.
- `--p1` is a short greeting (spoken in 2–4 s) containing `{name}`. It's stored with the sample name `Jonathan`. If the user gave none, propose one in the existing style ("Toothbrush time, {name}!").
- `--prompt`: `Encouraging` (default), `Cheerful`, or `Relaxing` (evening/bedtime). These map to the catalog tone `encouraging`/`cheerful`/`calm`.
- Alternative script → `--option b` (stored as `opt_b`, archived as `option_b/`). Rewriting an existing option → `--replace`.
- `python3 $M show --id KEY` prints the exact TTS texts and the derived catalog `part1` `{text, tone}`. Use them **verbatim** in every later step.
- Run `npm test`. `tests/activityCatalog.test.cjs` validates the manifest against the catalog seed (`functions/scripts/activity-catalog.seed.json`); the app bundles no activities.

## Step 1: TTS (Gemini)

- Model `gemini-3.8-flash-tts`. Voice **Aoede** (woman/default) or **Kore** (man), the same as `functions/src/index.ts` so dubbed greetings match.
- The text is spoken **verbatim**. Put delivery only in `speechMetadata.style`. Never write "Say cheerfully: …" in the text.
- Part 1 text = `python3 $M text --id KEY --part p1` (e.g. `Doggy time, Jonathan!`). Part 2 text = `python3 $M text --id KEY --part p2`.
- Style from the manifest `prompt`: Encouraging → "encouraging and supportive, speaking warmly to a young child". Cheerful → "energetic, cheerful and motivating". Relaxing → "calm, soft and soothing bedtime tone".
- For ≈40 s+ Part 2 scripts, add to the style: "at a slightly slower, relaxed pace with short pauses between sentences".
- Save the returned WAV as-is (no re-wrapping): `routines/KEY/option_x/part1.wav`, `part2.wav`.

## Step 2: Render (HeyGen, **sequentially**)

1. Upload each WAV as an asset (create upload → PUT bytes → complete).
2. `create_video_from_avatar` for Part 1:
   - `avatarId: 6a9c3f4eaab4239be0bab3ee340fa6e5` (Becky gesture avatar)
   - `audioAssetId: <part1 asset>`, `engine: {type: "avatar_v"}`
   - `aspectRatio: "9:16"`, `resolution: "1080p"`, `background: {type: "color", value: "#f6f6fc"}`
   - **No** `motionPrompt`, **no** `expressiveness`. Never use a HeyGen script or voice.
3. Wait for completion, download it, then **immediately** copy it to `takes/part1_v{N}_avatar_v_{outcome}.mp4`. Extract the last frame:
   `ffmpeg -sseof -0.1 -i part1.mp4 -update 1 -frames:v 1 part1_last_frame.png`
4. Render Part 2 the same way, with `caption: {file_format: "srt"}`. Back it up to `takes/`.

**Never use:**
- Avatar IV (the default when `engine` is omitted, and also `create_video_from_image`): closed eyes, invented gloves/props.
- Avatar IV Custom Motion: hallucinates watches/bracelets, and rerolls don't fix it.
- Avatar III: almost no motion.
- The old look `976f0236235e4a1fb4f3875f2c297071`: no hand gestures.

Don't animate Part 1's closing frame. It's only the seam reference. For a new gesture avatar, run `create_photo_avatar` via the API on a 720×1280 mid-torso still and wait for `completed` (~10 min). Web-app photo avatars are rejected for avatar_v.

## Step 3: QA (reject and re-render on any failure)

```bash
~/workspace/kidocoach-assets/video/qa_check.sh part1_render.mp4
~/workspace/kidocoach-assets/video/qa_check.sh part2_render.mp4 part1_last_frame.png
```

View the generated sheets (`<render>_qa/full.png`, `hands_N.png`, `first.png`) and check:
- Eyes are open on frame 1. Outfit, hair, framing and background are unchanged. No text.
- Hands are bare and empty in every 0.5 s hands sheet. Accessories often last only 2–3 s.
- Seam SSIM ≥ 0.8, or a side-by-side visual check shows only a gesturing hand differs.
- Lips follow the audio (spot-check with sound).

Name rejected takes with the reason: `_gloves`, `_watch`, `_closed_eyes`, `_no_gestures`.

## Step 4: Transcode to the published spec

```bash
for p in part1 part2; do
  ffmpeg -y -i ${p}_render.mp4 -vf "scale=720:1280:flags=lanczos,fps=25" -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 18 -preset slow \
    -c:a aac -ar 48000 -ac 2 -b:a 160k -movflags +faststart $p.mp4
done
ffprobe -v error -show_entries format=duration -of csv=p=0 part1.mp4   # cue[0].end
```

## Step 5: Captions

Use the **generate-activity-captions** skill on the transcoded `part1.mp4`/`part2.mp4`. Pass `--part1-text` = `catalog_part1.text` from `manifest.py show` and `--script part2.txt`, written with `python3 $M text --id KEY --part p2 > part2.txt`. Have the user review the player. Then copy `KEY/KEY_captions.json` to `option_x/captions.json`, and the `.srt`/`.vtt` to `captions_combined.*`.

If a `script≠voice` diff is a real TTS deviation, re-render the audio. Don't patch the manifest to match a mistake.

## Step 6: Archive + hand off to publishing

Archive to `~/workspace/kidocoach-assets/routines/KEY/option_{a|b}/`: `part1.wav`, `part2.wav`, `part1.mp4`, `part2.mp4` (as uploaded), `part1_last_frame.png`, `part{1,2}.srt/.vtt`, `captions_combined.srt/.vtt`, `captions.json`, `player.html`, and `takes/` (every raw render, never deleted; the published take gets `_PUBLISHED`, a replaced one `_superseded`).

For **publish-activity**, build the details JSON from the manifest: `label` = `title`, `part1` = `catalog_part1` from `manifest.py show`. Get the other fields (emoji, subtitle, timeOfDay, timerSeconds, durationMode, stars, order, tags, routine) from the user.

When filing an existing video, transcribe it and match the text against `docs/routines_manifest.json` and the `part*.srt` files. Never guess from the file name.

## Checklist

- [ ] Script added to `docs/routines_manifest.json` (`manifest.py add`), and `npm test` passes.
- [ ] TTS texts, caption script and catalog `part1` all come from the manifest, verbatim.
- [ ] Part 1 text = `part1.text` with a sample name. Part 2 has no name.
- [ ] Same TTS model and voice for both parts and the runtime.
- [ ] Avatar V + Becky gesture avatar, our audio, eyes open, bare hands, no props, lips in sync.
- [ ] Seam SSIM ≥ 0.8 (or visually justified).
- [ ] Every take is in `takes/`.
- [ ] 720×1280, 25 fps, H.264 High, AAC 48 kHz stereo, faststart.
- [ ] Captions: `cues[0].end` = p1 duration, `{{name}}`, user-approved.
- [ ] Archived. Then run **publish-activity**.
