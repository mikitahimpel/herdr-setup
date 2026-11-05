// Agents running on the herdr TUI's servers, as records the agents list can show
// beside the app's own. Reading never changes them; opening one attaches a tab with
// `herdr terminal attach`, so it keeps running there and closing the tab only detaches.

import { exec, hc, knownAgents, notify, playSound, panes, run, spaces } from "herdr";

const LOCAL_EVERY = 3000;
const REMOTE_EVERY = 15000;

async function herdr(prefix, args) {
  const r = await exec("herdr", [...prefix, ...args]);
  return JSON.parse(r.stdout);
}

async function read(prefix) {
  const [w, a] = await Promise.all([herdr(prefix, ["workspace", "list"]), herdr(prefix, ["agent", "list"])]);
  const places = new Map(w.result.workspaces.map(x => [x.workspace_id, x]));
  return a.result.agents.map(x => ({ ...x, workspace_label: places.get(x.workspace_id)?.label ?? "", worktree: places.get(x.workspace_id)?.worktree ?? null }));
}

export class TuiAgents {
  constructor() {
    this.sources = new Map();
    this.tabs = JSON.parse(localStorage.getItem("tui-tabs") ?? "{}");
    this.programs = new Map();
    this.last = new Map();
  }

  start(cx) {
    cx.timer.every(LOCAL_EVERY, (cx) => this.refreshLocal(cx));
    cx.timer.every(REMOTE_EVERY, (cx) => this.refreshRemote(cx));
    cx.spawn(async (cx) => {
      for (const p of await knownAgents().catch(() => [])) this.programs.set(p.key, p);
      cx.notify();
    });
    this.refreshLocal(cx);
    this.refreshRemote(cx);
    this.checked = new Set();
    cx.timer.every(10000, (cx) => this.adopt(cx));
    this.adopt(cx);
  }

  // Which tabs show a TUI agent, read from what their terminal runs
  // (`herdr [--session s] terminal attach <id>`), so a tab attached outside this mod,
  // or before its saved list was lost, still counts. Each terminal is asked once.
  adopt(cx) {
    const fresh = panes().filter((p) => p.terminal && !p.terminal.includes("/") && !this.checked.has(p.terminal));
    if (!fresh.length) return;
    cx.spawn(async (cx) => {
      let found = false;
      for (const p of fresh) {
        this.checked.add(p.terminal);
        try {
          const r = await hc(["get", p.terminal, "--json"]);
          const argv = JSON.parse(r.stdout).foreground?.argv ?? [];
          const at = argv.indexOf("attach");
          if (argv[0] !== "herdr" || at < 0 || argv[at - 1] !== "terminal") continue;
          const s = argv.indexOf("--session");
          const key = `local/${s >= 0 ? argv[s + 1] : "default"}|${argv[at + 1]}`;
          if (this.tabs[key] !== p.tab) { this.tabs[key] = p.tab; found = true; }
        } catch {}
      }
      if (!found) return;
      localStorage.setItem("tui-tabs", JSON.stringify(this.tabs));
      cx.notify();
    });
  }

  // Unreachable means unknown: its agents leave the list rather than show a stale state.
  async load(key, source) {
    source.agents = await read(source.prefix).catch(() => []);
    this.sources.set(key, source);
    for (const a of source.agents) this.alert(key, a);
  }

  alert(key, a) {
    const id = `${key}|${a.terminal_id}`, was = this.last.get(id), now = a.agent_status;
    this.last.set(id, now);
    if (was === undefined || was === now) return;
    const title = a.terminal_title_stripped || a.agent;
    if (now === "blocked") {
      playSound("blocked");
      notify({ title: "Needs you", body: `${a.workspace_label} · ${title}` });
    } else if (was === "working" && (now === "done" || now === "idle")) {
      playSound("done");
      notify({ title: "Finished", body: `${a.workspace_label} · ${title}` });
    }
  }

