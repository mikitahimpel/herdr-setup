// Review a branch against its base, or local changes, with difftastic's structural diff.
// A file at a time; comments are kept until submitted to the branch's MR/PR or handed to an agent.
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";
import { appHome, exec, focused, nextCommand, panes, props, readTextFile, run, settings, spaces, theme, writeTextFile } from "herdr";
import { buildRows, foldRows, inlineItems, segments, wrap } from "./diff.js";
import { parseRemote, providerFor } from "./providers.js";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const CACHE = () => `${appHome()}/mods/sleeve-review/.cache`;
const LINE = 21, FILE = 30, MAX_BYTES = 900000;
const SCOPES = [["branch", "Branch"], ["local", "Uncommitted"], ["all", "Both"]];
const ACCENT = "#2f74d6";
const BARS = 92, DOCK = 52; // Header and file bar above the diff; the comment box below it.
let tempId = 0;

function where() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on: space?.machine ?? null };
}

function parseRaw(text) {
  const parts = text.split("\0"), files = [];
  for (let i = 0; i + 1 < parts.length;) {
    const [, , oldSha, newSha, code] = parts[i++].slice(1).split(" ");
    const status = code[0], old = /[RC]/.test(status) ? parts[i++] : null, path = parts[i++];
    files.push({ path, oldPath: old ?? path, status, oldSha, newSha, add: 0, del: 0 });
  }
  return files;
}

function applyNumstat(text, files) {
  const parts = text.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const [add, del, name] = parts[i].split("\t");
    if (del === undefined) continue;
    const path = name || parts[(i += 2)];
    const file = files.find((f) => f.path === path);
    if (file) { file.add = +add || 0; file.del = +del || 0; file.binary = add === "-"; }
  }
}

