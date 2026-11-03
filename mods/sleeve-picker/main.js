// Go to a tab. Spaces with something that needs you come first, quiet spaces (no agent
// running) fold into their own group. Type to filter, ↑/↓ and Enter to go, ctrl+d to close
// a tab, Esc to leave. Last rows: new work (a tab here, a space on this
// computer or on each connected machine).

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, spaces, panes, terminals, run, hc, theme, props, closeOverlay } from "herdr";

const SELECTED = "#2f74d6";
const ROW_H = 34, HEAD_H = 30, QUIET_H = 32, RULE_H = 9, MAX_LIST = 420;

export default class Picker extends View {
  init(_props, cx) {
    this.filter = "";
    this.input = InputState.new({ placeholder: "Go to a tab, space or agent…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", () => this.go(this.rows().filter(r => r.kind === "ctx" || r.kind === "new" || r.kind === "space")[this.at]));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.at = null;
    this.showEarlier = false;
    this.machines = [];
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => m.state === "connected" && !m.temporary).map((m) => m.name);
      } catch {}
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  rows() {
    const f = this.filter.toLowerCase();
    const all = agents();
    const live = terminals().filter((x) => x.state === "live");
    const teamOf = (addrs) => {
      let n = 0;
      const walk = (a) => live.filter((x) => x.parent === a).forEach((k) => (n++, walk(k.address)));
      addrs.forEach(walk);
      return n;
    };
    const groups = spaces().map((w) => {
      const ctxs = w.tabs
        .map((ctx) => {
          const mine = all.filter((a) => a.tab === ctx.id);
          return { w, ctx, mine, team: teamOf(mine.map((a) => a.address)) };
        })
        .filter((c) => !f || [w.name, c.ctx.name, ...c.mine.map((a) => a.program?.name ?? "")].join(" ").toLowerCase().includes(f));
      return { w, ctxs };
    });
    const busy = groups.filter((p) => p.w.status && p.ctxs.length);
    const quiet = groups.filter((p) => !p.w.status && p.ctxs.length);
    busy.sort((a, b) => (b.w.status === "blocked") - (a.w.status === "blocked"));
    const out = [];
    const add = (p) => {
      out.push({ kind: "head", w: p.w });
      for (const c of p.ctxs) out.push({ kind: "ctx", ...c });
    };
    busy.forEach(add);
    if (quiet.length) {
      out.push({ kind: "quiet", count: quiet.length });
      if (this.showEarlier || f) quiet.forEach(add);
    }
    out.push({ kind: "rule" });
    out.push({ kind: "new" });
    out.push({ kind: "space", machine: null });
    for (const m of this.machines) out.push({ kind: "space", machine: m });
    return out;
  }

  go(r) {
    if (!r) return;
    this.close();
    if (r.kind === "ctx") run("tab.select", { id: r.ctx.id });
    else if (r.kind === "new") run("tab.new");
    else if (r.kind === "space") run("space.new", r.machine ? { machine: r.machine } : {});
  }

  // A tab's tile, as the tab bar and the sidebar draw it.
  tile(r, on, t) {
    const inTab = panes().filter((p) => p.tab === r.ctx.id);
    const pane = inTab.find((p) => p.program?.agent) ?? inTab[0];
    const program = pane?.program, tint = on ? "#ffffff" : t.muted;
    const art = !program?.icon ? svg(pane?.mod === "sleeve-review" ? "mods/workspace-chrome/branch.svg" : "mods/sleeve-chrome/icons/file.svg").size(16).text_color(tint)
      : program.tint ? svg(program.icon).size(16).text_color(tint) : image(program.icon).size(20);
    return div().size(20).flex_none().flex().items_center().justify_center().child(art);
  }

  // What a tab is doing, at its end: the same spinner and dot as the sidebar.
  state(st, on, t) {
    if (st === "working") return svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(on ? "#ffffff" : t.working).spin(1500);
    if (st !== "blocked" && st !== "done") return null;
    return h_flex().flex_none().gap(6).items_center().text_size(12).text_color(on ? "#ffffffd9" : t.muted)
      .child(st === "blocked" ? "Needs you" : "Finished")
      .child(div().size(7).rounded_full().bg(on ? "#ffffff" : t[st]));
  }