  refreshLocal(cx) {
    if (this.localBusy) return;
    this.localBusy = true;
    cx.spawn(async (cx) => {
      try {
        const { sessions } = await herdr([], ["session", "list", "--json"]);
        const live = sessions.filter(s => s.running);
        await Promise.all(live.map(s => this.load(`local/${s.name}`, { prefix: s.default ? [] : ["--session", s.name], machine: null })));
        const keep = new Set(live.map(s => `local/${s.name}`));
        for (const k of this.sources.keys()) if (k.startsWith("local/") && !keep.has(k)) this.sources.delete(k);
      } catch (_e) {
        for (const k of this.sources.keys()) if (k.startsWith("local/")) this.sources.delete(k);
      }
      this.localBusy = false;
      cx.notify();
    });
  }

  refreshRemote(cx) {
    if (this.remoteBusy) return;
    this.remoteBusy = true;
    cx.spawn(async (cx) => {
      const saved = await herdr([], ["machine", "list", "--json"]).catch(() => []);
      await Promise.all(saved.filter(m => m.enabled).map(m => this.load(`machine/${m.label}`, { prefix: ["--machine", m.label], machine: m.label })));
      this.remoteBusy = false;
      cx.notify();
    });
  }

  shownTab(key) {
    for (const s of spaces()) {
      const tab = s.tabs.find(t => t.id === this.tabs[key]);
      if (tab) return { space: s, tab };
    }
    return null;
  }

  // Shaped like the app's AgentInfo, so the list treats both the same.
  agents() {
    return [...this.sources.entries()].flatMap(([source, s]) => s.agents.map(a => {
      const key = `${source}|${a.terminal_id}`;
      const shown = this.shownTab(key);
      const status = a.agent_status === "unknown" ? "idle" : a.agent_status;
      return {
        address: `tui:${key}`,
        pane: null,
        space: `tui:${source}:${a.workspace_id}`,
        space_name: a.workspace_label,
        tab: shown?.tab.id ?? null,
        status,
        app: a.agent,
        program: this.programs.get(a.agent) ?? { key: a.agent, name: a.agent, icon: null, tint: false },
        title: a.terminal_title_stripped || "",
        seq: a.state_change_seq ?? 0,
        focused: Boolean(shown?.space.active && shown.tab.active),
        tui: { key, source: s, terminal: a.terminal_id, pane: a.pane_id, cwd: a.cwd, worktree: a.worktree },
      };
    }));
  }

  open(a, cx) {
    const shown = this.shownTab(a.tui.key);
    if (shown) {
      run("space.select", { id: shown.space.id });
      run("tab.select", { id: shown.tab.id });
      return;
    }
    const { source, terminal, cwd } = a.tui;
    // --machine can't carry an attach, so a machine's agents attach from a space on that machine.
    const argv = ["herdr", ...(source.machine ? [] : source.prefix), "terminal", "attach", terminal];
    const space = spaces().find(s => s.name === a.space_name && (s.machine ?? null) === source.machine);
    const name = (a.title || a.program.name).slice(0, 40);
    const args = space
      ? ["do", "tab.new", JSON.stringify({ name, space: space.id, argv })]
      : ["do", "space.new", JSON.stringify({ name: a.space_name, tab: name, folder: cwd, argv, machine: source.machine ?? undefined })];
    cx.spawn(async (cx) => {
      const r = await exec("herdr-app", args).catch(e => ({ stdout: "", stderr: String(e) }));
      try {
        const made = JSON.parse(r.stdout);
        if (made.error) throw new Error(made.error);
        this.tabs[a.tui.key] = made.tab;
        localStorage.setItem("tui-tabs", JSON.stringify(this.tabs));
      } catch (e) {
        notify({ title: "Couldn't open that agent", body: String(e.message ?? r.stderr), level: "error" });
      }
      cx.notify();
    });
  }
}
