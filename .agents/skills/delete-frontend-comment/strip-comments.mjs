// Usage (from apps/frontend): node ../../.agents/skills/delete-frontend-comment/strip-comments.mjs <file> [startLine ...]
// Deletes the non-directive comments that start on the given lines (every one when none are given).
// A JSX comment's `{ }` goes with it.
import fs from "node:fs";
import tseslint from "typescript-eslint";

const DIRECTIVE = /^\s*(eslint-|@ts-|prettier-ignore|global\s)|^\/\s*</;
const [file, ...lines] = process.argv.slice(2);
const only = new Set(lines.map(Number));
let text = fs.readFileSync(file, "utf8");
const { ast } = tseslint.parser.parseForESLint(text, {
  comment: true,
  range: true,
  loc: true,
  filePath: file,
});
const doomed = ast.comments.filter(
  (c) =>
    !DIRECTIVE.test(c.value) &&
    !(c.type === "Line" && /^ why: \S/.test(c.value)) &&
    (only.size === 0 || only.has(c.loc.start.line)),
);
const emptyJsx = [];
const cut = new Set();
(function walk(n) {
  if (!n || typeof n.type !== "string") return;
  if (
    n.type === "JSXExpressionContainer" &&
    n.expression.type === "JSXEmptyExpression"
  )
    emptyJsx.push(n.range);
  for (const [k, v] of Object.entries(n)) {
    if (k === "parent") continue;
    for (const x of Array.isArray(v) ? v : [v])
      if (x && typeof x === "object") walk(x);
  }
})(ast);
for (const c of doomed.reverse()) {
  let [start, end] = c.range;
  const box = emptyJsx.find(([s, e]) => s < start && end < e);
  if (box && cut.has(box)) continue;
  if (box) [start, end] = (cut.add(box), box);
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const nl = text.indexOf("\n", end);
  const lineEnd = nl === -1 ? text.length : nl;
  if (
    !text.slice(lineStart, start).trim() &&
    !text.slice(end, lineEnd).trim()
  ) {
    [start, end] = [lineStart, Math.min(lineEnd + 1, text.length)];
  } else {
    while (start > lineStart && /[ \t]/.test(text[start - 1])) start--;
  }
  text = text.slice(0, start) + text.slice(end);
}
fs.writeFileSync(file, text);
console.log(`${file}: removed ${doomed.length}`);
