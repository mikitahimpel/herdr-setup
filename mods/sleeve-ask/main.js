// Ask Claude: one line for a question or a problem, and Claude starts on it in the
// right place. The place is a space: the one the props name (a context menu), else the
// one whose name the text mentions, else the shown one; ↑/↓ or Tab pick another.
// Enter starts Claude in a new tab there; ⌘Enter in a new worktree of that space's repo.
// Opened by mod.open (keys, palette, the + menu) or openOverlay with props { space? }.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, exec, home } from "herdr";

const CLAUDE = ["claude"];
const RU = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };

// A branch name from the text: its first few words, in Latin letters.
function slug(text) {
  const latin = [...text.toLowerCase()].map((c) => RU[c] ?? c).join("");
  const words = latin.replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean).slice(0, 5);
  return words.join("-").slice(0, 40).replace(/-+$/, "") || `ask-${Date.now().toString(36)}`;
}

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

const base = (path) => (path ?? "").replace(/\/+$/, "").split("/").pop();

// How much the text is about space `c`: its name's or folder's words in the text.
function score(text, c) {
  const t = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  let n = 0;
  for (const name of new Set([c.name, base(c.folder)].filter(Boolean).map((s) => s.toLowerCase()))) {
    if (name.length < 3) continue;
    if (t.includes(` ${name.replace(/[^\p{L}\p{N}]+/gu, " ")} `)) n += 3;
    else for (const w of name.split(/[^\p{L}\p{N}]+/u)) if (w.length >= 4 && t.includes(` ${w} `)) n += 1;
  }
  return n;
}

async function git(cwd, args, on) {
  const r = await exec("git", args, { cwd, on: on ?? undefined, timeout: 120000 });
  return { ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}

export default class SleeveAsk extends View {
  init(_props, cx) {
    const active = spaces().find((s) => s.active);
    this.places = spaces().filter((s) => !s.tui).map((s) => ({ id: s.id, name: s.name, folder: place(s), machine: s.machine ?? null }));
    const asked = props()?.space;
    this.fixed = Boolean(asked);
    this.at = Math.max(0, this.places.findIndex((c) => c.id === (asked ?? active?.id)));
    this.shown = this.at;
    this.text = "";
    this.error = "";
    this.busy = false;
    this.input = InputState.new({ value: "", placeholder: "A question or a problem…" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.guess(); cx.notify(); });
    this.input.on("submit", (e, cx) => this.go(Boolean(e?.secondary), cx));
    this.input.focus();
    cx.timer.after(100, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  // Follows the text to the space it names, until a place is picked by hand.
  guess() {
    if (this.fixed) return;
    let best = this.shown, top = 0;
    this.places.forEach((c, i) => { const s = score(this.text, c); if (s > top) { top = s; best = i; } });
    this.at = best;
  }

  pick(step) {
    if (!this.places.length) return;
    this.fixed = true;
    this.at = (this.at + step + this.places.length) % this.places.length;
  }

  close() {
    closeOverlay(props().overlay);
  }

  go(worktree, cx) {
    const task = this.text.trim();
    const c = this.places[this.at];
    if (!task || !c || this.busy) return;
    if (!worktree) {
      this.close();
      run("tab.new", { space: c.id, folder: c.folder, argv: CLAUDE, task });
      return;
    }
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      this.error = await this.worktree(c, task).catch((e) => String(e));
      this.busy = false;
      if (!this.error) this.close();
      cx.notify();
    });
  }

  // A new branch and checkout of the space's repo, from where that space is, and a
  // space there with Claude on the task. "" when done, else what went wrong.
  async worktree(c, task) {
    const top = await git(c.folder, ["rev-parse", "--show-toplevel"], c.machine);
    const common = await git(c.folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], c.machine);
    if (!top.ok || !common.ok) return `${c.name} isn't in a git repo: Enter starts a tab there.`;
    const repo = common.out.endsWith("/.git") ? base(common.out.slice(0, -5)) : base(common.out).replace(/\.git$/, "");
    const root = c.machine ? (await exec("sh", ["-c", "printf %s \"$HOME\""], { on: c.machine })).stdout.trim() : home();
    let branch = slug(task);
    for (let n = 2; (await git(top.out, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], c.machine)).ok; n++) branch = `${slug(task)}-${n}`;
    const path = `${root}/.herdr/worktrees/${repo}/${branch}`;
    const add = await git(top.out, ["worktree", "add", "-b", branch, path, "HEAD"], c.machine);
    if (!add.ok) return add.err || "git worktree add failed.";
    // Unnamed, so it follows its folder and nests under the repo in the sidebar.
    run("space.new", { folder: path, machine: c.machine ?? "", argv: CLAUDE, task });
    return "";
  }

  render(cx) {
    const t = theme();
    const c = this.places[this.at];
    const cap = (id, label, key, action) => h_flex().id(id).gap(6).items_center().cursor_pointer()
      .text_color(t.muted).hover((s) => s.text_color(t.foreground))
      .on_click(action)
      .child(label)
      .child(div().h(20).px(6).flex().items_center().rounded(6).border_1().border_color(t.input).text_color(t.foreground).child(key));
    return v_flex()
      .id("sleeve-ask")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.close();
        else if (e.key === "down" || (e.key === "tab" && !e.modifiers.shift)) this.pick(1);
        else if (e.key === "up" || e.key === "tab") this.pick(-1);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .size_full().rounded(12).overflow_hidden().border_1().border_color(t.input).bg(t.popover).shadow_2xl().font_semibold()
      .child(h_flex().h(46).flex_none().px(16).gap(10).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/sleeve-ask/sparkles.svg").size(16).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(13.5).text_color(t.foreground)))
      // Where it starts: the picked space, its folder dim beside it.
      .child(h_flex().h(40).flex_none().px(16).gap(8).items_center().text_size(12).border_b(1).border_color(t.border)
        .child(div().flex_none().text_color(t.dim).child("In"))
        .child(h_flex().id("ask-place").flex_none().h(24).px(8).gap(6).items_center().rounded(7).cursor_pointer()
          .bg(t.raised ?? t.hover).text_color(t.foreground).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.pick(1); cx.notify(); })
          .child(c?.name ?? "No space")
          .child(svg("mods/workspace-chrome/chevron-down.svg").size(11).text_color(t.dim)))
        .child(div().flex_1().min_w(0).truncate().font_medium().text_color(this.error ? t.blocked : t.dim)
          .child(this.error || (this.busy ? "Making the worktree…" : c ? `${c.machine ? `${c.machine}:` : ""}${(c.folder ?? "").replace(home(), "~")}` : "")))
        .child(div().flex_none().font_medium().text_color(t.dim).child("↑↓")))
      .child(h_flex().h(52).flex_none().px(18).gap(18).items_center().justify_end().text_size(12)
        .child(cap("ask-cancel", "Cancel", "esc", () => this.close()))
        .child(cap("ask-tree", "New worktree", "⌘↩", (_e, cx) => this.go(true, cx)))
        .child(cap("ask-tab", "New tab", "↩", (_e, cx) => this.go(false, cx))));
  }
}
