// The grove top +: where a new session starts, picked from a list before anything is made.
// props { agent: "claude" | "codex" | "terminal" }. Opened as a popup with frame "none".
// Places: every checkout of the repos open here (git worktree list), the folders open
// outside git, ~/Developer, home, and other machines. Enter starts the agent there
// (space.new), alt+Enter a terminal. The list starts on the place you're looking at.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, run, theme, closeOverlay, spaces, panes, machines, exec, appHome } from "herdr";

const AGENTS = {
  claude: { name: "Claude Code", argv: ["claude"], icon: "mods/sleeve-spaces/icons/app-claude.svg" },
  codex: { name: "Codex", argv: ["codex"] },
  terminal: { name: "Terminal", argv: null, icon: "mods/sleeve-spaces/icons/app-terminal.svg" },
};
const ROW = 34;

async function git(cwd, args, on) {
  const r = await exec("git", args, { cwd, timeout: 4000, ...(on ? { on } : {}) });
  return r.code === 0 ? (r.stdout ?? "").trim() : null;
}
const base = (p) => p.replace(/\/+$/, "").split("/").pop();

export default class Places extends View {
  init(_p, cx) {
    this.handle = cx.focus_handle();
    this.agent = props()?.agent ?? "claude";
    this.text = "";
    this.at = 0;
    this.places = null;
    const what = this.agent === "claude" ? "New session" : `New ${AGENTS[this.agent].name} session`;
    this.input = InputState.new({ value: "", placeholder: `${what} in…  (type to search every worktree)` });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.at = 0; cx.notify(); });
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
    // Each machine's places show as soon as they're read; this machine's come first.
    cx.spawn(async (cx) => {
      let placed = false;
      await this.find((list) => {
        this.places = list;
        const here = this.shown().findIndex((p) => p.here);
        if (!placed && here >= 0) { this.at = here; placed = true; }
        cx.notify();
      });
    });
  }

  // Per machine with open spaces (this one first): every checkout of the repos open there,
  // the folders open outside git, then ~/Developer and home here, home elsewhere.
  // `open`: something runs there now; the rest show only when searched for.
  async find(emit) {
    const h = appHome().replace(/\/\.config\/herdr-app\/?$/, "");
    const ps = panes();
    const active = spaces().find((s) => s.active);
    const hereTabs = new Set((active?.tabs ?? []).map((c) => c.id));
    const hereCwd = ps.find((p) => hereTabs.has(p.tab) && p.cwd)?.cwd ?? active?.folder;
    const hereOn = active?.machine ?? null;
    const ons = [null, ...new Set(spaces().map((s) => s.machine).filter(Boolean))];
    const away = new Set(machines().filter((m) => m.layout === "unavailable").map((m) => m.name));
    const per = ons.map(() => null);
    const show = () => {
      const out = per.flatMap((x) => x ?? []);
      const here = out.find((p) => p.machine === hereOn && !p.folder && hereCwd && (hereCwd === p.path || hereCwd.startsWith(p.path + "/")) && p.wt)
        ?? out.find((p) => p.machine === hereOn && hereCwd && (hereCwd === p.path || hereCwd.startsWith(p.path + "/")));
      for (const p of out) p.here = p === here;
      if (here) here.open = true;
      emit(out);
    };
    await Promise.all(ons.map(async (on, n) => {
      if (on && away.has(on)) { per[n] = [{ name: on, sub: "offline", folder: true, path: "~", machine: on, off: true, open: true }]; return show(); }
      const ids = new Set(spaces().filter((s) => (s.machine ?? null) === on).flatMap((s) => (s.tabs ?? []).map((c) => c.id)));
      const cwds = [...new Set(ps.filter((p) => ids.has(p.tab) && p.cwd).map((p) => p.cwd))];
      const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
      const repos = new Set(), folders = new Set();
      await Promise.all(cwds.map(async (cwd) => {
        const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
        if (common) repos.add(common.replace(/\/\.git\/?$/, "")); else folders.add(cwd);
      }));
      const mine = [];
      for (const main of [...repos].sort()) {
        const list = (await git(main, ["worktree", "list", "--porcelain"], on)) ?? "";
        for (const block of list.split(/\n\n+/)) {
          const lines = block.split("\n");
          const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
          if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
          const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? "detached";
          const used = cwds.some((c) => inside(c, path));
          mine.push({ name: base(main), sub: branch, wt: path !== main, path, machine: on, open: path === main || used });
        }
      }
      const fixed = on ? ["~"] : [`${h}/Developer`, h];
      for (const f of [...folders, ...fixed]) {
        if (mine.some((p) => p.path === f)) continue;
        mine.push({ name: f === h || f === "~" ? "Home" : base(f), sub: on ? `folder · ${on}` : "folder", folder: true, path: f, machine: on, open: true });
      }
      if (on) for (const p of mine) if (!p.folder) p.sub = `${p.sub} · ${on}`;
      per[n] = mine;
      show();
    }));
  }

  shown() {
    const q = this.text.trim().toLowerCase();
    return (this.places ?? []).filter((p) => q ? `${p.name} ${p.sub} ${p.path}`.toLowerCase().includes(q) : p.open);
  }

  go(p, terminal) {
    if (!p || p.off) return;
    closeOverlay(props().overlay);
    const argv = terminal ? null : AGENTS[this.agent].argv;
    run("space.new", { folder: p.path === "~" ? "" : p.path, ...(p.machine ? { machine: p.machine } : {}), ...(argv ? { argv } : {}), focus: true });
  }

  key(e, cx) {
    const list = this.shown();
    if (e.key === "escape") return closeOverlay(props().overlay);
    if (e.key === "enter") this.go(list[this.at], e.modifiers.alt);
    else if ((e.key === "down" || e.key === "up") && list.length) this.at = (this.at + (e.key === "down" ? 1 : list.length - 1)) % list.length;
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  render() {
    const t = theme();
    const list = this.shown();
    if (this.at >= list.length) this.at = Math.max(0, list.length - 1);
    const a = AGENTS[this.agent];
    return v_flex().id("grove-places").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().max_h_full().bg(t.popover).rounded(14).border_1().border_color(t.input).shadow_2xl().overflow_hidden()
      .child(h_flex().h(42).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/workspace-chrome/plus.svg").size(14).flex_none().text_color(t.muted))
        .child(Input.new(this.input).flex_1().h_full().text_size(14).text_color(t.foreground)))
      .child(v_flex().id("places").flex_1().min_h(0).overflow_y_scroll().p(6).gap(0)
        .when(this.places === null, (el) => el.child(div().h(ROW).px(10).flex().items_center().text_size(13).text_color(t.muted).child("Looking for places…")))
        .when(this.places !== null && !list.length, (el) => el.child(div().h(ROW).px(10).flex().items_center().text_size(13).text_color(t.muted).child(`Nothing matches “${this.text}”`)))
        .children(list.map((p, i) => h_flex().id(`pl-${i}`).h(ROW).flex_none().px(10).gap(8).items_center().rounded(9)
          .when(i === this.at, (el) => el.bg(t.hover))
          .when(Boolean(p.off), (el) => el.opacity(0.4))
          .hover((s) => s.bg(t.hover)).tooltip(p.machine ? `${p.machine}:${p.path}` : p.path)
          .on_click((e) => this.go(p, e.modifiers.alt))
          .child(svg(p.folder ? "mods/workspace-chrome/folder.svg" : "mods/workspace-chrome/git-branch.svg").size(13).flex_none().text_color(t.muted))
          .child(div().flex_none().text_size(13.5).text_color(t.foreground).child(p.name))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(p.wt ? `worktree · ${p.sub}` : p.sub)))))
      .child(h_flex().h(30).flex_none().px(14).gap(14).items_center().border_t(1).border_color(t.border).text_size(11.5).text_color(t.dim)
        .child(div().child(`↵ ${a.name}`))
        .when(this.agent !== "terminal", (el) => el.child(div().child("⌥↵ Terminal")))
        .child(div().flex_1())
        .child(div().child("esc")));
  }
}
