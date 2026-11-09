// The sidebar's tree, from facts alone: machine → repo → space → tab.
//
// - A machine is a group once any machine besides this computer is known.
// - A repo is a group once two or more of the machine's spaces are in it, main checkout
//   or worktree alike. It stands where its first space would, its spaces keep their order.
// - A space lists its tabs when it has more than one; with one it is a single row.
// - A space whose tabs work on different branches (a manager and its workers, each in
//   a worktree) lists them in sections, one per branch: its own branch's first.
//
// Pure (no herdr imports) so it runs under node: see tree.test.mjs.

// rows: [{ w, i, g, tabG }] in space order. w: a space (or a TUI session, w.tui), i: its
// index, g: its git facts ({ repo, name, branch, linked, ... }) or null outside a repo,
// tabG: tab id -> that tab's git facts (missing: not known yet, taken as the space's).
// remote: names of the other machines; [] draws no machine groups.
// Returns [{ machine, nodes }], this computer (null) first.
export function buildTree(rows, remote) {
  if (!remote.length) return [{ machine: null, nodes: forest(rows) }];
  return [null, ...remote].map((m) => ({ machine: m, nodes: forest(rows.filter((r) => (r.w.machine ?? null) === m)) }));
}

// The tabs a space lists: settled ones are put away, unless shown.
export function tabsOf(w) {
  return w.tui ? [] : (w.tabs ?? []).filter((c) => !c.settled || c.active);
}

function forest(rows) {
  const count = new Map();
  for (const r of rows) if (r.g?.repo) count.set(r.g.repo, (count.get(r.g.repo) ?? 0) + 1);
  const out = [];
  const repos = new Map();
  for (const r of rows) {
    const key = r.g?.repo;
    if (!key || count.get(key) < 2) {
      out.push(spaceNode(r, false));
      continue;
    }
    let repo = repos.get(key);
    if (!repo) {
      repo = { kind: "repo", id: key, name: r.g.name, machine: r.w.machine ?? null, children: [] };
      repos.set(key, repo);
      out.push(repo);
    }
    repo.children.push(spaceNode(r, true));
  }
  return out;
}

// Where a tab works, for sections: its repo and branch.
const checkout = (g) => (g ? `${g.repo}\n${g.branch ?? ""}` : "");

function sections(w, g, tabs) {
  const own = checkout(g);
  const groups = new Map();
  for (const t of tabs) {
    const k = t.g === undefined ? own : checkout(t.g);
    if (!groups.has(k)) groups.set(k, { kind: "section", id: `${w.id}\n${k}`, g: t.g === undefined ? g : t.g, children: [] });
    groups.get(k).children.push(t);
  }
  if (groups.size < 2) return tabs;
  const first = groups.get(own);
  return first ? [first, ...[...groups.values()].filter((s) => s !== first)] : [...groups.values()];
}

function spaceNode({ w, i, g, tabG = {} }, inRepo) {
  const tabs = tabsOf(w);
  const nodes = tabs.map((c) => ({ kind: "tab", id: c.id, w, c, g: tabG[c.id] }));
  return {
    kind: "space",
    id: w.id,
    w,
    i,
    g,
    inRepo,
    single: tabs.length === 1 ? tabs[0] : null,
    children: tabs.length > 1 ? sections(w, g, nodes) : [],
  };
}

// The space nodes in drawing order, for the narrow rail.
export function spacesIn(nodes) {
  return nodes.flatMap((n) => (n.kind === "repo" ? n.children : n.kind === "space" ? [n] : []));
}
