// Context menus for the sleeve layout, from the app's menu mod. Opened as a popup with
// props { tab: "pane" | "tab" | "space" | "global", target }.
// ↑/↓ move, Enter runs, Esc closes. An item is [label, command, args];
// a command "worktree" opens the worktree dialog instead.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, terminals, spaces, panes, exec, setShared } from "herdr";
import { askClose, askRename } from "./ask.js";

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

// What "Copy ID" puts on the clipboard: a name and the hc address(es) an agent in
// Herdr can use (`hc read t5j`), e.g. "perf-tabs (t5j)".
function tabTerminals(id) {
  const tab = spaces().flatMap((s) => s.tabs ?? []).find((c) => c.id === id);
  const listed = (tab?.terminals ?? []).filter((x) => x?.terminal);
  // Its agent first, as the tab shows it.
  const agent = listed.find((x) => x.app && x.app !== "shell") ?? listed[0];
  const rest = listed.filter((x) => x !== agent);
  if (agent) return [agent, ...rest].map((x) => x.terminal);
  return panes().filter((p) => p.tab === id && typeof p.terminal === "string").map((p) => p.terminal);
}

function reference(p) {
  const tg = p.target ?? {};
  if (p.tab === "pane") {
    const term = terminals().find((t) => t.address === tg.terminal);
    return term ? `${term.name || term.address} (${term.address})` : null;
  }
  if (p.tab === "tab") {
    const tab = spaces().flatMap((s) => s.tabs ?? []).find((c) => c.id === tg.id);
    const ids = tabTerminals(tg.id);
    return ids.length ? `${tab?.name ?? "tab"} (${ids.join(", ")})` : null;
  }
  if (p.tab === "space") {
    const space = spaces().find((s) => s.id === tg.id);
    if (!space) return null;
    const ids = (space.tabs ?? []).flatMap((c) => tabTerminals(c.id).slice(0, 1));
    return `space ${space.name} (${ids.join(", ") || space.id})`;
  }
  return null;
}

const copyItem = (p) => {
  const text = reference(p ?? {});
  return text ? [["Copy ID", "copy", { text }]] : [];
};

function items(p, git) {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "pane": {
      // A kept sub-agent can go back under its parent, still running.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      return [
        ["Split right", "pane.split", { direction: "right", pane: tg.pane }],
        ["Split down", "pane.split", { direction: "down", pane: tg.pane }],
        ["Zoom", "pane.zoom", { pane: tg.pane }],
        ...(term
          ? [
              toProgram
                ? ["Use Herdr right-click menu", "terminal.right_click", { terminal: term.address, to: "menu" }]
                : ["Send right-clicks to pane", "terminal.right_click", { terminal: term.address, to: "program" }],
            ]
          : []),
        ...(parent ? [[`Send back to ${parent.name || parent.address}`, "terminal.park", { terminal: term.address }]] : []),
        ...copyItem(p),
        ["Close pane", "pane.close", { pane: tg.pane }],
      ];
    }
    case "tab":
      return [
        ["Rename", "tab.rename", { id: tg.id }],
        ["New tab", "tab.new", { space: tg.space }],
        ["Ask Claude here\u2026", "ask", { space: tg.space }],
        ...copyItem(p),
        ["Close", "tab.close", { id: tg.id }],
      ];
    case "space":
      return [
        ["Rename", "space.rename", { id: tg.id }],
        ["Ask Claude here\u2026", "ask", { space: tg.id }],
        ...(git ? [["New worktree", "worktree", { space: tg.id, action: "new" }], ["Open worktree", "worktree", { space: tg.id, action: "open" }]] : []),
        ...(git === "linked" ? [["Remove worktree", "worktree", { space: tg.id, action: "remove" }]] : []),
        ...copyItem(p),
        ["Close", "space.close", { id: tg.id }],
      ];
    default:
      return [
        ["New space", "space.new", {}],
        ["Keybinds", "app.help", {}],
        ["Theme: graphite", "app.theme", { name: "graphite" }],
        ["Theme: ink", "app.theme", { name: "ink" }],
        ["Theme: moss", "app.theme", { name: "moss" }],
        ["Theme: atom one dark", "app.theme", { name: "atom-one-dark" }],
      ];
  }
}

