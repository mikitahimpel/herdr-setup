// The work sidebar: every agent and terminal, by where it works.
//
//   NEEDS YOU                 what waits for the person, wherever it is
//   BILLET                    a repo
//     ⑂ main            ↓9    a checkout of it: the main one or a worktree, by branch
//       ⠋ billet-manager  2   a tab working there; on its right, the terminals it
//       ○ Claude Code     5   started (hc run, no pane), listed under it on a click
//     ⑂ fix/tabs-moments ↓4
//       ⠋ tabs-moments
//   ~/Developer               tabs outside any repo, by folder
//
// A row leads with what runs there (Claude's mark, Codex's, a terminal's) and ends with
// its state: a spinner at work, red waiting for the person, green finished. Text is
// brighter where something happens. Machines other than this one head their own part. The hover card (card.js,
// hover.js) has the rest: folder, last commit, changes. Git comes from git.js.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Popup } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, hc, theme, shared, layout, nextCommand, home, terminals } from "herdr";
import { askRename } from "./ask.js";
import { GitFacts, lead } from "./git.js";
import { Card } from "./card.js";
import { HoverCard } from "./hover.js";

const TERMINAL = "mods/sleeve-spaces/icons/app-terminal.svg";

// A repo's tile color, picked by its name so it stays the same.
const REPO_COLORS = ["#22a99a", "#e3814f", "#5b8def", "#8b7cf6", "#3fae6a", "#d9649a"];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

const base = (path) => (path ?? "").replace(/\/+$/, "").split("/").pop();

// A folder with its home as ~, here or on another machine.
const short = (path) => (path ?? "").replace(home(), "~").replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// A program's icon: agents and other programs keep their own mark; a shell is the
// sleeve terminal tile.
function programIcon(program, size, color) {
  const shell = !program || program.shell || program.key === "shell" || !program.icon;
  if (shell) return image(TERMINAL).size(size).flex_none();
  return program.tint ? svg(program.icon).size(size).flex_none().text_color(color) : image(program.icon).size(size).flex_none();
}

// A tab's program: its lead pane's (the agent, else the focused or first pane).
function tabProgram(c, ps) {
  return lead(c.id, ps)?.program ?? null;
}

// A tab's name: the one given; else what its agent set as its title, unless that's only
// the program's name or the command it was started with; else its space's name.
function tabName(w, c, ps) {
  // A name that is a command line ("claude --model opus", given by whatever started it) says nothing.
  if (c.named && !/^[\w.-]+ --?\w/.test(c.name)) return c.name;
  const pane = lead(c.id, ps);
  const program = pane?.program;
  let title = (pane?.title ?? "").replace(/^[^\p{L}\p{N}~/.]+/u, "").trim();
  if (!program?.agent && /^[^\s@]+@[^\s:]+/.test(title)) title = "";
  const plain = !title || !/[\p{L}\p{N}]/u.test(title)
    || title.toLowerCase() === (program?.name ?? "").toLowerCase()
    || (program?.key && title.toLowerCase().startsWith(`${program.key} `))
    || /^[\w.-]+ --?\w/.test(title) // a command line: "claude --model opus"
    || /^~?\//.test(title);
  return plain ? w.name : title;
}

// A sub-terminal's state in three words: at work, waiting for the person, or finished.
function subState(k) {
  if (k.status === "working") return "working";
  if (k.status === "blocked" || k.status === "error") return "blocked";
  return "finished";
}

// The list's edges fade into the sidebar instead of cutting rows off.
const fade = (color, height, down) => {
  const steps = Math.max(6, Math.round(height / 2)), base = color.slice(0, 7);
  const strips = Array.from({ length: steps }, (_, n) => {
    const a = Math.round(255 * (1 - (n + 0.5) / steps)).toString(16).padStart(2, "0");
    return div().h(height / steps).flex_none().bg(`${base}${a}`);
  });
  return div().absolute().top(0).left(0).right(0).flex().flex_col().children(down ? strips : strips.reverse());
};

