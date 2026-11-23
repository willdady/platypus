// Usage (from apps/backend): node ../../.agents/skills/delete-comment/strip-comments.mjs <file> [startLine ...]
// Deletes the non-directive comments that start on the given lines (every one when none are given).
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
for (const c of doomed.reverse()) {
  let [start, end] = c.range;
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
