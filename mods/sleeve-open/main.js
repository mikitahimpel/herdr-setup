// Open a folder: on this Mac or another machine, a terminal or Claude there.
// Type a path (~ is that machine's home) and its folders are listed as you go; with
// nothing typed, the folders already open there and its repos and worktrees.
// ↑/↓ pick, Tab completes into the field, ⌥Tab switches machine.
// Enter: Claude there; ⌘Enter: a terminal there. In the space already at that folder
// if there is one, else in a new space. A folder that isn't there (a path, or a bare
// name for ~/Developer/<name>) is made, with git init, and opened the same way.
// Opened by mod.open (keys, the + menu) or openOverlay with props { machine? }.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, exec, home, machines } from "herdr";

const CLAUDE = ["claude"];

const trim = (path) => path.replace(/(.)\/+$/, "$1");
const base = (path) => trim(path).split("/").pop();

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

async function sh(script, args, on) {
  const r = await exec("sh", ["-c", script, "sh", ...args], { on: on ?? undefined, timeout: 8000 });
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : null;
}

export default class SleeveOpen extends View {
  init(_props, cx) {
    const active = spaces().find((s) => s.active);
    this.list = [null, ...machines().map((m) => m.name).filter(Boolean)];
    const asked = props()?.machine;
    this.on = asked !== undefined ? asked : active?.machine ?? null;
    if (!this.list.includes(this.on)) this.on = null;
    this.homes = { "": home() }; // machine -> its home
    this.known = {}; // machine -> its repos and worktrees, as folders
    this.dirs = {}; // machine \n folder -> its folders, null: none or unreadable
    this.text = "";
    this.at = 0;
    this.error = "";
    this.input = InputState.new({ value: "", placeholder: "A folder, or a name for a new project" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.at = 0; this.error = ""; this.look(cx); cx.notify(); });
    this.input.on("submit", (e, cx) => this.go(!e?.secondary, cx));
    this.input.focus();
    cx.timer.after(100, () => this.input.focus());
    this.handle = cx.focus_handle();
    this.prepare(cx);
  }

  key(m = this.on) { return m ?? ""; }

  ready(m) {
    return !m || machines().find((k) => k.name === m)?.layout === "ready";
  }

  // That machine's home and the folders worth offering before anything is typed.
  prepare(cx) {
    const m = this.on, k = this.key(m);
    if (k in this.known) return;
    this.known[k] = [];
    cx.spawn(async (cx) => {
      try {
        if (m && !(k in this.homes)) this.homes[k] = (await sh('printf "%s\\n" "$HOME"', [], m))?.[0] ?? null;
        const found = await sh('for d in "$HOME"/Developer/*/ "$HOME"/.herdr/worktrees/*/*/; do [ -d "$d" ] && printf "%s\\n" "${d%/}"; done', [], m);
        this.known[k] = found ?? [];
      } catch { this.known[k] = []; }
      cx.notify();
    });
  }

  // ~ for that machine's home, both ways.
  short(path) {
    const h = this.homes[this.key()];
    if (!h) return path;
    return path === h ? "~" : path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
  }

  full(path) {
    const h = this.homes[this.key()];
    if (!h) return path;
    return path === "~" ? h : path.startsWith("~/") ? h + path.slice(1) : path;
  }

  // The folder typed so far, as a folder and the start of a name in it.
  parts() {
    const t = this.text.trim();
    const i = t.lastIndexOf("/");
    if (i < 0) return null;
    return { dir: this.full(t.slice(0, i) || "/"), start: t.slice(i + 1) };
  }

  look(cx) {
    const p = this.parts();
    if (!p) return;
    const k = `${this.key()}\n${p.dir}`;
    if (k in this.dirs) return;
    this.dirs[k] = undefined;
    const m = this.on;
    cx.spawn(async (cx) => {
      try {
        const names = await sh('cd -- "$1" 2>/dev/null && ls -1pA | grep "/$"', [p.dir], m);
        this.dirs[k] = names ? names.map((n) => n.replace(/\/$/, "")) : null;
      } catch { this.dirs[k] = null; }
      cx.notify();
    });
  }

