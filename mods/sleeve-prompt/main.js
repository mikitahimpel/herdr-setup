// A one-line text prompt in the sleeve look, opened as a dialog with props
// { title, hint?, value?, placeholder?, icon?, verb?, command: { name, args } }.
// Enter runs the command with { ...args, name: text }; Esc cancels.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme } from "herdr";

export default class SleevePrompt extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.text = p.value ?? "";
    this.input = InputState.new({ value: this.text, placeholder: p.placeholder ?? "" });
    if (this.text) this.input.set_selected_range({ start: 0, end: this.text.length });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", () => this.submit());
    this.input.focus();
    cx.timer.after(100, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  close() {
    closeOverlay(props().overlay);
  }

  submit() {
    const p = props();
    this.close();
    run(p.command.name, { ...(p.command.args ?? {}), name: this.text.trim() });
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const cap = (id, label, key, action) => h_flex().id(id).gap(6).items_center().cursor_pointer()
      .text_color(t.muted).hover((s) => s.text_color(t.foreground))
      .on_click(action)
      .child(label)
      .child(div().h(20).px(6).flex().items_center().rounded(6).border_1().border_color(t.input).text_color(t.foreground).child(key));
    return v_flex()
      .id("sleeve-prompt")
      .track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .size_full()
      .rounded(12)
      .overflow_hidden()
      .border_1()
      .border_color(t.input)
      .bg(t.popover)
      .shadow_2xl()
      .font_semibold()
      .child(h_flex().h(46).flex_none().px(16).gap(10).items_center().border_b(1).border_color(t.border)
        .child(svg(p.icon ?? "mods/workspace-chrome/square-pen.svg").size(16).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(13.5).text_color(t.foreground)))
      .child(h_flex().flex_1().px(16).gap(12).items_center().text_size(12)
        .child(h_flex().flex_1().min_w(0).gap(8).items_center()
          .child(div().flex_none().text_color(t.foreground).child(p.title ?? ""))
          .when(Boolean(p.hint), (el) => el.child(div().min_w(0).truncate().font_medium().text_color(t.dim).child(p.hint))))
        .child(cap("pm-cancel", "Cancel", "esc", () => this.close()))
        .child(cap("pm-save", p.verb ?? "Save", "↩", () => this.submit())));
  }
}
