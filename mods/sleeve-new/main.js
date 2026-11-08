import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, spaces, panes, knownAgents, run, openOverlay, closeOverlay, props, window, keys, shared, setShared } from "herdr";

function shortcut(name) {
  const k = keys().find(b => b.section === "global" && b.action === name);
  if (!k?.keys.trim()) return "";
  const mac = window()?.platform === "macos";
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", fn: "Fn" };
  const alias = { secondary: mac ? "cmd" : "ctrl", super: "cmd", win: "cmd" };
  return k.keys.trim().split(/\s+/).map(stroke => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") { key = "-"; parts.pop(); }
    const held = new Set(parts.map(m => alias[m.toLowerCase()] ?? m.toLowerCase()));
    if (/^[A-Z]$/.test(key)) held.add("shift");
    const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase();
    return [...Object.keys(names).filter(m => held.has(m)).map(m => names[m]), label].join(mac ? "" : "+");
  }).join(" ");
}

export default class NewMenu extends View {
  init(_props, cx) {
    // Shows the last list at once; asking the shell takes a moment.
    const on = spaces().find(s => s.active)?.machine;
    const key = `new.agents.${on ?? "local"}`;
    this.agents = shared(key) ?? [];
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async cx => {
      try {
        const fresh = await knownAgents({ on });
        if (JSON.stringify(fresh) !== JSON.stringify(this.agents)) setShared(key, fresh);
        this.agents = fresh;
      } catch { this.failed = true; }
      cx.notify();
    });
  }
  row(id, icon, name, action, hint = "", enabled = true) {
    const t = theme();
    return h_flex().id(id).h(31).px(10).gap(9).rounded(7).items_center().flex_none()
      .text_color(enabled ? t.foreground : t.dim).when(enabled, el => el.hover(s => s.bg(t.selected)))
      .on_click(() => { if (enabled) { closeOverlay(props().overlay); action(); } })
      .child(icon).child(div().flex_1().child(name)).child(div().text_size(12).child(hint));
  }
  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const installed = this.agents.filter(a => a.installed);
    const choices = [...installed, ...this.agents.filter(a => !a.installed).slice(0, 2)];
    return v_flex().min_h(0).w_full().h(Math.min(491, 180 + Math.max(1, choices.length) * 32)).p(5).gap(2).rounded(12).overflow_hidden().border_1().border_color(t.input).bg(t.popover).shadow_2xl().text_size(12.8).font_semibold()
      .id("new-menu").track_focus(this.handle)
      .on_key_down((e) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        const agent = /^[1-9]$/.test(e.key) ? installed[Number(e.key) - 1] : null;
        if (!agent) return;
        closeOverlay(props().overlay);
        run("tab.new", { name: agent.name, space: space?.id, argv: agent.run });
      })
      .child(this.row("terminal", image("mods/sleeve-spaces/icons/app-terminal.svg").size(18), "Terminal", () => run("tab.new", { space: space?.id }), shortcut("tab.new")))
      .child(div().px(10).pt(8).pb(4).text_size(11).font_semibold().text_color(t.dim).child("Start an agent"))
      .child(v_flex().id("new-agents").flex_1().min_h(0).gap(2).overflow_y_scroll()
        .children(choices.map((a, i) => this.row(a.key, a.tint ? svg(a.icon).size(16) : image(a.icon).size(18), a.name,
          () => run("tab.new", { name: a.name, space: space?.id, argv: a.run }), a.installed ? (i < 9 ? String(i + 1) : "") : "not installed", a.installed)))
        .when(this.agents.length === 0, el => el.child(div().px(9).py(6).text_color(t.dim).child(this.failed ? "Could not load agents" : "Checking installed agents…"))))
      .child(div().h(1).mx(10).my(4).bg(t.border))
      .child(this.row("space", div().w(18).flex().justify_center().child(svg("mods/sleeve-chrome/icons/plus.svg").size(15)), "New space", () => run("space.new"), shortcut("space.new")))
      .child(this.row("worktree", image("mods/sleeve-spaces/icons/app-branch.svg").size(18), "New worktree…", () => openOverlay({ mod: "sleeve-worktree", kind: "dialog", frame: "none", width: 460, height: 158, props: { space: space?.id, folder: panes().find(p => p.focused)?.cwd, action: "new" } }), "", Boolean(space)))
      .child(this.row("worktree-open", image("mods/sleeve-spaces/icons/app-branch.svg").size(18), "Open worktree\u2026", () => openOverlay({ mod: "sleeve-worktree", kind: "dialog", frame: "none", width: 560, height: 480, props: { space: space?.id, folder: panes().find(p => p.focused)?.cwd, action: "open" } }), "", Boolean(space)));
  }
}