  // The folders already open on this machine: path -> its space.
  open() {
    const ps = panes();
    const at = new Map();
    for (const s of spaces()) {
      if ((s.machine ?? null) !== this.on || s.tui) continue;
      const f = place(s, ps);
      if (f && !at.has(trim(f))) at.set(trim(f), s);
    }
    return at;
  }

  rows() {
    const open = this.open();
    const p = this.parts();
    if (p) {
      const names = this.dirs[`${this.key()}\n${p.dir}`];
      if (!names) return { rows: [], waiting: names === undefined };
      const start = p.start.toLowerCase();
      const hidden = start.startsWith(".");
      const rows = names.filter((n) => n.toLowerCase().startsWith(start) && (hidden || !n.startsWith(".")))
        .map((n) => trim(`${p.dir}/${n}`.replace(/\/\/+/g, "/")));
      return { rows: rows.slice(0, 50), open };
    }
    const all = [...new Set([...open.keys(), ...this.known[this.key()] ?? []])];
    const words = this.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = all.filter((f) => words.every((w) => this.short(f).toLowerCase().includes(w)))
      .sort((a, b) => (open.has(b) ? 1 : 0) - (open.has(a) ? 1 : 0));
    return { rows: rows.slice(0, 50), open };
  }

  // What Enter opens: the picked row, else the folder typed.
  target() {
    const { rows } = this.rows();
    if (rows[this.at]) return rows[this.at];
    const t = this.text.trim();
    return t ? trim(this.full(t)) : null;
  }

  // A folder that isn't there yet, to make: the path typed when nothing matches it,
  // or a bare name, which goes in ~/Developer. null: it exists, or not known yet.
  fresh() {
    const t = this.text.trim();
    if (!t || this.rows().rows.length) return null;
    const p = this.parts();
    if (!p) return /^[\w.-]+$/.test(t) && this.homes[this.key()] ? `${this.homes[this.key()]}/Developer/${t}` : null;
    const names = this.dirs[`${this.key()}\n${p.dir}`];
    if (names === undefined || !p.start || names?.includes(p.start)) return null;
    return trim(this.full(t));
  }

  complete(cx) {
    const f = this.rows().rows[this.at];
    if (!f) return;
    this.input.set_value(`${this.short(f)}/`);
    this.text = this.input.value();
    this.at = 0;
    this.look(cx);
  }

  machine(m, cx) {
    if (m === this.on) return;
    this.on = m;
    this.at = 0;
    this.dirs = {};
    this.prepare(cx);
    this.look(cx);
  }

  go(claude, cx) {
    const make = this.fresh();
    if (make) return this.create(make, claude, cx);
    const folder = this.target();
    if (!folder) return;
    if (!this.ready(this.on)) { this.error = `${this.on} is away`; cx.notify(); return; }
    const s = this.open().get(folder);
    closeOverlay(props().overlay);
    const argv = claude ? CLAUDE : undefined;
    if (s) run("tab.new", { space: s.id, folder, ...(argv ? { argv } : {}) });
    else run("space.new", { folder, machine: this.key(), ...(argv ? { argv } : {}) });
  }

  // A new project: the folder, a git repo in it, and a space there.
  create(folder, claude, cx) {
    if (!this.ready(this.on)) { this.error = `${this.on} is away`; cx.notify(); return; }
    this.busy = true;
    cx.notify();
    const m = this.on;
    cx.spawn(async (cx) => {
      let error = "";
      try {
        const r = await exec("sh", ["-c", 'mkdir -p -- "$1" && git init -q -- "$1"', "sh", folder], { on: m ?? undefined, timeout: 15000 });
        if (r.code !== 0) error = r.stderr.trim() || "Couldn't make the folder";
      } catch (e) { error = String(e); }
      this.busy = false;
      if (error) { this.error = error; cx.notify(); return; }
      closeOverlay(props().overlay);
      run("space.new", { folder, machine: this.key(m), ...(claude ? { argv: CLAUDE } : {}) });
    });
  }

