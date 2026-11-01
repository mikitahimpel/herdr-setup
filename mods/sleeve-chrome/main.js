import { View, div, image, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, updates, layout, keys } from "herdr";

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

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

export default class SleeveChrome extends View {
  button(id, icon, tip, action) {
    const t = theme();
    return div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded_full().text_color(t.foreground).hover(s => s.bg(t.hover)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(svg(`mods/sleeve-chrome/icons/${icon}.svg`).size(16));
  }
  render() {
    const t = theme();
    const collapsed = narrow();
    return h_flex().size_full().gap(2).items_center().justify_end()
      .when(!collapsed, el => el.child(this.button("search", "command", hint("Go to", "mod.open:sleeve-picker"), () => run("mod.open", { name: "sleeve-picker" })))
        .child(this.button("history", "history", hint("Agent history", "mod.open:sleeve-history"), () => run("mod.open", { name: "sleeve-history" })))
        .child(this.button("settings", "settings", hint("Settings", "app.settings"), () => run("app.settings"))))
      .when(Boolean(updates().app.ready) && !collapsed, el => el.child(div().size(6).rounded_full().bg(t.accent)));
  }
}
