#!/usr/bin/env python3
"""Read/write activity scripts in docs/routines_manifest.json (the source text for TTS, captions and details JSON)."""
import argparse, json, os, re, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), *[".."] * 4))
PATH = os.path.join(ROOT, "docs", "routines_manifest.json")
SAMPLE = "Jonathan"
TONE = {"Encouraging": "encouraging", "Cheerful": "cheerful", "Relaxing": "calm"}


def load():
    with open(PATH, encoding="utf-8") as f:
        return json.load(f)


def save(data):
    with open(PATH, "w", encoding="utf-8") as f:
        f.write(json.dumps(data, indent=2, ensure_ascii=False))


def clean(text):
    return re.sub(r"\s+", " ", text).strip()


def cmd_add(a):
    if not re.fullmatch(r"[a-z0-9_]+", a.id):
        sys.exit(f"invalid key '{a.id}': use [a-z0-9_]+")
    if a.prompt not in TONE:
        sys.exit(f"--prompt must be one of {', '.join(TONE)}")
    p1, p2 = clean(a.p1).replace("{name}", SAMPLE), clean(a.p2)
    if SAMPLE not in p1:
        sys.exit(f"--p1 must contain {{name}} or the sample name {SAMPLE}")
    if SAMPLE in p2 or "{name}" in p2:
        sys.exit("--p2 must not contain the child's name")
    data, opt = load(), f"opt_{a.option}"
    entry = next((e for e in data if e["id"] == a.id), None)
    if entry is None:
        entry = {"id": a.id, "title": a.title or a.id.replace("_", " ").title()}
        data.append(entry)
    elif opt in entry and not a.replace:
        sys.exit(f"{a.id}.{opt} already exists; pass --replace or use another --option")
    if a.title:
        entry["title"] = a.title
    entry[opt] = {"p1": {"prompt": a.prompt, "text": p1}, "p2": {"prompt": a.prompt, "text": p2}}
    save(data)
    print(f"{a.id}.{opt} saved → {os.path.relpath(PATH, ROOT)}")
    cmd_show(argparse.Namespace(id=a.id, option=a.option))


def get(key, option):
    entry = next((e for e in load() if e["id"] == key), None)
    if not entry or f"opt_{option}" not in entry:
        sys.exit(f"{key}.opt_{option} not in {PATH}")
    return entry, entry[f"opt_{option}"]


def cmd_show(a):
    entry, o = get(a.id, a.option)
    print(json.dumps({
        "id": entry["id"], "title": entry["title"], "option": a.option,
        "part1_tts_text": o["p1"]["text"],
        "part2_tts_text": o["p2"]["text"],
        "catalog_part1": {"text": o["p1"]["text"].replace(SAMPLE, "{name}"), "tone": TONE[o["p1"]["prompt"]]},
        "prompt": o["p2"]["prompt"],
    }, indent=2, ensure_ascii=False))


def cmd_text(a):
    _, o = get(a.id, a.option)
    sys.stdout.write(o[a.part]["text"] + "\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sp = ap.add_subparsers(dest="cmd", required=True)
    ad = sp.add_parser("add", help="add/replace an activity script option")
    ad.add_argument("--id", required=True)
    ad.add_argument("--title")
    ad.add_argument("--p1", required=True, help="greeting with {name} (or Jonathan), e.g. 'Doggy time, {name}!'")
    ad.add_argument("--p2", required=True, help="Part 2 paragraph, spoken verbatim, no name")
    ad.add_argument("--prompt", default="Encouraging", help="Encouraging | Cheerful | Relaxing")
    ad.add_argument("--option", default="a", help="script option letter (opt_a, opt_b, …)")
    ad.add_argument("--replace", action="store_true")
    sh = sp.add_parser("show", help="print the TTS texts and derived catalog part1")
    tx = sp.add_parser("text", help="print one part's exact text (pipe into part2.txt)")
    for p in (sh, tx):
        p.add_argument("--id", required=True)
        p.add_argument("--option", default="a")
    tx.add_argument("--part", choices=["p1", "p2"], default="p2")
    a = ap.parse_args()
    {"add": cmd_add, "show": cmd_show, "text": cmd_text}[a.cmd](a)


if __name__ == "__main__":
    main()
