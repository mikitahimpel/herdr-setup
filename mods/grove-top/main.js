// The grove sidebar's top bar, beside the window buttons: hide sidebar, then go to,
// history and +. + opens grove-places (where the new session starts); with ⌥ the session
// is a terminal; a right-click offers Claude, Codex or a terminal first.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, keys, openOverlay, nextCommand, notify, agents } from "herdr";
import { muted, toggleMute } from "./mute.js";

const GLYPHS = { cmd: "⌘", shift: "⇧", ctrl: "⌃", alt: "⌥" };
function hint(label, action) {
  const k = keys().find((b) => b.action === action && b.section !== "terminal")?.keys;
  return k ? `${label}   ${k.split("-").map((p) => GLYPHS[p] ?? p.toUpperCase()).join("")}` : label;
}

export const places = (agent) => ({ mod: "grove-places", kind: "popup", frame: "none", width: 400, height: 440, at: { x: 10, y: 46 }, props: { agent } });

const MENU = [
  { label: "Claude session in…", program: { icon: "mods/sleeve-spaces/icons/app-claude.svg", tint: false }, key: "⌘N", open: places("claude") },
  { label: "Codex session in…", program: { icon: "icons/codex.svg", tint: true }, open: places("codex") },
  { label: "Terminal session in…", program: { shell: true }, key: "⌥⌘N", open: places("terminal") },
];

export default class GroveTop extends View {
  init(_p, cx) {
    // keys.json's layout:grove: ⌘N new (⌥⌘N a terminal), ⌘⇧M mute.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "new" || c === "new-terminal") openOverlay(places(c === "new" ? "claude" : "terminal"));
        if (c === "mute") await toggleMute();
        // A sample of what Herdr posts for an agent, to look at the toast.
        if (c === "test-toast") {
          const a = agents().find((x) => x.program?.agent) ?? agents()[0];
          if (a) notify({ title: "Agent needs you", body: `${a.space_name} / ${a.title || a.tab_name}`, level: "warning", action: { name: "agent.focus", args: { terminal: a.address } } });
        }
        cx.notify();
      }
    });
  }

  button(t, id, icon, tip, action, extra) {
    return div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded_full()
      .text_color(t.muted).hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((e) => action(e))
      .when(Boolean(extra), extra)
      .child(svg(icon).size(16));
  }

  render() {
    const t = theme();
    return h_flex().size_full().pl(82).pr(4).gap(2).items_center()
      .child(this.button(t, "sidebar", "mods/sleeve-chrome/icons/sidebar.svg", hint("Hide sidebar", "layout.toggle:sidebar"), () => run("layout.toggle", { id: "sidebar" })))
      .child(div().flex_1())
      .child(this.button(t, "mute", muted() ? "mods/grove-top/icons/bell-off.svg" : "mods/grove-top/icons/bell.svg",
        hint(muted() ? "Unmute agents" : "Mute agents", "grove-top.mute"), () => toggleMute(),
        muted() ? (el) => el.text_color(t.working) : null))
      .child(this.button(t, "goto", "mods/sleeve-chrome/icons/command.svg", hint("Go to", "mod.open:sleeve-picker"), () => run("mod.open", { name: "sleeve-picker" })))
      .child(this.button(t, "history", "mods/sleeve-chrome/icons/history.svg", hint("Agent history", "mod.open:sleeve-history"), () => run("mod.open", { name: "sleeve-history" })))
      .child(this.button(t, "new", "mods/sleeve-chrome/icons/plus.svg", "New session in…   ⌘N · ⌥ terminal · right-click: more",
        (e) => openOverlay(places(e.modifiers.alt ? "terminal" : "claude")),
        (el) => el.on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openOverlay({ mod: "grove-menu", kind: "popup", frame: "none", width: 230, height: 10 + 3 * 28, props: { items: MENU } });
        })));
  }
}
