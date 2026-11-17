// Asks before closing something, in grove's look. Opened as a dialog with props
// { title, name?, detail?, verb, command: { name, args } }: the question, what it is about
// (one line, cut to fit), where. Enter runs the command (the highlighted choice starts on
// it), Esc cancels. Callers pass `confirmed: true` so Herdr doesn't ask again.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme } from "herdr";

export default class GroveConfirm extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(100, () => this.handle.focus());
  }

  choose(i) {
    const p = props();
    closeOverlay(p.overlay);
    if (i === 0) run(p.command.name, p.command.args ?? {});
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const rows = [
      { label: p.verb ?? "Close", icon: "mods/workspace-chrome/x.svg", key: "↩" },
      { label: "Cancel", icon: null, key: "esc" },
    ];
    return v_flex().id("grove-confirm").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "down" || e.key === "up" || e.key === "tab") this.at = 1 - this.at;
        else if (e.key === "enter") return this.choose(this.at);
        else if (e.key === "escape") return this.choose(1);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .size_full().p(6).gap(2).rounded(14).overflow_hidden()
      .border_1().border_color(t.input).bg(t.popover).shadow_2xl()
      .child(v_flex().px(10).pt(8).pb(6).gap(4).min_w(0)
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child(p.title ?? "Are you sure?"))
        .child(h_flex().min_w(0).gap(6).items_center().text_size(12.5)
          .when(Boolean(p.name), (el) => el.child(div().flex_shrink(1).min_w(0).truncate().text_color("#b4b8bd").child(String(p.name))))
          .when(Boolean(p.name && p.detail), (el) => el.child(div().flex_none().text_color(t.dim).child("·")))
          .when(Boolean(p.detail), (el) => el.child(div().flex_none().max_w(140).truncate().text_color(t.muted).child(String(p.detail))))))
      .child(div().mx(10).my(3).h(1).flex_none().bg(t.border))
      .children(rows.map((r, i) => {
        const on = i === this.at;
        const danger = i === 0;
        return h_flex().id(`gc-${i}`).h(32).flex_none().px(10).gap(9).rounded(9).items_center().cursor_pointer()
          .text_size(13).font_medium()
          .text_color(danger ? t.blocked : on ? t.foreground : "#b4b8bd")
          .when(on, (el) => el.bg(danger ? `${t.blocked.slice(0, 7)}24` : t.raised))
          .on_hover((over, cx) => { if (over && this.at !== i) { this.at = i; cx.notify(); } })
          .on_click(() => this.choose(i))
          .child(r.icon ? svg(r.icon).size(12).flex_none() : div().size(12).flex_none())
          .child(div().flex_1().child(r.label))
          .child(div().text_size(11.5).text_color(on && danger ? t.blocked : t.dim).child(r.key));
      }));
  }
}
