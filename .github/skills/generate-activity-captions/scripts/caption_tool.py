#!/usr/bin/env python3
"""Word-aligned captions for KidoCoach two-part activity videos.

  build   Align one activity's script to its Part 2 voice and write captions + review data.
  player  (Re)build the review player for every activity folder under --out.

Timeline contract (services/twoPartVideoService.ts → buildAndCacheMergedCaptions):
  cue[0]   Part 1 greeting, exactly [0, Part 1 video duration]
  cue[1..] Part 2 narration at Part1Duration + t_part2
"""
import argparse
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

import numpy as np

SR = 16000
HOP = 0.005  # 5 ms energy envelope resolution
MAX_CHARS = 42  # ~2 lines in the app caption bar
MAX_DUR = 4.2
FLICKER_GAP = 0.35  # shorter silences are bridged so the bar does not blink
HOLD = 0.30  # reading hold after speech ends, never past the next cue
MIN_SHOW = 0.80
PEAKS_PER_SEC = 100
HERE = os.path.dirname(os.path.abspath(__file__))

NO_BREAK_AFTER = {
    "a", "an", "the", "and", "or", "but", "of", "for", "to", "into", "on", "in", "at", "with",
    "such", "your", "our", "my", "their", "those", "these", "this", "that", "some", "any",
    "so", "big", "nice", "very", "super", "if", "as", "all", "by", "out", "up", "look", "like",
}
CONJ = {"and", "but", "so", "or", "to", "into", "while", "before", "after", "with", "like"}


# ---------------------------------------------------------------- media helpers

def probe(path):
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]
    )
    return round(float(out.strip()), 3)


