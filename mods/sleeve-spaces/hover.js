// Which row the hover card (card.js) is beside, and what it says. It opens after the
// pointer rests a moment, at once for the keyboard's row, follows from row to row,
// and goes when the pointer leaves the rows, on a click and while the window is in
// the background. The row draws it (main.js, cardAt) in a Popup anchored to itself,
// which keeps it inside the window.
//
// The card opens with everything in it, so it never grows while shown: the one thing
// not already known (the last commit) is read while the pointer rests, and kept a while.

import { exec, window as appWindow } from "herdr";

const DELAY = 450; // ms resting on a row before the first card
const GRACE = 90; // ms between two rows, so moving on doesn't close it
const WAIT = 700; // ms the card waits for the last commit before opening without it
const KEEP = 30000; // ms a folder's last commit is reused

export class HoverCard {
  constructor() {
    this.id = null; // the row asked for
    this.shown = null; // { id, props }: the card on screen
    this.commits = new Map(); // machine + folder -> { at, value: promise of { subject, at } or null }
  }

  // `spec()`: the card's props, or null for none. `now`: no wait for the pointer to rest.
  over(id, spec, cx, now = false) {
    this.id = id;
    const props = spec();
    if (!props) return this.close(cx);
    const commit = this.commit(props);
    let rested = now || Boolean(this.shown), last;
    const open = (cx) => {
      if (this.id !== id || !rested || last === undefined || !appWindow()?.active) return;
      this.shown = { id, props: { ...props, commit: last } };
      cx.notify();
    };
    cx.spawn(async (cx) => {
      const timeout = new Promise((done) => cx.timer.after(WAIT, () => done(null)));
      last = await Promise.race([commit, timeout]);
      open(cx);
    });
    if (!rested) cx.timer.after(DELAY, (cx) => { rested = true; open(cx); });
  }

  commit({ git, folder, machine }) {
    if (!git || !folder) return Promise.resolve(null);
    const key = `${machine ?? ""}\n${folder}`;
    const kept = this.commits.get(key);
    if (kept && Date.now() - kept.at < KEEP) return kept.value;
    const value = exec("git", ["log", "-1", "--format=%s%x1f%ct"], { cwd: folder, on: machine ?? undefined, timeout: 3000 })
      .then((r) => {
        const [subject, at] = (r.code === 0 ? r.stdout.trim() : "").split("\x1f");
        return subject ? { subject, at: Number(at) * 1000 } : null;
      })
      .catch(() => null);
    this.commits.set(key, { at: Date.now(), value });
    return value;
  }

  out(id, cx) {
    if (this.id !== id) return;
    this.id = null;
    cx.timer.after(GRACE, (cx) => { if (!this.id) this.close(cx); });
  }

  // The card's props when it is beside row `id`.
  at(id) {
    return this.shown?.id === id ? this.shown.props : null;
  }

  // `cx`: to redraw; without one the next render drops it.
  close(cx) {
    this.id = null;
    if (!this.shown) return;
    this.shown = null;
    cx?.notify();
  }
}
