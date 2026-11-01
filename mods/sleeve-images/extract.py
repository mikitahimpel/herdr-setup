#!/usr/bin/env python3
"""Pictures pasted into a Claude Code session, copied out of its transcript.

usage: extract.py <claude pid> <cwd>

Prints {"session", "images": [...]}, newest first. Keeps its place in the transcript, so
a later run reads only what was added.
"""
import base64, glob, hashlib, json, os, re, subprocess, sys

HOME = os.path.expanduser("~")
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
EXT = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}
KEEP = 200


def transcript(pid, cwd):
    project = os.path.join(HOME, ".claude/projects", cwd.replace("/", "-").replace(".", "-"))
    try:
        with open(os.path.join(HOME, ".claude/sessions", f"{pid}.json")) as f:
            path = os.path.join(project, json.load(f)["sessionId"] + ".jsonl")
        if os.path.exists(path):
            return path
    except (OSError, ValueError, KeyError):
        pass
    found = glob.glob(os.path.join(project, "*.jsonl"))
    return max(found, key=os.path.getmtime) if found else None


def save(block, when):
    source = block.get("source") or {}
    if source.get("type") != "base64":
        return None
    data = base64.b64decode(source["data"])
    name = hashlib.sha256(data).hexdigest()[:20]
    full = os.path.join(CACHE, f"{name}.{EXT.get(source.get('media_type'), 'png')}")
    thumb = os.path.join(CACHE, f"{name}.thumb.png")
    if not os.path.exists(full):
        with open(full, "wb") as f:
            f.write(data)
    if not os.path.exists(thumb):
        subprocess.run(["sips", "-s", "format", "png", "-Z", "360", full, "--out", thumb], capture_output=True)
    out = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", thumb], capture_output=True, text=True).stdout
    size = [int(l.split()[-1]) for l in out.splitlines() if "pixel" in l]
    if len(size) != 2:
        return None
    return {"id": name, "file": full, "thumb": os.path.relpath(thumb, os.path.dirname(os.path.dirname(os.path.dirname(CACHE)))), "w": size[0], "h": size[1], "time": when}


def main():
    path = transcript(sys.argv[1], sys.argv[2])
    if not path:
        print(json.dumps({"session": None, "images": []}))
        return
    session = os.path.basename(path)[:-6]
    os.makedirs(CACHE, exist_ok=True)
    index = os.path.join(CACHE, session + ".json")
    state = {"offset": 0, "images": []}
    if os.path.exists(index):
        with open(index) as f:
            state = json.load(f)
    if os.path.getsize(path) != state["offset"]:
        with open(path, "rb") as f:
            f.seek(state["offset"])
            data = f.read()
        whole = data[: data.rfind(b"\n") + 1]
        seen = {i["id"] for i in state["images"]}
        when = state.get("when")
        for line in whole.splitlines():
            stamp = re.search(rb'"timestamp":"([^"]+)"', line[-300:]) or re.search(rb'"timestamp":"([^"]+)"', line[:300])
            if stamp:
                when = stamp.group(1).decode()
            if b'"image"' not in line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            message = entry.get("message")
            if entry.get("type") not in ("user", "api-request-blob") or not isinstance(message, dict) or not isinstance(message.get("content"), list):
                continue
            for block in message["content"]:
                if isinstance(block, dict) and block.get("type") == "image":
                    image = save(block, entry.get("timestamp") or when)
                    if image and image["id"] not in seen:
                        seen.add(image["id"])
                        state["images"].append(image)
        state["offset"] += len(whole)
        state["when"] = when
        state["images"] = state["images"][-KEEP:]
        with open(index, "w") as f:
            json.dump(state, f)
    print(json.dumps({"session": session, "images": state["images"][::-1]}))


main()
