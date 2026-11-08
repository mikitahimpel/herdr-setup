// Brings Claude Code back after a reboot. herdr-core keeps each pane's terminal, but a
// lost one (reboot, logout, core crash) comes back as a bare shell at the same address.
// Every few seconds this remembers which panes run Claude and in which session; when a
// remembered pane's shell has a new pid and Claude is gone, the terminal was lost, and a
// card offers to run `claude --resume <session>` there. A pane whose Claude exited while
// its shell stayed is forgotten, not offered.
//
// Shown as a floating block (layouts/sleeve.json, id "resume"); it draws nothing until
// there is something to resume.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, exec, hc, home, readTextFile, spaces, terminals, theme, run } from "herdr";

const EVERY_MS = 4000;
const SLOW_MS = 60000;
const KEY = "panes";
// Flags worth keeping on resume; anything else (a prompt, -p) belongs to the first run.
const WITH_VALUE = new Set(["--model", "--permission-mode", "--add-dir", "--agent", "--settings", "--mcp-config"]);
const ALONE = new Set(["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--verbose"]);

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function keptFlags(argv) {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const name = a.split("=")[0];
    if (ALONE.has(a)) out.push(a);
    else if (WITH_VALUE.has(name) && a.includes("=")) out.push(a);
    else if (WITH_VALUE.has(a) && i + 1 < argv.length) out.push(a, argv[++i]);
  }
  return out;
}

const isClaude = (fg) => !!fg && /(^|\/)claude$/.test(fg.argv?.[0] ?? "");

async function getTerminal(address) {
  try {
    const r = await hc(["get", address, "--json"]);
    return r.code === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    return null;
  }
}

