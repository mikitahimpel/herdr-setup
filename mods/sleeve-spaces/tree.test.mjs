import assert from "node:assert/strict";
import { buildTree, spacesIn } from "./tree.js";
const tab = (id, extra) => ({ id, ...extra });
const sp = (id, tabs, machine = null) => ({ id, name: id, machine, tabs: tabs.map((t) => tab(t)) });
const g = (repo, linked = false, on = null) => ({ repo: JSON.stringify([on, repo]), name: repo, linked });
const shape = (nodes) => nodes.map((n) => n.kind === "repo" ? { repo: n.name, of: shape(n.children) } : n.kind === "space" ? (n.children.length ? { [n.id]: n.children.map((c) => c.id) } : n.id) : n.id);

// Two spaces on the main checkout and a worktree: one repo group, in space order.
let rows = [
  { w: sp("a", ["a1", "a2"]), i: 0, g: g("herdr") },
  { w: sp("notes", ["n1"]), i: 1, g: null },
  { w: sp("b", ["b1"]), i: 2, g: g("herdr") },
  { w: sp("wt", ["w1"]), i: 3, g: g("herdr", true) },
];
assert.deepEqual(shape(buildTree(rows, [])[0].nodes), [{ repo: "herdr", of: [{ a: ["a1", "a2"] }, "b", "wt"] }, "notes"]);

// A worktree alone in its repo (main checkout not open) stays a plain space.
rows = [{ w: sp("wt", ["w1"]), i: 0, g: g("herdr", true) }, { w: sp("x", ["x1"]), i: 1, g: g("other") }];
assert.deepEqual(shape(buildTree(rows, [])[0].nodes), ["wt", "x"]);

// Only worktrees, no main checkout: still a group.
rows = [{ w: sp("w1", ["t"]), i: 0, g: g("herdr", true) }, { w: sp("w2", ["u"]), i: 1, g: g("herdr", true) }];
assert.deepEqual(shape(buildTree(rows, [])[0].nodes), [{ repo: "herdr", of: ["w1", "w2"] }]);

// Machines: same repo path on two machines are two repos; each machine its own group.
rows = [
  { w: sp("a", ["t"]), i: 0, g: g("herdr") },
  { w: sp("b", ["t"], "pc"), i: 1, g: g("herdr", false, "pc") },
  { w: sp("c", ["t"], "pc"), i: 2, g: g("herdr", true, "pc") },
];
const tree = buildTree(rows, ["pc"]);
assert.deepEqual(tree.map((m) => m.machine), [null, "pc"]);
assert.deepEqual(shape(tree[0].nodes), ["a"]);
assert.deepEqual(shape(tree[1].nodes), [{ repo: "herdr", of: ["b", "c"] }]);
assert.deepEqual(spacesIn(tree[1].nodes).map((n) => n.id), ["b", "c"]);

// Settled tabs are put away unless shown.
rows = [{ w: { id: "s", name: "s", tabs: [tab("1"), tab("2", { settled: true }), tab("3", { settled: true, active: true })] }, i: 0, g: null }];
assert.deepEqual(shape(buildTree(rows, [])[0].nodes), [{ s: ["1", "3"] }]);
console.log("tree: ok");

// A manager and its workers: sections per branch, the space's own first; unknown tabs count as the space's.
{
  const gb = (branch) => ({ repo: "R", name: "billet", branch });
  const w = { id: "m", name: "m", tabs: ["boss", "w1", "w2", "w3", "late"].map((id) => ({ id })) };
  const rows = [{ w, i: 0, g: gb("arch/mood"), tabG: { boss: gb("arch/mood"), w1: gb("feat/a"), w2: gb("feat/b"), w3: gb("feat/a") } }];
  const kids = buildTree(rows, [])[0].nodes[0].children;
  assert.deepEqual(kids.map((s) => [s.kind, s.g.branch, s.children.map((c) => c.id)]), [
    ["section", "arch/mood", ["boss", "late"]],
    ["section", "feat/a", ["w1", "w3"]],
    ["section", "feat/b", ["w2"]],
  ]);
  // All on one branch: plain tabs.
  const flat = buildTree([{ w, i: 0, g: gb("x"), tabG: {} }], [])[0].nodes[0].children;
  assert.deepEqual(flat.map((n) => n.kind), ["tab", "tab", "tab", "tab", "tab"]);
  console.log("sections: ok");
}
