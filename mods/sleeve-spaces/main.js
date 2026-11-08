// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout, keys, nextCommand } from "herdr";
import { askClose } from "./ask.js";

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

// The list's edges fade into the sidebar instead of cutting rows off: a few stacked
// strips of the sidebar color, from solid to clear (plain divs, nothing to allocate).
const fade = (color, height, down) => {
  const steps = 6, base = color.slice(0, 7);
  const strips = Array.from({ length: steps }, (_, n) => {
    const a = Math.round(255 * (1 - (n + 0.5) / steps)).toString(16).padStart(2, "0");
    return div().h(height / steps).flex_none().bg(`${base}${a}`);
  });
  return div().absolute().top(0).left(0).right(0).flex().flex_col().children(down ? strips : strips.reverse());
};

const TERMINAL = "mods/sleeve-spaces/icons/app-terminal.svg";

// What a tab shows as: its agent, else its focused pane, else its first.
function lead(tab, ps) {
  const here = ps.filter((p) => p.tab === tab);
  return here.find((p) => p.program?.agent) ?? here.find((p) => p.focused) ?? here[0] ?? null;
}

// A program's icon: agents and other programs keep their own mark; a shell (or nothing
// known) is the sleeve terminal tile, the same size and weight as an agent's.
export function programIcon(program, size, color) {
  const shell = !program || program.shell || program.key === "shell" || !program.icon;
  if (shell) return image(TERMINAL).size(size).flex_none();
  return program.tint ? svg(program.icon).size(size).flex_none().text_color(color) : image(program.icon).size(size).flex_none();
}

// A tab's name: the one given, else what its program set as the title (an agent's
// task), else the program's name.
function tabName(c, pane, program) {
  if (c.named) return c.name;
  let title = (pane?.title ?? "").replace(/^[^\p{L}\p{N}~/.]+/u, "").trim();
  // A shell's default title is user@host:folder; the folder is the useful part.
  if (!program?.agent && /^[^\s@]+@[^\s:]+/.test(title)) title = (pane?.cwd ?? "").split("/").filter(Boolean).pop() ?? "";
  return (/[\p{L}\p{N}]/u.test(title) && title) || program?.name || "Terminal";
}

// A tab's program. A tab attached to the herdr TUI server runs `herdr terminal attach`,
// which the app sees as a plain shell; sleeve-agents publishes which agent is really
// there (shared "tui.tabs"), drawn with the same mark as a native one.
function tabProgram(c, ps) {
  const pane = lead(c.id, ps);
  if (pane?.program?.agent) return pane.program;
  const own = (shared("tui.tabs") ?? {})[c.id];
  if (!own) return pane?.program ?? null;
  const key = own.match(/app-(\w+)\.svg$/)?.[1];
  const native = key && ps.find((p) => p.program?.agent && p.program.key?.startsWith(key))?.program;
  return native ?? { key, name: key === "claude" ? "Claude Code" : key, icon: own, tint: false, agent: true };
}

export default class Spaces extends View {
  init(_props, cx) {
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
    this.spaceFolds = new Set(JSON.parse(localStorage.getItem("spaces.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(1000, (cx) => this.checkNew(cx));
    // cmd-1..9 and ctrl-1..9: a number with nothing there does nothing, where the app's own
    // tab.select and space.select post an error.
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        const [, kind, n] = /^(tab|space)([1-9])$/.exec(command) ?? [];
        const list = kind === "tab" ? (spaces().find(p => p.active)?.tabs ?? []).filter(c => !c.settled) : spaces();
        if (kind && Number(n) <= list.length) run(`${kind}.select`, { index: Number(n) });
      }
    });
  }

  // Also run on every render (live data changed), without a redraw of its own.
  checkNew(cx, redraw = true) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (redraw && sp.some((s) => !this.shown.has(s.id))) cx.notify();
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
    if (window()?.active) {
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
    // A popup is as tall as its items; height is only the most.
    // Whether it's a checkout is known here already, so the menu opens with its final items.
    const key = where(w, panes()), g = this.git[key];
    const git = key in this.git ? (g ? (g.linked ? "linked" : "main") : null) : undefined;
    openOverlay({ mod: "sleeve-menu", kind: "popup", frame: "none", width: 240, height: 260, props: { tab: "space", target: { id: w.id }, git } });
  }

