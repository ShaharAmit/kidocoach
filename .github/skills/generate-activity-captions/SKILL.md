---
name: generate-activity-captions
description: Generate word-aligned captions for a KidoCoach two-part activity video (Part 1 greeting + Part 2 narration) with Whisper + wav2vec2 forced alignment. Writes {key}_captions.json, .srt and .vtt, and a review player. Use it to create or fix {key}_captions.json, or to retime or review subtitles for avatars/becky videos.
---

# Generate activity captions

This produces `{key}_captions.json` in the app's timeline contract. Timings come from forced alignment of the **actual voice**, refined on the audio energy envelope, with ~10 ms precision. All tooling lives in `scripts/`:

| File | Purpose |
|---|---|
| `scripts/setup.sh` | One-time venv with WhisperX (`~/.cache/kidocoach-captions/venv`, override with `CAPTIONS_VENV`). Needs python3.11 and ffmpeg. |
| `scripts/caption_tool.py build` | Takes one activity from the p1/p2 mp4s and writes captions + `_review.json`, then refreshes the player |
| `scripts/caption_tool.py player` | Rebuilds `<out>/index.html` + `captions_data.js` from every `<out>/*/_review.json` |
| `scripts/player.html` | Review player template: p1→p2 playback, app-style caption bar, word highlight, new/old toggle, zoomable waveform |

## Timeline contract (must hold; see `services/twoPartVideoService.ts` `buildAndCacheMergedCaptions`)

- `cues[0]` is the greeting only and spans exactly `[0, Part 1 video duration]`, where the duration is ffprobe's format duration of the **published** `_p1.mp4`.
- Part 2 cues are `p1Duration + t` on Part 2's own timeline, and the last `end` must be ≤ p1 + p2 duration.
- The name is templated as `{{name}}` (`{name}` also works). The greeting text = the catalog `part1.text`.
- The app resizes cue 0 to the personalized greeting and shifts everything else by the difference. **Never pre-shift.**
- The player shows the cue where `start ≤ t < end`. Cues must not overlap.

## Workflow

1. **Setup** (once): `.github/skills/generate-activity-captions/scripts/setup.sh`. It prints the venv python path; call it `$PY` below.
2. **Get the published media**. Use `gcloud storage cp`; `gsutil -m` hangs on macOS.
   ```bash
   B=gs://kids-routine-coach-app.firebasestorage.app; W=/tmp/cap_src; mkdir -p $W
   gcloud storage cp $B/avatars/becky/{KEY}_p1.mp4 $B/avatars/becky/{KEY}.mp4 $W/
   gcloud storage cp $B/avatars/becky/{KEY}_captions.json $W/ 2>/dev/null || true   # old captions (if any)
   ```
   Always caption the exact files that are (or will be) published. A re-encode changes the Part 1 duration.
3. **Get the greeting template**: use `part1.text` from Firestore `catalog/activities` (`activities.{KEY}.part1.text`) or from the activity's details JSON. Firestore REST read:
   ```bash
   curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
     "https://firestore.googleapis.com/v1/projects/kids-routine-coach-app/databases/(default)/documents/catalog/activities" > /tmp/catalog.json
   ```
4. **Build**:
   ```bash
   $PY .github/skills/generate-activity-captions/scripts/caption_tool.py build \
     --key KEY --p1 $W/KEY_p1.mp4 --p2 $W/KEY.mp4 \
     --part1-text "Good morning, {name}!" \
     --script $W/KEY_captions.json          # or a .txt with the authored Part 2 script \
     --old $W/KEY_captions.json \
     --out ~/workspace/kidocoach-assets/new_captions
   ```
   - `--script` sets the **wording** (authored punctuation and casing). Timing always comes from the voice. If omitted, the ASR text is used.
   - Read each `script≠voice` line. When the voice really says something different, add `--fix 'authored words=>spoken words'` (e.g. `--fix "Your energy battery is=>Ah, your energy battery's"`). Ignore spelling-only diffs (`brand-new ⇄ brand new`, `'em ⇄ them`).
   - When an automatic split reads badly, force a break: `--break 'left words | right words'` (repeatable). Use the phrasing of the sentence, not its length.
   - The tool validates the contract and exits non-zero on failure.
5. **Review**: open `<out>/index.html` (`open ~/workspace/kidocoach-assets/new_captions/index.html`) and have the user watch it. Keys: Space play/pause, ←/→ previous/next cue, `,`/`.` frame step. Adjust with `--fix`/`--break`, then rebuild.
6. **Upload**: only after the user approves. See *Publishing* below.

Batch: run `build` per key (the model loads once per run, ~15–40 s per activity on Apple Silicon CPU). The player aggregates all keys under `--out`.

## Timing policy (built into the tool; change only deliberately)

- Each cue is ≤ 42 chars and ≤ 4.2 s. Splitting is sentence-first, never breaks after function words, leaves no 1–2 word orphans, and keeps chants/lists together.
- A cue starts at the first word's onset, refined −120/+150 ms to the energy rise. It ends at the last word's offset + 0.30 s hold, never past the next cue's start.
- Gaps < 0.35 s between cues are bridged (no flicker). Every cue shows for at least 0.8 s.
- Envelope: 5 ms RMS; threshold = max(floor + 25 % of range, peak − 40 dB).

## Outputs (`<out>/<key>/`)

`{key}_captions.json` (upload this), `.srt`/`.vtt` (sample name, for preview tools), `{key}_words.json` (per-word timings + cue index), `_review.json` (player data).

## Publishing (replace live captions)

```bash
B=gs://kids-routine-coach-app.firebasestorage.app
mkdir -p ~/workspace/kidocoach-assets/new_captions/_backup_live_$(date +%F)
gcloud storage cp $B/avatars/becky/KEY_captions.json ~/workspace/kidocoach-assets/new_captions/_backup_live_$(date +%F)/   # local backup only, never under avatars/
TOKEN=$(gcloud storage objects describe $B/avatars/becky/KEY_captions.json --format='value(metadata.firebaseStorageDownloadTokens)' 2>/dev/null)
gcloud storage cp --content-type=application/json ${TOKEN:+--custom-metadata=firebaseStorageDownloadTokens=$TOKEN} \
  ~/workspace/kidocoach-assets/new_captions/KEY/KEY_captions.json $B/avatars/becky/
```

- Overwriting with gcloud drops the Firebase download token unless you pass it back, as above.
- Verify: the Storage object's `generation` must equal `activities.KEY.assets.becky.captions.generation` in `catalog/activities` (written by the `onCatalogAssetFinalized` trigger). Devices re-download captions on the next app open (generation-versioned in `services/assetSync.ts`).
- Upload only to `avatars/becky/`. The app and catalog use `DEFAULT_AVATAR_ID = 'becky'`, and `avatars/default/` holds different renders.

## Gotchas

- whisperx prints torchcodec/libav dlopen warnings. They're harmless.
- Use python3.11. The system python3 (3.9) can't install whisperx.
- If ASR misses words (music, whispering), check `{key}_words.json` for words with interpolated timing and listen to that span in the player.
