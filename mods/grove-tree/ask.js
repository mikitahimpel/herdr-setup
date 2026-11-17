// Asks before closing a tab or a session (grove-confirm) and renames one (sleeve-prompt),
// so these dialogs wear the layout's theme instead of Herdr's own.
import { spaces, panes, openOverlay } from "herdr";

const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

// What grove's sidebar calls a tab: the name given; else its agent's title unless that is
// only the program's name or a command line; else the program's name.
function shownName(tab) {
  const here = panes().filter((p) => p.tab === tab.id);
  const pane = here.find((x) => x.program?.agent) ?? here.find((x) => x.focused) ?? here[0];
  const program = pane?.program;
  const plain = (s) => !s || s.toLowerCase() === (program?.name ?? "").toLowerCase() || /^[\w.-]+ --?\w/.test(s);
  if (tab.named && !plain(tab.name)) return tab.name;
  const title = (pane?.title ?? "").replace(/^[^\p{L}\p{N}~/.]+/u, "").trim();
  if (title && /[\p{L}\p{N}]/u.test(title) && !plain(title) && !/^(~|\/)/.test(title) && !/^[^\s@]+@[^\s:]+/.test(title)) return title;
  return program?.agent ? program.name : program && !program.shell && program.name ? program.name : "Terminal";
}

function find(kind, id) {
  const all = spaces();
  const space = kind === "space"
    ? all.find((s) => (id ? s.id === id : s.active))
    : all.find((s) => (id ? s.tabs.some((c) => c.id === id) : s.active));
  const tab = kind === "tab" ? space?.tabs.find((c) => (id ? c.id === id : c.active)) : null;
  return { space, tab };
}

// The dialogs as overlay specs, for a menu item's `open`; null when it's gone.
// `id` left out: the active tab or session.
export function closeDialog(kind, id) {
  const { space, tab } = find(kind, id);
  if (!space || (kind === "tab" && !tab)) return null;
  const whole = !tab || space.tabs.length === 1;
  const tabs = whole ? space.tabs : [tab];
  const panesIn = tabs.reduce((n, c) => n + (c.panes ?? 0), 0);
  const what = [plural(tabs.length, "tab"), panesIn ? plural(panesIn, "pane") : null].filter(Boolean).join(", ");
  return {
    mod: "grove-confirm", kind: "dialog", frame: "none", width: 340, height: 150,
    props: {
      title: whole ? "Close this session?" : "Close this tab?",
      name: whole ? space.name : shownName(tab),
      detail: whole ? `${what} will stop` : space.name,
      verb: whole ? "Close session" : "Close tab",
      command: whole ? { name: "space.close", args: { id: space.id, confirmed: true } } : { name: "tab.close", args: { id: tab.id, confirmed: true } },
    },
  };
}

// An unnamed one starts empty with its shown name as the placeholder; empty goes back to Herdr's.
export function renameDialog(kind, id) {
  const { space, tab } = find(kind, id);
  if (!space || (kind === "tab" && !tab)) return null;
  const named = tab ? tab.named : space.named;
  const shown = tab ? shownName(tab) : space.name;
  return {
    mod: "sleeve-prompt", kind: "dialog", frame: "none", width: 440, height: 86,
    props: {
      title: tab ? "Rename tab" : "Rename session",
      hint: tab ? "empty: its number" : "empty: folder name",
      value: named ? shown : "",
      placeholder: shown,
      command: { name: tab ? "tab.rename" : "space.rename", args: { id: tab ? tab.id : space.id } },
    },
  };
}

export const askClose = (kind, id) => { const d = closeDialog(kind, id); if (d) openOverlay(d); };
export const askRename = (kind, id) => { const d = renameDialog(kind, id); if (d) openOverlay(d); };
