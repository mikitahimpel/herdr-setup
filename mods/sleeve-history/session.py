#!/usr/bin/env python3
"""The conversation around a search hit, as JSON: session.py <agent> <file:start-end> <query>."""
import json, re, sys

KEEP_BEFORE, KEEP_AFTER, MAX_TEXT = 2, 4, 1800


def text_of(content):
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if isinstance(block, dict) and block.get("type") in ("text", "input_text", "output_text"):
            parts.append(block.get("text") or "")
    return "\n\n".join(p for p in parts if p)


def noise(text):
    t = text.lstrip()
    return not t or t.startswith(("<", "[Request interrupted", "Caveat:", "# AGENTS.md", "# CLAUDE.md"))


def turn(line):
    """role, text, time, and whatever the line says about where the session ran."""
    d = json.loads(line)
    place = {}
    if d.get("cwd"):
        place["cwd"] = d["cwd"]
    if d.get("gitBranch"):
        place["branch"] = d["gitBranch"]
    payload = d.get("payload") if isinstance(d.get("payload"), dict) else {}
    if d.get("type") == "session_meta":
        place["cwd"] = payload.get("cwd")
        place["branch"] = (payload.get("git") or {}).get("branch")
    if d.get("type") == "turn_context" and payload.get("cwd"):
        place["cwd"] = payload["cwd"]
    role = text = None
    if d.get("type") in ("user", "assistant") and not d.get("isSidechain") and not d.get("isMeta"):
        role, text = d["type"], text_of((d.get("message") or {}).get("content"))
    elif d.get("type") == "response_item" and payload.get("type") == "message" and payload.get("role") in ("user", "assistant"):
        role, text = payload["role"], text_of(payload.get("content"))
    return role, text, d.get("timestamp"), place


def clip(text):
    if len(text) <= MAX_TEXT:
        return text.strip()
    cut = text[:MAX_TEXT].rsplit("\n", 1)[0]
    if cut.count("```") % 2:
        cut += "\n```"
    return cut.strip() + "\n\n…"


def main():
    path, _, span = sys.argv[2].rpartition(":")
    start, _, end = span.partition("-")
    start, end = int(start), int(end or start)
    words = [w.lower() for w in re.findall(r"\w+", sys.argv[3])]
    turns, place, offset = [], {}, 0
    with open(path, "rb") as f:
        for raw in f:
            at, offset = offset, offset + len(raw)
            if len(raw) > 2000000 and offset <= start:
                continue
            try:
                role, text, time, seen = turn(raw)
            except (ValueError, KeyError, TypeError, AttributeError):
                continue
            place.update({k: v for k, v in seen.items() if v})
            if role and text and not noise(text):
                turns.append({"role": role, "text": text, "time": time, "in": at < end and offset > start})
    def score(t):
        return sum(w in t["text"].lower() for w in words)
    inside = [i for i, t in enumerate(turns) if t["in"]]
    hit = max(inside or range(len(turns)), key=lambda i: (score(turns[i]), -i), default=0) if words else max(len(turns) - 1, 0)
    first = next((i for i, t in enumerate(turns) if t["role"] == "user"), 0)
    begin, stop = max(0, hit - KEEP_BEFORE), hit + KEEP_AFTER + 1
    shown = ([first] if first < begin else []) + list(range(begin, min(stop, len(turns))))
    out = []
    for i in shown:
        t = turns[i]
        out.append({"role": t["role"], "text": clip(t["text"]), "time": t["time"], "hit": i == hit and bool(words), "skipped": begin - first - 1 if i == begin and first < begin else 0})
    print(json.dumps({"turns": out, "total": len(turns), "cwd": place.get("cwd"), "branch": place.get("branch")}))


if __name__ == "__main__":
    main()
