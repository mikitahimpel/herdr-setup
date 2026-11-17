// The grove sidebar, in Rex's manner with Herdr's structure:
//
//   space (a session: its name, then where it works, dim)        + new tab (⌥: terminal)
//     tab (agent or terminal), with where it works when that differs from its space
//       sub-agents (hc run), folded into a count on their parent
//   machines away, at the bottom
//
// Right-click a space, its +, a tab or a sub-agent for the rest of the choices.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import * as H from "herdr";
import { spaces, panes, terminals, machines, run, theme, appHome, openOverlay, setAgentOrder } from "herdr";
import { GitFacts, lead } from "./git.js";
import { tile } from "./tile.js";
import { fade } from "./fade.js";

const TERMINAL = "mods/sleeve-spaces/icons/app-terminal.svg";
const CLAUDE = "mods/sleeve-spaces/icons/app-claude.svg";
const CODEX = "icons/codex.svg";
const BRANCH = "mods/workspace-chrome/git-branch.svg";
const FOLDER = "mods/workspace-chrome/folder.svg";
const RANK = { blocked: 3, working: 2, done: 1 };
// Rex's sidebar ink, measured: titles a soft grey, the selected one bright; headers darker.
const TITLE = "#b4b8bd", HEADER = "#83868b";

// Measured from Rex: rows 32 apart with a 20px icon; titles start 37 in.
const ROW = 32, SUB = 30, HEAD = 28, ICON = 20, SUB_ICON = 16, INSET = 9, GAP = 8, END = 24;
// A sub-agent's fill starts under its parent's title.
const SUB_INDENT = INSET + ICON + GAP - 9;

const base = (path) => (path ?? "").replace(/\/+$/, "").split("/").pop();
const worst = (list) => list.reduce((a, s) => ((RANK[s] ?? 0) > (RANK[a] ?? 0) ? s : a), null);
// This machine's home. An earlier build of this mod had a top-level `home` of its own, and
// Herdr's loader put it over the shared `home` export until the app restarts; put the real
// one back (it is appHome() without Herdr's folder) when that is what's there.
const userHome = () => appHome().replace(/\/\.config\/herdr-app\/?$/, "");
function repairHome() {
  try { if (/w\.id/.test(String(H.home))) H.home = userHome; } catch {}
}

// Home as ~, here and on other machines (/home/<user>, /Users/<user>).
const tilde = (p) => {
  const h = userHome();
  if (p && h && (p === h || p.startsWith(h + "/"))) return "~" + p.slice(h.length);
  return (p ?? "").replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");
};