export default class Review extends View {
  init(given, cx) {
    const here = where();
    this.cwd = given?.folder ?? props()?.folder ?? here.cwd;
    this.on = given?.on ?? props()?.on ?? here.on;
    this.scope = "branch"; this.inline = false; this.files = []; this.tree = []; this.items = []; this.sizes = [];
    this.diffs = {}; this.opened = new Set(); this.state = { viewed: {}, comments: [] }; this.threads = [];
    this.handle = cx.focus_handle(); this.scrollY = 0; this.treeY = 0; this.viewH = 900;
    this.input = InputState.new({ placeholder: "Leave a comment" });
    this.input.on("submit", (_e, cx) => this.addComment(cx));
    this.filter = InputState.new({ placeholder: "Find a branch" });
    this.filter.on("change", (_e, cx) => cx.notify());
    this.handle.focus();
    exec("sh", ["-c", 'rm -rf "$1"/diff-*', "sh", CACHE()]).catch(() => {});
    this.load(cx);
    cx.timer.every(6000, (cx) => this.reload(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = (await nextCommand()).split(".").pop();
        try { if (this.key(command, cx)) cx.notify(); }
        catch (e) { this.note = `Failed: ${e.message ?? e}`; cx.notify(); }
      }
    });
  }

  git(args) { return exec("git", [...READ, ...args], { cwd: this.root ?? this.cwd, on: this.on }); }
  async must(args) {
    const r = await this.git(args);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0]);
    return r.stdout;
  }

  async defaultBase() {
    const head = await this.git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (head.code === 0) return head.stdout.trim();
    for (const ref of ["origin/main", "origin/master", "main", "master"]) {
      if ((await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code === 0) return ref;
    }
    return null;
  }

  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const [top, branch, origin] = await Promise.all([this.must(["rev-parse", "--show-toplevel"]), this.must(["rev-parse", "--abbrev-ref", "HEAD"]), this.git(["remote", "get-url", "origin"])]);
        this.root = top.trim(); this.branch = branch.trim();
        this.provider = origin.code === 0 ? providerFor(parseRemote(origin.stdout), { cwd: this.root, on: this.on }) : null;
        await this.readState();
        this.base = this.state.base ?? await this.defaultBase();
        if (!this.base) this.scope = "local";
        await this.reload(cx, true);
        cx.notify();
        await this.connect(cx);
      } catch (e) { this.error = String(e.message ?? e); }
      cx.notify();
    });
  }

  // The MR/PR for this branch: its target is the base unless one was picked by hand.
  async connect(cx) {
    if (!this.provider) return;
    try {
      this.remote = await this.provider.find(this.branch);
      this.remoteError = null;
      if (!this.remote) return;
      if (!this.state.base && `origin/${this.remote.target}` !== this.base) { this.base = `origin/${this.remote.target}`; await this.reload(cx, true); }
      this.threads = await this.provider.threads(this.remote);
      this.layout();
    } catch (e) {
      const text = String(e.message ?? e);
      this.remoteError = /ENOENT|not found|No such file/i.test(text) ? `${this.provider.cli} is not installed` : /401|auth|log ?in/i.test(text) ? `Run: ${this.provider.login}` : text;
    }
  }

  stateFile() { return `${CACHE()}/state/${`${this.root}@${this.branch}`.replace(/\W+/g, "_")}.json`; }
  async readState() {
    this.saved = await readTextFile(this.stateFile()).catch(() => null);
    if (this.saved) this.state = { viewed: {}, comments: [], ...JSON.parse(this.saved) };
  }
  async save() {
    const text = JSON.stringify(this.state);
    await exec("mkdir", ["-p", `${CACHE()}/state`]);
    await writeTextFile(this.stateFile(), text, this.saved ?? null);
    this.saved = text;
  }

  range() {
    if (this.scope === "local") return ["HEAD", null];
    return [this.mergeBase, this.scope === "branch" ? "HEAD" : null];
  }

  async reload(cx, force) {
    if (!this.root || this.loading) return;
    this.loading = true;
    try {
      if (this.base) {
        const [tip, merge] = await Promise.all([this.must(["rev-parse", "HEAD"]), this.git(["merge-base", this.base, "HEAD"])]);
        this.head = tip.trim();
        this.mergeBase = merge.stdout.trim();
        if (!this.mergeBase && this.scope !== "local") throw new Error(`No common history with ${this.base}`);
      }
      const [from, to] = this.range(), spec = to ? [from, to] : [from];
      const [raw, stat, fresh] = await Promise.all([
        this.must(["diff", "--raw", "-z", "-M", "--abbrev=40", "--no-ext-diff", ...spec]),
        this.must(["diff", "--numstat", "-z", "-M", "--no-ext-diff", ...spec]),
        to ? "" : this.must(["ls-files", "-o", "--exclude-standard", "-z"]),
      ]);
      const stamp = `${this.scope}|${this.base}|${from}|${raw}|${stat}|${fresh}`;
      if (stamp === this.stamp && !force) return;
      this.stamp = stamp;
      const files = parseRaw(raw);
      applyNumstat(stat, files);
      for (const path of fresh.split("\0").filter(Boolean)) files.push({ path, oldPath: path, status: "A", fresh: true, add: 0, del: 0 });
      files.sort((a, b) => a.path.localeCompare(b.path));
      for (const f of files) f.key = `${f.oldSha ?? ""}:${f.newSha ?? ""}:${f.add}:${f.del}:${/^0+$/.test(f.newSha ?? "0") ? stamp.length : ""}`;
      this.files = files;
      this.buildTree();
      this.error = null;
      const keep = files.find((f) => f.path === this.open?.path);
      this.pick(keep ?? files[0] ?? null, cx);
    } catch (e) { this.error = String(e.message ?? e); }
    finally { this.loading = false; cx.notify(); }
  }

  buildTree() {
    this.tree = [];
    let dir = null;
    for (const file of this.files) {
      const at = file.path.lastIndexOf("/"), here = at < 0 ? "" : file.path.slice(0, at);
      if (here !== dir && here) this.tree.push({ dir: here });
      dir = here;
      this.tree.push({ file, name: file.path.slice(at + 1), nested: Boolean(here) });
    }
  }

  async side(file, old) {
    const [from, to] = this.range();
    if (old) {
      if (file.status === "A" || file.fresh) return "";
      const r = await this.git(["show", `${from}:${file.oldPath}`]);
      return r.code === 0 ? r.stdout : "";
    }
    if (file.status === "D") return "";
    if (to) return this.must(["show", `${to}:${file.path}`]);
    return (await readTextFile(`${this.root}/${file.path}`, { on: this.on })) ?? "";
  }

  async diff(file) {
    const id = `${this.scope}:${this.mergeBase}:${file.path}:${file.key}`;
    if (this.diffs[id]) return this.diffs[id];
    if (file.binary) return (this.diffs[id] = { note: "Binary file" });
    const [left, right] = await Promise.all([this.side(file, true), this.side(file, false)]);
    if (left.length > MAX_BYTES || right.length > MAX_BYTES) return (this.diffs[id] = { note: "Too large to diff" });
    if (left.includes("\0") || right.includes("\0")) return (this.diffs[id] = { note: "Binary file" });
    const dir = `${CACHE()}/diff-${Date.now()}-${tempId++}`, name = file.path.split("/").pop();
    await exec("mkdir", ["-p", `${dir}/a`, `${dir}/b`]);
    try {
      await Promise.all([writeTextFile(`${dir}/a/${name}`, left, null), writeTextFile(`${dir}/b/${name}`, right, null)]);
      const r = await exec("env", ["DFT_UNSTABLE=yes", "difft", "--display", "json", `${dir}/a/${name}`, `${dir}/b/${name}`]);
      if (r.code !== 0) throw new Error(/not found|No such/.test(r.stderr) ? "difft is not installed" : r.stderr.trim().split("\n")[0]);
      const parsed = JSON.parse(r.stdout);
      const rows = buildRows(left, right, parsed);
      const width = rows.reduce((n, row) => Math.max(n, row.lt?.length ?? 0, row.rt?.length ?? 0), 0);
      const quiet = parsed.status === "unchanged";
      return (this.diffs[id] = { rows, width, language: parsed.language, note: quiet ? "Only formatting changed, nothing structural" : null });
    } finally { await exec("rm", ["-rf", dir]); }
  }

  pick(file, cx) {
    const same = file && this.open?.path === file.path && this.open?.key === file.key;
    this.open = file;
    if (same) return;
    if (!file) { this.current = null; this.items = []; this.sizes = []; return; }
    this.cursor = null; this.opened = new Set(); this.current = null; this.diffError = null; this.layout();
    cx.spawn(async (cx) => {
      try {
        const got = await this.diff(file);
        if (this.open !== file) return;
        this.current = got; this.diffError = null;
        this.scrollY = 0;
        this.layout();
        const next = this.files[this.files.indexOf(file) + 1];
        if (next) this.diff(next).catch(() => {});
      } catch (e) { if (this.open === file) { this.current = null; this.diffError = String(e.message ?? e); this.layout(); } }
      cx.notify();
    });
  }

  commentsHere() {
    const path = this.open?.path;
    const mine = this.state.comments.filter((c) => c.path === path).map((c) => ({ ...c, pending: true }));
    return [...this.threads.filter((c) => c.path === path), ...mine];
  }

  // Everything the list draws for the open file, with comments under their lines.
  layout() {
    const rows = this.current?.rows ?? [];
    const folded = foldRows(rows, this.opened), base = this.inline ? inlineItems(folded) : folded;
    const notes = this.commentsHere(), items = [];
    for (const item of base) {
      items.push(item);
      if (item.kind !== "line") continue;
      const { row, side } = item;
      for (const c of notes) {
        const hit = c.side === "new" ? row.r === c.line - 1 && side !== "old" : row.l === c.line - 1 && side !== "new" && !(side === "both");
        if (hit) { const lines = wrap(c.body); items.push({ kind: "comment", c, lines }); }
      }
    }
    this.items = items;
    this.sizes = items.map((item) => (item.kind === "comment" ? 42 + item.lines.length * 18 : item.kind === "fold" ? 26 : LINE));
    this.offsets = [0];
    for (const size of this.sizes) this.offsets.push(this.offsets.at(-1) + size);
    this.scrollY = Math.min(this.scrollY, this.maxScroll());
    this.hunks = items.flatMap((item, i) => (item.kind === "line" && item.row.changed && !(items[i - 1]?.row?.changed) ? [i] : []));
    const chars = this.current?.width ?? 0;
    this.diffWidth = this.inline ? Math.min(chars, 400) * 7.3 + 124 : 0;
  }

  maxScroll() { return Math.max(0, (this.offsets?.at(-1) ?? 0) - this.diffHeight()); }
  diffHeight() { return this.viewH - BARS - (this.writing ? DOCK : 0); }
  scrollTo(index) { this.scrollY = Math.min(this.offsets[Math.max(0, index)], this.maxScroll()); }

  fileStep(step, cx) {
    const at = this.files.indexOf(this.open), next = this.files[at + step];
    if (next) this.pick(next, cx);
  }
  hunkStep(step) {
    const top = this.cursor ? this.items.indexOf(this.cursor) : -1;
    const list = this.hunks ?? [];
    const next = step > 0 ? list.find((i) => i > top) : list.findLast((i) => i < top);
    if (next === undefined) return;
    this.cursor = this.items[next];
    this.scrollTo(next - 3);
  }
  isViewed(file) { return this.state.viewed[file.path] === file.key; }
  toggleViewed(cx) {
    const file = this.open;
    if (!file) return;
    if (this.isViewed(file)) delete this.state.viewed[file.path];
    else { this.state.viewed[file.path] = file.key; const next = this.files.slice(this.files.indexOf(file) + 1).find((f) => !this.isViewed(f)); if (next) this.pick(next, cx); }
    this.save().catch(() => {});
  }
  startComment(cx) {
    if (!this.cursor?.row) { this.cursor = this.items.find((item) => item.kind === "line" && item.row.changed) ?? null; if (!this.cursor) return; }
    this.writing = true; this.input.set_value(""); this.input.focus?.(cx);
  }
  addComment(cx) {
    const body = this.input.value().trim(), item = this.cursor, file = this.open;
    if (!body || !item?.row || !file) return;
    const { row, side } = item, old = side === "old" || row.r === null || (this.cursorOld && row.l !== null);
    this.state.comments.push({
      id: `c${Date.now()}`, path: file.path, oldPath: file.oldPath, side: old ? "old" : "new", line: (old ? row.l : row.r) + 1,
      newLine: old ? null : row.r + 1, oldLine: !row.changed || old ? row.l + 1 : null, body, scope: this.scope,
    });
    this.writing = false; this.input.set_value(""); this.handle.focus();
    this.save().catch(() => {}); this.layout(); cx.notify();
  }
  removeChosen(cx) {
    const before = this.state.comments.length;
    this.state.comments = this.state.comments.filter((c) => c.id !== this.chosen);
    if (this.state.comments.length === before) return;
    this.chosen = null; this.save().catch(() => {}); this.layout(); cx.notify();
  }

  canSubmit() {
    return this.remote && this.scope === "branch" && this.head === this.remote.head && this.state.comments.some((c) => c.scope === "branch");
  }
  submit(cx) {
    if (!this.canSubmit() || this.busy) return;
    const sent = this.state.comments.filter((c) => c.scope === "branch");
    this.act(cx, async () => {
      await this.provider.submit(this.remote, sent);
      this.state.comments = this.state.comments.filter((c) => !sent.includes(c));
      await this.save();
      this.threads = await this.provider.threads(this.remote);
      this.layout();
      return `Sent ${sent.length} comment${sent.length === 1 ? "" : "s"} to ${this.remote.name}`;
    });
  }
  approve(cx) {
    if (!this.remote || this.busy) return;
    this.act(cx, async () => { await this.provider.approve(this.remote); return `Approved ${this.remote.name}`; });
  }
  act(cx, work) {
    this.busy = true; this.note = null; cx.notify();
    cx.spawn(async (cx) => {
      try { this.note = await work(); }
      catch (e) { this.note = `Failed: ${e.message ?? e}`; }
      this.busy = false; cx.notify();
    });
  }
  fixWithAgent() {
    const list = this.state.comments.map((c) => `- ${c.path}:${c.line}: ${c.body}`).join("\n");
    if (!list) return;
    run("tab.new", { name: "Review fixes", folder: this.root, argv: ["claude"], task: `Address these review comments on branch ${this.branch}:\n${list}` });
  }

  key(key, cx) {
    switch (key) {
      case "j": case "next-file": this.fileStep(1, cx); return true;
      case "k": case "prev-file": this.fileStep(-1, cx); return true;
      case "n": case "next-change": this.hunkStep(1); return true;
      case "p": case "prev-change": this.hunkStep(-1); return true;
      case "v": case "viewed": this.toggleViewed(cx); return true;
      case "c": case "comment": this.startComment(cx); return true;
      case "x": this.removeChosen(cx); return true;
      case "u": case "layout": this.inline = !this.inline; this.layout(); return true;
      case "s": case "scope": this.setScope(SCOPES[(SCOPES.findIndex(([id]) => id === this.scope) + 1) % SCOPES.length][0], cx); return true;
    }
    return false;
  }
  setScope(scope, cx) { this.scope = scope; this.reload(cx, true); }
  setBase(ref, cx) {
    this.base = ref; this.state.base = ref; this.picking = false;
    this.save().catch(() => {}); this.reload(cx, true);
  }
  openPicker(cx) {
    this.picking = !this.picking; this.filter.set_value("");
    if (this.picking && !this.refs) cx.spawn(async (cx) => {
      const out = await this.must(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/remotes", "refs/heads"]).catch(() => "");
      this.refs = out.split("\n").filter((r) => r && !r.endsWith("/HEAD"));
      cx.notify();
    });
  }

  span(seg, t, tint) {
    const colors = { keyword: t.ansi5, string: t.ansi2, number: t.ansi3, comment: t.dim, type: t.ansi4 };
    return div().flex_none().whitespace_nowrap().text_color(colors[seg.kind] ?? t.foreground).when(Boolean(seg.strong && tint), (el) => el.bg(tint + "4d").rounded(2)).child(seg.text);
  }
  cell(id, number, text, changes, tint, t, solid, on, click) {
    const spans = segments(text, solid ? null : changes);
    return h_flex().id(id).flex_1().min_w(0).h_full().overflow_hidden().on_click(click).when(Boolean(tint), (el) => el.bg(tint + "1a"))
      .child(div().w(46).flex_none().pr(10).text_right().text_color(on ? t.foreground : t.dim).when(Boolean(tint), (el) => el.bg(tint + "26")).child(number === null ? "" : String(number + 1)))
      .child(h_flex().flex_1().pl(8).items_center().children(number === null ? [] : spans.map((seg) => this.span(seg, t, tint))));
  }
  renderItem(item, index, t) {
    const select = (old) => (_e, cx) => { this.cursor = item; this.cursorOld = old; cx.notify(); };
    if (item.kind === "fold") return h_flex().id(`fold-${item.at}`).w_full().h(26).px(14).cursor_pointer().on_click((_e, cx) => { this.opened.add(item.at); this.layout(); cx.notify(); }).gap(8).items_center().bg(t.surface).text_color(t.muted).text_size(11.5).child(svg("mods/workspace-chrome/chevron-down.svg").size(11)).child(`${item.count} unchanged lines`);
    if (item.kind === "comment") {
      const { c, lines } = item, on = this.chosen === c.id;
      return div().id(`note-${c.id}`).w_full().h(42 + lines.length * 18).px(56).py(5).on_click((_e, cx) => { this.chosen = this.chosen === c.id ? null : c.id; cx.notify(); }).child(v_flex().size_full().px(12).py(6).rounded(10).bg(t.raised).border_1().border_color(on ? t.accent : t.border)
        .child(h_flex().gap(6).h(18).text_size(11.5).child(div().text_color(t.foreground).child(c.pending ? "You" : c.author)).child(div().text_color(c.pending ? t.blocked : t.dim).child(c.pending ? "Pending" : c.resolved ? "Resolved" : "")))
        .children(lines.map((line) => div().h(18).truncate().text_color(t.foreground).child(line || " "))));
    }
    const { row, side } = item, on = this.cursor === item, add = t.ansi2, del = t.ansi1;
    const base = h_flex().w_full().h(LINE).items_center().when(on, (el) => el.bg(t.selected));
    if (!this.inline) {
      const leftTint = row.l !== null && (row.r === null || row.lc) ? del : null, rightTint = row.r !== null && (row.l === null || row.rc) ? add : null;
      return base.child(this.cell(`old-${index}`, row.l, row.lt, row.lc, leftTint, t, row.r === null, on, select(true))).child(div().w(1).h_full().flex_none().bg(t.border)).child(this.cell(`new-${index}`, row.r, row.rt, row.rc, rightTint, t, row.l === null, on, select(false)));
    }
    const old = side === "old", text = old ? row.lt : row.rt, changes = old ? row.lc : row.rc, tint = side === "both" ? null : old ? del : add;
    const spans = segments(text, row.l === null || row.r === null ? null : changes);
    return base.id(`line-${index}`).on_click(select(old)).when(Boolean(tint), (el) => el.bg(tint + "1a"))
      .child(div().w(46).flex_none().pr(8).text_right().text_color(t.dim).child(row.l === null || side === "new" ? "" : String(row.l + 1)))
      .child(div().w(46).flex_none().pr(8).text_right().text_color(t.dim).child(row.r === null || side === "old" ? "" : String(row.r + 1)))
      .child(div().w(16).flex_none().text_color(t.dim).child(side === "both" ? "" : old ? "−" : "+"))
      .child(h_flex().flex_1().items_center().children(spans.map((seg) => this.span(seg, t, tint))));
  }

  pill(id, label, action, t, options = {}) {
    const { on, solid, tip, off } = options;
    return div().id(id).h(30).px(12).flex().flex_none().items_center().rounded_full().text_size(12)
      .bg(solid && !off ? ACCENT : on ? t.selected : t.chrome).text_color(off ? t.dim : solid ? "#ffffff" : on ? t.foreground : t.muted)
      .when(!off, (el) => el.cursor_pointer().hover((s) => s.bg(solid ? ACCENT : t.hover)).on_click((_e, cx) => { action(cx); cx.notify(); }))
      .when(Boolean(tip), (el) => el.tooltip(tip)).child(label);
  }
  header(t) {
    const viewed = this.files.filter((f) => this.isViewed(f)).length;
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const pending = this.state.comments.length, pipe = this.remote?.pipeline;
    const pipeColor = { passed: t.done, failed: t.ansi1, running: t.working, pending: t.working }[pipe] ?? t.dim;
    const stale = this.remote && this.head !== this.remote.head;
    const remote = this.remote
      ? h_flex().gap(6).flex_none().items_center().text_size(12).child(div().text_color(t.foreground).child(this.remote.name)).when(Boolean(pipe), (el) => el.child(div().size(7).rounded_full().bg(pipeColor).tooltip(`Pipeline ${pipe}`)))
      : div().text_size(12).text_color(t.dim).when(Boolean(this.remoteError), (el) => el.text_color(t.blocked)).child(this.remoteError ?? (this.provider ? `No open ${this.provider.label}` : "No remote"));
    return h_flex().h(52).flex_none().px(14).gap(8).items_center().bg(t.chrome).border_b_1().border_color(t.border)
      .child(div().flex_none().max_w(220).truncate().child(this.branch ?? "Review"))
      .child(div().flex_none().text_color(t.dim).child("→"))
      .child(this.pill("base", this.base ?? "No base", (cx) => this.openPicker(cx), t, { tip: "Base branch", on: true }))
      .child(h_flex().flex_none().gap(2).ml(6).children(SCOPES.map(([id, label]) => this.pill(`scope-${id}`, label, (cx) => this.setScope(id, cx), t, { on: this.scope === id, off: id !== "local" && !this.base }))))
      .child(div().flex_1())
      .child(remote)
      .when(Boolean(this.note), (el) => el.child(div().max_w(280).truncate().text_size(12).text_color(this.note?.startsWith("Failed") ? t.ansi1 : t.muted).child(this.note)))
      .child(div().flex_none().text_size(12).text_color(t.muted).child(`${viewed}/${this.files.length} viewed`))
      .when(add > 0, (el) => el.child(div().flex_none().text_size(12).text_color(t.ansi2).child(`+${add}`)))
      .when(del > 0, (el) => el.child(div().flex_none().text_size(12).text_color(t.ansi1).child(`−${del}`)))
      .child(this.pill("layout", this.inline ? "Inline" : "Split", () => { this.inline = !this.inline; this.layout(); }, t, { tip: "Side by side or inline   U" }))
      .when(pending > 0, (el) => el.child(this.pill("fix", "Fix", () => this.fixWithAgent(), t, { tip: "Open Claude in a new tab with these comments" })))
      .when(Boolean(this.remote), (el) => el
        .child(this.pill("approve", "Approve", (cx) => this.approve(cx), t, { off: this.busy }))
        .child(this.pill("submit", pending ? `Submit ${pending}` : "Submit", (cx) => this.submit(cx), t, { solid: true, off: !this.canSubmit() || this.busy, tip: stale ? `Push first: ${this.remote.name} is on another commit` : this.scope !== "branch" ? "Submit from the Branch view" : "Send pending comments" })));
  }
  fileTree(t) {
    const pendingAt = new Set(this.state.comments.map((c) => c.path));
    return v_flex().w(292).h_full().flex_none().min_h(0).bg(t.chrome).border_r_1().border_color(t.border)
      .child(this.viewport((y) => { this.treeY = y; }, this.treeY, this.tree.length * FILE, this.viewH - 52, FILE, this.tree, (row) => {
        if (row.dir) return h_flex().h(FILE).flex_none().px(14).items_center().text_size(11.5).text_color(t.dim).child(div().truncate().child(row.dir));
        const { file } = row, on = file === this.open, seen = this.isViewed(file);
        return h_flex().id(`file-${file.path}`).h(FILE).flex_none().px(6).on_click((_e, cx) => { this.pick(file, cx); cx.notify(); })
          .child(h_flex().flex_1().min_w(0).h(28).pr(10).pl(row.nested ? 14 : 10).gap(6).items_center().rounded_full().text_size(12.5)
            .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
            .child(svg("mods/workspace-chrome/check.svg").size(12).flex_none().text_color(seen ? t.done : "#00000000"))
            .child(div().flex_1().min_w(0).truncate().text_color(seen ? t.muted : t.foreground).child(row.name))
            .when(pendingAt.has(file.path), (el) => el.child(div().size(6).rounded_full().bg(t.blocked)))
            .when(file.add > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${file.add}`)))
            .when(file.del > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${file.del}`))));
      }));
  }

  // A plain retained window over a long list. A virtual list's renderer runs on
  // every frame, so a spinner anywhere would rebuild its rows 30 times a second;
  // these rows are only rebuilt when something here changes.
  viewport(store, y, total, height, step, list, draw, offsets) {
    const top = Math.max(0, Math.min(y, total - height));
    let first = offsets ? 0 : Math.floor(top / step);
    if (offsets) { let hi = list.length; while (first < hi) { const mid = (first + hi) >> 1; if (offsets[mid + 1] <= top) first = mid + 1; else hi = mid; } }
    const rows = [];
    let at = offsets ? offsets[first] : first * step;
    const start = at;
    for (let i = first; i < list.length && at < top + height; i++) { rows.push(draw(list[i], i)); at = offsets ? offsets[i + 1] : at + step; }
    return div().relative().flex_1().min_h(0).w_full().overflow_hidden()
      .on_scroll_wheel((e, cx) => {
        const next = Math.max(0, Math.min(y - e.delta.y, total - height));
        if (next !== y) { y = next; store(next); cx.notify(); }
      })
      .child(v_flex().absolute().left(0).right(0).top(start - top).children(rows));
  }

  diffPane(t) {
    const file = this.open, cur = this.current;
    const body = this.diffError || cur?.note || !cur
      ? v_flex().flex_1().items_center().justify_center().text_color(t.muted).child(this.diffError ?? cur?.note ?? "Diffing…")
      : div().id("review-x").flex_1().min_h(0).flex().flex_col().overflow_x_scroll().child(div().flex().flex_col().w_full().min_w(this.diffWidth ?? 0).h_full()
        .child(this.viewport((y) => { this.scrollY = y; }, this.scrollY, this.offsets?.at(-1) ?? 0, this.diffHeight(), LINE, this.items, (item, i) => this.renderItem(item, i, t), this.offsets)));
    return v_flex().flex_1().h_full().min_w(0).min_h(0)
      .child(h_flex().h(40).flex_none().px(14).gap(10).items_center().border_b_1().border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().child(file ? (file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path) : ""))
        .when(Boolean(cur?.language), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(cur.language)))
        .when(Boolean(file), (el) => el.child(this.pill("comment", "Comment", (cx) => this.startComment(cx), t, { tip: "Comment on the selected line   C" }))
          .when(Boolean(this.chosen && this.state.comments.some((c) => c.id === this.chosen)), (el) => el.child(this.pill("delete", "Delete comment", (cx) => this.removeChosen(cx), t, { tip: "X" })))
          .child(this.pill("viewed", file && this.isViewed(file) ? "Viewed" : "Mark viewed", (cx) => this.toggleViewed(cx), t, { on: Boolean(file && this.isViewed(file)), tip: "V" }))))
      .child(div().flex_1().min_h(0).flex().flex_col().font_family(settings().font_family ?? "JetBrains Mono").text_size(12).child(body))
      .when(Boolean(this.writing), (el) => el.child(h_flex().flex_none().p(8).gap(6).border_t_1().border_color(t.border)
        .child(div().flex_1().min_w(0).h(36).px(14).flex().items_center().rounded_full().bg(t.selected).child(Input.new(this.input).h_full()))
        .child(this.pill("add", "Add", (cx) => this.addComment(cx), t, { solid: true }))
        .child(this.pill("cancel", "Cancel", () => { this.writing = false; this.handle.focus(); }, t))));
  }
  picker(t) {
    const q = this.filter.value().toLowerCase(), refs = (this.refs ?? []).filter((r) => r.toLowerCase().includes(q)).slice(0, 60);
    return v_flex().absolute().top(50).left(160).w(320).h(360).p(6).gap(2).rounded(16).bg(t.popover).border_1().border_color(t.border)
      .child(div().h(34).flex_none().px(12).flex().items_center().rounded_full().bg(t.selected).child(Input.new(this.filter).h_full()))
      .child(v_flex().id("review-refs").flex_1().min_h(0).overflow_y_scroll().gap(2).children(refs.map((ref) => h_flex().id(`ref-${ref}`).h(30).flex_none().px(12).items_center().rounded_full().cursor_pointer()
        .hover((s) => s.bg(ACCENT).text_color("#ffffff")).on_click((_e, cx) => { this.setBase(ref, cx); cx.notify(); }).child(div().truncate().child(ref)))));
  }

  render() {
    const t = theme();
    const empty = this.error ?? (this.root && !this.loading ? (this.scope === "local" ? "No uncommitted changes" : `Nothing differs from ${this.base}`) : "Loading…");
    return v_flex().id("review").relative().size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13).font_bold().track_focus(this.handle)
      .on_size_change((size, cx) => {
        if (size.height === this.viewH) return;
        this.viewH = size.height; this.scrollY = Math.min(this.scrollY, this.maxScroll()); cx.notify();
      })
      .on_key_down((e, cx) => {
        if (this.writing || this.picking) {
          if (e.key === "escape") { this.writing = false; this.picking = false; this.handle.focus(); cx.notify(); }
          return;
        }
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        if (this.key(e.key, cx)) { cx.stop_propagation(); cx.notify(); }
      })
      .child(this.header(t))
      .child(this.files.length
        ? h_flex().flex_1().min_h(0).items_start().child(this.fileTree(t)).child(this.diffPane(t))
        : v_flex().flex_1().gap(6).items_center().justify_center().child(image("mods/sleeve-spaces/icons/app-branch.svg").size(36).mb(4)).child(empty))
      .when(Boolean(this.picking), (el) => el.child(this.picker(t)));
  }
}
