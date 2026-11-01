// Turns `difft --display json` output into rows the review draws.
const KEYWORDS = new Set("as async await break case catch class const continue def default defer do elif else enum except export extends false final finally fn for from func function go if impl implements import in interface is let loop match mod module mut new nil none not null of or package private protected pub public raise return self static struct super switch this throw trait true try type undefined use var void where while with yield".split(" "));
const TOKEN = /(\/\/.*|#(?![\w{[]).*|--\s.*)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\w.]*\b)|([A-Za-z_$][\w$]*)/g;
const MAX_LINE = 1200;

const split = (text) => (text ? text.replace(/\n$/, "").split("\n") : []);

// difftastic counts bytes; JS strings count UTF-16 units.
function charOffset(line, byte) {
  let bytes = 0;
  for (let i = 0; i < line.length; i++) {
    if (bytes >= byte) return i;
    const c = line.codePointAt(i);
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (c >= 0x10000) i++;
  }
  return line.length;
}

function changesByLine(chunks, side) {
  const lines = new Map();
  for (const chunk of chunks ?? []) for (const entry of chunk) {
    const hit = entry[side];
    if (hit) lines.set(hit.line_number, [...(lines.get(hit.line_number) ?? []), ...hit.changes]);
  }
  return lines;
}

// One row per aligned pair; a null side is a line the other side doesn't have.
export function buildRows(oldText, newText, parsed) {
  const left = split(oldText), right = split(newText);
  if (parsed.status === "created" || !left.length) return right.map((text, r) => ({ l: null, r, rt: text, changed: true }));
  if (parsed.status === "deleted" || !right.length) return left.map((text, l) => ({ l, r: null, lt: text, changed: true }));
  const lhs = changesByLine(parsed.chunks, "lhs"), rhs = changesByLine(parsed.chunks, "rhs");
  const rows = [];
  for (const [l, r] of parsed.aligned_lines ?? []) {
    const lt = l === null ? undefined : left[l], rt = r === null ? undefined : right[r];
    if (lt === undefined && rt === undefined) continue;
    const lc = lhs.get(l), rc = rhs.get(r);
    rows.push({ l: lt === undefined ? null : l, r: rt === undefined ? null : r, lt, rt, lc, rc, changed: lt === undefined || rt === undefined || Boolean(lc || rc) });
  }
  return rows;
}

// Hunks with `context` lines around them; the rest collapse to a fold.
export function foldRows(rows, opened, context = 3) {
  const keep = new Uint8Array(rows.length);
  rows.forEach((row, i) => {
    if (!row.changed) return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = 1;
  });
  const items = [];
  for (let i = 0; i < rows.length;) {
    if (keep[i]) { items.push({ kind: "line", row: rows[i] }); i++; continue; }
    let end = i;
    while (end < rows.length && !keep[end]) end++;
    if (opened.has(i)) for (; i < end; i++) items.push({ kind: "line", row: rows[i] });
    else items.push({ kind: "fold", at: i, count: end - i });
    i = end;
  }
  return items;
}

// A side-by-side row becomes up to two lines when read inline.
export function inlineItems(items) {
  return items.flatMap((item) => {
    if (item.kind !== "line") return [item];
    const { row } = item;
    if (!row.changed) return [{ ...item, side: "both" }];
    return [row.l !== null ? { ...item, side: "old" } : null, row.r !== null ? { ...item, side: "new" } : null].filter(Boolean);
  });
}

function tokens(line) {
  const out = [];
  let at = 0;
  for (const m of line.matchAll(TOKEN)) {
    const kind = m[1] ? "comment" : m[2] ? "string" : m[3] ? "number" : KEYWORDS.has(m[4]) ? "keyword" : /^[A-Z]/.test(m[4]) ? "type" : null;
    if (!kind) continue;
    if (m.index > at) out.push({ text: line.slice(at, m.index) });
    out.push({ text: m[0], kind });
    at = m.index + m[0].length;
  }
  if (at < line.length) out.push({ text: line.slice(at) });
  return out;
}

// A line as runs of { text, kind, strong }: syntax colour, with difftastic's changes marked.
export function segments(line = "", changes) {
  const text = line.length > MAX_LINE ? line.slice(0, MAX_LINE) + "…" : line;
  const spans = (changes ?? []).map((c) => [charOffset(line, c.start), charOffset(line, c.end)]).sort((a, b) => a[0] - b[0]);
  const out = [];
  let at = 0;
  for (const token of tokens(text)) {
    const end = at + token.text.length;
    const cuts = [at, end];
    for (const [a, b] of spans) { if (a > at && a < end) cuts.push(a); if (b > at && b < end) cuts.push(b); }
    cuts.sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i++) {
      if (cuts[i] === cuts[i + 1]) continue;
      const strong = spans.some(([a, b]) => a <= cuts[i] && cuts[i + 1] <= b);
      out.push({ text: text.slice(cuts[i], cuts[i + 1]), kind: token.kind, strong });
    }
    at = end;
  }
  return out.length ? out : [{ text: " " }];
}

export const wrap = (body, width = 96) => body.split("\n").flatMap((line) => {
  const out = [];
  for (let rest = line; ;) {
    if (rest.length <= width) { out.push(rest); return out; }
    const cut = rest.lastIndexOf(" ", width);
    out.push(rest.slice(0, cut > 0 ? cut : width));
    rest = rest.slice(cut > 0 ? cut + 1 : width);
  }
});
