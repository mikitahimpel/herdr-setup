// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "sleeve-pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane. While a file
// is dragged (shared "sleeve.dragging", from sleeve-drop) a terminal's header becomes its
// drop target: a drop here pastes a copy the terminal can read (drop.js).

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, layout, focused, shared } from "herdr";
import { dropInto } from "./drop.js";

function icon(p, size, color) {
  if (!p?.icon || p.shell || p.key === "shell") return image("mods/sleeve-spaces/icons/app-terminal.svg").w(size).h(size).flex_none();
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// With the sidebar hidden, the window buttons sit over the first pane's header: it
// leaves them room and carries the sidebar toggle the hidden bar had.
function underLights(p) {
  if (!find(layout(), "sidebar")?.hidden) return false;
  const shown = panes().filter((x) => x.tab === (focused()?.tab ?? p.tab));
  return shown[0]?.pane === p.pane;
}

export default class Pane extends View {
  init() { this.hovered = false; }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/sleeve-pane/${icon}.svg`).size(14));
  }

  // The header as a drop target: same height and place, tinted with the accent, saying
  // where the file goes.
  target(t, p, name, pic, lights) {
    const tint = t.accent.slice(0, 7);
    return h_flex()
      .font_bold()
      .id(`pane-drop-${p.pane}`)
      .size_full()
      .px(10)
      .when(lights, (el) => el.pl(73))
      .gap(8)
      .items_center()
      .bg(`${tint}1f`)
      .border_b(1)
      .border_color(t.accent)
      .text_size(12)
      .on_drop((e, cx) => dropInto(p.pane, e.paths, cx))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().text_color(t.accent).child("Drop to attach"))
      .child(div().flex_1().truncate().font_medium().text_color(t.muted).child(`to ${name}`))
      .child(svg("mods/sleeve-chrome/icons/images.svg").size(14).flex_none().text_color(t.accent));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const lights = underLights(p);
    if (shared("sleeve.dragging") && p.terminal) return this.target(t, p, name, pic, lights);
    return h_flex()
      .font_bold()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .on_drop((e, cx) => dropInto(pane, e.paths, cx))
      .when(lights, (el) => el.pl(73)
        // The pane's 1px border puts the header 1px right of and below the sidebar's bar.
        .child(div().id(`ph-sidebar-${pane}`).relative().top(-0.5).size(30).flex_none().flex().items_center().justify_center().rounded(8).text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Show sidebar")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); run("layout.show", { id: "sidebar" }); })
          .child(svg("mods/sleeve-chrome/icons/sidebar.svg").size(16)))
        .child(div().w(1).h(14).mx(2).bg(t.border)))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(1500)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