const GLYPHS = { cmd: "⌘", shift: "⇧", ctrl: "⌃", alt: "⌥", enter: "↩", left: "←", right: "→", up: "↑", down: "↓" };

function menuIcon(command) {
  const name = command.endsWith(".close") ? "x" : command.endsWith(".rename") ? "square-pen" : command.endsWith(".new") ? "plus" : command === "worktree" ? "git-branch" : command === "app.help" ? "terminal" : command === "app.theme" ? "settings" : command === "pane.split" ? "panel-right" : command === "pane.zoom" ? "square" :  "terminal";
  if (command === "ask") return "mods/sleeve-ask/sparkles.svg";
  return command === "copy" ? "mods/sleeve-chrome/icons/copy.svg" : `mods/workspace-chrome/${name}.svg`;
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys.split("-").map((p) => GLYPHS[p] ?? p.toUpperCase()).join("") : "";
}

export default class Menu extends View {
  init(_props, cx) {
    // While a menu is open the sidebar shows no hover card (hover.js).
    setShared("sleeve.menu", true);
    this.at = 0;
    this.git = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    const space = p?.tab === "space" && spaces().find((s) => s.id === p.target?.id);
    const folder = space && place(space);
    if (p?.git !== undefined) this.git = p.git;
    else if (folder)
      cx.spawn(async (cx) => {
        this.git = await checkout(folder, space.machine).catch(() => null);
        cx.notify();
      });
  }

  async close() {
    setShared("sleeve.menu", false);
  }

  choose(i, cx) {
    const it = items(props(), this.git)[i];
    if (!it) return;
    closeOverlay(props()?.overlay);
    if (it[1] === "ask") openOverlay({ mod: "sleeve-ask", kind: "dialog", frame: "none", width: 560, height: 136, props: it[2] });
    else if (it[1] === "copy") exec("sh", ["-c", 'printf %s "$0" | pbcopy', it[2].text]).catch(() => {});
    else if (it[1] === "worktree") openOverlay({ mod: "sleeve-worktree", kind: "dialog", frame: "none", ...(it[2].action === "open" ? { width: 560, height: 480 } : it[2].action === "remove" ? { width: 380, height: 176 } : { width: 460, height: 158 }), props: it[2] });
    else if (it[1] === "tab.rename" || it[1] === "space.rename") askRename(it[1] === "tab.rename" ? "tab" : "space", it[2].id);
    else if (it[1] === "tab.close" || it[1] === "space.close") askClose(it[1] === "tab.close" ? "tab" : "space", it[2].id);
    else run(it[1], it[2]);
  }

  render(cx) {
    const t = theme();
    const list = items(props(), this.git);
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .gap(2)
      .rounded(12)
      .overflow_hidden()
      .border_1()
      .border_color(t.input)
      .bg(t.popover)
      .shadow_2xl()
      .text_size(12.8).font_semibold()
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) =>
          v_flex()
            .when(i > 0 && (it[1].endsWith(".close") || it[1] === "app.help" || (it[1] === "app.theme" && list[i - 1][1] !== "app.theme")), el => el.child(div().mx(12).my(4).h(1).bg(t.border)))
            .child(h_flex()
            .id(`mi-${i}`)
            .h(31)
            .px(12)
            .gap(9)
            .rounded(7)
            .items_center()
            .justify_between()
            .text_color(t.foreground)
            .when(i === this.at, (el) => el.bg(t.selected))
            .on_hover((on, cx) => { if (on) { this.at = i; cx.notify(); } })
            .on_click((_e, cx) => this.choose(i, cx))
            .child(svg(menuIcon(it[1])).size(14).flex_none())
            .child(div().flex_1().child(it[0]))
            .child(div().flex_none().max_w(140).truncate().text_size(12).text_color(t.muted).child(it[1] === "copy" ? (/\(([^)]*)\)$/.exec(it[2].text)?.[1] ?? "") : shortcut(it[1], it[2])))),
        ),
      );
  }
}