  // TUI sessions with no space yet, shaped as rows; they sit in the tree by machine and repo.
  sessions() {
    return (shared("tui.places") ?? []).map((p) => ({
      i: -1,
      w: { ...p, tui: true, tabs: [], active: false },
      g: p.repo ? { name: p.repo.name, branch: "", ahead: 0, behind: 0, repo: JSON.stringify([p.machine, p.repo.key]), linked: p.repo.linked } : null,
    }));
  }

  // Spaces in order, each repo's worktree spaces moved under one parent: the one named
  // after the repo, else its first main checkout. Spaces on the main checkout itself stay
  // side by side, and a repo with no main checkout stays flat.
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
    const nested = (r) => r.g?.linked && parents.has(r.g.repo);
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
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : this.forest(rows, collapsed, draw, t);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const machine = this.machines.find(k => k.name === m);
      const connected = !m || machine?.state === "connected";
      const folded = this.folded.has(m);
      const first = m === machineNames[0];
      const hot = this.hotMachine === (m ?? "local");
      const head = h_flex().id(`machine-${m ?? "local"}`).h(24).flex_none().when(!first, el => el.mt(14)).when(collapsed, el => el.justify_center()).when(!collapsed, el => el.pl(10).pr(4)).gap(7).items_center()
        .text_size(12).font_bold().text_color(hot ? t.foreground : t.muted)
        .cursor_pointer()
        .on_hover((on, cx) => { this.hotMachine = on ? m ?? "local" : undefined; cx.notify(); })
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(div().relative().size(14).flex_none()
          .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(14))
          .when(Boolean(m), el => el.child(div().absolute().right(-2).bottom(-2).size(7).rounded_full().border_1().border_color(t.chrome).bg(connected ? t.done : t.dim))))
        .when(!collapsed, el => el.child(div().flex_none().child(m ?? "This computer"))
          .when(!connected, el => el.child(div().flex_none().px(6).h(16).flex().items_center().rounded_full().bg(t.raised).text_size(10.5).font_semibold().text_color(t.dim).child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .child(div().flex_1())
          .when(hot, el => el.child(h_flex().flex_none().gap(2).items_center()
            .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).size(22).flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", m ? { machine: m } : {}); }).child(svg("mods/sleeve-chrome/icons/plus.svg").size(15))))
            .child(div().size(22).flex().items_center().justify_center().child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(12)))))
          .when(!hot && folded, el => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(12).flex_none())));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", m ? { machine: m } : {}))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      const body = mine.length ? this.forest(mine, collapsed, draw, t) : [loading(m) ? loadingRow(m) : empty];
      if (folded) return [head];
      return collapsed ? [head, ...body] : [head, v_flex().flex_none().ml(16).when(!connected, el => el.opacity(0.55)).children(body.map((b, n) => this.branch(b, n === body.length - 1, t)))];
    });
  }

  tabsOf(w) {
    if (w.tui) return [];
    return (w.tabs ?? []).filter((c) => !c.settled || c.active);
  }

  // Each space with what hangs under it: its tabs when it has several, then its repo's
  // worktrees. Children sit behind one thin guide line, one step in.
  forest(rows, collapsed, draw, t) {
    if (collapsed) return rows.map(draw);
    const out = [];
    for (let n = 0; n < rows.length; n++) {
      const r = rows[n];
      if (r.tree) continue;
      const kids = [];
      while (rows[n + 1]?.tree) kids.push(rows[++n]);
      out.push(this.block(r, kids, t));
    }
    return out;
  }

  block(r, kids, t) {
    const tabs = this.tabsOf(r.w);
    // A space with anything under it is a folder: its own tabs go inside too, so a
    // click on any folder row folds it and a click on a tab goes there.
    const own = tabs.length > 1 || kids.length > 0 ? tabs : [];
    const parent = own.length > 0 || kids.length > 0;
    const open = !this.spaceFolds.has(r.w.id);
    const children = [...own.map((c) => this.tabRow(r.w, c, t)), ...kids.map((k) => this.block(k, [], t))];
    return v_flex().id(`block-${r.w.id}`).flex_none().gap(1)
      .child(this.row({ ...r, parent, open, single: !own.length && tabs.length === 1 ? tabs[0] : null }, t))
      .when(parent && open, (el) => el.child(v_flex().flex_none().ml(15).children(children.map((c, n) => this.branch(c, n === children.length - 1, t)))));
  }

  // One child under its parent, joined by a guide: a line down from the parent's
  // icon and a rounded elbow into the child's. The last child's line stops at its elbow.
  branch(child, last, t) {
    const line = t.input;
    return div().relative().flex_none().pl(10).pt(1)
      .when(!last, (el) => el.child(div().absolute().left(0).top(0).bottom(0).w(1).bg(line)))
      .child(div().absolute().left(0).top(0).w(14).h(15).border_l(1).border_b(1).border_color(line).rounded_bl(8))
      .child(child);
  }

  fold(id, cx) {
    this.spaceFolds.has(id) ? this.spaceFolds.delete(id) : this.spaceFolds.add(id);
    localStorage.setItem("spaces.folded", JSON.stringify([...this.spaceFolds]));
    cx.notify();
  }

  // What a tab is doing, at a row's end: the close button while hovered.
  state(c, hot, t) {
    return div().id(`tab-close-${c.id}`).size(20).flex_none().flex().items_center().justify_center().rounded(6)
      .when(hot, (el) => el.text_color(t.muted).hover((s) => s.bg(`${t.foreground.slice(0, 7)}1f`).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); askClose("tab", c.id); })
        .child(svg("mods/workspace-chrome/x.svg").size(10)))
      .when(!hot && c.status === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.working).spin(1500)))
      .when(!hot && (c.status === "blocked" || c.status === "done"), (el) => el.child(div().size(6).rounded(3).bg(t[c.status])));
  }

  tabRow(w, c, t) {
    const pane = lead(c.id, this.ps);
    const program = tabProgram(c, this.ps);
    const name = tabName(c, pane, program);
    const on = w.active && c.active;
    const hot = this.hotTab === c.id;
    return h_flex().id(`tab-${c.id}`).pl(8).pr(8).h(28).flex_none().gap(9).items_center().rounded(8)
      .text_size(13).font_semibold().text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_hover((over, cx) => {
        if (over) this.hotTab = c.id;
        else if (this.hotTab === c.id) this.hotTab = null;
        cx.notify();
      })
      .on_mouse_down("left", (e) => {
        if (e.click_count === 2) return run("tab.rename", { id: c.id });
        if (!w.active) run("space.select", { id: w.id });
        if (!c.active) run("tab.select", { id: c.id });
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "sleeve-menu", kind: "popup", frame: "none", width: 240, props: { tab: "tab", target: { id: c.id, space: w.id } } });
      })
      .child(div().size(16).flex_none().flex().items_center().justify_center().child(programIcon(program, 16, on ? t.foreground : t.muted)))
      .child(div().flex_1().min_w(0).truncate().child(c.zoomed ? `${name} · zoomed` : name))
      .child(this.state(c, hot, t));
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

  // A space's program: the agent in its shown tab, else any of its agents, else what
  // its shown tab runs. A TUI session or a tab attached to one brings its own icon.
  program(w) {
    if (w.tui) return w.icon ? { icon: w.icon, tint: false, agent: true } : null;
    const shownTab = w.tabs.find((c) => c.active) ?? w.tabs[0];
    const all = [shownTab, ...w.tabs].filter(Boolean).map((c) => tabProgram(c, this.ps));
    return all.find((p) => p?.agent) ?? all[0] ?? null;
  }

  // The tile, with a branch badge on its corner for a worktree. `under` is the row's background,
  // which the badge's ring cuts into the tile with.
  icon(w, g, size, under, t, corner = "right") {
    return div().relative().size(size).flex_none()
      .child(programIcon(this.program(w), size, theme().foreground))
      .when(Boolean(g?.linked), (el) => el.child(div().absolute().bottom(-3).when(corner === "right", (b) => b.right(-3)).when(corner !== "right", (b) => b.left(-3))
        .size(13).flex().items_center().justify_center().rounded_full().border_2().border_color(under).bg(BRANCH)
        .child(svg("mods/workspace-chrome/branch.svg").size(7).text_color("#ffffff"))));
  }

  // A space: a fold chevron when things hang under it, else its one tab's program.
  // On the right only what's unusual about its git, and its tab's state.
  row({ w, i, g, tree, parent, open, single }, t) {
    const line = g ? this.gitLine(g, tree, w.name) : "";
    const lists = parent && !w.tui;
    const on = w.active && !lists;
    const hot = single && this.hotTab === single.id;
    const program = w.tui ? this.program(w) : single ? tabProgram(single, this.ps) : null;
    const slot = parent
      ? div().id(`fold-${w.id}`).size(16).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim)
        .hover((s) => s.text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.fold(w.id, cx); })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(12))
      : div().size(16).flex_none().flex().items_center().justify_center()
        .child(programIcon(program, 16, on ? t.foreground : t.muted));
    return h_flex()
      .id(`space-${w.id}`)
      .relative()
      .pl(8)
      .pr(8)
      .h(28)
      .flex_none()
      .gap(9)
      .items_center()
      .rounded(8)
      .text_size(13)
      .font_bold()
      .text_color(t.foreground)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === i && this.over !== i, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(this.pressed < i, line => line.bottom(0))
          .when(this.pressed > i, line => line.top(0)),
      ))
      .when(Boolean(single), (el) => el.on_hover((over, cx) => {
        if (over) this.hotTab = single.id;
        else if (this.hotTab === single.id) this.hotTab = null;
        cx.notify();
      }))
      .on_mouse_down("left", (e) => {
        if (w.tui) return setShared("tui.open", w.address);
        if (e.click_count === 2 && single) return run("tab.rename", { id: single.id });
        this.pressed = i;
        this.over = i;
        // A space that lists its tabs is a folder: its tabs are where you go.
        if (!lists) run("space.select", { id: w.id });
      })
      .on_mouse_move((_e, cx) => {
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
        else if (from === i && lists) return this.fold(w.id, cx);
        cx.notify();
      })
      .on_mouse_down("right", () => { if (!w.tui) this.menu(w); })
      .child(slot)
      .child(div().flex_shrink(1).min_w(0).truncate().child(w.name))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().pl(6).justify_end().gap(4).items_center().text_size(11.5).font_semibold().text_color(t.dim)
        .when(Boolean(line), (el) => el.child(h_flex().min_w(0).overflow_hidden().gap(4).items_center()
          .when(Boolean(g?.linked), (el) => el.child(svg("mods/workspace-chrome/git-branch.svg").size(11).flex_none()))
          .child(div().min_w(0).truncate().child(line)))))
      .when(g?.ahead > 0, (el) => el.child(this.badge(`\u2191${g.ahead}`, t.done)))
      .when(g?.behind > 0, (el) => el.child(this.badge(`\u2193${g.behind}`, t.blocked)))
      .when(Boolean(single), (el) => el.child(this.state(single, hot, t)));
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
      .on_mouse_down("left", () => {
        if (w.tui) setShared("tui.open", w.address);
        else run("space.select", { id: w.id });
      })
      .on_mouse_down("right", () => { if (!w.tui) this.menu(w); })
      .child(div().relative().size(22).flex_none()
        .child(this.icon(w, g, 22, w.active ? t.selected : t.chrome, t, "left"))
        .when(Boolean(live), (el) => el.child(div().absolute().right(-2).bottom(-2).size(9).rounded_full().border_2().border_color(t.chrome).bg(t[w.status]))));
  }

  render(cx) {
    const t = theme();
    const collapsed = narrow();
    this.checkNew(cx, false);
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
      .child(div().relative().flex_1().min_h(0)
        .child(v_flex().id("spaces-list").size_full().px(8).pt(6).pb(24).gap(2).overflow_y_scroll()
          .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
          .children(this.grouped(t, collapsed)))
        .child(div().absolute().top(0).left(0).right(0).h(14).child(fade(t.chrome, 14, true)))
        .child(div().absolute().bottom(0).left(0).right(0).h(28).child(fade(t.chrome, 28, false))));
  }
}