async function sessionOf(pid) {
  const text = await readTextFile(`${home()}/.claude/sessions/${pid}.json`).catch(() => null);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function hasTranscript(session) {
  try {
    const r = await exec("sh", ["-c", 'ls "$HOME"/.claude/projects/*/"$1".jsonl', "sh", session]);
    return r.code === 0;
  } catch {
    return false;
  }
}

export default class SleeveResume extends View {
  init(_props, cx) {
    // address -> { shell, pid, session, cwd, flags, space, tab, lost }
    try {
      this.panes = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    } catch {
      this.panes = {};
    }
    this.saved = JSON.stringify(this.panes);
    this.busy = false;
    this.sig = null;
    this.scanned = 0;
    cx.timer.every(EVERY_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  save() {
    const text = JSON.stringify(this.panes);
    if (text === this.saved) return false;
    localStorage.setItem(KEY, text);
    this.saved = text;
    return true;
  }

  // What Herdr already holds in memory about Claude panes. While it stays the same,
  // nothing started, stopped or was lost, so the hc and file reads can wait for the
  // slow pass (which catches a /clear or /resume switching the session).
  signature() {
    const claude = new Set(agents().filter((a) => a.app === "claude-code").map((a) => a.address));
    return terminals()
      .filter((t) => !t.address.includes("/") && (claude.has(t.address) || t.agent === "claude-code" || t.address in this.panes))
      .map((t) => `${t.address}:${claude.has(t.address)}:${t.agent ?? ""}:${t.state ?? ""}`)
      .sort()
      .join(" ");
  }

  refresh(cx) {
    if (this.busy) return;
    const sig = this.signature();
    if (sig === this.sig && Date.now() - this.scanned < SLOW_MS) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        await this.scan();
        this.sig = sig;
        this.scanned = Date.now();
      } finally {
        this.busy = false;
      }
      if (this.save()) cx.notify();
    });
  }

  async scan() {
    // Only this computer's panes Herdr shows; nothing yet means the core is still loading.
    const shown = new Map(
      terminals()
        .filter((t) => !t.address.includes("/") && t.labels?.["herdr.space"])
        .map((t) => [t.address, t]),
    );
    if (shown.size === 0) return;

    const running = agents().filter((a) => a.app === "claude-code" && shown.has(a.address)).map((a) => a.address);
    const addresses = new Set([...Object.keys(this.panes), ...running]);

    for (const address of addresses) {
      const known = this.panes[address];
      if (!shown.has(address)) {
        delete this.panes[address];
        continue;
      }
      const t = await getTerminal(address);
      if (!t || t.state !== "live") continue;

      if (isClaude(t.foreground)) {
        const s = await sessionOf(t.foreground.pid);
        this.panes[address] = {
          shell: t.pid,
          pid: t.foreground.pid,
          session: s?.sessionId ?? known?.session ?? null,
          cwd: s?.cwd ?? t.foreground.cwd ?? t.cwd,
          flags: keptFlags(t.foreground.argv ?? []),
          space: t.labels?.["herdr.space"],
          tab: t.labels?.["herdr.tab"],
          lost: false,
        };
      } else if (known && !known.lost) {
        // A new shell pid means the core replaced a lost terminal; the same one means
        // Claude simply exited in it.
        if (known.shell !== t.pid) known.lost = true;
        else delete this.panes[address];
      }
    }
  }

  lost() {
    return Object.entries(this.panes)
      .filter(([, p]) => p.lost)
      .map(([address, p]) => ({ address, ...p }));
  }

  where(p) {
    const space = spaces().find((s) => s.id === p.space);
    const tab = space?.tabs.find((t) => t.id === p.tab);
    return { space: space?.name ?? "", tab: tab?.name ?? p.address };
  }

  resume(list, cx) {
    cx.spawn(async (cx) => {
      for (const p of list) {
        // Claude saves a conversation only after its first message; without one there is
        // nothing to resume, so start it fresh with the same flags.
        const saved = p.session && (await hasTranscript(p.session));
        const how = saved ? ["--resume", quote(p.session)] : [];
        const line = [`cd ${quote(p.cwd)} &&`, "claude", ...how, ...p.flags.map(quote)].join(" ");
        await hc(["send", p.address, line]).catch(() => null);
        delete this.panes[p.address];
      }
      this.save();
      cx.notify();
    });
  }

  dismiss(list, cx) {
    for (const p of list) delete this.panes[p.address];
    this.save();
    cx.notify();
  }

  render() {
    const list = this.lost();
    if (list.length === 0) return div();
    const t = theme();
    const button = (id, label, primary, onClick) =>
      div().id(id).h(26).px(10).flex().items_center().rounded(7).cursor_pointer().text_size(12).font_semibold()
        .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
        .hover((s) => s.opacity(0.85))
        .on_click((_e, cx) => onClick(cx))
        .child(label);

    return v_flex().id("sleeve-resume").w(340).p(8).gap(6).text_color(t.foreground)
      .child(v_flex().px(4).pt(2).gap(2)
        .child(div().text_size(13.5).font_bold()
          .child(list.length === 1 ? "Claude stopped in 1 tab" : `Claude stopped in ${list.length} tabs`))
        .child(div().text_size(12).text_color(t.muted).child("Its terminals were lost in a restart.")))
      .child(v_flex().gap(2).children(list.map((p) => {
        const w = this.where(p);
        return h_flex().id(`r-${p.address}`).py(5).px(4).gap(8).items_center().rounded(7)
          .hover((s) => s.bg(t.hover))
          .child(v_flex().flex_1().min_w(0)
            .child(div().text_size(12.5).font_medium().truncate().cursor_pointer()
              .on_click(() => run("pane.focus", { terminal: p.address }))
              .child(w.tab))
            .child(div().text_size(11).text_color(t.dim).truncate().child(w.space)))
          .child(button(`go-${p.address}`, "Resume", false, (cx) => this.resume([p], cx)));
      })))
      .child(h_flex().gap(6).justify_end().pt(2)
        .child(button("dismiss", "Dismiss", false, (cx) => this.dismiss(list, cx)))
        .child(button("all", list.length === 1 ? "Resume" : "Resume all", true, (cx) => this.resume(list, cx))));
  }
}
