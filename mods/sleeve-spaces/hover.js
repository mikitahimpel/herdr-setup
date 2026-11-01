// Opens the preview card over whatever a mod is hovering. The screen is read as soon as the
// pointer arrives, so the card opens with its text in place: after a moment the first time,
// at once when the pointer moves on to the next item.
import { exec, hc, openOverlay, closeOverlay } from "herdr";

export const WIDTH = 440, HEIGHT = 262;
const DELAY = 100, LINES = 14;

export async function readScreen({ terminal, command }) {
  const r = await (command ? exec(command[0], command.slice(1)) : hc(["read", terminal])).catch(() => null);
  if (!r || r.code !== 0) return null;
  const all = r.stdout.split("\n").map((l) => l.trimEnd());
  while (all.length && !all[all.length - 1]) all.pop();
  return all.slice(-LINES);
}

export class PreviewHover {
  // `spec()` gives { at: {x, y}, props }, or null for nothing to show.
  show(id, spec, cx) {
    this.hovered = id;
    const first = spec();
    if (!first) return;
    let due = Boolean(this.card), lines;
    const open = () => {
      if (this.hovered !== id || !due || lines === undefined) return;
      const s = spec();
      this.hide();
      if (s) this.card = openOverlay({ mod: "sleeve-preview", kind: "window", frame: "none", width: WIDTH, height: HEIGHT, at: s.at, props: { ...s.props, lines } });
    };
    cx.spawn(async () => { lines = await readScreen(first.props); open(); });
    if (!due) cx.timer.after(DELAY, () => { due = true; open(); });
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
    if (this.card) closeOverlay(this.card);
    this.card = null;
  }
}
