// A right-click menu for grove: props { items: [{ label, icon? (a glyph), program? (an app tile), key?, danger?, run?: { name, args },
// open?: OverlaySpec } | "-"] }. Opened as a popup at the pointer with frame "none";
// each item runs one command or opens one overlay, then the menu closes.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, run, theme, closeOverlay, openOverlay } from "herdr";
import { tile } from "./tile.js";

export const ROW = 28;
export const RULE = 9;
// The popup's height for a list of items, so callers can size it.
export function menuHeight(items) {
  return 10 + items.reduce((h, it) => h + (it === "-" ? RULE : ROW), 0);
}

export default class GroveMenu extends View {
  init(_p, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  pick(it) {
    closeOverlay(props().overlay);
    if (it.run) run(it.run.name, it.run.args ?? {});
    if (it.open) openOverlay(it.open);
  }

  render() {
    const t = theme();
    const items = props()?.items ?? [];
    return v_flex().id("grove-menu").track_focus(this.handle).size_full().p(5).gap(0)
      .bg(t.popover).rounded(10).border_1().border_color(t.input).shadow_2xl()
      .text_size(13).text_color(t.foreground)
      .children(items.map((it, i) => it === "-"
        ? div().h(RULE).flex_none().flex().items_center().px(4).child(div().h(1).w_full().bg(t.border))
        : h_flex().id(`mi-${i}`).h(ROW).flex_none().px(8).gap(8).items_center().rounded(6)
          .text_color(it.danger ? t.blocked : t.foreground)
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.pick(it))
          .child(div().size(16).flex_none().flex().items_center().justify_center()
            .children(it.program ? [tile(it.program, 16)] : it.icon ? [svg(it.icon).size(14).text_color(t.muted)] : []))
          .child(div().flex_1().truncate().child(it.label))
          .child(div().text_size(11.5).text_color(t.dim).child(it.key ?? ""))));
  }
}
