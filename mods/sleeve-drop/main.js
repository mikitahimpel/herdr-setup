// Says when a file is being dragged, so pane headers can turn into drop targets
// (sleeve-pane/drop.js explains why a drop on the terminal itself isn't enough).
//
// Herdr has no drag-enter event for mods, so watch.jxa runs beside the app and writes
// "drag" or "idle" to a file; this waits for that file to change and sets the shared
// "sleeve.dragging". A floating block (layouts/sleeve.json, id "drop") that draws nothing.

import { View, div } from "gpui-kit";
import { appHome, exec, home, readTextFile, setShared, shared, watchFolder } from "herdr";

const DIR = () => `${home()}/Library/Caches/herdr-drag`;

// Starts the watcher unless one from an earlier start is still running.
const START = `
d="$1"; js="$2"
mkdir -p "$d"
if [ -f "$d/pid" ] && ps -p "$(cat "$d/pid")" -o command= 2>/dev/null | grep -q 'watch.jxa'; then exit 0; fi
nohup osascript -l JavaScript "$js" "$d/state" "$d/pid" >/dev/null 2>&1 &
echo $! > "$d/pid"`;

export default class SleeveDrop extends View {
  init(_props, cx) {
    cx.spawn(async () => {
      await exec("sh", ["-c", START, "sh", DIR(), `${appHome()}/mods/sleeve-drop/watch.jxa`]).catch(() => null);
      for (;;) {
        const dragging = (await readTextFile(`${DIR()}/state`).catch(() => null))?.trim() === "drag";
        if (dragging !== Boolean(shared("sleeve.dragging"))) setShared("sleeve.dragging", dragging);
        await watchFolder(DIR());
      }
    });
  }

  render() {
    return div();
  }
}
