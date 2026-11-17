// A program's icon as an app tile, the way Rex draws them: a picture as it is; a one-color
// glyph on its tile color (programs.json `tile`, `color`); an unlisted program by its
// initial on its own color. Shells, and nothing known, show the terminal tile.

import { div, image, svg } from "gpui-kit";

const TERMINAL = "mods/sleeve-spaces/icons/app-terminal.svg";

export function tile(program, size) {
  if (!program || program.shell || program.key === "shell") return image(TERMINAL).size(size).flex_none();
  if (program.icon && !program.tint) return image(program.icon).size(size).flex_none().rounded(Math.round(size * 0.24));
  const box = div().size(size).flex_none().flex().items_center().justify_center().rounded(Math.round(size * 0.24))
    .bg(program.tile ?? "#2b2d33").border_1().border_color("#ffffff14");
  const ink = program.color ?? "#ffffff";
  if (program.icon) return box.child(svg(program.icon).size(Math.round(size * 0.6)).text_color(ink));
  return box.child(div().text_size(Math.round(size * 0.55)).font_bold().text_color(ink).child((program.name ?? "?").slice(0, 1).toUpperCase()));
}
