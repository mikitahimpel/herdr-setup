// Workspace spaces as a tree: machine, repo, space, tab (tree.js decides what goes where,
// git.js what git says about each space). After a space's name only what's unusual:
// repo, branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, the chevron folds, right-click for its menu, drag to reorder.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Popup } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, hc, theme, shared, setShared, layout, keys, nextCommand, home, terminals } from "herdr";
import { askClose, askRename } from "./ask.js";
import { GitFacts, lead, place } from "./git.js";
import { Card } from "./card.js";
import { HoverCard } from "./hover.js";
import { buildTree, spacesIn } from "./tree.js";

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

// The least room dim text on a row's right is shown in.
const MIN_SIDE = 60;

// Every row's height: what lets folding() know a block's height ahead.
const ROW = 28;

// How far in each level of the tree sits (under(): margin and guide).
const STEP = 25;

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
  const steps = Math.max(6, Math.round(height / 2)), base = color.slice(0, 7);
  const strips = Array.from({ length: steps }, (_, n) => {
    const a = Math.round(255 * (1 - (n + 0.5) / steps)).toString(16).padStart(2, "0");
    return div().h(height / steps).flex_none().bg(`${base}${a}`);
  });
  return div().absolute().top(0).left(0).right(0).flex().flex_col().children(down ? strips : strips.reverse());
};

