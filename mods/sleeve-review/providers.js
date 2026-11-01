// Where a branch's merge request lives. Each provider answers the same four
// questions, so the review doesn't care which one the remote is.
import { exec, appHome, writeTextFile } from "herdr";

export function parseRemote(url) {
  const m = /^(?:\w+:\/\/(?:[^@/]+@)?|[^@/]+@)?([^/:]+)(?::\d+\/|[:/])(.+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m) return null;
  return { host: m[1], path: m[2], kind: m[1].includes("github") ? "github" : "gitlab" };
}

const json = async (r) => {
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0]);
  return JSON.parse(r.stdout);
};

function gitlab(remote, ctx) {
  const project = `projects/${encodeURIComponent(remote.path)}`;
  const api = (path, args = []) => exec("glab", ["api", "--hostname", remote.host, path, ...args], ctx).then(json);
  const pipelines = { success: "passed", failed: "failed", running: "running", pending: "pending", canceled: "canceled" };
  return {
    label: "MR", cli: "glab", login: `glab auth login --hostname ${remote.host}`,
    async find(branch) {
      const list = await api(`${project}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=opened&per_page=1`);
      if (!list.length) return null;
      const mr = await api(`${project}/merge_requests/${list[0].iid}`);
      return { id: mr.iid, name: `!${mr.iid}`, title: mr.title, url: mr.web_url, target: mr.target_branch, head: mr.diff_refs?.head_sha ?? mr.sha, refs: mr.diff_refs, pipeline: pipelines[mr.head_pipeline?.status] ?? mr.head_pipeline?.status ?? null };
    },
    async threads(mr) {
      const list = await api(`${project}/merge_requests/${mr.id}/discussions?per_page=100`);
      return list.flatMap((d) => d.notes.filter((n) => n.position && !n.system).map((n) => ({
        id: `gl-${n.id}`, path: n.position.new_path ?? n.position.old_path, side: n.position.new_line ? "new" : "old",
        line: n.position.new_line ?? n.position.old_line, author: n.author?.name ?? "", body: n.body, resolved: Boolean(d.notes[0]?.resolved),
      })));
    },
    async submit(mr, comments) {
      for (const c of comments) {
        const fields = {
          note: c.body, "position[position_type]": "text", "position[base_sha]": mr.refs.base_sha, "position[start_sha]": mr.refs.start_sha,
          "position[head_sha]": mr.refs.head_sha, "position[old_path]": c.oldPath ?? c.path, "position[new_path]": c.path,
        };
        if (c.newLine) fields["position[new_line]"] = String(c.newLine);
        if (c.oldLine) fields["position[old_line]"] = String(c.oldLine);
        await api(`${project}/merge_requests/${mr.id}/draft_notes`, ["--method", "POST", ...Object.entries(fields).flatMap(([k, v]) => ["--raw-field", `${k}=${v}`])]);
      }
      await api(`${project}/merge_requests/${mr.id}/draft_notes/bulk_publish`, ["--method", "POST"]);
    },
    approve: (mr) => api(`${project}/merge_requests/${mr.id}/approve`, ["--method", "POST"]),
  };
}

function github(remote, ctx) {
  const base = `repos/${remote.path}/pulls`;
  const api = (path, args = []) => exec("gh", ["api", path, ...args], { ...ctx }).then(json);
  const review = async (mr, body) => {
    const file = `${appHome()}/mods/sleeve-review/.cache/review-${Date.now()}.json`;
    await exec("mkdir", ["-p", file.slice(0, file.lastIndexOf("/"))]);
    await writeTextFile(file, JSON.stringify({ commit_id: mr.head, ...body }), null);
    try { await api(`${base}/${mr.id}/reviews`, ["--method", "POST", "--input", file]); }
    finally { await exec("rm", ["-f", file]); }
  };
  const verdict = (rollup) => {
    const states = (rollup ?? []).map((c) => c.conclusion || c.state || c.status);
    if (!states.length) return null;
    if (states.some((s) => /FAIL|ERROR|CANCEL/.test(s))) return "failed";
    return states.every((s) => /SUCCESS|NEUTRAL|SKIP/.test(s)) ? "passed" : "running";
  };
  return {
    label: "PR", cli: "gh", login: "gh auth login",
    async find(branch) {
      const r = await exec("gh", ["pr", "view", branch, "--repo", remote.path, "--json", "number,title,url,baseRefName,headRefOid,state,statusCheckRollup"], ctx);
      if (r.code !== 0) { if (/no pull requests? found/i.test(r.stderr)) return null; throw new Error(r.stderr.trim().split("\n")[0]); }
      const pr = JSON.parse(r.stdout);
      if (pr.state !== "OPEN") return null;
      return { id: pr.number, name: `#${pr.number}`, title: pr.title, url: pr.url, target: pr.baseRefName, head: pr.headRefOid, pipeline: verdict(pr.statusCheckRollup) };
    },
    async threads(mr) {
      const list = await api(`${base}/${mr.id}/comments?per_page=100`);
      return list.filter((c) => c.line ?? c.original_line).map((c) => ({
        id: `gh-${c.id}`, path: c.path, side: c.side === "LEFT" ? "old" : "new", line: c.line ?? c.original_line, author: c.user?.login ?? "", body: c.body, resolved: false,
      }));
    },
    submit: (mr, comments) => review(mr, { event: "COMMENT", comments: comments.map((c) => ({ path: c.path, line: c.line, side: c.side === "old" ? "LEFT" : "RIGHT", body: c.body })) }),
    approve: (mr) => review(mr, { event: "APPROVE" }),
  };
}

export const providerFor = (remote, ctx) => (remote?.kind === "github" ? github(remote, ctx) : remote ? gitlab(remote, ctx) : null);
