// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { PreviewHover } from "./hover.js";
import { spaces, machines, panes, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout, keys } from "herdr";

const GLYPHS = { cmd: "⌘", shift: "⇧", ctrl: "⌃", alt: "⌥" };
// A control's tooltip: what it does, then its key.
function hint(label, action) {
  const k = keys().find(b => b.action === action && b.section !== "terminal")?.keys;
  return k ? `${label}   ${k.split("-").map(p => GLYPHS[p] ?? p.toUpperCase()).join("")}` : label;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;
const BRANCH = "#2f74d6";

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.previews = new PreviewHover();
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    this.previews.cancel();
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "sleeve-menu", kind: "popup", frame: "none", width: 224, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  // TUI sessions with no space yet, shaped as rows; they sit in the tree by machine and repo.
  sessions() {
    return (shared("tui.places") ?? []).map((p) => ({
      i: -1,
      w: { ...p, tui: true, tabs: [], active: false },
      g: p.repo ? { name: p.repo.name, branch: "", ahead: 0, behind: 0, repo: JSON.stringify([p.machine, p.repo.key]), linked: p.repo.linked } : null,
    }));
  }

  // Spaces in order, each repo's other spaces moved under one parent: the one named
  // after the repo, else its first main checkout. A repo with no main checkout stays flat.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null })).filter((r) => this.shown.has(r.w.id));
    list.push(...this.sessions());
    const parents = new Map();
    for (const r of list) {
      if (!r.g || r.g.linked) continue;
      const best = parents.get(r.g.repo);
      if (!best || (r.w.name === r.g.name && best.w.name !== r.g.name)) parents.set(r.g.repo, r);
    }
    const nested = (r) => r.g && parents.has(r.g.repo) && parents.get(r.g.repo) !== r;
    const out = [];
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (parents.get(r.g?.repo) !== r) continue;
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─", first: n === 0 }));
    }
    return out;
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    this.ps = panes();
    const rows = this.ordered();
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row(r, t));
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.map(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const machine = this.machines.find(k => k.name === m);
      const connected = !m || machine?.state === "connected";
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(30).mt(4).flex_none().rounded_full().when(collapsed, el => el.justify_center()).when(!collapsed, el => el.pl(10).pr(4)).gap(8).items_center().text_size(12).font_bold().text_color(t.muted)
        .cursor_pointer().hover(s => s.text_color(t.foreground))
        .on_hover((on, cx) => { this.hotMachine = on ? m ?? "local" : undefined; cx.notify(); })
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(div().relative().size(20).flex_none()
          .child(image(`mods/sleeve-spaces/icons/app-${m ? "server" : "computer"}.svg`).size(20))
          .when(Boolean(m), el => el.child(div().absolute().right(-2).bottom(-2).size(9).rounded_full().border_2().border_color(t.chrome).bg(connected ? t.done : t.dim))))
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected, el => el.child(div().flex_none().font_semibold().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(this.hotMachine === (m ?? "local"), el => el.child(h_flex().flex_none().gap(2).items_center()
            .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).size(22).flex().items_center().justify_center().rounded_full().hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", m ? { machine: m } : {}); }).child(svg("mods/sleeve-chrome/icons/plus.svg").size(13))))
            .child(div().size(22).flex().items_center().justify_center().child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11))))));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", m ? { machine: m } : {}))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      const lastTop = mine.findLastIndex((r) => !r.tree);
      const body = mine.length ? mine.map((r, n) => draw({ ...r, trunk: { first: n === 0, more: n < lastTop } })) : [loading(m) ? loadingRow(m) : empty];
      if (folded) return [head];
      return collapsed ? [head, ...body] : [head, v_flex().flex_none().ml(20).pl(5).gap(2).children(body)];
    });
  }

  // Only what's unusual, under the name: "herdr \u00b7 spike". The repo or branch
  // goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitLine(g, tree, name) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase().replace(/\//g, "-") === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    return [repo, branch].filter(Boolean).join(" \u00b7 ");
  }

  badge(text, color) {
    return div().flex_none().text_size(11.5).font_bold().text_color(color).child(text);
  }

  // The space's shown tab, beside the sidebar at the pointer's height.
  previewSpace(w, g, cx) {
    this.previews.show(w.id, () => {
      const at = { x: (find(layout(), "sidebar")?.size?.px ?? 268) + 16, y: Math.max(12, (this.previews.mouse?.y ?? 60) - 40) };
      if (w.tui) return { at, props: { command: w.command, title: w.name, icon: this.tile(w, g) } };
      const tab = w.tabs.find((c) => c.active) ?? w.tabs[0];
      const here = panes().filter((p) => p.tab === tab?.id);
      const pane = here.find((p) => p.program?.agent) ?? here.find((p) => p.focused) ?? here[0];
      if (!pane?.terminal) return null;
      return { at, props: { terminal: pane.terminal, title: w.name, icon: this.tile(w, g) } };
    }, cx);
  }

  // A space's tile: the agent running there, else a terminal. A worktree says so with `icon`'s badge.
  tile(w, g) {
    if (w.tui) return w.icon ?? "mods/sleeve-spaces/icons/app-terminal.svg";
    const tabs = new Set(w.tabs.map((c) => c.id));
    const program = this.ps.find((p) => tabs.has(p.tab) && p.program?.agent)?.program;
    if (program?.icon && !program.tint) return program.icon;
    const attached = shared("tui.tabs") ?? {};
    return w.tabs.map((c) => attached[c.id]).find(Boolean) ?? "mods/sleeve-spaces/icons/app-terminal.svg";
  }

  // The tile, with a branch badge on its corner for a worktree. `under` is the row's background,
  // which the badge's ring cuts into the tile with.
  icon(w, g, size, under, t, corner = "right") {
    return div().relative().size(size).flex_none()
      .child(image(this.tile(w, g)).size(size))
      .when(Boolean(g?.linked), (el) => el.child(div().absolute().bottom(-3).when(corner === "right", (b) => b.right(-3)).when(corner !== "right", (b) => b.left(-3))
        .size(13).flex().items_center().justify_center().rounded_full().border_2().border_color(under).bg(BRANCH)
        .child(svg("mods/workspace-chrome/branch.svg").size(7).text_color("#ffffff"))));
  }

  // Tree lines: one weight, each ending at its tile. The trunk runs from the
  // machine's tile to its last space, a nested run from the repo's tile to its last worktree.
  lines(tree, first, trunk, t) {
    const h = rowHeight({ tree }), mid = h / 2;
    const stem = (left, top, bottom) => div().absolute().left(left).top(top).bottom(bottom).w(1.5).bg(t.input);
    const elbow = (left, top, width) => div().absolute().left(left).top(top).w(width).h(mid - top).border_l(1.5).border_b(1.5).rounded_bl(8).border_color(t.input);
    const out = [];
    if (tree) {
      const parent = rowHeight({ tree: null });
      const top = first ? -(parent - 20) / 2 : -2;
      if (trunk?.more) out.push(stem(-29, -2, -2));
      if (tree === "\u251c\u2500") out.push(stem(-5, mid - 4, -2));
      out.push(elbow(-5, top, 8));
    } else if (trunk) {
      if (trunk.more) out.push(stem(-5, mid - 4, -2));
      out.push(elbow(-5, trunk.first ? -4 : -2, 12));
    }
    return out;
  }

  row({ w, i, g, tree, first, trunk }, t) {
    const on = w.active;
    const line = g ? this.gitLine(g, tree, w.name) : "";
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .when(Boolean(tree), (el) => el.ml(24))
      .pl(tree ? 5 : 10)
      .pr(15)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded_full()
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === i && this.over !== i, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(this.pressed < i, line => line.bottom(0))
          .when(this.pressed > i, line => line.top(0)),
      ))
      .on_hover((over, cx) => {
        if (!over) this.previews.leave(w.id, cx);
        else if (!on && this.pressed === null) this.previewSpace(w, g, cx);
      })
      .on_mouse_down("left", () => {
        this.previews.cancel();
        if (w.tui) return setShared("tui.open", w.address);
        this.pressed = i;
        this.over = i;
        run("space.select", { id: w.id });
      })
      .on_mouse_move((e, cx) => {
        this.previews.mouse = e.position;
        const source = spaces()[this.pressed];
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? i : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === i && from !== i) run("space.move", { id: spaces()[from].id, index: i + 1 });
        cx.notify();
      })
      .on_mouse_down("right", () => { if (!w.tui) this.menu(w); })
      .children(this.lines(tree, first, trunk, t))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .child(this.icon(w, g, 20, w.active ? t.selected : t.chrome, t))
          .child(div().flex_shrink(1).min_w(0).max_w(150).truncate().font_bold().text_color(t.foreground).child(w.name))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_semibold().text_right().text_color(t.muted).child(line))
          .when(g?.ahead > 0, (el) => el.child(this.badge(`\u2191${g.ahead}`, t.done)))
          .when(g?.behind > 0, (el) => el.child(this.badge(`\u2193${g.behind}`, t.blocked))),
      );
  }

  compact({ w, g }, t) {
    const live = t[w.status] && w.status !== "idle";
    return h_flex()
      .id(`space-${w.id}`)
      .size(36)
      .flex_none()
      .self_center()
      .items_center()
      .justify_center()
      .rounded_full()
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_mouse_move((e) => { this.previews.mouse = e.position; })
      .on_hover((over, cx) => {
        if (!over) this.previews.leave(w.id, cx);
        else if (!w.active) this.previewSpace(w, g, cx);
      })
      .on_mouse_down("left", () => {
        this.previews.cancel();
        if (w.tui) setShared("tui.open", w.address);
        else run("space.select", { id: w.id });
      })
      .on_mouse_down("right", () => { if (!w.tui) this.menu(w); })
      .child(div().relative().size(22).flex_none()
        .child(this.icon(w, g, 22, w.active ? t.selected : t.chrome, t, "left"))
        .when(Boolean(live), (el) => el.child(div().absolute().right(-2).bottom(-2).size(9).rounded_full().border_2().border_color(t.chrome).bg(t[w.status]))));
  }

  close() {
    this.previews.hide();
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13).font_bold()
      .child(h_flex().h(31).when(!collapsed, el => el.pl(16).pr(10).justify_between()).when(collapsed, el => el.justify_center()).items_center().text_size(12).font_bold().text_color(t.muted)
        .when(!collapsed, el => el.child("Spaces"))
        .child(div().id("space-new").size(28).flex_none().flex().items_center().justify_center().rounded_full().text_color(t.foreground).hover(s => s.bg(t.hover)).tooltip(hint("New space", "space.new"))
          .on_click(() => run("space.new")).child(svg("mods/sleeve-chrome/icons/plus.svg").size(15))))
      .child(v_flex().id("spaces-list").flex_1().min_h(0).px(8).pb(14).gap(2).overflow_y_scroll()
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(this.grouped(t, collapsed)));
  }
}
