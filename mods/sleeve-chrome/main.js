// The sidebar's two bars. Top (default): go to, history and the one + menu, beside the
// window buttons. Footer (props { part: "footer" }): settings, and the side panel's
// Images, Files and Changes, remembered per space.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, updates, layout, keys, props, spaces, agents, shared, setShared, knownAgents, openOverlay, appHome } from "herdr";
import * as fs from "fs/promises";

const GLYPHS = { cmd: "⌘", shift: "⇧", ctrl: "⌃", alt: "⌥" };
// A control's tooltip: what it does, then its key.
function hint(label, action) {
  const k = keys().find(b => b.action === action && b.section !== "terminal")?.keys;
  return k ? `${label}   ${k.split("-").map(p => GLYPHS[p] ?? p.toUpperCase()).join("")}` : label;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
const footer = () => props()?.part === "footer";

// Herdr draws notifications with its shipped `toast` mod and has no setting to pick
// another, and it restores an edited shipped mod at start. So while this layout runs the
// sleeve version (toast/main.js.txt) stands in for it, and the original goes back on quit
// or when this layout closes; a start after a crash finds it as `toast-edited`, removed here.
const MARK = "// sleeve-toast:";
const TOAST = () => `${appHome()}/mods/toast/main.js`;
const KEPT = () => `${appHome()}/mods/sleeve-chrome/.toast-original.js`;

async function swapToast() {
  const now = await fs.readFile(TOAST(), "utf8");
  if (!now.startsWith(MARK)) await fs.writeFile(KEPT(), now);
  const ours = await fs.readFile(`${appHome()}/mods/sleeve-chrome/toast/main.js.txt`, "utf8");
  if (now !== ours) await fs.writeFile(TOAST(), ours);
  for (const name of await fs.readdir(`${appHome()}/mods`)) {
    if (!/^toast-edited(-\d+)?$/.test(name)) continue;
    const dir = `${appHome()}/mods/${name}`;
    const main = await fs.readFile(`${dir}/main.js`, "utf8").catch(() => "");
    if (!main.startsWith(MARK)) continue;
    for (const f of await fs.readdir(dir)) await fs.unlink(`${dir}/${f}`).catch(() => {});
    await fs.rmdir(dir).catch(() => {});
  }
}

const PANELS = [
  { id: "images", label: "Images", icon: "mods/sleeve-chrome/icons/images.svg" },
  { id: "files", label: "Files", icon: "mods/sleeve-chrome/icons/file.svg" },
  { id: "changes", label: "Changes", icon: "mods/sleeve-chrome/icons/changes.svg" },
];

export default class SleeveChrome extends View {
  init(_props, cx) {
    if (!footer()) return;
    // The + menu opens with this list ready.
    cx.spawn(async () => { try { setShared("new.agents.local", await knownAgents({})); } catch {} });
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    cx.spawn(async () => { try { await swapToast(); } catch (e) { console.log(`sleeve-toast: ${e}`); } });
  }

  async close() {
    if (!footer()) return;
    const kept = await fs.readFile(KEPT(), "utf8").catch(() => null);
    if (kept) await fs.writeFile(TOAST(), kept);
  }

  button(id, icon, tip, action, on = false, big = false) {
    const t = theme();
    return div().id(id).size(big ? 30 : 28).flex_none().flex().items_center().justify_center().rounded(8)
      .text_color(on ? t.foreground : t.muted).when(on, el => el.bg(t.selected))
      .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(svg(icon).size(big ? 16 : 15));
  }

  // Switching spaces shows that space's panel (closed if it never had one); opening
  // or closing it records the choice.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  // When each agent last changed state, for the inbox's "how long ago". Done and idle
  // count as one: looking at a finished agent isn't the agent doing anything.
  stamp(list) {
    const since = shared("inbox.since") ?? {}, now = Date.now(), next = {};
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      next[a.address] = since[a.address]?.s === s ? since[a.address] : { s, at: now };
      if (next[a.address] !== since[a.address]) dirty = true;
    }
    if (dirty || Object.keys(since).length !== list.length) setShared("inbox.since", next);
  }

  inbox(t, list) {
    const waiting = list.filter((a) => a.status === "blocked" || a.status === "done");
    const blocked = waiting.some((a) => a.status === "blocked");
    const color = blocked ? t.blocked : t.done;
    return div().id("inbox").h(28).flex_none().flex().items_center().gap(6).rounded(8)
      .when(waiting.length > 0, (el) => el.pl(7).pr(9))
      .when(!waiting.length, (el) => el.w(28).justify_center())
      .text_color(waiting.length ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(hint("Inbox", "mod.open:sleeve-inbox"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => run("mod.open", { name: "sleeve-inbox" }))
      .child(svg("mods/sleeve-chrome/icons/inbox.svg").size(16))
      .when(waiting.length > 0, (el) => el.child(h_flex().gap(5).items_center()
        .child(div().size(6).rounded_full().bg(color))
        .child(div().text_size(12).font_bold().child(String(waiting.length)))));
  }

  // Beside the window buttons, as in Rex: the sidebar toggle, then go to, history and +.
  top(t, collapsed) {
    const add = () => openOverlay({ mod: "sleeve-new", kind: "popup", frame: "none", width: 240, height: 512 });
    return h_flex().size_full().pl(74).gap(4).items_center()
      .when(!collapsed, el => el
        .child(this.button("sidebar", "mods/sleeve-chrome/icons/sidebar.svg", hint("Hide sidebar", "layout.toggle:sidebar"), () => run("layout.toggle", { id: "sidebar" }), false, true))
        .child(div().w(8))
        .child(this.button("search", "mods/sleeve-chrome/icons/command.svg", hint("Go to", "mod.open:sleeve-picker"), () => run("mod.open", { name: "sleeve-picker" }), false, true))
        .child(this.button("history", "mods/sleeve-chrome/icons/history.svg", hint("Agent history", "mod.open:sleeve-history"), () => run("mod.open", { name: "sleeve-history" }), false, true))
        .child(this.button("new", "mods/sleeve-chrome/icons/plus.svg", hint("New", "tab.new"), add, false, true)));
  }

  bottom(t, collapsed) {
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "images"];
    this.syncPanel(spaces().find(s => s.active), panel, body, enabled);
    const toggle = (p) => {
      const on = Boolean(panel && !panel.hidden && body?.active === p.id);
      return this.button(`panel-${p.id}`, p.icon, p.label, () => {
        if (on) run("layout.hide", { id: "panel" });
        else { run("layout.select", { stack: "panel-body", child: p.id }); run("layout.show", { id: "panel" }); }
      }, on);
    };
    const list = agents();
    this.stamp(list);
    return h_flex().size_full().px(8).gap(2).items_center().when(collapsed, el => el.justify_center())
      .child(this.inbox(t, list))
      .child(div().relative()
        .child(this.button("settings", "mods/sleeve-chrome/icons/settings.svg", hint("Settings", "app.settings"), () => run("app.settings")))
        .when(Boolean(updates().app.ready), el => el.child(div().absolute().top(4).right(4).size(6).rounded_full().bg(t.accent))))
      .when(!collapsed, el => el.child(div().flex_1())
        .children(PANELS.filter(p => enabled.includes(p.id)).map(toggle)));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    return footer() ? this.bottom(t, collapsed) : this.top(t, collapsed);
  }
}
