// Files dropped on a pane header go to that pane's terminal as readable copies.
//
// A file dragged from the macOS screenshot thumbnail lives in a protected temporary
// folder that only the app accepting the drop may read. Herdr accepts it, but the
// terminal's programs run under herdr-core, so a path dropped straight onto the
// terminal can't be opened there. Here the app (whose programs may read the dropped
// files) copies them to CACHE, puts the copies on the clipboard and pastes them, which
// types their paths like a drop.

import { exec, home, notify, run, setShared, writeTextFile } from "herdr";

const CACHE = () => `${home()}/Library/Caches/herdr-drops`;
const KEEP_DAYS = 7;

const COPY = `
dir="$1"; shift
mkdir -p "$dir" || exit 1
find "$(dirname "$dir")" -mindepth 1 -maxdepth 1 -type d -mtime +${KEEP_DAYS} -exec rm -rf {} + 2>/dev/null
for src in "$@"; do
  cp "$src" "$dir/" || exit 1
  printf '%s\\n' "$dir/$(basename "$src")"
done`;

// File URLs, as Finder copies them; AppleScript's `set the clipboard` writes its own list
// type, which terminal.paste doesn't take as files.
const CLIPBOARD = `
ObjC.import("AppKit");
function run(argv) {
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  const urls = $.NSMutableArray.array;
  argv.forEach((p) => urls.addObject($.NSURL.fileURLWithPath(p)));
  return pb.writeObjects(urls);
}`;

export function dropInto(pane, paths, cx) {
  setShared("sleeve.dragging", false);
  if (!paths?.length) return;
  cx.spawn(async () => {
    // The drag watcher only times out, so the drop ends the highlight.
    await writeTextFile(`${home()}/Library/Caches/herdr-drag/state`, "idle", null).catch(() => null);
    const dir = `${CACHE()}/${Date.now()}`;
    const copied = await exec("sh", ["-c", COPY, "sh", dir, ...paths]).catch((e) => ({ code: 1, stderr: String(e) }));
    if (copied.code !== 0) {
      notify({ title: "Couldn't take the dropped file", body: (copied.stderr || "cp failed").trim(), level: "error" });
      return;
    }
    const copies = copied.stdout.trim().split("\n").filter(Boolean);
    const clip = await exec("osascript", ["-l", "JavaScript", "-e", CLIPBOARD, ...copies]).catch((e) => ({ code: 1, stderr: String(e) }));
    if (clip.code !== 0) {
      notify({ title: "Couldn't paste the dropped file", body: (clip.stderr || "osascript failed").trim(), level: "error" });
      return;
    }
    run("pane.focus", { pane });
    run("terminal.paste");
  });
}
