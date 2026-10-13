#!/usr/bin/env bash
# One-time: isolated Python env with WhisperX (ASR + wav2vec2 forced alignment). Needs ffmpeg/ffprobe.
set -euo pipefail
VENV="${CAPTIONS_VENV:-$HOME/.cache/kidocoach-captions/venv}"
PY="$(command -v python3.11 || command -v /opt/homebrew/bin/python3.11 || true)"
[ -n "$PY" ] || { echo "python3.11 is required (brew install python@3.11)"; exit 1; }
command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || { echo "ffmpeg/ffprobe required (brew install ffmpeg)"; exit 1; }
if [ ! -x "$VENV/bin/python" ]; then
  mkdir -p "$(dirname "$VENV")"
  "$PY" -m venv "$VENV"
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q whisperx
fi
"$VENV/bin/python" -c "import whisperx" && echo "ready: $VENV/bin/python"
