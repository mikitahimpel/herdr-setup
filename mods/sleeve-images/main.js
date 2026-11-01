// Pictures pasted into the Claude Code session in the focused tab, newest first.
// Claude Code only prints [Image #N], so extract.py copies them out of its transcript.
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, exec, focused, hc, panes, theme } from "herdr";

const EVERY = 4000, TILE = 164, TILE_H = 116;

function when(time) {
  const d = new Date(time);
  return time ? `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}` : "";
}

export default class Images extends View {
  init(_props, cx) {
    this.images = [];
    this.note = "";
    this.seen = {}; // terminal -> its last list, so coming back to a tab shows it at once
    this.look(cx);
    cx.timer.every(EVERY, (cx) => this.look(cx));
  }

  // The focused pane if it's Claude Code, else the first Claude Code pane in its tab.
  pane() {
    const f = focused(), all = panes();
    const claude = (p) => p.program?.key === "claude";
    const here = all.find((p) => p.pane === f?.pane);
    return here && claude(here) ? here : all.find((p) => p.tab === f?.tab && claude(p));
  }

  look(cx) {
    if (this.busy) { this.again = true; return; }
    const p = this.pane();
    const address = p?.terminal;
    if (!address) return this.show([], "No Claude Code session in this tab", cx);
    if (address.includes("/")) return this.show([], "Only sessions on this computer", cx);
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const got = await hc(["get", address, "--json"]);
        const fg = JSON.parse(got.stdout).foreground;
        const r = await exec("python3", [`${appHome()}/mods/sleeve-images/extract.py`, String(fg?.pid ?? 0), fg?.cwd ?? p.cwd]);
        this.seen[address] = JSON.parse(r.stdout).images;
        this.show(this.seen[address], "No images in this session yet", cx);
      } catch { this.show([], "Couldn't read this session", cx); }
      finally {
        this.busy = false;
        if (this.again) { this.again = false; this.look(cx); }
      }
    });
  }

  show(images, note, cx) {
    if (JSON.stringify(images) === JSON.stringify(this.images) && note === this.note) return;
    this.images = images;
    this.note = note;
    cx.notify();
  }

  tile(m, t) {
    const fit = Math.min(TILE / m.w, TILE_H / m.h, 1);
    return v_flex().id(`img-${m.id}`).w(TILE).flex_none().gap(4).cursor_pointer()
      .on_click(() => exec("open", [m.file]))
      .child(h_flex().w(TILE).h(TILE_H).items_center().justify_center().rounded(12).overflow_hidden().bg(t.chrome).border_1().border_color(t.border)
        .hover((s) => s.border_color(t.input).bg(t.hover))
        .child(image(m.thumb).w(m.w * fit).h(m.h * fit)))
      .child(div().px(4).text_size(12).font_semibold().text_color(t.muted).child(when(m.time)));
  }

  render(cx) {
    const t = theme();
    const address = this.pane()?.terminal;
    if (address !== this.address) {
      this.address = address;
      this.images = this.seen[address] ?? [];
      this.look(cx);
    }
    return v_flex().id("images").font_bold().size_full().min_h(0).rounded(12).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(44).flex_none().px(16).gap(8).items_center()
        .child(div().child("Images"))
        .when(this.images.length > 0, (el) => el.child(div().text_size(12).text_color(t.muted).child(String(this.images.length)))))
      .when(this.images.length > 0, (el) => el.child(div().id("images-list").flex_1().min_h(0).overflow_y_scroll()
        .child(h_flex().flex_wrap().gap(8).px(12).pb(12).children(this.images.map((m) => this.tile(m, t))))))
      .when(this.images.length === 0, (el) => el.child(v_flex().flex_1().min_h(0).items_center().justify_center().px(24).text_color(t.muted).child(this.note)));
  }
}
