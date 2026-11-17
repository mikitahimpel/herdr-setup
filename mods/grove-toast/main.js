// grove-toast: notifications for the grove layout (its root "toast"). Herdr sizes and places
// the popup; this draws two lines: status and task, then what the agent said (read off its
// screen with `hc read`), or the question it waits on. Clicking runs Herdr's action.
// Muted (settings.json sounds.enabled false, from grove's top bar or ⌘⇧M), agents'
// notifications close at once; errors and the app's own still show.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { tile } from "./tile.js";
import { props, closeOverlay, run, theme, agents, settings, hc } from "herdr";

const DOT = { error: "blocked", warning: "working", success: "done", info: "accent" };
const TITLE = "#b4b8bd";

function tone(p) {
  const title = (p.title ?? "").toLowerCase();
  if (/needs you|blocked|waiting/.test(title)) return "blocked";
  if (/finished|done/.test(title)) return "done";
  return DOT[p.level] ?? "accent";
}

// Herdr's agent notifications read "<space> / <task>" (older ones "<space> · <task>").
function parts(body) {
  const m = /^(.*?) (?:·|\/) (.+)$/.exec(body ?? "");
  return m ? [m[1], m[2]] : [body ?? "", undefined];
}

function agentOf(p) {
  const want = p.action?.args?.terminal;
  if (want) return agents().find((a) => a.address === want) ?? null;
  const [space, task] = parts(p.body);
  if (!task) return null;
  return agents().find((a) => a.space_name === space && (a.title === task || a.tab_name === task))
    ?? agents().find((a) => a.space_name === space) ?? null;
}

// What the agent said last, from its screen: the question it waits on when blocked,
// else its last reply (Claude Code's ⏺ block, Codex's •), first paragraph.
export function said(text, blocked) {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  // The input box and status lines below it aren't what it said.
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) if (/^[─━]{8,}/.test(lines[i].trim())) end = i;
  const body = lines.slice(0, end);
  if (blocked) {
    for (let i = body.length - 1; i >= Math.max(0, body.length - 30); i--) {
      const l = body[i].replace(/^[\s│╭╰|>❯]+|[\s│╮╯|]+$/g, "");
      if (!/\?$/.test(l) || /^\d+\./.test(l)) continue;
      // A permission box: its kind ("Bash command"), then what it wants to run.
      const clean = (s) => s.replace(/^[\s│╭╰|]+|[\s│╮╯|]+$/g, "");
      for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
        if (/^(Bash command|Edit file|Write file|Create file|Read file|Fetch|Web ?Search|.*\btool\b)/i.test(clean(body[j]))) {
          const what = body.slice(j + 1, i).map(clean).find(Boolean);
          return what ? `${what} — ${l}` : l;
        }
      }
      return l;
    }
  }
  let at = -1;
  // A tool call (followed by ⎿/└ output, or timed "· 2s") isn't a reply.
  const tool = (i) => /^\s*(⏺|●|•)\s+(Ran|Read|Bash|Edit|Write|Update|Search)\b/.test(body[i]) || / · \d+(\.\d+)?\s?(ms|s|m)\b/.test(body[i])
    || /^\s*(⎿|└)/.test(body.slice(i + 1).find((l) => l.trim()) ?? "");
  for (let i = body.length - 1; i >= 0; i--) if (/^\s*(⏺|●|•)\s/.test(body[i]) && !tool(i)) { at = i; break; }
  if (at < 0) return "";
  const out = [];
  for (let i = at; i < body.length; i++) {
    const l = body[i].trim();
    if (i > at && (!l || /^[✻※✶⏺●•]/.test(l))) break;
    out.push(l.replace(/^(⏺|●|•)\s*/, ""));
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

export default class Toast extends View {
  init(_p, cx) {
    const p = props() ?? {};
    this.agent = agentOf(p);
    if (settings()?.sounds?.enabled === false && p.level !== "error" && this.agent) return closeOverlay(p.overlay);
    this.said = null;
    if (!this.agent) return;
    cx.spawn(async (cx) => {
      const r = await hc(["read", this.agent.address, "--json"]).catch(() => null);
      try { this.said = said(JSON.parse(r?.stdout ?? "{}").text ?? "", tone(p) === "blocked"); } catch { this.said = ""; }
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const state = tone(p);
    const color = t[state];
    const [where, task] = parts(p.body);
    const a = this.agent;
    const icon = p.icon ?? a?.program?.icon ?? null;
    const machine = a?.address?.includes("/") ? a.address.split("/")[0] : null;
    const headline = task ? ({ blocked: "Needs you", done: "Done" })[state] ?? p.title ?? "" : p.title ?? "";
    const what = task ?? (p.body || "");
    const open = () => { if (p.action?.name) run(p.action.name, p.action.args ?? {}); closeOverlay(p.overlay); };

    // The status is a ring around the icon and a small tag; the task gets the first line,
    // what the agent said the second, where it is the tooltip.
    const mark = div().size(36).flex_none().flex().items_center().justify_center().rounded(11)
      .border_2().border_color(color + "b3")
      .child(icon ? (p.icon ? image(p.icon).size(26).rounded(7) : tile(a?.program, 26))
        : div().size(26).rounded(7).bg(t.raised).flex().items_center().justify_center().child(div().size(8).rounded_full().bg(color)));
    const tag = h_flex().h(18).px(7).flex_none().items_center().rounded(6).bg(color + "26")
      .text_size(10.5).font_semibold().text_color(color).child(headline);
    const line = this.said === null ? "…" : this.said ? (this.said.length > 160 ? this.said.slice(0, 158).trimEnd() + "…" : this.said) : where;

    return h_flex().id("toast").size_full().pl(13).pr(12).gap(12).items_center()
      .bg(t.popover).cursor_pointer()
      .hover((s) => s.bg(t.raised))
      .on_hover((h, cx) => { this.hovered = h; cx.notify(); })
      .tooltip(`${where}${machine ? ` · ${machine}` : ""}`)
      .on_click(open)
      .child(mark)
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(h_flex().min_w(0).gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(13.5).font_semibold().text_color(t.foreground).child(task ? what : headline))
          .child(this.hovered
            ? div().id("toast-close").size(18).flex_none().flex().items_center().justify_center().rounded(6)
              .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => { cx.stop_propagation(); closeOverlay(p.overlay); })
              .child(svg("mods/workspace-chrome/x.svg").size(9))
            : task ? tag : div()))
        .child(div().truncate().text_size(12.5).text_color(TITLE).child(task ? line : what)));
  }
}
