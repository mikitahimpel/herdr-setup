// Search past Claude Code and Codex conversations with the agent-history CLI.
// Enter resumes the conversation in a new tab, in the folder it ran in.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { appHome, closeOverlay, exec, home, notify, props, run, spaces, theme } from "herdr";

const SELECTED = "#2f74d6";
const SHOWN = 10, ROW_H = 50, LIST_W = 400, HEIGHT = 620, LABEL_H = 24, WAIT = 120, KEEP = 40;
const TILE = { Claude: "mods/sleeve-spaces/icons/app-claude.svg", Codex: "icons/codex.svg" };
const SPINNER = "mods/workspace-chrome/spinner.svg";
const FOLDER = `f="\${1%:*}"; grep -m1 -o '"cwd":"[^"]*"' "$f" | head -1 | sed 's/"cwd":"//;s/"$//'`;

// A snippet read as a sentence: markdown marks are noise on one line.
const plain = (text) => text
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/```\w*/g, " ")
  .replace(/(\*\*|__|`|~~)/g, "")
  .replace(/(^|\s)[*_](\S(?:.*?\S)?)[*_](?=\s|[.,:;!?]|$)/g, "$1$2")
  .replace(/(^|\s)(#{1,6}|>|[-*+]|\d+\.)\s+/g, "$1")
  .replace(/\s+/g, " ").trim();

// One tab-separated line per hit: rank, agent, role, project / branch, id, time, file:range, text.
function parse(out) {
  const seen = new Set(), rows = [];
  let last = null; // A hit's text can run over several lines.
  for (const line of out.split("\n")) {
    const [rank, agent, role, where, id, time, file, ...text] = line.split("\t");
    if (!/^\d+$/.test(rank) || !id) { if (last) last.text += ` ${line}`; continue; }
    last = null;
    if (seen.has(id)) continue;
    seen.add(id);
    last = { agent, role, where, id, time, file, text: text.join(" ") };
    rows.push(last);
  }
  for (const row of rows) row.text = plain(row.text.replace(/\s*…\s*/g, " "));
  return rows.slice(0, KEEP);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function stamp(time) {
  const d = new Date(time);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function ago(time) {
  const minutes = Math.floor((Date.now() - new Date(time).getTime()) / 60000), days = Math.floor(minutes / 1440);
  if (minutes < 60) return `${Math.max(minutes, 1)}m`;
  if (days < 1) return `${Math.floor(minutes / 60)}h`;
  if (days < 30) return `${days}d`;
  return days < 365 ? `${Math.floor(days / 30)}mo` : `${Math.floor(days / 365)}y`;
}

export default class History extends View {
  init(_props, cx) {
    this.query = "";
    this.rows = [];
    this.recent = [];
    this.sessions = {};
    this.at = 0;
    this.asked = 0;
    this.input = InputState.new({ placeholder: "Search past conversations…" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.soon(cx); });
    this.input.on("submit", (_e, cx) => this.resume(this.rows[this.at], cx));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      const got = await exec("python3", [`${appHome()}/mods/sleeve-history/recent.py`, String(KEEP)]).catch(() => null);
      try { this.recent = JSON.parse(got.stdout).map((r) => ({ ...r, text: plain(r.text) })); } catch { this.recent = []; }
      this.loaded = true;
      if (!this.query.trim()) this.rows = this.recent;
      cx.notify();
    });
    cx.spawn(async (cx) => {
      await exec("agent-history", ["index"]).catch(() => null);
      this.search(cx);
    });
  }

  soon(cx) {
    const asked = ++this.asked;
    this.busy = Boolean(this.query.trim());
    cx.notify();
    cx.timer.after(WAIT, (cx) => { if (asked === this.asked) this.search(cx); });
  }

  search(cx) {
    const q = this.query.trim(), asked = this.asked;
    if (!q) {
      if (this.rows !== this.recent) { this.rows = this.recent; this.at = 0; }
      this.failed = this.busy = false;
      return cx.notify();
    }
    cx.spawn(async (cx) => {
      const r = await exec("agent-history", ["search", "--", q]).catch(() => null);
      if (asked !== this.asked) return;
      this.busy = false;
      this.failed = !r || r.code !== 0;
      this.rows = this.failed ? [] : parse(r.stdout);
      this.at = 0;
      this.searched = q;
      cx.notify();
    });
  }

  resume(r, cx) {
    if (!r) return;
    cx.spawn(async () => {
      const found = await exec("sh", ["-c", FOLDER, "sh", r.file]).catch(() => null);
      const folder = found?.stdout.trim();
      const there = folder && (await exec("test", ["-d", folder]).catch(() => null))?.code === 0;
      closeOverlay(props()?.overlay);
      if (!there) return notify({ title: "Couldn't resume", body: `Its folder is gone: ${folder || r.where}`, level: "error" });
      const argv = r.agent === "Codex" ? ["codex", "resume", r.id] : ["claude", "--resume", r.id];
      const space = spaces().find((s) => s.folder === folder && !s.machine);
      if (space) run("space.select", { id: space.id });
      run("tab.new", { name: r.where.split(" / ")[0].split("/").pop(), folder, argv, ...(space ? { space: space.id } : {}) });
    });
  }

  // The conversation around the selected hit; the last one stays up until the next arrives.
  details(r, cx) {
    if (!r || this.about === r.file) return;
    const about = this.about = r.file;
    if (this.sessions[r.file]) return;
    cx.timer.after(WAIT, (cx) => {
      if (this.about !== about) return;
      cx.spawn(async (cx) => {
        const got = await exec("python3", [`${appHome()}/mods/sleeve-history/session.py`, r.agent.toLowerCase(), r.file, r.file.endsWith(":0-0") ? "" : this.searched ?? ""]).catch(() => null);
        try { this.sessions[r.file] = { id: r.id, ...JSON.parse(got.stdout) }; }
        catch { this.sessions[r.file] = { id: r.id, turns: [], failed: true }; }
        cx.notify();
      });
    });
  }

  title(r, on, t) {
    const [repo, branch] = r.where.split(" / ");
    const name = repo === "-" ? "No project" : repo.split("/").pop();
    return h_flex().min_w(0).gap(6).items_center()
      .child(div().flex_none().text_color(on ? "#ffffff" : t.foreground).child(name))
      .when(Boolean(branch) && branch !== "-", (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(on ? "#ffffffcc" : t.muted).child(branch)));
  }

  row(r, i, t) {
    const on = i === this.at;
    return h_flex().id(`hs-${r.id}`).h(ROW_H - 2).flex_none().px(12).gap(10).items_center().rounded(18).cursor_pointer()
      .when(on, (el) => el.bg(SELECTED))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_hover((over, cx) => { if (over && this.at !== i) { this.at = i; cx.notify(); } })
      .on_click((_e, cx) => this.resume(r, cx))
      .child(image(TILE[r.agent] ?? TILE.Claude).size(22).flex_none())
      .child(v_flex().flex_1().min_w(0).child(this.title(r, on, t))
        .child(div().truncate().text_size(12.5).font_medium().text_color(on ? "#ffffff" : t.foreground).child(r.text)))
      .child(div().flex_none().text_size(12).text_color(on ? "#ffffffd9" : t.muted).child(ago(r.time)));
  }

  message(turn, i, id, t) {
    const mine = turn.role === "user";
    const body = TextView.markdown(`hs-text-${id}-${i}`, turn.text).selectable(true);
    return v_flex().flex_none().gap(4)
      .when(turn.skipped > 0, (el) => el.child(div().py(4).text_size(11.5).text_center().text_color(t.dim).child(`${turn.skipped} more message${turn.skipped === 1 ? "" : "s"}`)))
      .child(h_flex().gap(6).items_center().text_size(11.5)
        .child(div().text_color(mine ? t.foreground : t.muted).child(mine ? "You" : "Agent"))
        .child(div().font_medium().text_color(t.dim).child(turn.time ? stamp(turn.time) : ""))
        .when(turn.hit, (el) => el.child(div().px(6).py(1).rounded_full().bg(SELECTED).text_color("#ffffff").child("Match"))))
      .child(div().px(12).py(8).rounded(14).text_size(12.5).font_medium().text_color(t.foreground)
        .bg(mine ? t.selected : t.raised).border_1().border_color(turn.hit ? SELECTED : mine ? t.selected : t.raised).child(body));
  }

  preview(r, t) {
    const session = this.sessions[r.file] ?? this.shownSession;
    if (this.sessions[r.file]) this.shownSession = session;
    const [repo, branch] = r.where.split(" / ");
    const folder = session?.id === r.id ? session.cwd?.replace(home(), "~") : null;
    const name = repo === "-" ? folder?.split("/").pop() ?? "No project" : repo.split("/").pop();
    const live = session?.id === r.id && session.branch !== "HEAD" ? session.branch : null;
    const facts = [branch && branch !== "-" ? branch : live, session?.id === r.id && session.total ? `${session.total} messages` : null, stamp(r.time)].filter(Boolean);
    return v_flex().flex_1().min_w(0).h_full().border_l(1).border_color(t.border)
      .child(v_flex().h(58).flex_none().px(16).justify_center().gap(2).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center().child(image(TILE[r.agent] ?? TILE.Claude).size(18).flex_none()).child(div().truncate().child(name)))
        .child(div().truncate().text_size(11.5).font_medium().text_color(t.muted).child(facts.join("  ·  "))))
      .child(v_flex().id(`hs-chat-${session?.id ?? "none"}`).flex_1().min_h(0).overflow_y_scroll().px(14).py(12).gap(12)
        .when(Boolean(session?.failed), (el) => el.child(div().text_color(t.muted).child("Couldn't read this conversation")))
        .children((session?.turns ?? []).map((turn, i) => this.message(turn, i, session.id, t))));
  }

  // Nothing to list: why, and what to do about it. Spans the whole popup.
  state(icon, title, detail, t, turning = false) {
    return v_flex().flex_1().h_full().items_center().justify_center().gap(4).pb(24)
      .child(div().size(52).mb(10).flex().items_center().justify_center().rounded_full().bg(t.raised)
        .child(svg(icon).size(22).text_color(t.muted).when(turning, (el) => el.spin(900))))
      .child(div().text_size(14).text_color(t.foreground).child(title))
      .child(div().max_w(380).text_center().truncate().text_size(12.5).font_medium().text_color(t.muted).child(detail));
  }

  empty(q, t) {
    if (this.busy) return this.state(SPINNER, "Searching…", `Looking through your conversations for "${q}"`, t, true);
    if (!q && !this.loaded) return this.state(SPINNER, "Loading conversations…", "Reading your latest Claude Code and Codex sessions", t, true);
    if (this.failed) return this.state("mods/sleeve-chrome/icons/search.svg", "Search isn't available", "agent-history didn't run", t);
    if (q && this.searched === q) return this.state("mods/sleeve-chrome/icons/search.svg", `No matches for "${q}"`, "Try fewer or different words", t);
    if (!q && this.loaded) return this.state("mods/sleeve-chrome/icons/history.svg", "No conversations yet", "Claude Code and Codex sessions will appear here", t);
    return div().flex_1();
  }

  render(cx) {
    const t = theme();
    // The window moves only when the selection walks off its edge.
    this.top = Math.max(0, Math.min(this.top ?? 0, this.at, this.rows.length - SHOWN));
    if (this.at >= this.top + SHOWN) this.top = this.at - SHOWN + 1;
    const from = this.top;
    if (cx) this.details(this.rows[this.at], cx);
    const q = this.query.trim(), some = this.rows.length > 0;
    const waiting = this.busy || (!q && !this.loaded);
    const label = !q ? "Recent" : this.busy ? "Searching…" : `${this.rows.length}${this.rows.length === KEEP ? "+" : ""} conversation${this.rows.length === 1 ? "" : "s"}`;
    const hint = (label, cap) => h_flex().gap(6).items_center().child(label)
      .child(div().h(20).px(6).flex().items_center().rounded(6).border_1().border_color(t.input).text_color(t.foreground).child(cap));
    return v_flex().id("history").track_focus(this.handle).w_full().h(HEIGHT).rounded(26).overflow_hidden().border_1().border_color(t.input).bg(t.popover).shadow_2xl().text_size(13).font_semibold()
      .on_key_down((e, cx) => {
        if (e.key === "escape") return closeOverlay(props()?.overlay);
        if (e.key === "down") this.at = Math.min(this.at + 1, this.rows.length - 1);
        else if (e.key === "up") this.at = Math.max(this.at - 1, 0);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().m(6).mb(8).h(38).flex_none().px(12).gap(8).items_center().rounded_full().bg(t.selected)
        .child(waiting
          ? svg(SPINNER).size(16).flex_none().text_color(t.muted).spin(900)
          : svg("mods/sleeve-chrome/icons/search.svg").size(16).flex_none().text_color(t.foreground))
        .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground)))
      .child(h_flex().flex_1().min_h(0).items_start()
        .when(!some, (el) => el.child(this.empty(q, t)))
        .when(some, (el) => el
          .child(v_flex().w(LIST_W).flex_none().h_full().px(6).gap(2).overflow_hidden()
            .child(div().h(LABEL_H).flex_none().px(12).text_size(12).text_color(t.muted).child(label))
            .child(v_flex().flex_1().min_h(0).gap(2).when(this.busy, (el) => el.opacity(0.45))
              .children(this.rows.slice(from, from + SHOWN).map((r, n) => this.row(r, from + n, t)))))
          .child(this.preview(this.rows[this.at], t))))
      .child(h_flex().h(40).flex_none().px(14).gap(14).items_center().justify_end().border_t(1).border_color(t.border).text_size(12).text_color(t.muted)
        .child(hint("Close", "esc")).when(some, (el) => el.child(hint("Resume", "↩"))));
  }
}
