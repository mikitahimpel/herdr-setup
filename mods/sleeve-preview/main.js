// A tab's screen as text, shown while its tab is hovered. Reads with `hc read`, so the
// terminal keeps its size and nothing here takes the keyboard. Props: { terminal, title, icon },
// or { command, title, icon } for an agent in the herdr TUI.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, props, settings, theme } from "herdr";

export default class Preview extends View {
  init(_props, cx) {
    this.lines = props()?.lines ?? null;
    cx.timer.every(1500, (cx) => this.read(cx));
  }

  read(cx) {
    cx.spawn(async (cx) => {
      const { terminal, command } = props() ?? {};
      if (!terminal && !command) return;
      const r = await (command ? exec(command[0], command.slice(1)) : hc(["read", terminal])).catch(() => null);
      if (!r || r.code !== 0) return;
      const all = r.stdout.split("\n").map((l) => l.trimEnd());
      while (all.length && !all[all.length - 1]) all.pop();
      this.lines = all.slice(-14);
      cx.notify();
    });
  }

  render() {
    const t = theme(), p = props() ?? {};
    return v_flex().size_full().min_h(0).rounded(18).overflow_hidden().border_1().border_color(t.input).bg(t.background).shadow_2xl()
      .child(h_flex().h(36).flex_none().px(14).gap(8).items_center().bg(t.popover).rounded_t(17).text_size(12.8).font_bold().text_color(t.foreground)
        .when(Boolean(p.icon), (el) => el.child(image(p.icon).size(16).flex_none()))
        .child(div().flex_1().min_w(0).truncate().child(p.title ?? "")))
      .child(v_flex().flex_1().min_h(0).px(14).py(8).justify_end().overflow_hidden().font_family(settings().font_family ?? "JetBrains Mono").text_size(11).text_color(t.muted)
        .children((this.lines ?? []).map((l) => div().h(15).flex_none().whitespace_nowrap().child(l.replace(/ /g, " ") || " "))));
  }
}
