// The hover card: what a sidebar row is, in full, beside it while the pointer (or the
// keyboard) rests there: its whole name, what it's doing and since when, and where it
// works (branch, ahead/behind, folder, uncommitted files, the last commit).
// props: { title, icon?: { program } | { svg }, status?, since?, doing?, git?, folder?, machine?, commit? }
// git: { branch, ahead, behind, linked, changed, untracked } as git.js knows it.
// commit: { subject, at } or null. All of it comes at once, so the card never grows.

import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";

const TERMINAL = "mods/sleeve-spaces/icons/app-terminal.svg";
const WORDS = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle" };
export const WIDTH = 300;

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const tilde = (path, h) => (h && path.startsWith(h) ? `~${path.slice(h.length)}` : path);
const tint = (color, alpha) => `${color.slice(0, 7)}${alpha}`;
// The color moved `k` of the way toward `b` (both #rrggbb).
const mix = (a, b, k) => `#${[1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - k) + parseInt(b.slice(i, i + 2), 16) * k).toString(16).padStart(2, "0")).join("")}`;



export class Card {
  // `home`: the home folder, shown as ~.
  constructor(home) {
    this.home = home;
  }

  icon(p, t) {
    const i = p.icon ?? {};
    if (i.svg) return svg(i.svg).size(16).flex_none().text_color(t.muted);
    const prog = i.program;
    const shell = !prog || prog.shell || prog.key === "shell" || !prog.icon;
    if (shell) return image(TERMINAL).size(16).flex_none();
    return prog.tint ? svg(prog.icon).size(16).flex_none().text_color(t.foreground) : image(prog.icon).size(16).flex_none();
  }

  // A pill for the agent's state: its color, its word, and how long. The color as a
  // soft fill and a hairline, the words lifted toward the text color so they read.
  status(p, t) {
    const color = (t[p.status] ?? t.unknown).slice(0, 7);
    const when = p.since ? ` · ${ago(p.since)}` : "";
    return h_flex().flex_none().h(22).px(8).gap(6).items_center().rounded_full()
      .bg(tint(color, "2e")).border_1().border_color(tint(color, "59"))
      .text_size(11).font_bold().text_color(mix(color, t.foreground.slice(0, 7), 0.35))
      .child(p.status === "working"
        ? svg("mods/workspace-chrome/spinner.svg").size(9).text_color(color).spin(1500)
        : div().size(6).rounded(3).bg(color))
      .child(`${WORDS[p.status] ?? p.status}${when}`);
  }

  // One fact: a dim glyph in the icon column, then the text.
  line(glyph, text, color, t) {
    return h_flex().gap(10).items_start().text_size(12).font_medium()
      .child(div().size(16).h(17).flex_none().flex().items_center().justify_center()
        .child(svg(glyph).size(12).text_color(t.dim)))
      .child(div().flex_1().min_w(0).text_color(color ?? t.muted).child(text));
  }

  chip(text, color, t) {
    const c = color.slice(0, 7);
    return div().flex_none().h(18).px(6).flex().items_center().rounded_full()
      .bg(tint(c, "2e")).border_1().border_color(tint(c, "59"))
      .text_size(10.5).font_bold().text_color(mix(c, t.foreground.slice(0, 7), 0.35)).child(text);
  }

  // `close`: when a press lands anywhere else.
  render(p, t, close) {
    const g = p.git;
    const changes = g ? [g.changed && `${g.changed} changed`, g.untracked && `${g.untracked} untracked`].filter(Boolean).join(" · ") || "No uncommitted changes" : "";
    const facts = [
      p.doing && this.line("mods/workspace-chrome/terminal.svg", p.doing, t.foreground, t),
      g && h_flex().gap(10).items_center().text_size(12).font_semibold()
        .child(div().size(16).flex_none().flex().items_center().justify_center().child(svg("mods/workspace-chrome/git-branch.svg").size(12).text_color(t.dim)))
        // On a branch's own card the title is the branch: here only what kind of checkout.
        .when(p.title !== (g.branch ?? "detached"), (el) => el.child(div().flex_shrink(1).min_w(0).truncate().text_color(t.foreground).child(g.branch ?? "detached")))
        .when(!g.linked, (el) => el.child(div().flex_none().text_size(11).font_medium().text_color(t.dim).child("main checkout")))
        .child(div().flex_1())
        .when(g.ahead > 0, (el) => el.child(this.chip(`↑${g.ahead}`, t.done, t)))
        .when(g.behind > 0, (el) => el.child(this.chip(`↓${g.behind}`, t.blocked, t))),
      p.folder && this.line("mods/workspace-chrome/folder.svg", `${p.machine ? `${p.machine}:` : ""}${tilde(p.folder, this.home)}`, t.muted, t),
      g && this.line("mods/workspace-chrome/git-compare.svg", changes, g.changed || g.untracked ? t.muted : t.dim, t),
      p.commit && this.line("mods/workspace-chrome/circle-check.svg", p.commit.subject, t.muted, t)
        .child(div().flex_none().pl(6).text_color(t.dim).child(ago(p.commit.at))),
    ].filter(Boolean);
    return v_flex().id("sleeve-card").w(WIDTH).text_size(12).font_normal().rounded(12).overflow_hidden()
      // Whatever else is pressed, it goes: a card left behind never stays in the way.
      .on_mouse_down_out((_e, cx) => close(cx))
      .border_1().border_color(t.input).bg(t.popover).shadow_2xl()
      .child(h_flex().px(14).pt(12).pb(facts.length ? 10 : 12).gap(10).items_center()
        .child(this.icon(p, t))
        .child(div().flex_1().min_w(0).text_size(13.5).font_bold().text_color(t.foreground).child(p.title ?? ""))
        .when(Boolean(p.status), (el) => el.child(this.status(p, t))))
      .when(facts.length > 0, (el) => el
        .child(div().mx(14).h(1).bg(t.border))
        .child(v_flex().px(14).pt(10).pb(12).gap(7).children(facts)));
  }
}
