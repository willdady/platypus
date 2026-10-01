// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * An icon-only button has no text, so without an `aria-label` a screen reader
 * announces it only as "button" (issue #1137). Every `<Button size="icon">`,
 * and every raw `<button>` whose only children are components (icons), must
 * carry `aria-label` / `aria-labelledby`, or a `sr-only` text child, in the
 * source — `title` alone is not enough.
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

/** A raw `<button>` whose children are all self-closing components, e.g. `<X />`. */
const isIconOnlyRawButton = (node: ts.Node) => {
  if (!ts.isJsxElement(node)) return false;
  if (node.openingElement.tagName.getText() !== "button") return false;
  const children = node.children.filter(
    (c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces),
  );
  return (
    children.length > 0 &&
    children.every(
      (c) =>
        ts.isJsxSelfClosingElement(c) && /^[A-Z]/.test(c.tagName.getText()),
    )
  );
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

/** A present, non-empty `aria-label` / `aria-labelledby`. */
const hasNameAttr = (opening: ts.JsxOpeningLikeElement) =>
  ["aria-label", "aria-labelledby"].some((name) => {
    const a = attr(opening, name);
    if (!a?.initializer) return false;
    return (
      !ts.isStringLiteral(a.initializer) || a.initializer.text.trim() !== ""
    );
  });

const hasAccessibleName = (node: ts.JsxElement | ts.JsxSelfClosingElement) => {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  if (hasNameAttr(opening)) return true;
  return ts.isJsxElement(node) && hasSrOnlyChild(node);
};

describe("icon-only buttons", () => {
  it("all have an accessible name", () => {
    const unnamed: string[] = [];

    for (const file of tsxFiles(APP_ROOT)) {
      const source = readFileSync(file, "utf8");
      if (!/size="icon|<button/.test(source)) continue;
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
          (isIconButton(opening) || isIconOnlyRawButton(node)) &&
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
