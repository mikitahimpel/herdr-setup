// Agents waiting on you: blocked first, then finished, newest first in each. One line of
// each agent's screen says what it wants or what it ended with, read once when this opens.
// ↑/↓ to choose, Enter to go there, Space to peek without leaving, Esc to close.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, hc, run, theme, shared, props, closeOverlay } from "herdr";

const ROW_H = 48, HEAD_H = 30, MAX_LIST = 400;
const SECTIONS = [
  { status: "blocked", label: "Needs you" },
  { status: "done", label: "Finished" },
];

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const NOISE = [
  /^[\s─━═╌\-–—_·•.]*$/,
  /^[│┃╭╮╰╯┌┐└┘├┤]/,
  /^[>❯›$%#]\s*$/,
  /auto mode|bypass permissions|for shortcuts|esc to interrupt|ctrl\+[a-z] to|\? for help/i,
  /^\s*[⏵▶►⏩]+/,
  /^\[hc\]/,
];
const meaningful = (l) => !NOISE.some((r) => r.test(l));
const strip = (l) => l.replace(/^[\s●•✻✽✶*⏺+✔✓→-]+/u, "").replace(/\s+/g, " ").trim();

// What an agent asks (a question near the end) or last said (its last message line).
export function excerpt(text, status) {
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() && meaningful(l));
  const tail = lines.slice(-30);
  if (status === "blocked") {
    const ask = tail.findLast((l) => /\?\s*$/.test(strip(l)));
    if (ask) return strip(ask);
  }
  const said = tail.findLast((l) => /^\s*[●•⏺]/u.test(l));
  return strip(said ?? tail.at(-1) ?? "");
}

export default class Inbox extends View {
  init(_props, cx) {
    this.at = 0;
    this.lines = {};
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(100, () => this.handle.focus());
    for (const a of this.list()) {
      cx.spawn(async (cx) => {
        try {
          const r = await hc(["read", a.address, "--lines", "80"]);
          if (r.code === 0) this.lines[a.address] = excerpt(r.stdout, a.status);
        } catch {}
        cx.notify();
      });
    }
  }

  list() {
    const since = shared("inbox.since") ?? {};
    const at = (a) => since[a.address]?.at ?? 0;
    return SECTIONS.flatMap((s) => agents().filter((a) => a.status === s.status).sort((x, y) => at(y) - at(x) || y.seq - x.seq));
  }

  close() {
    closeOverlay(props().overlay);
  }

  go(a) {
    if (!a) return;
    this.close();
    run("agent.focus", { terminal: a.address });
  }

  peek(a) {
    if (!a) return;
    this.close();
    run("terminal.peek", { terminal: a.address });
  }

  icon(a, on, t) {
    const p = a.program, tint = t.muted;
    const art = !p?.icon || p.shell || p.key === "shell" ? image("mods/sleeve-spaces/icons/app-terminal.svg").size(18)
      : p.tint ? svg(p.icon).size(15).text_color(tint) : image(p.icon).size(18);
    return div().size(20).flex_none().flex().items_center().justify_center().child(art);
  }

  row(a, on, now, since, t) {
    const line = this.lines[a.address];
    const when = since[a.address]?.at;
    const tab = a.tab_name && !/^\d+$/.test(a.tab_name) ? a.tab_name : a.title || a.program?.name || "";
    return h_flex()
      .id(`in-${a.address}`)
      .h(ROW_H)
      .flex_none()
      .px(12)
      .gap(10)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(`${t.selected.slice(0, 7)}80`)))
      .on_click(() => this.go(a))
      .child(this.icon(a, on, t))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().min_w(0).gap(5).items_center()
          .child(div().flex_none().max_w(200).truncate().font_medium().text_color(t.foreground).child(a.space_name || tab))
          .when(Boolean(tab) && tab !== a.space_name, (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(`· ${tab}`))))
        .child(div().truncate().text_size(12).font_medium().text_color(t.dim).child(line === undefined ? "…" : line || " ")))
      .child(h_flex().flex_none().gap(7).items_center()
        .when(Boolean(when), (el) => el.child(div().text_size(11.5).font_semibold().text_color(t.muted).child(duration(now - when))))
        .child(div().size(7).rounded_full().bg(t[a.status])));
  }

  render() {
    const t = theme();
    const list = this.list();
    const since = shared("inbox.since") ?? {};
    const now = Date.now();
    this.at = Math.max(0, Math.min(this.at, list.length - 1));
    const sel = list[this.at];
    const rows = [];
    let height = 0;
    for (const s of SECTIONS) {
      const mine = list.filter((a) => a.status === s.status);
      if (!mine.length) continue;
      rows.push(h_flex().h(HEAD_H).flex_none().px(12).pt(8).gap(6).items_center().text_size(11).font_semibold().text_color(t.dim)
        .child(div().size(6).rounded_full().bg(t[s.status]))
        .child(s.label)
        .child(div().text_color(t.dim).child(String(mine.length))));
      height += HEAD_H;
      for (const a of mine) {
        rows.push(this.row(a, a === sel, now, since, t));
        height += ROW_H;
      }
    }

    return v_flex()
      .id("inbox")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .rounded(12)
      .overflow_hidden()
      .border_1()
      .border_color(t.input)
      .bg(t.popover)
      .shadow_2xl()
      .text_size(12.8).font_semibold()
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (k === "enter") return this.go(sel);
        if (k === "space") return this.peek(sel);
        if (!list.length) return;
        if (k === "down") this.at = (this.at + 1) % list.length;
        else if (k === "up") this.at = (this.at + list.length - 1) % list.length;
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().h(34).flex_none().px(12).items_center().justify_between()
        .child(h_flex().gap(8).items_center().text_size(13).font_bold().text_color(t.foreground)
          .child(svg("mods/sleeve-chrome/icons/inbox.svg").size(15).text_color(t.muted))
          .child("Inbox"))
        .child(div().text_size(11.5).font_semibold().text_color(t.dim).child(list.length ? "↵ go   ␣ peek" : "")))
      .when(!list.length, (el) => el.child(v_flex().h(120).items_center().justify_center().gap(6)
        .child(svg("mods/workspace-chrome/circle-check.svg").size(20).text_color(t.done))
        .child(div().text_size(13).font_bold().text_color(t.foreground).child("All clear"))
        .child(div().text_size(12).font_medium().text_color(t.muted).child("No agent is waiting on you"))))
      .when(list.length > 0, (el) => el.child(v_flex().id("inbox-list").h(Math.min(MAX_LIST, height + 6)).min_h(0).pb(6).overflow_y_scroll().children(rows)));
  }
}