def pcm(path, rate):
    raw = subprocess.check_output(
        ["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(rate), "-f", "s16le", "-"]
    )
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768


def peaks(path, dur):
    a = pcm(path, 8000)
    n = 8000 // PEAKS_PER_SEC
    a = a[: len(a) // n * n].reshape(-1, n)
    pk = [round(float(x), 3) for x in np.abs(a).max(axis=1)]
    want = int(round(dur * PEAKS_PER_SEC))
    return (pk + [0.0] * want)[:want]  # pinned to the container duration


# ---------------------------------------------------------------- text helpers

def norm(w):
    w = w.lower().replace("’", "'")
    w = {"'em": "them"}.get(w.strip(".,!?;:\"…"), w)
    return re.sub(r"[^a-z0-9']", "", w)


def load_script(path, fixes):
    if path.endswith(".json"):
        cues = json.load(open(path))
        text = " ".join(c["text"] for c in cues[1:])  # cue[0] is the greeting
    else:
        text = open(path).read()
    text = re.sub(r"\s+", " ", text).strip().replace("...", "…")
    for f in fixes:
        a, b = f.split("=>", 1)
        if a not in text:
            sys.exit(f"--fix: '{a}' not found in script")
        text = text.replace(a, b)
    return text.split(" ")


def text_of(ws):
    return " ".join(w["word"] for w in ws)


# ---------------------------------------------------------------- alignment

def map_script_to_asr(script, asr_words):
    """Carries ASR/wav2vec2 word timings onto the authored script words."""
    a = [norm(w) for w in script]
    b = [norm(w["word"]) for w in asr_words]
    timed = [None] * len(script)
    diffs = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        if tag == "equal" or (tag == "replace" and i2 - i1 == j2 - j1):
            for k in range(i2 - i1):
                timed[i1 + k] = asr_words[j1 + k]
        elif tag == "replace":
            s, e = asr_words[j1]["start"], asr_words[j2 - 1]["end"]
            n = i2 - i1
            for k in range(n):
                timed[i1 + k] = {"start": s + (e - s) * k / n, "end": s + (e - s) * (k + 1) / n}
        if tag != "equal":
            diffs.append((tag, script[i1:i2], [w["word"] for w in asr_words[j1:j2]]))
    missing = [script[i] for i, t in enumerate(timed) if t is None]
    return timed, diffs, missing


def envelope(audio):
    n = int(HOP * SR)
    frames = len(audio) // n
    rms = np.sqrt(np.mean(audio[: frames * n].reshape(frames, n) ** 2, axis=1) + 1e-12)
    db = np.convolve(20 * np.log10(rms), np.ones(3) / 3, mode="same")
    floor, peak = np.percentile(db, 10), np.percentile(db, 99)
    return db, max(floor + 0.25 * (peak - floor), peak - 40)


def refine_start(t, db, thr, back=0.12, fwd=0.15):
    i = min(int(t / HOP), len(db) - 1)
    lo, hi = max(0, i - int(back / HOP)), min(len(db) - 1, i + int(fwd / HOP))
    if db[i] >= thr:
        while i > lo and db[i - 1] >= thr:
            i -= 1
    else:
        while i < hi and db[i] < thr:
            i += 1
        if db[i] < thr:
            return t
    return i * HOP


def refine_end(t, db, thr, fwd=0.15, back=0.15):
    i = min(int(t / HOP), len(db) - 1)
    lo, hi = max(0, i - int(back / HOP)), min(len(db) - 1, i + int(fwd / HOP))
    if db[i] >= thr:
        while i < hi and db[i + 1] >= thr:
            i += 1
    else:
        while i > lo and db[i] < thr:
            i -= 1
        if db[i] < thr:
            return t
    return (i + 1) * HOP


# ---------------------------------------------------------------- chunking

def mark_forced(words, breaks):
    text = text_of(words)
    forced = set()
    for phrase in breaks:
        left, full = phrase.split(" | ")[0], phrase.replace(" | ", " ")
        pos = text.find(full)
        if pos < 0:
            sys.exit(f"--break phrase not found in script: {phrase}")
        forced.add(len((text[:pos] + left).split()) - 1)
    for i, w in enumerate(words):
        w["forced"] = i in forced


def split_cost(words):
    pts = {}
    for i, w in enumerate(words[:-1]):
        gap = words[i + 1]["start"] - w["end"]
        c = 3.0
        if re.search(r"[.!?…]$", w["word"]):
            c = 0.0
        elif re.search(r"[,;:—]$", w["word"]):
            c = 1.0
        elif words[i + 1]["word"].lower() in CONJ:
            c = 2.0
        if norm(w["word"]) in NO_BREAK_AFTER and c > 0:
            c += 5.0
        if c > 0 and norm(w["word"]) == norm(words[i + 1]["word"]):
            c += 5.0  # keep chants together ("pat, pat, pat")
        c -= min(gap, 0.6) * 2.5
        if w.get("forced"):
            c = -100.0
        pts[i] = c
    return pts


def chunk(words):
    sentences, cur = [], []
    for w in words:
        cur.append(w)
        if re.search(r"[.!?…]$", w["word"]):
            sentences.append(cur)
            cur = []
    if cur:
        sentences.append(cur)

    def fits(ws):
        return len(text_of(ws)) <= MAX_CHARS and ws[-1]["end"] - ws[0]["start"] <= MAX_DUR

    def split(ws):
        if (fits(ws) and not any(w["forced"] for w in ws[:-1])) or len(ws) < 2:
            return [ws]
        best, bc, total = None, 1e9, len(text_of(ws))
        for i, c in split_cost(ws).items():
            lt, rt = text_of(ws[: i + 1]), text_of(ws[i + 1 :])
            strong = bool(re.search(r"[.!?…]$", ws[i]["word"]))
            orphan = 4.0 if not strong and (len(lt) < 14 or len(rt) < 14) else 0.0
            overflow = 0.5 * ((len(lt) > MAX_CHARS) + (len(rt) > MAX_CHARS))
            cost = c + abs(len(lt) - len(rt)) / total * 2.0 + orphan + overflow
            if cost < bc:
                best, bc = i, cost
        return split(ws[: best + 1]) + split(ws[best + 1 :])

    out = [p for s in sentences for p in split(s)]
    merged = []
    for ws in out:  # glue tiny fragments ("Ready?") spoken without a real pause
        if merged:
            prev = merged[-1]
            gap = ws[0]["start"] - prev[-1]["end"]
            short = (ws[-1]["end"] - ws[0]["start"] < 0.6) or (prev[-1]["end"] - prev[0]["start"] < 0.6)
            if short and gap < 0.4 and fits(prev + ws) and not prev[-1]["forced"]:
                merged[-1] = prev + ws
                continue
        merged.append(ws)
    return merged


# ---------------------------------------------------------------- outputs

def ts(t, sep):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02}{sep}{ms:03}"


def write_outputs(d, key, cues, sample_name):
    with open(f"{d}/{key}_captions.json", "w") as f:
        json.dump(cues, f, indent=2, ensure_ascii=False)
        f.write("\n")
    sub = lambda c: c["text"].replace("{{name}}", sample_name)
    open(f"{d}/{key}_captions.srt", "w").write(
        "\n".join(f"{i}\n{ts(c['start'], ',')} --> {ts(c['end'], ',')}\n{sub(c)}\n" for i, c in enumerate(cues, 1))
    )
    open(f"{d}/{key}_captions.vtt", "w").write(
        "WEBVTT\n\n" + "\n".join(f"{ts(c['start'], '.')} --> {ts(c['end'], '.')}\n{sub(c)}\n" for c in cues)
    )


def validate(cues, p1, total):
    errs = []
    if cues[0]["start"] != 0 or abs(cues[0]["end"] - p1) > 1e-6:
        errs.append(f"cue[0] must be [0, {p1}]")
    if "{{name}}" not in cues[0]["text"]:
        errs.append("cue[0] must contain {{name}}")
    for i, c in enumerate(cues):
        if not c["start"] < c["end"]:
            errs.append(f"cue {i} has start >= end")
        if i and cues[i - 1]["end"] > c["start"] + 1e-9:
            errs.append(f"cue {i} overlaps cue {i - 1}")
        if c["end"] > total + 1e-6:
            errs.append(f"cue {i} ends after the video ({c['end']} > {total})")
        if i and len(c["text"]) > MAX_CHARS:
            errs.append(f"cue {i} is {len(c['text'])} chars (> {MAX_CHARS})")
    return errs


# ---------------------------------------------------------------- commands

def cmd_build(a):
    import whisperx  # heavy import only for build

    key = a.key
    if not re.fullmatch(r"[a-z0-9_]+", key):
        sys.exit("--key must be the canonical activity key ([a-z0-9_]+)")
    part1 = a.part1_text.replace("{name}", "{{name}}").replace("{{{{name}}}}", "{{name}}")
    if "{{name}}" not in part1:
        sys.exit("--part1-text must contain {name} or {{name}}")

    out = os.path.join(a.out, key)
    os.makedirs(out, exist_ok=True)
    p1, p2 = probe(a.p1), probe(a.p2)

    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "p2.wav")
        subprocess.check_call(["ffmpeg", "-v", "error", "-y", "-i", a.p2, "-vn", "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", wav])
        audio = whisperx.load_audio(wav)

    print(f"[{key}] transcribing Part 2 ({p2:.2f}s) with Whisper {a.model}…", flush=True)
    model = whisperx.load_model(a.model, "cpu", compute_type="int8", language="en")
    asr = model.transcribe(audio, batch_size=8, language="en")
    asr_text = " ".join(s["text"].strip() for s in asr["segments"])
    print(f"[{key}] ASR: {asr_text}")

    align_model, meta = whisperx.load_align_model(language_code="en", device="cpu")
    aligned = whisperx.align(asr["segments"], align_model, meta, audio, "cpu")
    asr_words = [w for w in aligned["word_segments"] if "start" in w]

    script = load_script(a.script, a.fix) if a.script else asr_text.split(" ")
    timed, diffs, missing = map_script_to_asr(script, asr_words)
    for tag, s, r in diffs:
        print(f"[{key}] script≠voice ({tag}): {' '.join(s) or '∅'}  ⇄  {' '.join(r) or '∅'}")
    if missing:
        sys.exit(f"[{key}] script words not heard in the audio: {missing}. Fix the script (--fix) and rerun.")
    words = [{"word": w, "start": float(t["start"]), "end": float(t["end"])} for w, t in zip(script, timed)]
    mark_forced(words, a.brk)

    db, thr = envelope(audio)
    groups = chunk(words)
    spans = [(refine_start(g[0]["start"], db, thr), refine_end(g[-1]["end"], db, thr)) for g in groups]
    cues = [{"start": 0.0, "end": p1, "text": part1}]
    word_cue = []
    for i, (g, (s, se)) in enumerate(zip(groups, spans)):
        nxt = spans[i + 1][0] if i + 1 < len(spans) else p2
        e = nxt if nxt - se < FLICKER_GAP else min(se + HOLD, nxt)
        if e - s < MIN_SHOW:
            e = min(s + MIN_SHOW, nxt)
        e = min(e, p2)
        cues.append({"start": round(p1 + s, 3), "end": round(p1 + e, 3), "text": text_of(g)})
        word_cue += [len(cues) - 1] * len(g)

    errs = validate(cues, p1, round(p1 + p2, 3))
    write_outputs(out, key, cues, a.sample_name)
    with open(f"{out}/{key}_words.json", "w") as f:
        json.dump({"part2Offset": p1, "words": [{"w": w["word"], "s": round(w["start"], 3), "e": round(w["end"], 3)} for w in words]}, f, indent=1, ensure_ascii=False)

    shutil.copy2(a.p1, f"{out}/{key}_p1.mp4")
    shutil.copy2(a.p2, f"{out}/{key}.mp4")
    old = json.load(open(a.old)) if a.old else (json.load(open(a.script)) if a.script and a.script.endswith(".json") else [])
    review = {
        "p1": p1, "p2": p2, "cues": cues, "old": old,
        "words": [{"w": w["word"], "s": round(p1 + w["start"], 3), "e": round(p1 + w["end"], 3), "c": word_cue[i]} for i, w in enumerate(words)],
        "peaks": peaks(a.p1, p1) + peaks(a.p2, p2),
    }
    json.dump(review, open(f"{out}/_review.json", "w"), separators=(",", ":"), ensure_ascii=False)

    for c in cues:
        print(f"   {c['start']:8.3f} {c['end']:8.3f}  {c['text']}")
    if errs:
        sys.exit(f"[{key}] VALIDATION FAILED:\n  " + "\n  ".join(errs))
    print(f"[{key}] OK — {len(cues)} cues, video {p1 + p2:.3f}s → {out}")
    cmd_player(a)


