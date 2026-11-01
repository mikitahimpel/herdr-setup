import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { PreviewHover } from "./hover.js";
import { spaces, panes, run, openOverlay, nextCommand, theme, window, shared, setShared, layout, settings, keys, knownAgents } from "herdr";

const openReview = () => {
  const space = spaces().find(s => s.active), pane = panes().find(p => p.focused);
  run("tab.new", { name: "Review", space: space?.id, mod: "sleeve-review", props: { folder: pane?.cwd ?? space?.folder, on: space?.machine ?? null } });
};

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

export default class Tabs extends View {
  init(_props, cx) {
    this.previews = new PreviewHover();
    // cmd-1..9 and ctrl-1..9: a number with nothing there does nothing, where the app's own
    // tab.select and space.select post an error.
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        if (command.endsWith("review")) { openReview(); continue; }
        const [, kind, n] = /^(tab|space)([1-9])$/.exec(command) ?? [];
        const list = kind === "tab" ? (spaces().find(p => p.active)?.tabs ?? []).filter(c => !c.settled) : spaces();
        if (kind && Number(n) <= list.length) run(`${kind}.select`, { index: Number(n) });
      }
    });
    // The + menu opens with this list ready.
    cx.spawn(async () => { try { setShared("new.agents.local", await knownAgents({})); } catch {} });
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  close() {
    this.previews.hide();
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action, tip) => div().id(id).size(30).flex_none().flex().items_center().justify_center().rounded_full().text_color(t.foreground).hover(s => s.bg(t.hover)).when(Boolean(tip), el => el.tooltip(tip))
      .on_mouse_move(e => { this.mouse = e.position; })
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      const kind = panes().find(p => p.tab === c.id)?.mod === "sleeve-review" ? "mods/workspace-chrome/branch.svg" : "mods/sleeve-chrome/icons/file.svg";
      const glyph = !program?.icon ? svg(kind).size(14).text_color(t.muted) : program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14);
      // The end slot is always there: the tab's status, or close when hovered, so nothing moves.
      const hot = this.hotTab === c.id;
      return h_flex().id(`tab-${c.id}`).h(30).pl(13).pr(7).gap(4).rounded_full().items_center().flex_none().text_size(12.8).font_bold()
        .bg(c.active ? t.selected : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_move(e => { this.mouse = e.position; })
        .on_hover((on, cx) => {
          if (on) this.hotTab = c.id;
          else if (this.hotTab === c.id) this.hotTab = null;
          cx.notify();
          if (!on) return this.previews.leave(c.id, cx);
          if (c.active) return;
          this.previews.show(c.id, () => {
            const pane = panes().find(p => p.tab === c.id && p.program?.agent) ?? panes().find(p => p.tab === c.id);
            if (!pane?.terminal) return null;
            return { at: { x: Math.max(12, (this.mouse?.x ?? 40) - 40), y: 52 }, props: { terminal: pane.terminal, title: name, icon: program?.tint ? null : program?.icon } };
          }, cx);
        })
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.previews.cancel(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); else if (!c.active) run("tab.select", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.previews.cancel(); openOverlay({ mod: "sleeve-menu", kind: "popup", frame: "none", width: 224, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .child(div().flex_none().mr(3).child(glyph))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .child(div().id(`close-${c.id}`).size(18).flex_none().flex().items_center().justify_center().rounded_full().text_color(t.muted)
          .when(hot, el => el.hover(s => s.bg(t.input).text_color(t.foreground))
            .on_mouse_down("left", stop)
            .on_click((_e, cx) => { cx.stop_propagation(); this.previews.cancel(); run("tab.close", { id: c.id }); })
            .child(svg("mods/pane/close.svg").size(12)))
          .when(!hot && c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(1500)))
          .when(!hot && (c.status === "blocked" || c.status === "done"), el => el.child(div().size(6).rounded(3).bg(t[c.status]))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(2, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 2;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "images"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(30).px(11).gap(5).flex_none().items_center().rounded_full()
        .text_size(12).font_bold().bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(15)).child(label);
    };
    return h_flex().size_full().min_w(0).pl(lightsPadding).gap(3).items_center().bg(t.chrome)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .when(Boolean(sidebar?.hidden), el => el.child(button("sidebar-show", svg("mods/sleeve-chrome/icons/sidebar.svg").size(16), () => run("layout.show", { id: "sidebar" }), hint("Show sidebar", "layout.toggle:sidebar"))))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scroll().children(shown.map(item)))
      .child(button("tab-new", svg("mods/sleeve-chrome/icons/plus.svg").size(16), () => openOverlay({ mod: "sleeve-new", kind: "popup", frame: "none", width: 250, height: 512 }), hint("New tab", "tab.new")))
      .child(h_flex().id("open-review").h(30).px(11).gap(5).flex_none().items_center().rounded_full().text_size(12).font_bold().bg(t.chrome).text_color(t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop).tooltip(hint("Review a branch", "sleeve-tabs.review")).on_click(openReview)
        .child(svg("mods/workspace-chrome/branch.svg").size(15)).child("Review"))
      .child(panelButton("images", "Images", "mods/sleeve-chrome/icons/images.svg"))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/sleeve-chrome/icons/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/sleeve-chrome/icons/changes.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/sleeve-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/sleeve-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/sleeve-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
