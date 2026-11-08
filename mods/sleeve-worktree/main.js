// Worktree dialog in the sleeve look (a copy of Herdr's worktree mod, same git logic):
// { space, action: "new" | "open" | "remove" } or { folder, machine } for a repo without
// a space; optional { branch, tab, argv }. Opened with frame: "none".

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, exec, home } from "herdr";

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, all = panes()) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

// Checkouts go to <ROOT>/<repo>/<branch, slashes as dashes>.
const ROOT = (home) => `${home}/.herdr/worktrees`;
// Home as ~ (git says C:/Users/x where Windows says C:\Users\x).
const tilde = (path, userHome) => {
  const [p, h] = [path, userHome].map((s) => s.replace(/\\/g, "/"));
  return p.startsWith(h) ? `~${p.slice(h.length)}` : path;
};
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const ago = (s) => {
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};

// Every checkout of a repo (`git worktree list`), the main one first, then
// the most recently committed: { path, branch, main, at }.
async function checkouts(repo, on) {
  const list = await git(repo.main, ["worktree", "list", "--porcelain"], on);
  if (!list.ok) return [];
  const refs = await git(repo.main, ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"], on);
  const when = new Map(refs.out.split("\n").map((l) => l.split("\t")).map(([b, at]) => [b, Number(at) || 0]));
  const out = [];
  for (const block of list.out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    out.push({ path, branch, main: out.length === 0, at: branch ? (when.get(branch) ?? 0) : 0 });
  }
  return out.sort((a, b) => b.main - a.main || b.at - a.at);
}

// The space showing a checkout: its first terminal is in it (the deepest checkout wins).
function spaceOf(path, all, on, spaceList, paneList) {
  const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
  return spaceList.find((s) => (s.machine ?? null) === (on ?? null) && (() => {
    const at = place(s, paneList)?.replace(/\\/g, "/");
    if (!at || !inside(at, path)) return false;
    return !all.some((c) => c.path !== path && c.path.length > path.length && inside(at, c.path));
  })());
}

async function git(cwd, args, on, timeout) {
  const r = await exec("git", args, { cwd, on, ...(timeout === undefined ? {} : { timeout }) });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

// The submodule repos git keeps for a checkout (nested ones too, checked out
// or not): { name, dir, pinned }. `config` is the args that read its
// .gitmodules; `pinned` is the commit its parent records ("" if none).
async function modules(gitDir, config, on, out = [], parent = "") {
  const keys = await git(gitDir, ["--git-dir", gitDir, "config", ...config, "-z", "--get-regexp", "^submodule\\..*\\.path$"], on);
  if (!keys.ok) return out; // no .gitmodules, or no submodules in it
  // -z: "key\nvalue" records ended by NUL, so names and paths may hold spaces.
  for (const record of keys.out.split("\0").filter(Boolean)) {
    const at = record.indexOf("\n");
    const name = record.slice("submodule.".length, at - ".path".length);
    const dir = `${gitDir}/modules/${name}`;
    if (!(await git(gitDir, ["--git-dir", dir, "rev-parse", "--git-dir"], on)).ok) continue; // never checked out
    const pinned = await git(gitDir, ["--git-dir", gitDir, "rev-parse", `HEAD:${record.slice(at + 1)}`], on);
    // Names are only unique within their parent: nested ones carry its name.
    out.push({ name: parent + name, dir, pinned: pinned.ok ? pinned.out : "" });
    if ((await git(gitDir, ["--git-dir", dir, "cat-file", "-e", "HEAD:.gitmodules"], on)).ok) await modules(dir, ["--blob", "HEAD:.gitmodules"], on, out, `${parent + name}/`);
  }
  return out;
}

// The worktree's submodules, and the names of those with commits that exist
// nowhere else: not on a remote, and not the commit the parent pins (git
// fetches that by hash, so it is often on no remote branch here).
async function submodules(top, on) {
  const gitDir = await git(top, ["rev-parse", "--absolute-git-dir"], on);
  if (!gitDir.ok) throw new Error(gitDir.err || "git rev-parse failed.");
  const mods = await modules(gitDir.out, ["--file", `${top}/.gitmodules`], on);
  const unpushed = [];
  for (const m of mods) {
    const local = await git(gitDir.out, ["--git-dir", m.dir, "rev-list", "-n1", "--all", "--not", "--remotes", ...(m.pinned ? [m.pinned] : [])], on);
    if (!local.ok) throw new Error(local.err || `Couldn't check submodule ${m.name}.`);
    if (local.out) unpushed.push(m.name);
  }
  return { mods, unpushed };
}

// The repo a folder belongs to: its main checkout and name, and whether
// the folder is itself a linked worktree. null outside git.
async function repoOf(folder, on) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"], on);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { top: top.out, main, name: main.split("/").pop(), linked: main !== top.out };
}

export default class Worktree extends View {
  init(_props, cx) {
    this.on = this.space()?.machine;
    this.userHome = this.on ? null : home();
    this.opening = props()?.action === "open";
    this.text = props()?.branch ?? "";
    this.list = undefined; // open: the checkouts, once read
    this.at = props()?.action === "remove" ? 1 : 0; // remove starts on Cancel
    this.input = InputState.new({ value: this.text, placeholder: this.opening ? "filter worktrees" : "branch name" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.error = ""; this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.go(cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    if (props()?.action !== "remove") {
      this.input.focus();
      cx.timer.after(600, () => this.input.focus());
    }
    this.busy = false;
    this.error = "";
    this.repo = undefined; // undefined: looking, null: not in git
    this.dirty = false;
    this.unpushed = [];
    this.handle = cx.focus_handle();
    if (props()?.action === "remove") this.handle.focus();
    cx.spawn(async (cx) => {
      try {
        if (this.on) {
          let result;
          try { result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on }); } catch {}
          if (!result || result.code !== 0 || !result.stdout.trim()) result = await exec("powershell.exe", ["-NoProfile", "-Command", "[Console]::Write($HOME)"], { on: this.on });
          if (result.code !== 0 || !result.stdout.trim()) throw new Error("Could not find the remote home folder.");
          this.userHome = result.stdout.trim().replace(/\\/g, "/");
        }
        this.folder = props()?.folder || place(this.space()) || this.userHome;
        // The repo is set last: Enter does nothing until the warnings it consents to are known.
        const repo = await repoOf(this.folder, this.on);
        if (repo && props().action === "remove") {
          this.dirty = (await git(repo.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on)).out !== "";
          this.unpushed = (await submodules(repo.top, this.on)).unpushed;
        }
        if (repo && this.opening) this.list = await checkouts(repo, this.on);
        this.repo = repo;
        cx.notify();
        if (props().branch) await this.work(cx);
      } catch (error) { this.repo = null; this.error = String(error); cx.notify(); }
    });
  }

  space() {
    const p = props() ?? {};
    return spaces().find((s) => s.id === p.space) ?? (p.folder ? { folder: p.folder, machine: p.machine ?? null, name: "" } : undefined);
  }

  close() {
    closeOverlay(props().overlay);
  }

  go(cx) {
    if (this.busy || !this.repo) return;
    cx.spawn(async (cx) => this.work(cx));
  }

  async work(cx) {
    if (this.busy || !this.repo) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    try { this.error = props().action === "remove" ? await this.remove() : await this.create(); }
    catch (error) { this.error = String(error); }
    this.busy = false;
    if (!this.error) this.close();
    cx.notify();
  }

  async create() {
    const branch = this.text.trim();
    if (!branch) return "Type a branch name.";
    const path = `${ROOT(this.userHome)}/${this.repo.name}/${slug(branch)}`;
    const exists = (await git(this.repo.main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], this.on)).ok;
    const add = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"];
    const r = await git(this.repo.top, add, this.on, 600_000);
    if (!r.ok) return r.err || "git worktree add failed.";
    const p = props();
    // Leave spaces unnamed so they follow the checkout folder and nest under the repo.
    run("space.new", { folder: path, machine: this.on, tab: p.tab, argv: p.argv });
    return "";
  }

  shown() {
    const f = this.text.trim().toLowerCase();
    return (this.list ?? []).filter((c) => !f || `${c.branch ?? ""} ${c.path}`.toLowerCase().includes(f));
  }

  open(c) {
    if (!c) return;
    this.close();
    const s = spaceOf(c.path, this.list, this.on, spaces(), panes());
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: c.path, machine: this.on });
  }

  async remove() {
    const s = this.space();
    const status = await git(this.repo.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on);
    if (!status.ok) return status.err || "git status failed.";
    // git refuses a worktree with submodules unless forced, because their
    // history goes with it. The popup already showed what's at risk; only
    // risk that appeared since it opened gets one more warning.
    const { mods, unpushed } = await submodules(this.repo.top, this.on);
    const changed = (status.out && !this.dirty) || unpushed.some((name) => !this.unpushed.includes(name));
    this.dirty ||= status.out !== "";
    this.unpushed = [...new Set([...this.unpushed, ...unpushed])];
    if (changed) return "It changed since this opened. Enter again removes it anyway.";
    // Terminals first: a shell sitting in the folder keeps it busy on Windows.
    run("space.close", { id: s.id, confirmed: true });
    const force = this.dirty || mods.length > 0;
    const r = await git(this.repo.main, ["worktree", "remove", ...(force ? ["--force"] : []), this.repo.top], this.on, 600_000);
    return r.ok ? "" : r.err || "git worktree remove failed.";
  }

  key(e, cx) {
    if (e.key === "escape") return this.close();
    if (this.opening) {
      const n = this.shown().length;
      if (e.key === "enter") this.open(this.shown()[this.at]);
      else if ((e.key === "down" || e.key === "up") && n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
      else return;
      cx.stop_propagation();
      return cx.notify();
    }
    if (props()?.action !== "remove") return;
    if (e.key === "down" || e.key === "up" || e.key === "tab") this.at = 1 - this.at;
    else if (e.key === "enter") return this.at === 0 ? this.go(cx) : this.close();
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // The sleeve popup: a rounded card with a strip on top and a hint row at the bottom.
  card(t) {
    return v_flex()
      .id("sleeve-worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .rounded(12)
      .overflow_hidden()
      .border_1()
      .border_color(t.input)
      .bg(t.popover)
      .shadow_2xl()
      .font_semibold();
  }

  strip(t, icon) {
    return h_flex().h(46).flex_none().px(16).gap(10).items_center().border_b(1).border_color(t.border)
      .child(svg(icon).size(16).flex_none().text_color(t.dim))
      .child(Input.new(this.input).flex_1().h_full().text_size(13.5).text_color(t.foreground));
  }

  footer(t, title, note, caps) {
    return h_flex().h(40).flex_none().px(16).gap(12).items_center().text_size(12)
      .child(h_flex().flex_1().min_w(0).gap(8).items_center()
        .child(div().flex_none().text_color(t.foreground).child(title))
        .when(Boolean(note), (el) => el.child(div().min_w(0).truncate().font_medium().text_color(t.dim).child(note))))
      .children(caps.map(([id, label, key, action]) => h_flex().id(id).gap(6).items_center()
        .text_color(t.muted)
        .when(Boolean(action), (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(action))
        .when(Boolean(label), (el) => el.child(label))
        .child(div().h(20).px(6).flex().items_center().rounded(6).border_1().border_color(t.input).text_color(t.foreground).child(key))));
  }

  // One line of text under the strip, for what's loading, missing or wrong.
  note(t, text, color) {
    return div().px(16).py(12).text_size(12.5).font_medium().text_color(color ?? t.muted).child(text);
  }

  renderOpen(t) {
    const r = this.repo;
    const rows = this.shown();
    const all = this.list ?? [];
    const spaceList = spaces();
    const paneList = panes();
    const row = (c, i) => {
      const on = i === this.at;
      const there = spaceOf(c.path, all, this.on, spaceList, paneList);
      return v_flex()
        .id(`wt-${i}`)
        .flex_none()
        .h(44)
        .px(12)
        .justify_center()
        .rounded(7)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(`${t.selected.slice(0, 7)}80`)))
        .on_click(() => this.open(c))
        .child(h_flex().gap(8).items_center().text_size(13)
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.branch ?? "detached"))
          .when(c.main, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child("main checkout")))
          .when(Boolean(there), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.accent).child("open")))
          .when(!there && c.at > 0, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(ago(c.at)))))
        .child(div().truncate().text_size(11.5).font_medium().text_color(t.dim).child(tilde(c.path, this.userHome ?? "")));
    };
    const count = rows.length === all.length ? `${all.length} checkouts` : `${rows.length} of ${all.length}`;
    const ready = Boolean(r && this.list);
    return this.card(t)
      .child(this.strip(t, "mods/sleeve-chrome/icons/search.svg"))
      .when(!ready, (el) => el.child(this.note(t, r === null ? `${this.folder ? tilde(this.folder, this.userHome ?? "") : "This folder"} is not in a git repository.` : "…")).child(div().flex_1()))
      .when(ready, (el) => el.child(div().relative().flex_1().min_h(0).mx(5).my(5)
        .child(v_flex().id("wt-list").size_full().overflow_y_scroll()
          .children(rows.map(row))
          .when(rows.length === 0, (el) => el.child(div().px(12).py(10).text_size(13).text_color(t.muted).child("No matching worktrees."))))
        .child(Scrollbar.vertical("wt-list").absolute().inset_0())))
      .child(div().h(1).flex_none().bg(t.border))
      .child(this.footer(t, "Open worktree", r ? `${r.name} · ${ready ? count : "…"}` : "", [
        ["wt-move", "", "↑↓", null],
        ["wt-go", "Open", "↩", () => this.open(rows[this.at])],
      ]));
  }

  renderRemove(t) {
    const s = this.space();
    const r = this.repo;
    const blocked = !r || !r.linked;
    const detail = r === undefined ? "…"
      : r === null ? `${this.folder ? tilde(this.folder, this.userHome) : "This folder"} is not in a git repository.`
      : !r.linked ? "This is the repository's main checkout, not a worktree."
      : `Closes the space and deletes ${tilde(r.top, this.userHome)}. The branch stays.`;
    const warnings = [
      this.dirty && "It has uncommitted changes: they will be lost.",
      this.unpushed.length > 0 && `Submodule ${this.unpushed.join(", ")} has commits that aren't pushed anywhere: they will be lost.`,
      this.error,
    ].filter(Boolean);
    const rows = [
      { label: this.busy ? "Removing…" : "Remove worktree", icon: "mods/workspace-chrome/x.svg", key: "↩", danger: true, action: (cx) => this.go(cx) },
      { label: "Cancel", icon: null, key: "esc", action: () => this.close() },
    ].filter((row) => !(blocked && row.danger));
    if (blocked) this.at = 0;
    return this.card(t)
      .p(5)
      .gap(2)
      .text_size(12.8)
      .child(v_flex().px(12).pt(8).pb(4).gap(3)
        .child(div().text_size(13.5).font_bold().text_color(t.foreground).truncate().child(`Remove ${s?.name ?? "worktree"}?`))
        .child(div().text_size(12).font_medium().text_color(t.muted).child(detail))
        .children(warnings.map((w) => div().text_size(12).font_medium().text_color(t.blocked).child(w))))
      .child(div().mx(12).my(4).h(1).bg(t.border))
      .children(rows.map((row, i) => {
        const on = i === this.at;
        return h_flex().id(`wt-r-${i}`).h(31).px(12).gap(9).rounded(7).items_center().cursor_pointer()
          .text_color(row.danger ? t.blocked : t.foreground)
          .when(on, (el) => el.bg(row.danger ? `${t.blocked.slice(0, 7)}26` : t.selected))
          .on_hover((over, cx) => { if (over && this.at !== i) { this.at = i; cx.notify(); } })
          .on_click((_e, cx) => row.action(cx))
          .child(row.icon ? svg(row.icon).size(14).flex_none() : div().size(14).flex_none())
          .child(div().flex_1().child(row.label))
          .child(div().text_size(12).text_color(t.muted).child(row.key));
      }));
  }

  render(cx) {
    const t = theme();
    if (this.opening) return this.renderOpen(t);
    if (props()?.action === "remove") return this.renderRemove(t);
    const r = this.repo;
    const branch = this.text.trim();
    const where = r ? `${tilde(ROOT(this.userHome), this.userHome)}/${r.name}/${branch ? slug(branch) : "…"}` : "";
    return this.card(t)
      .child(this.strip(t, "mods/workspace-chrome/git-branch.svg"))
      .child(v_flex().flex_1().px(16).py(10).gap(4).text_size(12).font_medium()
        .when(r === undefined, (el) => el.child(div().text_color(t.muted).child("…")))
        .when(r === null, (el) => el.child(div().text_color(t.muted).child(`${this.folder ? tilde(this.folder, this.userHome) : "This folder"} is not in a git repository.`)))
        .when(Boolean(r), (el) => el
          .child(div().truncate().text_color(t.muted).child(where))
          .child(this.error
            ? div().truncate().text_color(t.blocked).child(this.error)
            : div().text_color(t.dim).child("An existing branch is checked out; a new one starts from here.")))
        .when(!r && Boolean(this.error), (el) => el.child(div().truncate().text_color(t.blocked).child(this.error))))
      .child(div().h(1).flex_none().bg(t.border))
      .child(this.footer(t, "New worktree", r?.name ?? "", [
        ["wt-cancel", "Cancel", "esc", () => this.close()],
        ["wt-create", this.busy ? "Creating…" : "Create", "↩", (_e, cx) => this.go(cx)],
      ]));
  }
}
