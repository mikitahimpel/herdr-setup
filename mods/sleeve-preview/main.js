// The end of a tab's screen as text, rewrapped to the card, shown while its tab is hovered. Reads
// with `hc read`, so the terminal keeps its size and nothing here takes the keyboard.
// Props: { terminal, title, icon, lines }, or { command, ... } for an agent in the herdr TUI.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, settings, theme } from "herdr";
import { HEIGHT, WIDTH, readScreen } from "./hover.js";

const SIDES = 14, BELOW = 8, HEAD = 36, BORDER = 1;
const TEXT = 10.5, LINE = 14, CHAR = 0.6, MAX_INDENT = 8;
const COLS = Math.floor((WIDTH - 2 * (SIDES + BORDER)) / (TEXT * CHAR));
const ROWS = Math.floor((HEIGHT - HEAD - 2 * (BELOW + BORDER)) / LINE);

function wrap(line) {
  const indent = line.match(/^\s*/)[0].slice(0, MAX_INDENT), out = [];
  let rest = line;
  while (rest.length > COLS) {
    const space = rest.lastIndexOf(" ", COLS), cut = space > indent.length ? space : COLS;
    out.push(rest.slice(0, cut).trimEnd());
    rest = indent + rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

// What fits, newest last: rules drawn across the terminal and runs of blank lines say nothing here.
function fit(lines) {
  const kept = [];
  for (const line of lines) {
    if (/^\s*[─━═╌-]{4,}\s*$/.test(line)) continue;
    if (!line.trim() && !kept[kept.length - 1]?.trim()) continue;
    kept.push(...wrap(line));
  }
  return kept.slice(-ROWS);
}

export default class Preview extends View {
  init(_props, cx) {
    this.lines = props()?.lines ?? [];
    cx.timer.every(1500, (cx) => this.read(cx));
  }

  read(cx) {
    cx.spawn(async (cx) => {
      const lines = await readScreen(props() ?? {});
      if (!lines) return;
      this.lines = lines;
      cx.notify();
    });
  }

  render() {
    const t = theme(), p = props() ?? {};
    return v_flex().size_full().min_h(0).rounded(18).overflow_hidden().border_1().border_color(t.input).bg(t.background).shadow_2xl()
      .child(h_flex().h(HEAD).flex_none().px(SIDES).gap(8).items_center().bg(t.popover).rounded_t(17).text_size(12.8).font_bold().text_color(t.foreground)
        .when(Boolean(p.icon), (el) => el.child(image(p.icon).size(16).flex_none()))
        .child(div().flex_1().min_w(0).truncate().child(p.title ?? "")))
      .child(v_flex().flex_1().min_h(0).px(SIDES).py(BELOW).justify_end().overflow_hidden().font_family(settings().font_family ?? "JetBrains Mono").text_size(TEXT).font_medium().text_color(t.foreground)
        .children(fit(this.lines).map((l) => div().h(LINE).flex_none().whitespace_nowrap().child(l.replace(/ /g, "\u00a0") || "\u00a0"))));
  }
}