const TERMINAL = "mods/sleeve-spaces/icons/app-terminal.svg";

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
    this.git = new GitFacts();
    this.card = new HoverCard();
    this.cardView = new Card(home());
    // The keyboard in the list (pane.go here, or cmd-shift-e): `cursor` is the row it's on,
    // `nav` the rows it can reach, in order, rebuilt on every render.
    this.handle = cx.focus_handle();
    this.keyboard = false;
    this.cursor = null;
    this.nav = [];
    // The list's own scrolling (see render): how far down, and its content and view heights.
    this.top = 0;
    this.contentH = 0;
    this.viewH = 0;
    this.places = null;
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
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") { this.focus(cx); cx.notify(); continue; }
        // F2 / Shift-F2 (keys.json): rename the shown tab or space in sleeve-prompt.
        const active = spaces().find(p => p.active);
        if (command === "rename-tab") { const tab = active?.tabs.find(c => c.active); if (tab) askRename("tab", tab.id); continue; }
        if (command === "rename-space") { if (active) askRename("space", active.id); continue; }
        const [, kind, n] = /^(tab|space)([1-9])$/.exec(command) ?? [];
        const list = kind === "tab" ? (spaces().find(p => p.active)?.tabs ?? []).filter(c => !c.settled) : spaces();
        if (kind && Number(n) <= list.length) run(`${kind}.select`, { index: Number(n) });
      }
    });
  }

  // A wheel or trackpad turn: the list moves by it, within its ends.
  scroll(e, cx) {
    if (!this.keyboard) this.card.close(cx);
    const top = Math.max(0, Math.min(this.top - e.delta.y, this.contentH - this.viewH));
    if (top === this.top) return;
    this.top = top;
    cx.notify();
  }

  // Scrolls row `id` into view, clear of the headers that would stay over it.
  reveal(id) {
    const r = this.places?.rows.get(id);
    if (!r) return;
    let over = 0;
    for (let u = r.up; u; u = u.up) over += u.h;
    if (r.y - over < this.top) this.top = Math.max(0, r.y - over - 6);
    else if (r.y + ROW > this.top + this.viewH - 24) this.top = r.y + ROW - this.viewH + 24;
  }

  async close() {
    this.card.close();
  }

  // Also run on every render (live data changed), without a redraw of its own.
  checkNew(cx, redraw = true) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    this.git.update(now, sp, panes(), this.folded, cx);
    // Focus left the list (a click in a terminal): its cursor goes.
    if (this.keyboard && !this.handle.is_focused()) { this.keyboard = false; this.card.close(); return cx.notify(); }
    if (redraw && sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    // Whether it's a checkout is known here already, so the menu opens with its final items.
    const ps = panes(), g = this.git.of(w, ps);
    const git = this.git.known(w, ps) ? (g ? (g.linked ? "linked" : "main") : null) : undefined;
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

  // The spaces with their git, in order. Spaces made while this runs wait (at most a
  // moment) for their git, so a worktree appears in its repo instead of jumping there.
  rows() {
    const sp = spaces(), ps = this.ps;
    const ready = (w) => this.shown.has(w.id) || this.git.known(w, ps) || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const tabG = (w) => Object.fromEntries((w.tabs ?? []).map((c) => [c.id, this.git.ofTab(w, c, ps)]).filter(([, g]) => g !== undefined));
    // Every live terminal an agent started (hc run) without a pane of its own, under the
    // tab whose terminal started it: sub-agents and the programs they run.
    const all = terminals().filter((k) => k.state === "live");
    const paned = new Set(ps.map((p) => p.terminal).filter(Boolean));
    const kids = (addr, depth) => all.filter((k) => k.parent === addr && !paned.has(k.address))
      .flatMap((k) => [{ k, depth }, ...kids(k.address, depth + 1)]);
    const subs = (w) => Object.fromEntries((w.tabs ?? []).map((c) => [c.id, ps.filter((p) => p.tab === c.id && p.terminal).flatMap((p) => kids(p.terminal, 0))]));
    const list = sp.map((w, i) => ({ w, i, g: this.git.of(w, ps) ?? null, tabG: tabG(w), subs: subs(w) })).filter((r) => this.shown.has(r.w.id));
    return [...list, ...this.sessions()];
  }

  // The tree, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    this.ps = panes();
    this.nav = [];
    const rows = this.rows();
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name)])].sort();
    const tree = buildTree(rows, remote);
    // Machine headers are labels over their spaces, not a level: rows start at the edge.
    this.indent = 0;
    const draw = (nodes) => (collapsed ? spacesIn(nodes).map((n) => this.compact(n, t)) : nodes.map((n) => this.node(n, t, this.indent)));
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    // Where every row is, for the headers that stay on top while scrolling and for
    // the keyboard: a machine without spaces shows one row (loading, or a new space).
    this.places = collapsed ? null : this.place(tree, remote, (m) => (loading(m) || !m || this.machines.find((k) => k.name === m)?.state === "connected" ? 1 : 0));
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : draw(tree[0].nodes);
    return tree.flatMap(({ machine: m, nodes }, n) => {
      const machine = this.machines.find(k => k.name === m);
      const connected = !m || machine?.state === "connected";
      const folded = this.folded.has(m);
      const head = this.machineHead(m, t, collapsed).when(n > 0, el => el.mt(14));
      if (folded) return [head];
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", m ? { machine: m } : {}))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      // A machine away takes no new space: its header already says so.
      const body = nodes.length ? draw(nodes) : loading(m) ? [loadingRow(m)] : connected ? [empty] : [];
      return collapsed ? [head, ...body] : [head, v_flex().flex_none().gap(2).when(!connected, el => el.opacity(0.55)).children(body)];
    });
  }

  // Every row's top in the list's content, and the headers that can stay on top (a
  // machine's, an open repo's, space's or branch's) with where their block ends. Worked
  // out, not measured: rows are ROW tall and the gaps are fixed, as drawn by grouped(),
  // folding(), branch() and branchBlock(). A fold's slide isn't followed: during it the
  // headers may sit up to its height off.
  // `alone(m)`: how many rows machine `m` shows without spaces (0 or 1).
  place(tree, remote, alone) {
    const rows = new Map(), heads = [];
    const GAP = 2; // between the list's rows
    // A node at `y`, `x` in; returns its height.
    const at = (n, y, x, up) => {
      if (n.kind === "tab" || n.kind === "sub") { rows.set(n.id, { y, up }); return ROW; }
      const id = n.kind === "repo" ? `repo:${n.id}` : n.id;
      if (n.kind !== "section") rows.set(id, { y, up });
      const open = n.kind === "section" || (n.kind === "repo" ? !this.spaceFolds.has(id) : n.children.length > 0 && !this.spaceFolds.has(n.id));
      if (!open) return ROW;
      const head = { n, y, x, h: ROW, up, end: 0 };
      heads.push(head);
      // Each child: a guide's 1 px over it, after the fold's (or the branch's gap) 1 px.
      let h = ROW + 1;
      for (const c of n.children) h += 1 + at(c, y + h + 1, x + STEP, head);
      head.end = y + h;
      return h;
    };
    const list = (nodes, y, up) => nodes.reduce((h, n, k) => h + (k ? GAP : 0) + at(n, y + h + (k ? GAP : 0), 0, up), 0);
    let y = 6; // the list's top padding
    if (!remote.length) return { rows, heads, end: y + list(tree[0].nodes, y, null) };
    tree.forEach(({ machine: m, nodes }, k) => {
      if (k) y += 14;
      const head = { machine: m, y, x: 0, h: 24, up: null, end: 0 };
      y += 24 + GAP;
      if (this.folded.has(m)) return;
      // Before its spaces' headers: stuck() takes a header only after the one it's under.
      if (nodes.length) heads.push(head);
      const body = nodes.length ? list(nodes, y, head) : alone(m) * ROW;
      head.end = y + body;
      y += body + GAP;
    });
    return { rows, heads, end: y };
  }

  // The headers that stay on top at scroll `top`: each whose row has gone above the ones
  // over it, until its block ends, then pushed up with it. [{ head, at }], `at` in the
  // view. At most MAX deep, so a deep tree still leaves room for the list.
  stuck(top) {
    if (!this.places || top <= 0) return [];
    const MAX = 4;
    const out = [], under = new Map(); // head -> the bottom of its stuck row in the view
    for (const head of this.places.heads) {
      const over = head.up ? under.get(head.up) : 0;
      if (over === undefined || out.length >= MAX) continue;
      if (head.y - top >= over || head.end - top <= over) continue;
      const at = Math.min(over, head.end - top - head.h);
      out.push({ head, at });
      under.set(head, at + head.h);
    }
    return out;
  }

  // A stuck header: a copy of its row, on the list's color, without its guides.
  stuckRow({ head, at }, t, collapsed) {
    const n = head.n;
    const row = head.machine !== undefined ? this.machineHead(head.machine, t, collapsed)
      : n.kind === "repo" ? this.repoHead(n, t)
      : n.kind === "section" ? this.branchHead(n, t)
      : this.row({ ...n, parent: true, open: true, x: head.x, sectioned: n.children[0]?.kind === "section" }, t);
    return div().absolute().top(at).left(0).right(0).h(head.h).px(8).bg(t.chrome)
      .child(div().pl(head.x).child(row));
  }

  // A machine's header: its name and state, and on hover a new space there and the fold.
  machineHead(m, t, collapsed) {
      const machine = this.machines.find(k => k.name === m);
      const connected = !m || machine?.state === "connected";
      const folded = this.folded.has(m);
      const hot = this.hotMachine === (m ?? "local");
      const head = h_flex().id(`machine-${m ?? "local"}`).h(24).flex_none().when(collapsed, el => el.justify_center()).when(!collapsed, el => el.pl(10).pr(4)).gap(7).items_center()
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
    return head;
  }

  // `x`: how far in from the list's edge the node's rows start.
  node(n, t, x) {
    return n.kind === "repo" ? this.repoBlock(n, t, x) : this.spaceBlock(n, t, x);
  }

  // Children one step in, each joined to the row above by a guide.
  under(children, t) {
    return v_flex().flex_none().ml(15).children(children.map((c, n) => this.branch(c, n === children.length - 1, t)));
  }

  // What folds under a row: its children, kept drawn while folded so the box can slide
  // between their height and nothing. `height`: theirs open (heightOf), known ahead
  // because every row is ROW tall.
  folding(children, height, open, t) {
    return div().flex_none().overflow_hidden()
      .h(open ? 1 + height : 0).opacity(open ? 1 : 0)
      .transition("height", { duration: 180, easing: "ease-out" })
      .transition("opacity", { duration: 140, easing: "ease-out" })
      .child(div().pt(1).child(this.under(children, t)));
  }

  // How tall the children a node lists are when shown, in px: each child is a guide's
  // 1 px over its own height; a row is ROW, and an open block adds 1 px and its children.
  heightOf(n) {
    const under = (list) => list.reduce((h, c) => h + 1 + c, 0);
    const block = (k) => {
      if (k.kind === "tab" || k.kind === "sub") return ROW;
      if (k.kind === "section") return ROW + 1 + under(k.children.map(block));
      const open = k.kind === "repo" ? !this.spaceFolds.has(`repo:${k.id}`) : k.children.length > 0 && !this.spaceFolds.has(k.id);
      return ROW + (open ? 1 + this.heightOf(k) : 0);
    };
    return under(n.children.map(block));
  }

  // A line down from the parent's icon and a rounded elbow into the child's.
  // The last child's line stops at its elbow.
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
    cx?.notify();
  }

  chevron(id, open, t) {
    return div().id(`fold-${id}`).size(16).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim)
      .hover((s) => s.text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.fold(id, cx); })
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(12));
  }

  // A repo with several spaces in it: a header that folds them, and a new worktree there.
  repoBlock(n, t, x, shown = true) {
    const key = `repo:${n.id}`;
    const open = !this.spaceFolds.has(key);
    if (shown) this.nav.push({ id: key, fold: key, open, go: () => this.fold(key) });
    return v_flex().id(`block-${key}`).flex_none()
      .child(this.repoHead(n, t))
      .child(this.folding(n.children.map((c) => this.spaceBlock(c, t, x + STEP, shown && open, key)), this.heightOf(n), open, t));
  }

  repoHead(n, t) {
    const key = `repo:${n.id}`;
    const open = !this.spaceFolds.has(key);
    const hot = this.hotRepo === n.id;
    const from = n.children.find((c) => !c.w.tui && !c.g?.linked) ?? n.children.find((c) => !c.w.tui);
    const head = h_flex().id(`repo-${n.id}`).relative().pl(8).pr(4).h(28).flex_none().gap(9).items_center().rounded(8)
      .text_size(13).font_bold().text_color(hot ? t.foreground : t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_hover((over, cx) => {
        if (over) this.hotRepo = n.id;
        else if (this.hotRepo === n.id) this.hotRepo = null;
        cx.notify();
      })
      .on_click((_e, cx) => this.fold(key, cx))
      .child(this.chevron(key, open, t))
      .child(div().flex_1().min_w(0).truncate().child(n.name))
      .when(!open && !hot, (el) => el.child(div().flex_none().pr(4).text_size(11.5).text_color(t.dim).child(String(n.children.length))))
      .when(hot && Boolean(from), (el) => el.child(div().id(`repo-add-${n.id}`).size(22).flex_none().flex().items_center().justify_center().rounded(6)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          cx.stop_propagation();
          openOverlay({ mod: "sleeve-worktree", kind: "dialog", frame: "none", width: 460, height: 158, props: { space: from.id, action: "new" } });
        })
        .child(svg("mods/sleeve-chrome/icons/plus.svg").size(15))))
      .child(this.ring(key, t));
    return head;
  }

  // A space, and its tabs under it when it has several. When they work on different
  // branches, the branches are a level of their own: each with its tabs under it.
  // `shown`: not inside something folded (only shown rows take the keyboard);
  // `up`: the nav id of the row it hangs under.
  spaceBlock(n, t, x, shown = true, up = null) {
    const parent = n.children.length > 0;
    const open = parent && !this.spaceFolds.has(n.id);
    if (shown) this.nav.push({ id: n.id, up, fold: parent ? n.id : null, open, card: () => this.spaceCard(n.w, n.g, n.single), go: () => this.goSpace(n.w, n.single) });
    const row = this.row({ ...n, parent, open, x, sectioned: n.children[0]?.kind === "section" }, t);
    const inner = shown && open;
    const kids = n.children.map((c) => (c.kind === "section" ? this.branchBlock(c, t, inner, n.id) : c.kind === "sub" ? this.subRow(c, t, inner, n.id) : this.tabRow(c.w, c.c, t, inner, n.id)));
    return v_flex().id(`block-${n.id}`).flex_none()
      .child(row)
      .when(parent, (el) => el.child(this.folding(kids, this.heightOf(n), open, t)));
  }

  goSpace(w, single) {
    if (w.tui) return setShared("tui.open", w.address);
    if (!w.active) run("space.select", { id: w.id });
    if (single && !single.active) run("tab.select", { id: single.id });
  }

  // The keyboard cursor: a hairline around the row it's on, while the list has the keyboard.
  ring(id, t) {
    return div().absolute().inset_0().rounded(8).when(this.keyboard && this.cursor === id, (el) => el.border_1().border_color(t.muted));
  }

  // The hover card beside row `id`, when it's that row's: a Popup pinned 10 px right of
  // the row, 8 above its top, moved up as needed to stay inside the window.
  cardAt(id, t) {
    const props = this.stuckDrawing ? null : this.card.at(id);
    // Out of the row's flow either way: a child in it would take a gap at the row's end.
    if (!props) return div().absolute();
    return div().absolute().top(-8).right(-10).size(0)
      .child(Popup.new(`card-${id}`, div().size(0)).anchor("top_left")
        .content(this.cardView.render(props, t, (cx) => this.card.close(cx))));
  }

  // The card of the keyboard's row, at once.
  peek(cx) {
    const row = this.nav.find((r) => r.id === this.cursor);
    if (row?.card) this.card.over(row.id, row.card, cx, true);
    else this.card.close(cx);
  }

  focus(cx) {
    this.keyboard = true;
    const active = spaces().find((s) => s.active);
    const tab = active?.tabs.find((c) => c.active);
    if (!this.nav.some((r) => r.id === this.cursor)) this.cursor = this.nav.some((r) => r.id === tab?.id) ? tab.id : active?.id ?? this.nav[0]?.id ?? null;
    this.handle.focus();
    this.reveal(this.cursor);
    this.peek(cx);
  }

  // Up and down move; right opens what's folded, else steps into its first child;
  // left folds what's open, else steps out to its parent; Enter goes there and back to
  // the terminal; Esc goes back without moving.
  key(e, cx) {
    const at = this.nav.findIndex((r) => r.id === this.cursor);
    const row = this.nav[at];
    const leave = () => { this.keyboard = false; this.card.close(cx); run("pane.go", { direction: "right" }); };
    if (e.key === "escape") leave();
    else if (e.key === "down" || e.key === "up") {
      const next = this.nav[Math.max(0, Math.min(this.nav.length - 1, at + (e.key === "down" ? 1 : -1)))];
      if (next) this.cursor = next.id;
    } else if (e.key === "right" && row) {
      if (row.fold && !row.open) this.fold(row.fold);
      else if (this.nav[at + 1]?.up === row.id) this.cursor = this.nav[at + 1].id;
    } else if (e.key === "left" && row) {
      if (row.fold && row.open) this.fold(row.fold);
      else if (row.up) this.cursor = row.up;
    } else if (e.key === "enter" && row) {
      row.go();
      // A repo isn't a place: Enter only folds it, and the keyboard stays.
      if (!row.id.startsWith("repo:")) leave();
    } else return;
    if (this.keyboard && this.cursor !== row?.id) { this.reveal(this.cursor); this.peek(cx); }
    cx.stop_propagation();
    cx.notify();
  }

  // A branch the space's tabs work on: a row like the others, its icon the branch's,
  // its name muted (it isn't something to go to), ahead/behind on the right. A label:
  // no hover, no card.
  branchBlock(c, t, shown = true, up = null) {
    return v_flex().flex_none().gap(1)
      .child(this.branchHead(c, t))
      .child(this.under(c.children.map((k) => (k.kind === "sub" ? this.subRow(k, t, shown, up) : this.tabRow(k.w, k.c, t, shown, up))), t));
  }

  branchHead(c, t) {
    const g = c.g;
    const head = h_flex().id(`section-${c.id}`).pl(8).pr(8).h(28).flex_none().gap(9).items_center()
      .text_size(13).font_semibold().text_color(t.muted)
      .child(div().size(16).flex_none().flex().items_center().justify_center().child(svg("mods/workspace-chrome/git-branch.svg").size(14).text_color(t.dim)))
      .child(div().flex_1().min_w(0).truncate().child(g ? g.branch ?? "detached" : "not in a repo"))
      .when(g?.ahead > 0, (el) => el.child(this.badge(`\u2191${g.ahead}`, t.done)))
      .when(g?.behind > 0, (el) => el.child(this.badge(`\u2193${g.behind}`, t.blocked)));
    return head;
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

  // A tab: its program, name and state.
  tabRow(w, c, t, shown = true, up = null) {
    if (shown) this.nav.push({ id: c.id, up, fold: null, card: () => this.tabCard(w, c), go: () => { if (!w.active) run("space.select", { id: w.id }); if (!c.active) run("tab.select", { id: c.id }); } });
    const pane = lead(c.id, this.ps);
    const program = tabProgram(c, this.ps);
    const name = tabName(c, pane, program);
    const on = w.active && c.active;
    const hot = this.hotTab === c.id;
    return h_flex().id(`tab-${c.id}`).relative().pl(8).pr(8).h(28).flex_none().gap(9).items_center().rounded(8)
      .text_size(13).font_semibold().text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_hover((over, cx) => {
        if (over) this.hotTab = c.id;
        else if (this.hotTab === c.id) this.hotTab = null;
        if (over) this.card.over(c.id, () => this.tabCard(w, c), cx);
        else this.card.out(c.id, cx);
        cx.notify();
      })
      .on_mouse_down("left", (e, cx) => {
        this.card.close(cx);
        if (e.click_count === 2) return askRename("tab", c.id);
        if (!w.active) run("space.select", { id: w.id });
        if (!c.active) run("tab.select", { id: c.id });
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "sleeve-menu", kind: "popup", frame: "none", width: 240, props: { tab: "tab", target: { id: c.id, space: w.id } } });
      })
      .child(div().size(16).flex_none().flex().items_center().justify_center().child(programIcon(program, 16, on ? t.foreground : t.muted)))
      .child(div().flex_1().min_w(0).truncate().child(c.zoomed ? `${name} · zoomed` : name))
      .child(this.state(c, hot, t))
      .child(this.ring(c.id, t))
      .child(this.cardAt(c.id, t));
  }

  // A sub-agent an agent started (hc run), with no pane: a tab's type, muted, stepped in
  // under the tab that started it (by a margin, so the highlight starts where the row
  // does; the tab's guide runs on to it). A click peeks at it over the tab; from there
  // it can be kept as a tab.
  subRow(n, t, shown = true, up = null) {
    const k = n.k;
    const step = 22 + 14 * n.depth;
    const peek = () => run("terminal.peek", { terminal: k.address });
    if (shown) this.nav.push({ id: n.id, up, fold: null, go: peek });
    const st = k.status === "error" ? "blocked" : k.status;
    const name = k.name || k.template || k.program?.name || "agent";
    return h_flex().id(n.id).relative().ml(step).pl(8).pr(8).h(28).flex_none().gap(9).items_center().rounded(8)
      .text_size(13).font_semibold().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => { this.card.close(cx); peek(); })
      .child(div().absolute().left(-step).top(13).w(step - 4).h(1).bg(t.input))
      .child(div().size(16).flex_none().flex().items_center().justify_center().child(programIcon(k.program, 16, t.muted)))
      .child(div().flex_1().min_w(0).truncate().child(name))
      .child(div().size(20).flex_none().flex().items_center().justify_center()
        .when(st === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.working).spin(1500)))
        .when(st === "blocked" || st === "done", (el) => el.child(div().size(6).rounded(3).bg(t[st]))))
      .child(this.ring(n.id, t));
  }

  // What the hover card shows (card.js): the whole name, the agent's state and
  // since when, what it's doing, and where it works.
  tabCard(w, c) {
    const ps = panes();
    const pane = lead(c.id, ps);
    const program = tabProgram(c, ps);
    const name = tabName(c, pane, program);
    const g = this.git.ofTab(w, c, ps) ?? null;
    const title = (pane?.title ?? "").replace(/^[^\p{L}\p{N}~/.]+/u, "").trim();
    return {
      title: name,
      icon: { program },
      status: c.status,
      since: c.status === "working" ? c.working_since : c.changed_at,
      doing: program?.agent && title && title !== name ? title : null,
      git: g,
      folder: g?.top ?? pane?.cwd ?? null,
      machine: w.machine,
    };
  }

  spaceCard(w, g, single) {
    if (single) return { ...this.tabCard(w, single), title: w.name };
    if (w.tui) return { title: w.name, icon: { program: this.program(w) }, git: g, folder: g?.top ?? w.folder ?? null, machine: w.machine };
    const shown = w.tabs.find((c) => c.active);
    return {
      title: w.name,
      icon: { program: this.program(w) },
      status: w.status,
      since: w.status === "working" ? shown?.working_since : shown?.changed_at,
      git: g,
      folder: g?.top ?? place(w, panes()) ?? null,
      machine: w.machine,
    };
  }

  // Only what's unusual, under the name: "herdr \u00b7 spike". The repo or branch
  // goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitLine(g, inRepo, name, noBranch = false) {
    if (noBranch) return inRepo || g.name.toLowerCase() === name.toLowerCase() ? "" : g.name;
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase().replace(/\//g, "-") === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = inRepo || same(g.name) ? "" : g.name;
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

  // Whether dim text on the right has room beside `name` in a row `x` in from the list's
  // edge, with the badges `ab` and a state slot (`state`) after it. The name keeps its
  // width; the text takes what's left, cut at its end, and goes when that's under
  // MIN_SIDE (a few letters and "…" say nothing). Widths are estimates of the fonts.
  fits(x, name, side, ab = [], state = true, icon = false) {
    if (!this.width) return false;
    const room = this.width - 16 - x - 16 - 16 - 9 - (state ? 29 : 0) - ab.reduce((n, b) => n + b.length * 7 + 9, 0);
    return name.length * 6.4 + 6 + 9 + Math.min(side.length * 6.3, MIN_SIDE) + (icon ? 15 : 0) <= room;
  }

  // A space's name in its repo's group: one nobody named is called after the repo,
  // which the header already says, so there it goes by its branch.
  title(w, g, inRepo) {
    return inRepo && g && !w.named && w.name.toLowerCase() === g.name.toLowerCase() ? (g.branch ?? "detached") : w.name;
  }

  // A space's row: a fold chevron when its tabs hang under it, else its one tab's
  // program. On the right only what's unusual about its git, and its tab's state.
  // A click always goes to the space; only the chevron folds.
  row({ w, i, g, inRepo, parent, open, single, x, sectioned }, t) {
    const name = this.title(w, g, inRepo);
    const ab = sectioned ? [] : [g?.ahead > 0 && `\u2191${g.ahead}`, g?.behind > 0 && `\u2193${g.behind}`].filter(Boolean);
    // Sectioned, its tabs' sections say the branches.
    const full = g ? this.gitLine(g, inRepo, name, sectioned) : "";
    const line = full && this.fits(x, name, full, ab, Boolean(single), g.linked) ? full : "";
    // With its tabs listed, the shown tab carries the highlight.
    const on = w.active && !open;
    const hot = single && this.hotTab === single.id;
    const program = w.tui ? this.program(w) : single ? tabProgram(single, this.ps) : null;
    const slot = parent
      ? this.chevron(w.id, open, t)
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
      .on_hover((over, cx) => {
        if (single) {
          if (over) this.hotTab = single.id;
          else if (this.hotTab === single.id) this.hotTab = null;
        }
        if (over && this.pressed === null) this.card.over(w.id, () => this.spaceCard(w, g, single), cx);
        else this.card.out(w.id, cx);
        cx.notify();
      })
      .on_mouse_down("left", (e, cx) => {
        this.card.close(cx);
        if (w.tui) return setShared("tui.open", w.address);
        if (e.click_count === 2 && single) return askRename("tab", single.id);
        this.pressed = i;
        this.over = i;
        if (!w.active) run("space.select", { id: w.id });
      })
      .on_mouse_move((e, cx) => {
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
      .child(slot)
      // Beside a branch the name keeps its width (fits() made room); alone it truncates.
      .child(line ? div().flex_none().child(name) : div().flex_shrink(1).min_w(0).truncate().child(name))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().pl(6).justify_end().gap(4).items_center().text_size(11.5).font_semibold().text_color(t.dim)
        .when(Boolean(line), (el) => el.child(h_flex().min_w(0).overflow_hidden().gap(4).items_center()
          .when(Boolean(g?.linked), (el) => el.child(svg("mods/workspace-chrome/git-branch.svg").size(11).flex_none()))
          .child(div().min_w(0).truncate().child(line)))))
      .when(!sectioned && g?.ahead > 0, (el) => el.child(this.badge(`\u2191${g.ahead}`, t.done)))
      .when(!sectioned && g?.behind > 0, (el) => el.child(this.badge(`\u2193${g.behind}`, t.blocked)))
      .when(Boolean(single), (el) => el.child(this.state(single, hot, t)))
      .child(this.ring(w.id, t))
      .child(this.cardAt(w.id, t));
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
    const rows = this.grouped(t, collapsed);
    this.top = Math.max(0, Math.min(this.top, this.contentH - this.viewH));
    this.stuckDrawing = true;
    const stuck = this.stuck(this.top);
    const pinned = stuck.map((s) => this.stuckRow(s, t, collapsed));
    this.stuckDrawing = false;
    const below = stuck.reduce((b, s) => Math.max(b, s.at + s.head.h), 0);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13).font_bold()
      .child(div().relative().flex_1().min_h(0)
        // Scrolled here rather than by overflow_y_scroll: the headers on top need to know how far.
        .child(v_flex().id("spaces-list").size_full().overflow_hidden()
          .track_focus(this.handle)
          .on_key_down((e, cx) => this.key(e, cx))
          .on_mouse_down("left", (_e, cx) => { if (this.keyboard) { this.keyboard = false; this.card.close(cx); cx.notify(); } })
          .on_size_change((size, cx) => {
            if (size.width === this.width && size.height === this.viewH) return;
            this.width = size.width;
            this.viewH = size.height;
            cx.notify();
          })
          .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
          .on_scroll_wheel((e, cx) => this.scroll(e, cx))
          .child(v_flex().id("spaces-rows").w_full().flex_none().mt(-this.top).px(8).pt(6).pb(24).gap(2)
            .on_size_change((size, cx) => { if (size.height !== this.contentH) { this.contentH = size.height; cx.notify(); } })
            .children(rows)))
        .child(div().absolute().top(0).left(0).right(0).h(14).child(fade(t.chrome, 14, true)))
        .child(div().absolute().bottom(0).left(0).right(0).h(28).child(fade(t.chrome, 28, false)))
        .when(stuck.length > 0, (el) => el
          .child(div().absolute().top(0).left(0).right(0).h(below).children(pinned))
          .child(div().absolute().top(below).left(0).right(0).h(10).child(fade(t.chrome, 10, true)))));
  }
}
