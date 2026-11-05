// Ask before closing a tab or a space, in sleeve-confirm.
import { spaces, panes, openOverlay } from "herdr";

const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

// What the sidebar calls a tab: its given name, else what its program set as the title.
function label(tab) {
  if (tab.named) return tab.name;
  const here = panes().filter((p) => p.tab === tab.id);
  const p = here.find((x) => x.program?.agent) ?? here.find((x) => x.focused) ?? here[0];
  const title = (p?.title ?? "").replace(/^[^\p{L}\p{N}~/.]+/u, "").trim();
  return (/[\p{L}\p{N}]/u.test(title) && title) || p?.program?.name || `Tab ${tab.name}`;
}

export function askClose(kind, id) {
  const all = spaces();
  const space = kind === "space" ? all.find((s) => s.id === id) : all.find((s) => s.tabs.some((c) => c.id === id));
  if (!space) return;
  const tab = kind === "tab" ? space.tabs.find((c) => c.id === id) : null;
  const whole = !tab || space.tabs.length === 1;
  const tabs = whole ? space.tabs : [tab];
  const panesIn = tabs.reduce((n, c) => n + (c.panes ?? 0), 0);
  const what = [plural(tabs.length, "tab"), panesIn ? plural(panesIn, "pane") : null].filter(Boolean).join(", ");
  openOverlay({
    mod: "sleeve-confirm", kind: "dialog", frame: "none", width: 320, height: 146,
    props: {
      title: whole ? `Close ${space.name}?` : `Close ${label(tab)}?`,
      detail: whole ? `${what} will stop.` : `In ${space.name}, its panes will stop.`,
      verb: whole ? "Close space" : "Close tab",
      command: whole ? { name: "space.close", args: { id: space.id, confirmed: true } } : { name: "tab.close", args: { id: tab.id, confirmed: true } },
    },
  });
}
