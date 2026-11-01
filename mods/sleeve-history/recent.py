#!/usr/bin/env python3
"""The latest Claude and Codex conversations as JSON rows: recent.py <limit>."""
import glob, json, os, sys
from datetime import datetime, timezone

from session import noise, turn

MAX_HEAD, MAX_LINE = 2000000, 200000


def latest():
    home = os.path.expanduser("~")
    claude = glob.glob(f"{home}/.claude/projects/*/*.jsonl")
    codex = glob.glob(f"{home}/.codex/sessions/*/*/*/*.jsonl")
    found = []
    for agent, paths in (("Claude", claude), ("Codex", codex)):
        for path in paths:
            try:
                found.append((os.path.getmtime(path), agent, path))
            except OSError:
                pass
    return sorted(found, reverse=True)


def codex_titles():
    names = {}
    try:
        with open(os.path.expanduser("~/.codex/session_index.jsonl"), encoding="utf-8") as f:
            for line in f:
                try:
                    row = json.loads(line)
                    names[row["id"]] = row.get("thread_name")
                except (ValueError, KeyError, TypeError):
                    pass
    except OSError:
        pass
    return names


def describe(path):
    """Where a session ran, its title and its first prompt, from the head of the file."""
    place, title, first, read = {}, None, None, 0
    with open(path, "rb") as f:
        for raw in f:
            read += len(raw)
            if read > MAX_HEAD or (place.get("cwd") and title and first):
                break
            if len(raw) > MAX_LINE:
                continue
            try:
                if b'"ai-title"' in raw:
                    title = json.loads(raw).get("aiTitle") or title
                role, text, _time, seen = turn(raw)
            except (ValueError, KeyError, TypeError, AttributeError):
                continue
            place.update({k: v for k, v in seen.items() if v})
            if role == "user" and not first and text and not noise(text):
                first = text
    return place, title, first


def main():
    limit, names, rows = int(sys.argv[1]), codex_titles(), []
    for mtime, agent, path in latest():
        if len(rows) >= limit:
            break
        try:
            place, title, first = describe(path)
        except OSError:
            continue
        stem = os.path.basename(path)[:-len(".jsonl")]
        id = stem if agent == "Claude" else stem[-36:]
        text = title or names.get(id) or first
        if not text:
            continue
        branch = place.get("branch") or "-"
        if branch == "HEAD":
            branch = "-"
        rows.append({
            "agent": agent,
            "where": f"{place.get('cwd') or '-'} / {branch}",
            "id": id,
            "time": datetime.fromtimestamp(mtime, timezone.utc).isoformat(),
            "file": f"{path}:0-0",
            "text": text,
        })
    print(json.dumps(rows))


main()