export default class Work extends View {
  init(_props, cx) {
    this.git = new GitFacts();
    this.card = new HoverCard();
    this.cardView = new Card(home());
    this.handle = cx.focus_handle();
    this.keyboard = false;
    this.cursor = null;
    this.nav = [];
    this.machines = [];
    this.folded = new Set(JSON.parse(localStorage.getItem("work.folded") ?? "[]")); // repo keys, machines
    this.open = new Set(); // tabs whose sub-terminals are listed
    // Until git has answered (a moment), a tab isn't shown: it would show under Other,
    // then jump to its repo.
    this.started = Date.now();
    cx.timer.after(2500, (cx) => cx.notify());
    this.refreshMachines(cx);
    cx.timer.every(15000, (cx) => this.refreshMachines(cx));
    cx.timer.every(1000, (cx) => this.git.update(Date.now(), spaces(), panes(), new Set(), cx));
    // Keys (keys.json): focus the list, rename, cmd-1..9 / ctrl-1..9.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") { this.focus(cx); cx.notify(); continue; }
        const active = spaces().find((p) => p.active);
        if (command === "rename-tab") { const tab = active?.tabs.find((c) => c.active); if (tab) askRename("tab", tab.id); continue; }
        if (command === "rename-space") { if (active) askRename("space", active.id); continue; }
        const [, kind, n] = /^(tab|space)([1-9])$/.exec(command) ?? [];
        const list = kind === "tab" ? (active?.tabs ?? []).filter((c) => !c.settled) : spaces();
        if (kind && Number(n) <= list.length) run(`${kind}.select`, { index: Number(n) });
      }
    });
  }

  async close() {
    this.card.close();
  }

  refreshMachines(cx) {
    cx.spawn(async (cx) => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  fold(key, cx) {
    this.folded.has(key) ? this.folded.delete(key) : this.folded.add(key);
    localStorage.setItem("work.folded", JSON.stringify([...this.folded]));
    cx?.notify();
  }

  // Everything the list shows, worked out once per render:
  // [{ machine, groups: [{ key, name, rows }] }], and the rows that need the person.
  // A row: { w, c, g, name, program, subs: [{ k, depth }] }.
  model() {
    const ps = this.ps;
    // Terminals started with hc run that have no pane, under the tab that started them.
    const live = terminals().filter((k) => k.state === "live");
    const paned = new Set(ps.map((p) => p.terminal).filter(Boolean));
    const kids = (addr, depth) => live.filter((k) => k.parent === addr && !paned.has(k.address))
      .flatMap((k) => [{ k, depth }, ...kids(k.address, depth + 1)]);
    const order = { working: 0, blocked: 0, finished: 1 };
    const rows = [];
    for (const w of spaces()) {
      for (const c of (w.tabs ?? []).filter((c) => !c.settled || c.active)) {
        const known = this.git.ofTab(w, c, ps) ?? this.git.of(w, ps);
        if (known === undefined && Date.now() - this.started < 2500) continue;
        const g = known ?? null;
        const subs = ps.filter((p) => p.tab === c.id && p.terminal).flatMap((p) => kids(p.terminal, 0))
          .sort((a, b) => order[subState(a.k)] - order[subState(b.k)]);
        rows.push({ w, c, g, name: tabName(w, c, ps), program: tabProgram(c, ps), folder: lead(c.id, ps)?.cwd ?? w.folder, subs });
      }
    }
    const needs = rows.filter((r) => r.c.status === "blocked" || r.subs.some((s) => subState(s.k) === "blocked"));
    const names = [...new Set([...rows.map((r) => r.w.machine).filter(Boolean), ...this.machines.map((m) => m.name)])].sort();
    const parts = [null, ...names].map((machine) => {
      // Repos, then folders outside any repo; in each, its places (a checkout, a
      // folder), each with its tabs, in the order they first come.
      const groups = new Map();
      for (const r of rows.filter((r) => (r.w.machine ?? null) === machine)) {
        const key = r.g?.repo ?? `other:${machine ?? ""}`;
        if (!groups.has(key)) groups.set(key, { key, name: r.g ? r.g.name : "Other", repo: Boolean(r.g), places: new Map() });
        const at = r.g ? r.g.top : r.folder ?? "";
        const places = groups.get(key).places;
        if (!places.has(at)) places.set(at, { key: `${key}\n${at}`, g: r.g, folder: r.folder, rows: [] });
        places.get(at).rows.push(r);
      }
      const list = [...groups.values()].map((x) => ({ ...x, places: [...x.places.values()] }));
      return { machine, groups: [...list.filter((x) => x.repo), ...list.filter((x) => !x.repo)].map((x) => ({ ...x, machine })) };
    });
    return { parts: names.length ? parts : parts.slice(0, 1), needs };
  }

  goTab(w, c) {
    if (!w.active) run("space.select", { id: w.id });
    if (!c.active) run("tab.select", { id: c.id });
  }

  // The hover card's props for a row.
  tabCard(r) {
    const pane = lead(r.c.id, this.ps);
    const title = (pane?.title ?? "").replace(/^[^\p{L}\p{N}~/.]+/u, "").trim();
    return {
      title: r.name,
      icon: { program: r.program },
      status: r.c.status,
      since: r.c.status === "working" ? r.c.working_since : r.c.changed_at,
      doing: r.program?.agent && title && title !== r.name ? title : null,
      git: r.g,
      folder: r.g?.top ?? pane?.cwd ?? null,
      machine: r.w.machine,
    };
  }

  cardAt(id) {
    const props = this.card.at(id);
    if (!props) return div().absolute();
    return div().absolute().top(-8).right(-10).size(0)
      .child(Popup.new(`card-${id}`, div().size(0)).anchor("top_left")
        .content(this.cardView.render(props, theme(), (cx) => this.card.close(cx))));
  }

  ring(id, t) {
    return div().absolute().inset_0().rounded(8).when(this.keyboard && this.cursor === id, (el) => el.border_1().border_color(t.muted));
  }

  // What runs there, leading the row: Claude's mark, Codex's, a terminal's.
  icon(program, size, t) {
    return div().size(16).flex_none().flex().items_center().justify_center().child(programIcon(program, size, t.muted));
  }

  // Its state, at the row's end: a spinner at work, red waiting for the person, green
  // finished; nothing idle.
  state(st, t) {
    const slot = div().size(14).flex_none().flex().items_center().justify_center();
    if (st === "working") return slot.child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.working).spin(1500));
    if (st === "blocked" || st === "done") return slot.child(div().size(7).rounded(4).bg(t[st]));
    return null; // idle: no slot, the name runs to the edge
  }

  // On a tab's right: how many terminals it started, a spinner before the number while
  // any works, red while any waits. A click lists them under it, or folds them.
  helpers(r, t) {
    const n = { working: 0, blocked: 0, finished: 0 };
    for (const s of r.subs) n[subState(s.k)]++;
    const open = this.open.has(r.c.id);
    const color = n.blocked ? t.blocked : n.working ? t.working : t.dim;
    return h_flex().id(`helpers-${r.c.id}`).flex_none().h(20).px(5).gap(3).items_center().rounded(5)
      .text_size(11.5).font_semibold().text_color(color)
      .when(open, (el) => el.bg(t.hover))
      .hover((s) => s.bg(t.hover))
      .tooltip(`${r.subs.length} started by it${n.working ? `, ${n.working} at work` : ""}${n.blocked ? `, ${n.blocked} waiting` : ""}`)
      .on_mouse_down("left", (_e, cx) => {
        cx.stop_propagation();
        this.open.has(r.c.id) ? this.open.delete(r.c.id) : this.open.add(r.c.id);
        cx.notify();
      })
      .when(n.working > 0, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(9).spin(1500)))
      .child(String(r.subs.length))
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(9).text_color(t.dim));
  }

  // A tab, one line: its state, its name, its helpers. `id`: unique in the list (a tab
  // can show twice: in Needs you and in its place). `note`: dim words after the name.
  tabRow(r, t, id, indent, note = "") {
    const { w, c } = r;
    const on = w.active && c.active;
    const live = c.status === "working" || c.status === "blocked" || c.status === "done";
    this.nav.push({ id, go: () => this.goTab(w, c) });
    return h_flex().id(id).relative().h(28).flex_none().ml(indent).pl(6).pr(4).gap(8).items_center().rounded(7)
      .text_size(13).font_semibold().text_color(on || live ? t.foreground : t.muted)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_hover((over, cx) => {
        if (over) this.card.over(id, () => this.tabCard(r), cx);
        else this.card.out(id, cx);
      })
      .on_mouse_down("left", (e, cx) => {
        this.card.close(cx);
        if (e.click_count === 2) return askRename("tab", c.id);
        this.goTab(w, c);
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "sleeve-menu", kind: "popup", frame: "none", width: 240, props: { tab: "tab", target: { id: c.id, space: w.id } } });
      })
      .child(this.icon(r.program, 15, t))
      .child(div().flex_shrink(1).min_w(0).truncate().child(c.zoomed ? `${r.name} · zoomed` : r.name))
      .when(Boolean(note), (el) => el.child(div().flex_shrink(2).min_w(0).truncate().text_size(11.5).text_color(t.dim).child(note)))
      .child(div().flex_1())
      .when(r.subs.length > 0, (el) => el.child(this.helpers(r, t)))
      .children([this.state(c.status, t)].filter(Boolean))
      .child(this.ring(id, t))
      .child(this.cardAt(id));
  }

  // The terminals a tab started, under it: one line each, a step further in. A click
  // peeks at one over the tab; from there it can be kept as a tab.
  subRows(r, t, indent) {
    return r.subs.map(({ k, depth }) => {
      const st = subState(k);
      const id = `sub-${k.address}`;
      const peek = () => run("terminal.peek", { terminal: k.address });
      this.nav.push({ id, go: peek });
      const name = k.name || k.template || k.program?.name || "terminal";
      return h_flex().id(id).relative().h(26).flex_none().ml(indent + 16 + 12 * depth).pl(6).pr(6).gap(8).items_center().rounded(7)
        .text_size(12.5).font_semibold().text_color(st === "finished" ? t.dim : t.foreground)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => { this.card.close(cx); peek(); })
        .child(this.icon(k.program, 13, t))
        .child(div().flex_1().min_w(0).truncate().child(name))
        .children([this.state(st === "finished" ? null : st, t)].filter(Boolean))
        .child(this.ring(id, t));
    });
  }

  // A checkout or a folder: a branch (the main checkout's or a worktree's), its
  // ahead/behind; outside a repo the folder. The tabs working there hang under it.
  placeHead(p, t) {
    const g = p.g;
    return h_flex().id(`place-${p.key}`).h(24).flex_none().ml(10).pl(6).pr(6).gap(6).items_center()
      .text_size(12).font_semibold().text_color(t.muted)
      .child(svg(`mods/workspace-chrome/${g ? "git-branch" : "folder"}.svg`).size(11).flex_none().text_color(t.dim))
      .child(div().flex_shrink(1).min_w(0).truncate().child(g ? g.branch ?? "detached" : short(p.folder)))
      .when(Boolean(g?.linked), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("worktree")))
      .child(div().flex_1())
      .when(g?.ahead > 0, (el) => el.child(div().flex_none().text_size(11.5).font_bold().text_color(t.done).child(`\u2191${g.ahead}`)))
      .when(g?.behind > 0, (el) => el.child(div().flex_none().text_size(11.5).font_bold().text_color(t.blocked).child(`\u2193${g.behind}`)));
  }

  // A group's head: a repo by a tile with its initial in a color of its own, or the
  // tabs outside any repo by a folder; its name; on hover the fold and, for a repo, a
  // new worktree. A click folds it.
  heading(key, label, t, { repo = false, add = null, machine = null } = {}) {
    const folded = this.folded.has(key);
    const hot = this.hotHead === key;
    const color = REPO_COLORS[[...label].reduce((n, ch) => n + ch.charCodeAt(0), 0) % REPO_COLORS.length];
    const tile = repo
      ? div().size(18).flex_none().flex().items_center().justify_center().rounded(5).bg(`${color}2e`)
        .text_size(10.5).font_bold().text_color(color).child(label.slice(0, 1).toUpperCase())
      : div().size(18).flex_none().flex().items_center().justify_center().child(svg("mods/workspace-chrome/folder.svg").size(14).text_color(t.dim));
    return h_flex().id(`head-${key}`).h(30).flex_none().mt(14).pl(6).pr(4).gap(8).items_center().rounded(7).cursor_pointer()
      .text_size(13).font_bold().text_color(t.foreground)
      .hover((s) => s.bg(t.hover))
      .on_hover((over, cx) => { this.hotHead = over ? key : this.hotHead === key ? null : this.hotHead; cx.notify(); })
      .on_mouse_down("left", (_e, cx) => this.fold(key, cx))
      .child(tile)
      .child(div().flex_shrink(1).min_w(0).truncate().child(label))
      .when(Boolean(machine), (el) => el.child(this.badge(machine, t)))
      .child(div().flex_1())
      .when(hot && Boolean(add), (el) => el.child(add))
      .when(hot || folded, (el) => el.child(div().size(20).flex_none().flex().items_center().justify_center().text_color(t.dim)
        .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11))));
  }

  group(x, t) {
    const from = x.places.flatMap((p) => p.rows).find((r) => r.g && !r.g.linked) ?? x.places[0]?.rows[0];
    const add = x.repo && from ? div().id(`add-${x.key}`).size(22).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("New worktree")
      .on_mouse_down("left", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "sleeve-worktree", kind: "dialog", frame: "none", width: 460, height: 158, props: { space: from.w.id, action: "new" } });
      })
      .child(svg("mods/sleeve-chrome/icons/plus.svg").size(14)) : null;
    const head = this.heading(x.key, x.repo ? x.name : "Other", t, { repo: x.repo, add, machine: x.machine });
    if (this.folded.has(x.key)) return [head];
    const items = x.places.flatMap((p) => [
      this.placeHead(p, t),
      ...p.rows.flatMap((r) => [
        this.tabRow(r, t, `tab-${r.c.id}`, 20),
        ...(this.open.has(r.c.id) ? this.subRows(r, t, 20) : []),
      ]),
    ]);
    return [head, ...items];
  }

  // Another machine's groups carry its name, a dot for whether it is reachable.
  badge(m, t) {
    const machine = this.machines.find((k) => k.name === m);
    const connected = machine?.state === "connected" || machines().find((k) => k.name === m)?.layout === "ready";
    return h_flex().flex_none().h(18).px(6).gap(5).items_center().rounded(5).bg(t.hover)
      .text_size(10.5).font_semibold().text_color(t.muted)
      .child(div().size(6).rounded_full().bg(connected ? t.done : t.dim))
      .child(m);
  }

  // The narrow rail: a tab's icon each, its state on its corner.
  rail(model, t) {
    return model.parts.flatMap((p) => p.groups.flatMap((x) => x.places.flatMap((pl) => pl.rows))).map((r) => {
      const on = r.w.active && r.c.active;
      const st = r.c.status;
      return h_flex().id(`rail-${r.c.id}`).size(36).flex_none().self_center().items_center().justify_center().rounded_full()
        .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_mouse_down("left", () => this.goTab(r.w, r.c))
        .child(div().relative().size(20).child(programIcon(r.program, 20, t.foreground))
          .when(st === "working" || st === "blocked" || st === "done", (el) => el.child(div().absolute().right(-2).bottom(-2).size(9).rounded_full().border_2().border_color(t.chrome).bg(t[st]))));
    });
  }

  focus(cx) {
    this.keyboard = true;
    const tab = spaces().find((s) => s.active)?.tabs.find((c) => c.active);
    if (!this.nav.some((r) => r.id === this.cursor)) this.cursor = tab ? `tab-${tab.id}` : this.nav[0]?.id ?? null;
    this.handle.focus();
  }

  // Up and down move, Enter goes there and back to the terminal, Esc goes back.
  key(e, cx) {
    const at = this.nav.findIndex((r) => r.id === this.cursor);
    const leave = () => { this.keyboard = false; this.card.close(cx); run("pane.go", { direction: "right" }); };
    if (e.key === "escape") leave();
    else if (e.key === "down" || e.key === "up") {
      const next = this.nav[Math.max(0, Math.min(this.nav.length - 1, at + (e.key === "down" ? 1 : -1)))];
      if (next) this.cursor = next.id;
    } else if (e.key === "enter" && this.nav[at]) { this.nav[at].go(); leave(); }
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  render(cx) {
    const t = theme();
    this.ps = panes();
    this.nav = [];
    const model = this.model();
    if (narrow()) {
      return v_flex().id("work-rail").size_full().bg(t.chrome).pt(8).gap(4).overflow_y_scroll().children(this.rail(model, t));
    }
    const items = [];
    if (model.needs.length) {
      items.push(this.heading("needs", "Needs you", t, { repo: true }));
      if (!this.folded.has("needs")) items.push(...model.needs.map((r) => this.tabRow(r, t, `need-${r.c.id}`, 0, r.g ? `${r.g.name} · ${r.g.branch ?? ""}` : short(r.folder))));
    }
    for (const p of model.parts) for (const x of p.groups) items.push(...this.group(x, t));
    return v_flex().id("work").size_full().bg(t.chrome).font_semibold()
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .child(div().relative().flex_1().min_h(0)
        .child(v_flex().id("work-list").size_full().overflow_y_scroll().px(8).pt(0).pb(28).gap(1)
          .on_scroll_wheel((_e, cx) => this.card.close(cx))
          .children(items))
        .child(div().absolute().top(0).left(0).right(0).h(12).child(fade(t.chrome, 12, true)))
        .child(div().absolute().bottom(0).left(0).right(0).h(28).child(fade(t.chrome, 28, false))));
  }
}
