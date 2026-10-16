import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * A raw `<button>` skips everything `Button` gives for free. Without `type` it
 * submits any form it lands in, and without a `focus-visible:` style a keyboard
 * user gets only the browser's faint default outline (issue #1480). Every raw
 * `<button>` outside `components/ui` must set both, or use `Button`.
 */

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));

const tsxFiles = (dir: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...tsxFiles(full));
    else if (full.endsWith(".tsx") && !full.endsWith(".test.tsx"))
      found.push(full);
  }
  return found;
};

type Offence = { where: string; missing: string[] };

const offences = (): Offence[] => {
  const result: Offence[] = [];
  const files = [
    ...tsxFiles(path.join(APP_ROOT, "app")),
    ...tsxFiles(path.join(APP_ROOT, "components")),
  ].filter((f) => !f.includes(`${path.sep}components${path.sep}ui${path.sep}`));
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText() === "button"
      ) {
        const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
        const named = (name: string) =>
          attrs.find((a) => a.name.getText() === name);
        const missing: string[] = [];
        if (!named("type")) missing.push("type");
        if (!named("className")?.getText().includes("focus-visible:"))
          missing.push("focus-visible style");
        if (missing.length) {
          const { line } = source.getLineAndCharacterOfPosition(
            node.getStart(),
          );
          result.push({
            where: `${path.relative(APP_ROOT, file)}:${line + 1}`,
            missing,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return result;
};

describe("raw <button> elements", () => {
  it("set a type and a focus-visible style", () => {
    expect(offences()).toEqual([]);
  });
});
