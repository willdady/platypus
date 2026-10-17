import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Org settings are for Org Admins only. Each layout under
 * `app/[orgId]/settings` must wrap its pages in
 * `<ProtectedRoute requireOrgAdmin>`, or a nested layout could expose a page
 * to every member.
 */

const SETTINGS_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "app/[orgId]/settings",
);

function layouts(dir: string) {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((entry) => path.basename(entry) === "layout.tsx")
    .map((entry) => path.join(dir, entry));
}

/** `requireOrgAdmin` bare, or `requireOrgAdmin={true}`. */
function requiresOrgAdmin(opening: ts.JsxOpeningLikeElement) {
  return opening.attributes.properties.some(
    (p) =>
      ts.isJsxAttribute(p) &&
      p.name.getText() === "requireOrgAdmin" &&
      (!p.initializer ||
        (ts.isJsxExpression(p.initializer) &&
          p.initializer.expression?.kind === ts.SyntaxKind.TrueKeyword)),
  );
}

function isGated(file: string) {
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText() === "ProtectedRoute" &&
      requiresOrgAdmin(node)
    )
      found = true;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("org settings layouts", () => {
  it("all require an Org Admin", () => {
    const files = layouts(SETTINGS_ROOT);

    // A moved directory would otherwise pass with nothing checked.
    expect(files.length).toBeGreaterThan(0);
    expect(
      files
        .filter((f) => !isGated(f))
        .map((f) => path.relative(SETTINGS_ROOT, f)),
    ).toEqual([]);
  });
});
