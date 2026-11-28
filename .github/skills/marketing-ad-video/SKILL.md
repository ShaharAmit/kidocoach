---
name: marketing-ad-video
description: Direct and produce a KidoCoach marketing/ad video (UGC-style, Meta/TikTok/Reels) from a script, using the HeyGen MCP tools directly as the director rather than the HeyGen app skills. Covers casting a realistic AI actor, prop and continuity control, B-roll, captions/overlays, AI disclosure and where to save the result. Use when asked to make, remake or edit an advertising video.
---

# Marketing ad video

You are the director. Build the video yourself with the HeyGen MCP tools (`create_image`, `create_photo_avatar`, `create_speech`, `create_video_from_avatar`, `image_to_video`, `search_audio_sounds`) and a local ffmpeg/PIL edit. **Don't use the generic HeyGen app skills or the Video Agent.**

## Creative rules (the user's standing direction)

- **The script is a starting point.** Reorganize, tighten or replace scenes when it makes a better ad. Keep the message, the hook and the CTA. Aim for about 30–40 s; trim lines that run long.
- **Real people, not avatars.** The on-camera parent must read as an actual mom (or dad) filming herself: natural skin, messy hair, everyday clothes, a lived-in home and a selfie framing. Reject anything glossy, stock-like or uncanny. Cast several candidates and pick one.
- **Obsess over small details.** No object may appear unless it's scripted: no hairbrush, toothbrush, mug or phone in hand. No jewelry, so nothing can change between shots. Keep hands out of frame unless the shot needs them. Hair, clothes, set dressing and the child's outfit/backpack must stay continuous across shots (reuse the still as the reference image).
- **No real app screenshots.** It's marketing: show the product through people, emotion and stylized graphics (drawn timer, stars, badges), never real UI or simulator recordings. Devices face away from the camera, or the screen stays blank.
- **QA every frame.** Design each shot as a still first and inspect it before animating. After rendering, check contact sheets (about 1 fps) for props appearing, morphing hands, moving clock hands, visible screens or broken continuity. Regenerate anything that fails.
- **Honest AI use.** Burn in a small, persistent "AI-generated actor · Dramatization" label. Never present it as a real customer review or testimonial (FTC). The CTA gesture and arrow must point where the link actually is.

## Production approach

1. Cast the actor with `create_image` (realistic phone-selfie prompt). Turn the pick into a photo avatar and lip-sync it to one continuous voiceover (`create_speech`; avoid bracket audio tags, because they get read aloud; add a pronunciation for "KidoCoach").
2. B-roll: one still per shot from `create_image` (with reference images for continuity), then `image_to_video` with prompts that forbid new objects, hands and camera cuts.
3. Edit locally: A-roll audio is the master timeline. Cut the B-roll on word timestamps, add a subtle handheld shake to the selfie shots, word-by-word captions, PNG overlays (this ffmpeg has no drawtext; render text with PIL), music about −22 dB under the voice, and a branded end card with `assets/icon.png`.
4. Output 1080×1920 H.264/AAC.

## Where files go

Save every finished ad to **`/Users/shaharamit/workspace/kidocoach-assets/advertising-videos/`** as `kidocoach_<style>_<concept>.mp4`. Archive its sources (actor still, B-roll stills/clips, A-roll, VO timestamps, overlay script) in `advertising-videos/sources/<style>_<concept>/`. Work in `/tmp` and copy the result over at the end. A reference example is in `sources/ugc_mom_morning_chaos/`.