  render() {
    const t = theme();
    const rows = this.rows();
    const pickable = rows.filter((r) => r.kind === "ctx" || r.kind === "new" || r.kind === "space");
    // Opens on where you are.
    if (this.at === null) this.at = Math.max(0, pickable.findIndex((r) => r.kind === "ctx" && r.w.active && r.ctx.active));
    this.at = Math.min(this.at, pickable.length - 1);
    const sel = pickable[this.at];

    const row = (r) => {
      if (r.kind === "head") {
        return h_flex().h(HEAD_H).flex_none().px(12).pt(8).items_center().text_size(11.5).font_bold().text_color(t.muted)
          .child(div().truncate().child(r.w.name));
      }
      if (r.kind === "rule") return div().h(RULE_H).flex_none().flex().items_center().px(12).child(div().h(1).w_full().bg(t.border));
      if (r.kind === "quiet") {
        return h_flex().id("pk-quiet").h(QUIET_H).flex_none().px(12).pt(8).gap(6).items_center().text_size(11.5).font_bold().text_color(t.muted)
          .cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => {
            this.showEarlier = !this.showEarlier;
            cx.notify();
          })
          .child("Quiet spaces")
          .child(div().text_color(t.dim).child(String(r.count)))
          .child(div().flex_1())
          .when(!this.filter, (el) => el.child(svg(`mods/workspace-chrome/chevron-${this.showEarlier ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim)));
      }
      const on = r === sel;
      if (r.kind === "new" || r.kind === "space") {
        const label = r.kind === "new" ? "New tab" : r.machine ? `New space on ${r.machine}` : "New space";
        return h_flex()
          .id(r.kind === "new" ? "pk-new" : `pk-space-${r.machine ?? "here"}`)
          .h(ROW_H)
          .flex_none()
          .px(12)
          .items_center()
          .rounded_full()
          .gap(10)
          .text_color(on ? "#ffffff" : t.foreground)
          .cursor_pointer()
          .when(on, (el) => el.bg(SELECTED))
          .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click(() => this.go(r))
          .child(div().size(20).flex_none().flex().items_center().justify_center().child(svg("mods/sleeve-chrome/icons/plus.svg").size(15).text_color(on ? "#ffffff" : t.muted)))
          .child(label);
      }
      const end = this.state(r.ctx.status, on, t);
      return h_flex()
        .id(`pk-${r.ctx.id}`)
        .h(ROW_H)
        .flex_none()
        .px(12)
        .rounded_full()
        .gap(10)
        .items_center()
        .cursor_pointer()
        .when(on, (el) => el.bg(SELECTED))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click(() => this.go(r))
        .child(this.tile(r, on, t))
        .child(div().flex_1().min_w(0).truncate().text_color(on ? "#ffffff" : t.foreground).child(r.ctx.name))
        .when(r.team > 0, (el) => el.child(div().flex_none().text_size(12).text_color(on ? "#ffffffcc" : t.muted).child(`+${r.team}`)))
        .when(Boolean(end), (el) => el.child(end));
    };

    return v_flex()
      .id("picker")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(6)
      .gap(6)
      .rounded(26)
      .overflow_hidden()
      .border_1()
      .border_color(t.input)
      .bg(t.popover)
      .shadow_2xl()
      .text_size(13)
      .font_semibold()
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (k === "down") this.at = (this.at + 1) % pickable.length;
        else if (k === "up") this.at = (this.at + pickable.length - 1) % pickable.length;
        else if (k === "d" && e.modifiers.control) {
          if (sel?.kind === "ctx") {
            this.close();
            run("tab.close", { id: sel.ctx.id });
          }
        } else return;
        cx.stop_propagation();
        cx.notify();
      })
            .child(
        h_flex().h(38).flex_none().px(12).gap(8).items_center().rounded_full().bg(t.selected)
          .child(svg("mods/sleeve-chrome/icons/search.svg").size(16).flex_none().text_color(t.foreground))
          .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)),
      )
      .child(v_flex().id("picker-list").h(Math.min(MAX_LIST, 6 + rows.reduce((h, r) => h + (r.kind === "head" ? HEAD_H : r.kind === "quiet" ? QUIET_H : r.kind === "rule" ? RULE_H : ROW_H), 0))).min_h(0).flex_shrink(1).pb(6).overflow_y_scroll().children(rows.map(row)));

  }
}