  chip(m, t) {
    const on = m === this.on;
    const up = this.ready(m);
    return h_flex().id(`open-m-${m ?? "local"}`).h(26).px(10).gap(6).items_center().rounded(7).cursor_pointer()
      .text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.bg(t.selected ?? t.hover)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { this.machine(m, cx); this.input.focus(); cx.notify(); })
      .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13))
      .child(m ?? "This Mac")
      .when(Boolean(m), (el) => el.child(div().size(6).rounded_full().bg(up ? t.done : t.dim)));
  }

  row(f, i, open, t) {
    const shown = this.short(f);
    const name = shown === "~" ? "~" : base(f) || f;
    const parent = shown === "~" ? "" : shown.slice(0, -name.length).replace(/\/$/, "");
    const s = open?.get(f);
    return h_flex().id(`open-r-${i}`).h(30).flex_none().px(10).gap(9).items_center().rounded(7).cursor_pointer()
      .when(i === this.at, (el) => el.bg(t.selected ?? t.hover)).when(i !== this.at, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((e, cx) => { this.at = i; if (e.click_count === 2) this.go(true, cx); else { this.complete(cx); this.input.focus(); } cx.notify(); })
      .child(svg("mods/workspace-chrome/folder.svg").size(13).flex_none().text_color(t.dim))
      .child(div().flex_none().max_w(220).truncate().text_color(t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().font_medium().text_color(t.dim).child(parent))
      .when(Boolean(s), (el) => el.child(div().flex_none().text_size(11).font_medium().text_color(t.dim).child(`in ${s.name}`)));
  }

  render(cx) {
    const t = theme();
    const { rows, open, waiting } = this.rows();
    if (this.at >= rows.length) this.at = Math.max(0, rows.length - 1);
    const cap = (id, label, key, action) => h_flex().id(id).gap(6).items_center().cursor_pointer()
      .text_color(t.muted).hover((s) => s.text_color(t.foreground))
      .on_click(action)
      .child(label)
      .child(div().h(20).px(6).flex().items_center().rounded(6).border_1().border_color(t.input).text_color(t.foreground).child(key));
    const make = this.fresh();
    const note = this.error || (this.busy ? "Making it\u2026" : make ? `New project: ${this.short(make)}, a git repo` : !this.ready(this.on) ? `${this.on} is away right now`
      : waiting ? "Looking…" : rows.length ? "" : this.text.trim() ? "No folders here: Enter opens what's typed" : "Type a folder");
    return v_flex()
      .id("sleeve-open")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") closeOverlay(props().overlay);
        else if (e.key === "tab" && e.modifiers.alt) {
          const i = this.list.indexOf(this.on);
          this.machine(this.list[(i + (e.modifiers.shift ? -1 : 1) + this.list.length) % this.list.length], cx);
        }
        else if (e.key === "tab") this.complete(cx);
        else if (e.key === "down") this.at = Math.min(rows.length - 1, this.at + 1);
        else if (e.key === "up") this.at = Math.max(0, this.at - 1);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .size_full().rounded(12).overflow_hidden().border_1().border_color(t.input).bg(t.popover).shadow_2xl().font_semibold()
      .child(h_flex().h(46).flex_none().px(16).gap(10).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/workspace-chrome/folder.svg").size(16).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(13.5).text_color(t.foreground)))
      .when(this.list.length > 1, (el) => el.child(h_flex().h(42).flex_none().px(12).gap(4).items_center().text_size(12).border_b(1).border_color(t.border)
        .children(this.list.map((m) => this.chip(m, t)))
        .child(div().flex_1())
        .child(div().flex_none().font_medium().text_color(t.dim).child("⌥⇥"))))
      .child(v_flex().id("open-rows").flex_1().min_h(0).overflow_y_scroll().p(6).gap(1).text_size(12.5)
        .children(rows.map((f, i) => this.row(f, i, open, t)))
        .when(Boolean(note), (el) => el.child(div().px(10).py(8).font_medium().text_color(this.error ? t.blocked : t.dim).child(note))))
      .child(h_flex().h(48).flex_none().px(18).gap(18).items_center().justify_end().text_size(12).border_t(1).border_color(t.border)
        .child(cap("open-cancel", "Cancel", "esc", () => closeOverlay(props().overlay)))
        .child(cap("open-term", "Terminal", "⌘↩", (_e, cx) => this.go(false, cx)))
        .child(cap("open-claude", make ? "Create \u00b7 Claude" : "Claude", "↩", (_e, cx) => this.go(true, cx))));
  }
}
