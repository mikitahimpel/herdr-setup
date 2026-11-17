// Scroll areas darken into their background at the edges, as in Rex: the bottom always
// (more below), the top once scrolled. Drawn as bands of falling opacity (bg takes colors
// only). `onScroll` gets the wheel's vertical delta.

import { div } from "gpui-kit";
import { v_flex } from "gpui-base";

const BANDS = 8;
const hex = (a) => Math.round(a * 255).toString(16).padStart(2, "0");

function edge(ground, top, height) {
  const band = height / BANDS;
  const list = Array.from({ length: BANDS }, (_, i) => {
    const a = Math.pow(1 - i / BANDS, 1.6) * 0.95;
    return div().h(band).w_full().flex_none().bg(ground.slice(0, 7) + hex(a));
  });
  return v_flex().absolute().left(0).right(0).h(height).when(top, (el) => el.top(0)).when(!top, (el) => el.bottom(0))
    .children(top ? list : list.reverse());
}

export function fade(area, ground, scrolled, onScroll) {
  return div().relative().size_full().min_h(0)
    .child(area.on_scroll_wheel((e) => onScroll(e.delta.y)))
    .when(scrolled, (el) => el.child(edge(ground, true, 24)))
    .child(edge(ground, false, 32));
}