// A worktree Herdr made, when git hasn't answered yet: ~/.herdr/worktrees/<repo>/<branch>.
function fromPath(folder) {
  const m = /^(.*\/\.herdr\/worktrees\/([^/]+)\/(.+?))\/*$/.exec(folder ?? "");
  return m ? { name: m[2], branch: m[3], linked: true, top: m[1] } : null;
}

// A tab's name: the one given; else its agent's title unless that is only the program's
// name or a command line; else the program's name.
function tabName(c, pane) {
  const program = pane?.program;
  const plain = (s) => !s || s.toLowerCase() === (program?.name ?? "").toLowerCase() || /^[\w.-]+ --?\w/.test(s);
  if (c.named && !plain(c.name)) return c.name;
  const title = (pane?.title ?? "").replace(/^[^\p{L}\p{N}~/.]+/u, "").trim();
  if (title && /[\p{L}\p{N}]/u.test(title) && !plain(title) && !/^(~|\/)/.test(title) && !/^[^\s@]+@[^\s:]+/.test(title)) return title;
  return program?.agent ? program.name : program && !program.shell && program.name ? program.name : "Terminal";
}

// A space's own folder as a place git is asked about: the repo's main checkout when agents
// follow herdr-placement (one space per repo, a tab per task in its worktree).
const ownPlace = (w) => ({ id: `${w.id}:home`, machine: w.machine, folder: w.folder, tabs: [] });

const menu = (items) => openOverlay({
  mod: "grove-menu", kind: "popup", frame: "none", width: 240,
  height: 10 + items.reduce((h, it) => h + (it === "-" ? 9 : 28), 0), props: { items },
});

export default class Grove extends View {
  init(_props, cx) {
    repairHome();
    this.git = new GitFacts();
    this.hover = null;
    this.open = new Set(); // tabs whose sub-agents are listed
    this.down = 0; // roughly how far the list is scrolled
    this.cx = cx;
    cx.timer.every(1000, (cx) => { const sp = spaces(); this.git.update(Date.now(), [...sp, ...sp.map(ownPlace)], panes(), new Set(), cx); });
  }

  // [{ w, where, wt, machine, tabs: [{ c, w, pane, name, tag, kids, status, cwd }] }]
  model() {
    const ps = panes();
    const live = terminals().filter((k) => k.state === "live");
    const paned = new Set(ps.map((p) => p.terminal).filter(Boolean));
    const kids = (addr, depth) => live.filter((k) => k.parent === addr && !paned.has(k.address))
      .flatMap((k) => [{ k, depth }, ...kids(k.address, depth + 1)]);
    return spaces().map((w) => {
      const folder = ps.find((p) => (w.tabs ?? []).some((c) => c.id === p.tab) && p.cwd)?.cwd ?? w.folder;
      const g = (w.folder && this.git.of(ownPlace(w), ps)) || this.git.of(w, ps) || fromPath(folder);
      // Where the space works, after its name; just the branch when the name is the repo's.
      const where = g ? [g.name === w.name ? null : g.name, g.branch].filter(Boolean).join(" · ") : (base(folder) === w.name ? "" : tilde(folder));
      const tabs = (w.tabs ?? []).filter((c) => !c.settled || c.active).map((c) => {
        const pane = lead(c.id, ps);
        const tg = this.git.ofTab(w, c, ps);
        let tag = null;
        if (tg && g && tg.top !== g.top) tag = { text: tg.linked && tg.name === g.name ? tg.branch : base(tg.top), wt: tg.linked, path: tg.top };
        else if (!tg && pane?.cwd && folder && pane.cwd !== folder && !pane.cwd.startsWith(folder + "/")) tag = { text: base(pane.cwd), path: pane.cwd };
        const ks = ps.filter((p) => p.tab === c.id && p.terminal).flatMap((p) => kids(p.terminal, 0));
        // Agents first, then helpers (caffeinate and the like).
        ks.sort((a, b) => Number(!a.k.program?.agent) - Number(!b.k.program?.agent));
        return { c, w, pane, name: tabName(c, pane), tag, kids: ks, status: c.status, cwd: pane?.cwd };
      });
      return { w, where, wt: Boolean(g?.linked), machine: w.machine ?? null, tabs };
    });
  }

  hovered(key, cx, h) {
    if (h) this.hover = key; else if (this.hover === key) this.hover = null;
    cx.notify();
  }

  icon(program, size) {
    return tile(program, size);
  }

  spin(t) {
    return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(1500);
  }

  // A small round button: × on a row's hover, + on a space's.
  mini(t, id, icon, tip, onClick, onRight) {
    return div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded_full()
      .text_color(t.muted).hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((e, cx) => { cx.stop_propagation(); onClick(e); })
      .when(Boolean(onRight), (el) => el.on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); onRight(); }))
      .child(svg(icon).size(12));
  }

  tabMenu(w) {
    return [
      { label: "Claude tab", program: { icon: CLAUDE, tint: false }, key: "⌘T", run: { name: "tab.new", args: { space: w.id, argv: ["claude"], focus: true } } },
      { label: "Codex tab", program: { icon: CODEX, tint: true }, run: { name: "tab.new", args: { space: w.id, argv: ["codex"], focus: true } } },
      { label: "Terminal tab", program: { shell: true }, key: "⌥⌘T", run: { name: "tab.new", args: { space: w.id, focus: true } } },
    ];
  }

  header(t, s) {
    const key = `head-${s.w.id}`;
    const hot = this.hover === key;
    const where = s.where;
    const m = s.machine ? machines().find((x) => x.name === s.machine) : null;
    const up = m?.layout === "ready";
    return h_flex().id(key).h(HEAD).flex_none().pl(INSET).pr(7).gap(6).items_center()
      .on_hover((h, cx) => this.hovered(key, cx, h))
      .on_mouse_down("right", () => menu([...this.tabMenu(s.w), "-",
        { label: "Rename session…", run: { name: "space.rename", args: { id: s.w.id } } },
        { label: "Close session", danger: true, run: { name: "space.close", args: { id: s.w.id } } }]))
      .child(div().flex_none().max_w(150).truncate().text_size(12).font_semibold().text_color(HEADER).child(s.w.name))
      .child(h_flex().flex_1().min_w(0).gap(3).items_center().text_color(t.dim)
        .when(s.wt, (el) => el.child(svg(BRANCH).size(10).flex_none()))
        .child(div().min_w(0).truncate().text_size(12).child(where)))
      .when(Boolean(s.machine), (el) => el.child(h_flex().id(`m-${s.w.id}`).flex_none().gap(4).items_center().text_size(11.5).text_color(t.dim)
        .tooltip(up ? `${s.machine} is online` : m?.layout === "loading" ? `Connecting to ${s.machine}…` : `${s.machine} is offline`)
        .child(div().size(6).rounded_full().bg(up ? t.done : t.idle))
        .child(s.machine)))
      .when(hot, (el) => el.child(this.mini(t, `add-${s.w.id}`, "mods/workspace-chrome/plus.svg",
        `New Claude tab in ${s.w.name}   ⌥ terminal · right-click: more`,
        (e) => run("tab.new", { space: s.w.id, ...(e.modifiers.alt ? {} : { argv: ["claude"] }), focus: true }),
        () => menu(this.tabMenu(s.w)))));
  }

  row(t, x, order) {
    const { c, w } = x;
    const key = `tab-${c.id}`;
    const hot = this.hover === key;
    const selected = w.active && c.active;
    const open = this.open.has(c.id);
    if (x.pane?.terminal && x.pane.program?.agent) order.push(x.pane.terminal);
    const badge = x.status === "blocked" || x.status === "done";
    const kidState = worst(x.kids.map(({ k }) => (k.status === "error" ? "blocked" : k.status)));
    const rows = [h_flex().id(key).h(ROW).flex_none().pl(INSET).pr(6).gap(GAP).items_center().rounded(10)
      .border_1().border_color(selected ? t.border : "#00000000")
      .when(selected, (el) => el.bg(t.selected))
      .when(!selected, (el) => el.hover((st) => st.bg(t.hover)))
      .on_hover((h, cx) => this.hovered(key, cx, h))
      .on_click(() => { if (!w.active) run("space.select", { id: w.id }); if (!c.active) run("tab.select", { id: c.id }); })
      .on_mouse_down("right", () => menu([
        ...(x.pane ? [
          { label: "Claude on the right", icon: "mods/sleeve-pane/split-right.svg", run: { name: "pane.split", args: { pane: x.pane.pane, direction: "right", argv: ["claude"] } } },
          { label: "Terminal below", icon: "mods/sleeve-pane/split-down.svg", run: { name: "pane.split", args: { pane: x.pane.pane, direction: "down" } } },
          "-"] : []),
        { label: "Rename tab…", run: { name: "tab.rename", args: { id: c.id } } },
        { label: "Close tab", danger: true, run: { name: "tab.close", args: { id: c.id } } }]))
      .child(div().relative().size(ICON).flex_none().flex().items_center().justify_center()
        .child(this.icon(x.pane?.program, ICON))
        .when(badge, (el) => el.child(div().absolute().right(-3).bottom(-3).size(8).rounded_full().bg(t[x.status])
          .border_2().border_color(selected ? t.selected : t.chrome))))
      .child(h_flex().flex_1().min_w(0).gap(8).items_center()
        .child(div().flex_shrink(1).min_w(40).truncate().text_size(13).text_color(selected ? t.foreground : TITLE).child(x.name))
        .when(Boolean(x.tag), (el) => el.child(h_flex().id(`tag-${c.id}`).flex_shrink(1000).min_w(13).max_w(110).gap(3).items_center().overflow_hidden()
          .text_size(11.5).text_color(t.dim).tooltip(`Works in ${tilde(x.tag.path)}`)
          .child(svg(x.tag.wt ? BRANCH : FOLDER).size(10).flex_none())
          .child(div().min_w(0).truncate().child(x.tag.text)))))
      .when(x.kids.length > 0, (el) => el.child(h_flex().id(`kids-${c.id}`).h(18).px(6).gap(4).flex_none().items_center().justify_center().rounded(9)
        .bg(open ? t.raised : t.hover).text_size(11).font_semibold().text_color(open ? t.foreground : t.muted)
        .hover((st) => st.bg(t.raised).text_color(t.foreground))
        .tooltip(`${open ? "Hide" : "Show"}: ${x.kids.map(({ k }) => k.name ?? k.program?.name ?? k.address).join(", ")}`)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); if (open) this.open.delete(c.id); else this.open.add(c.id); cx.notify(); })
        .when(Boolean(kidState) && !open, (el) => el.child(div().size(5).flex_none().rounded_full().bg(t[kidState])))
        .child(String(x.kids.length))))
      .child(div().w(END).h(END).flex_none().flex().items_center().justify_center()
        .child(hot ? this.mini(t, `close-${c.id}`, "mods/workspace-chrome/x.svg", "Close tab", () => run("tab.close", { id: c.id }))
          : x.status === "working" ? this.spin(t) : div()))];
    if (open) for (const { k, depth } of x.kids) rows.push(this.sub(t, x, k, depth));
    return rows;
  }

  sub(t, x, k, depth) {
    const key = `kid-${k.address}`;
    const hot = this.hover === key;
    const name = k.name ?? k.program?.name ?? k.address;
    const own = k.cwd && x.cwd && k.cwd !== x.cwd ? base(k.cwd) : null;
    const status = k.status === "error" ? "blocked" : k.status;
    return h_flex().id(key).h(SUB).flex_none().ml(SUB_INDENT + depth * 18).pl(9).pr(6).gap(8).items_center().rounded(10)
      .hover((st) => st.bg(t.hover))
      .on_hover((h, cx) => this.hovered(key, cx, h))
      .on_click(() => run("terminal.peek", { terminal: k.address }))
      .on_mouse_down("right", () => menu([
        { label: "Open on top", run: { name: "terminal.peek", args: { terminal: k.address } } },
        { label: "Give it a tab", run: { name: "terminal.keep", args: { terminal: k.address, place: "tab" } } },
        { label: "Give it a pane on the right", icon: "mods/sleeve-pane/split-right.svg", run: { name: "terminal.keep", args: { terminal: k.address, place: "right" } } },
        "-",
        { label: "Stop", danger: true, run: { name: "terminal.kill", args: { terminal: k.address } } }]))
      .child(div().relative().size(SUB_ICON).flex_none().flex().items_center().justify_center()
        .child(this.icon(k.program, SUB_ICON))
        .when(status === "done" || status === "blocked", (el) => el.child(div().absolute().right(-3).bottom(-3).size(7).rounded_full().bg(t[status]).border_2().border_color(t.chrome))))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().flex_shrink(1).min_w(30).truncate().text_size(12.5).text_color(k.program?.agent ? TITLE : t.muted).child(name))
        .when(Boolean(own), (el) => el.child(h_flex().id(`ktag-${k.address}`).flex_shrink(1000).min_w(11).gap(3).items_center().overflow_hidden()
          .text_size(11.5).text_color(t.dim).tooltip(`Works in ${tilde(k.cwd)}`)
          .child(svg(BRANCH).size(10).flex_none())
          .when(own !== name && !own.endsWith(`-${name}`), (el) => el.child(div().min_w(0).truncate().child(own))))))
      .child(div().w(END).h(END).flex_none().flex().items_center().justify_center()
        .child(hot ? this.mini(t, `stop-${k.address}`, "mods/workspace-chrome/x.svg", "Stop", () => run("terminal.kill", { terminal: k.address }))
          : status === "working" ? this.spin(t) : div()));
  }

  render() {
    const t = theme();
    const order = [];
    const rows = [];
    this.model().forEach((s, i) => {
      if (i > 0) rows.push(div().h(12).flex_none());
      rows.push(this.header(t, s));
      for (const x of s.tabs) rows.push(...this.row(t, x, order));
    });
    for (const m of machines().filter((m) => m.name && m.layout === "unavailable")) {
      rows.push(div().h(12).flex_none());
      rows.push(div().h(HEAD).flex_none().pl(INSET).flex().items_center().text_size(12).font_semibold().text_color(t.dim).child(`${m.name} · offline`));
    }
    setAgentOrder(order);
    // Wheel deltas are positive toward the top; past the start, the top edge darkens.
    return fade(v_flex().id("grove").size_full().pt(2).pb(24).gap(0).overflow_y_scroll().children(rows), t.chrome, this.down > 0,
      (dy) => { const was = this.down > 0; this.down = Math.max(0, (this.down ?? 0) - dy); if (was !== this.down > 0) this.cx?.notify(); });
  }
}
