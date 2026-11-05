// Asks before closing something, in the sleeve look. Opened as a dialog with props
// { title, detail, verb, command: { name, args } }; Enter runs the command, Esc cancels.
// Callers pass `confirmed: true` in the command so the app doesn't ask a second time.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme } from "herdr";

export default class SleeveConfirm extends View {
  init(_props, cx) {
    this.at = 1;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(100, () => this.handle.focus());
  }

  choose(i) {
    const p = props();
    closeOverlay(p.overlay);
    if (i === 0) run(p.command.name, p.command.args ?? {});
  }

  // Laid out like the right-click menu: what's asked on top, then the two choices as
  // its pill rows; the highlighted one is what Enter does.
  render() {
    const t = theme();
    const p = props() ?? {};
    const rows = [
      { label: p.verb ?? "Close", icon: "mods/workspace-chrome/x.svg", key: "↩", color: t.blocked },
      { label: "Cancel", icon: null, key: "esc", color: "#1f6feb" },
    ];
    return v_flex()
      .id("sleeve-confirm")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "down" || e.key === "up" || e.key === "tab") this.at = 1 - this.at;
        else if (e.key === "enter") return this.choose(this.at);
        else if (e.key === "escape") return this.choose(1);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .size_full()
      .p(5)
      .gap(2)
      .rounded(12)
      .overflow_hidden()
      .border_1()
      .border_color(t.input)
      .bg(t.popover)
      .shadow_2xl()
      .text_size(12.8).font_semibold()
      .child(v_flex().px(12).pt(8).pb(4).gap(3)
        .child(div().text_size(13.5).font_bold().text_color(t.foreground).truncate().child(p.title ?? "Are you sure?"))
        .child(div().text_size(12).font_medium().text_color(t.muted).child(p.detail ?? "")))
      .child(div().mx(12).my(4).h(1).bg(t.border))
      .children(rows.map((r, i) => {
        const on = i === this.at;
        return h_flex().id(`cf-${i}`).h(31).px(12).gap(9).rounded(7).items_center().cursor_pointer()
          .text_color(i === 0 ? t.blocked : t.foreground)
          .when(on, (el) => el.bg(i === 0 ? `${t.blocked.slice(0, 7)}26` : t.selected))
          .on_hover((over, cx) => { if (over && this.at !== i) { this.at = i; cx.notify(); } })
          .on_click(() => this.choose(i))
          .child(r.icon ? svg(r.icon).size(14).flex_none() : div().size(14).flex_none())
          .child(div().flex_1().child(r.label))
          .child(div().text_size(12).text_color(t.muted).child(r.key));
      }));
  }
}
