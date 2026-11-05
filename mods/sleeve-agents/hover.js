// Opens the preview card over whatever a mod is hovering. The screen is read as soon as the
// pointer arrives, so the card opens with its text in place: after a moment the first time,
// at once when the pointer moves on to the next item.
import { exec, hc, openOverlay, closeOverlay, window as appWindow } from "herdr";

export const WIDTH = 520, HEIGHT = 320;
const DELAY = 100, WATCH = 1000, EDGE = 12;

export async function readScreen({ terminal, command }) {
  const r = await (command ? exec(command[0], command.slice(1)) : hc(["read", terminal])).catch(() => null);
  if (!r || r.code !== 0) return null;
  const all = r.stdout.split("\n").map((l) => l.trimEnd());
  while (all.length && !all[all.length - 1]) all.pop();
  while (all.length && !all[0]) all.shift();
  return all;
}

// Keeps the card inside the window.
function inside(at) {
  const size = globalThis.window.bounds();
  return {
    x: Math.max(EDGE, Math.min(at.x, size.width - WIDTH - EDGE)),
    y: Math.max(EDGE, Math.min(at.y, size.height - HEIGHT - EDGE)),
  };
}

export class PreviewHover {
  // The pointer's last spot over a hovered item, where the card opens beside.
  mouse = null;

  // `spec()` gives { at: {x, y}, props }, or null for nothing to show.
  show(id, spec, cx) {
    this.hovered = id;
    const first = spec();
    if (!first) return this.hide();
    let due = Boolean(this.card), lines;
    const open = (cx) => {
      if (this.hovered !== id || !due || lines === undefined) return;
      const s = spec();
      this.hide();
      if (!s) return;
      this.card = openOverlay({ mod: "sleeve-preview", kind: "window", frame: "none", width: WIDTH, height: HEIGHT, at: inside(s.at), props: { ...s.props, lines } });
      this.watch(cx);
    };
    cx.spawn(async (cx) => { lines = await readScreen(first.props); open(cx); });
    if (!due) cx.timer.after(DELAY, (cx) => { due = true; open(cx); });
  }

  // A pointer that leaves the window sends no hover-out, so a card shown while the
  // window goes to the back closes then. Nothing else is asked of the system.
  watch(cx) {
    this.watcher = cx.timer.every(WATCH, () => { if (!appWindow()?.active) this.cancel(); });
  }

  leave(id, cx) {
    if (this.hovered === id) this.hovered = null;
    cx.timer.after(60, () => { if (!this.hovered) this.hide(); });
  }

  cancel() {
    this.hovered = null;
    this.hide();
  }

  hide() {
    this.watcher?.cancel();
    this.watcher = null;
    if (this.card) closeOverlay(this.card);
    this.card = null;
  }
}