def cmd_player(a):
    data = {}
    for k in sorted(os.listdir(a.out)):
        f = os.path.join(a.out, k, "_review.json")
        if os.path.isfile(f):
            data[k] = json.load(open(f))
    with open(os.path.join(a.out, "captions_data.js"), "w") as f:
        f.write("window.CAPTIONS_DATA = ")
        json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
        f.write(";\n")
    shutil.copy2(os.path.join(HERE, "player.html"), os.path.join(a.out, "index.html"))
    print(f"player: {os.path.join(a.out, 'index.html')} ({len(data)} activities)")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--key", required=True, help="canonical activity key, e.g. wake_up")
    b.add_argument("--p1", required=True, help="published Part 1 mp4")
    b.add_argument("--p2", required=True, help="published Part 2 mp4")
    b.add_argument("--part1-text", required=True, help="catalog part1.text, e.g. 'Good morning, {name}!'")
    b.add_argument("--script", help="Part 2 script: .txt, or an existing captions .json (cue[0] skipped). Omit to use the ASR text.")
    b.add_argument("--fix", action="append", default=[], help="'authored=>spoken' correction applied to the script (repeatable)")
    b.add_argument("--break", dest="brk", action="append", default=[], help="force a cue break: 'left words | right words' (repeatable)")
    b.add_argument("--old", help="previous captions .json, shown as the 'old' lane in the player")
    b.add_argument("--out", required=True, help="output root, e.g. ~/workspace/kidocoach-assets/new_captions")
    b.add_argument("--model", default="large-v3")
    b.add_argument("--sample-name", default="Liam", help="name used in .srt/.vtt previews")
    b.set_defaults(fn=cmd_build)
    pl = sub.add_parser("player")
    pl.add_argument("--out", required=True)
    pl.set_defaults(fn=cmd_player)
    a = p.parse_args()
    if getattr(a, "out", None):
        a.out = os.path.expanduser(a.out)
    a.fn(a)


if __name__ == "__main__":
    main()
