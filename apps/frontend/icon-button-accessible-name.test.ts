// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * An icon-only `<Button size="icon">` has no text, so without an `aria-label`
 * a screen reader announces it only as "button" (issue #1137). Every such
 * Button must carry `aria-label` / `aria-labelledby`, or a `sr-only` text
 * child, in the source — `title` alone is not enough.
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

const attr = (opening: ts.JsxOpeningLikeElement, name: string) =>
  opening.attributes.properties.find(
    (p): p is ts.JsxAttribute =>
      ts.isJsxAttribute(p) && p.name.getText() === name,
  );

const isIconButton = (opening: ts.JsxOpeningLikeElement) => {
  if (opening.tagName.getText() !== "Button") return false;
  const size = attr(opening, "size")?.initializer;
  return !!size && ts.isStringLiteral(size) && size.text.startsWith("icon");
};

const hasSrOnlyChild = (element: ts.JsxElement): boolean => {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const className = attr(node, "className")?.initializer;
      if (className && /\bsr-only\b/.test(className.getText())) found = true;
    }
    ts.forEachChild(node, visit);
  };
  element.children.forEach(visit);
  return found;
};

const hasAccessibleName = (node: ts.JsxElement | ts.JsxSelfClosingElement) => {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  if (attr(opening, "aria-label") || attr(opening, "aria-labelledby"))
    return true;
  return ts.isJsxElement(node) && hasSrOnlyChild(node);
};

describe("icon-only Buttons", () => {
  it("all have an accessible name", () => {
    const unnamed: string[] = [];

    for (const file of tsxFiles(APP_ROOT)) {
      const source = readFileSync(file, "utf8");
      if (!/size="icon/.test(source)) continue;
      const sf = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const visit = (node: ts.Node) => {
        const opening = ts.isJsxElement(node)
          ? node.openingElement
          : ts.isJsxSelfClosingElement(node)
            ? node
            : null;
        if (
          opening &&
          isIconButton(opening) &&
          !hasAccessibleName(node as ts.JsxElement | ts.JsxSelfClosingElement)
        ) {
          const { line } = sf.getLineAndCharacterOfPosition(opening.getStart());
          unnamed.push(`${path.relative(APP_ROOT, file)}:${line + 1}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    expect(unnamed).toEqual([]);
  });
});
