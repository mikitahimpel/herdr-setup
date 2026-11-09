// What git says about where each space is: its repo, branch and ahead/behind.
//
// Neither a space nor a tab has a repo of its own; git is asked about folders. A space is
// where its first terminal is now (else the folder it was made in), a tab where its lead
// terminal is (its agent, else its focused pane, else its first). One place is a machine
// and a folder, so everything in the same folder shares one answer.

import { exec, machines, watchFolder, window } from "herdr";

// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

const base = (path) => path.replace(/\/+$/, "").split("/").pop();

// `ps`: panes(), read once by the caller (each read copies every pane).
export function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

export const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);

// The pane a tab shows as: its agent, else its focused pane, else its first.
export function lead(tab, ps) {
  const here = ps.filter((p) => p.tab === tab);
  return here.find((p) => p.program?.agent) ?? here.find((p) => p.focused) ?? here[0] ?? null;
}

const tabWhere = (s, c, ps) => {
  const cwd = lead(c.id, ps)?.cwd;
  return cwd ? JSON.stringify([s.machine ?? null, cwd]) : null;
};

export class GitFacts {
  constructor() {
    this.facts = {}; // where() -> { name, branch, ahead, behind, repo, linked, top, changed, untracked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
  }

  // undefined: not looked at yet.
  of(s, ps) {
    return this.facts[where(s, ps)];
  }

  known(s, ps) {
    return where(s, ps) in this.facts;
  }

  // A tab's, in space `s`; undefined: not looked at yet or no terminal.
  ofTab(s, c, ps) {
    const k = tabWhere(s, c, ps);
    return k ? this.facts[k] : undefined;
  }

  // Looks again where the answer could have changed. `folded`: machines whose
  // spaces aren't shown, left to their next real change.
  update(now, sp, ps, folded, cx) {
    const due = this.due(now, sp, ps, folded);
    if (due.size) this.refresh(due, cx);
  }

  // New places (a new space, a cd), where a command or an agent's turn just ended
  // (a checkout, a commit, edits), those on a machine that is back, and repos in
  // view whose fallback is due.
  due(now, sp, ps, folded) {
    const at = {};
    for (const s of sp) {
      at[s.id] = where(s, ps);
      for (const c of s.tabs ?? []) {
        const k = tabWhere(s, c, ps);
        if (k) at[c.id] = k;
      }
    }
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.facts)));
    // Moved there: what it knew of that place may be old.
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !at[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      // Its own folder, and the tab's (a commit there moves the whole repo's ahead/behind).
      if (this.busy[p.pane] && !busy[p.pane]) {
        const mine = p.cwd ? JSON.stringify([JSON.parse(at[p.tab])[0], p.cwd]) : at[p.tab];
        for (const k of new Set([mine, at[p.tab]])) if (keys.has(k)) this.sameRepo(k, keys).forEach((r) => due.add(r));
      }
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window()?.active) {
      for (const k of keys) {
        const asks = this.facts[k] || this.unsure.has(k);
        if (asks && !folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.facts[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.facts[k]?.repo === repo) : [])];
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refresh(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const next = [...this.pending];
        this.pending.clear();
        for (const key of next) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.facts).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.facts[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git`, top: top.stdout.trim(), changed: 0, untracked: 0 };
      for (const line of r.stdout.split("\n")) {
        // Entries: "1"/"2" changed, "u" unmerged, "?" untracked.
        if (/^[12u] /.test(line)) info.changed++;
        else if (line.startsWith("? ")) info.untracked++;
        // "(detached)" when no branch is checked out.
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14) === "(detached)" ? null : line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.facts[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.facts[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refresh(Object.keys(this.facts).filter((k) => this.facts[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }
}
