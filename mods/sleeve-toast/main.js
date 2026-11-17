// sleeve-toast: notifications in the sleeve look. The sleeve layout picks it with
// its root "toast" setting, in place of the shipped toast.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme, agents } from "herdr";

const DOT = { error: "blocked", warning: "working", success: "done", info: "accent" };

// What a notification is about, by its words when Herdr posts one for an agent.
function tone(p) {
  const title = (p.title ?? "").toLowerCase();
  if (/needs you|blocked|waiting/.test(title)) return "blocked";
  if (/finished|done/.test(title)) return "done";
  return DOT[p.level] ?? "accent";
}

// Herdr's agent notifications read "<space> / <task>" (older ones "<space> · <task>").
function parts(body) {
  const m = /^(.*?) (?:·|\/) (.+)$/.exec(body ?? "");
  return m ? [m[1], m[2]] : [body ?? "", undefined];
}

// Find the agent a notification is about, for its icon.
function agentOf(p) {
  const [space, task] = parts(p.body);
  if (!task) return null;
  return agents().find((a) => a.space_name === space && (a.title === task || a.tab_name === task))
    ?? agents().find((a) => a.space_name === space) ?? null;
}

export default class Toast extends View {
  render() {
    const t = theme();
    const p = props() ?? {};
    const color = t[tone(p)];
    const [where, task] = parts(p.body);
    const agent = agentOf(p);
    const icon = p.icon ?? agent?.program?.icon ?? null;
    const tint = !p.icon && agent?.program?.tint;
    // What happened leads; where it happened follows, quieter. The status is the dot on
    // the mark, so the words never need a color. Herdr draws the frame around this.
    const headline = task ? ({ blocked: "Needs you", done: "Done" })[tone(p)] ?? p.title ?? "" : p.title ?? "";
    const detail = task ? `${where} · ${task}` : p.body ?? "";
    const act = () => {
      if (p.action?.name) run(p.action.name, p.action.args ?? {});
      closeOverlay(p.overlay);
    };
    const mark = div().relative().size(32).flex_none().flex().items_center().justify_center()
      .when(!icon, (el) => el.rounded(8).bg(t.raised).child(div().size(8).rounded_full().bg(color)))
      .when(Boolean(icon), (el) => el
        .child(tint ? svg(icon).size(26).text_color(color) : image(icon).size(32).rounded(8))
        .child(div().absolute().right(-3).bottom(-3).size(12).rounded_full().bg(color).border_2().border_color(t.popover)));
    return h_flex()
      .id("toast")
      .size_full()
      .px(16)
      .gap(12)
      .items_center()
      .bg(t.popover)
      .cursor_pointer()
      .hover((s) => s.bg(t.raised))
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(act)
      .child(mark)
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().font_semibold().text_size(14).text_color(t.foreground).child(headline))
        .when(Boolean(detail), (el) => el.child(div().truncate().text_size(13).text_color(t.muted).child(detail))))
      .child(div().id("toast-close").size(24).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(this.hovered ? t.muted : "#00000000")
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); closeOverlay(p.overlay); })
        .child(svg("mods/workspace-chrome/x.svg").size(10)));
  }
}
