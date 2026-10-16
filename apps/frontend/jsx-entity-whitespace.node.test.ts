import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/**
 * Next compiles JSX with SWC, and SWC drops the leading space of a multi-line
 * JSX text run that contains an HTML entity:
 *
 *   this {label} appears in. It
 *   runs against each workspace&apos;s own resources.
 *
 * compiles to `"this ", label, "appears in. …"` — the UI renders
 * "skillappears in" while the source reads correctly (issue #387). Babel keeps
 * the space, so the vitest render tests cannot see it; this compiles the real
 * files with the real transform instead.
 *
 * Each candidate file is compiled twice: as-is, and with its entities swapped
 * for a plain letter (the shape SWC handles correctly). Any difference in the
 * leading/trailing whitespace of an emitted string is the bug. Write the
 * character literally (’, ", &, —) to avoid it.
 *
 * This loads Next's own SWC binding, so a Next upgrade that moves or fixes it
 * fails here loudly rather than quietly letting the bug back in.
 */

const require = createRequire(import.meta.url);
const swc = require("next/dist/build/swc");

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
// Any named or numeric entity, so a future &rsquo; or &hellip; is covered too.
const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]{1,10}|#\d+|#x[0-9a-fA-F]+);/g;

const tsxFiles = (dir: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...tsxFiles(full));
    else if (full.endsWith(".tsx")) found.push(full);
  }
  return found;
};

/** String literals in emitted JS, in source order. */
const literals = (code: string): string[] => {
  const found: string[] = [];
  const re = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code))) found.push(match[1] ?? match[2]);
  return found;
};

// Deliberately excludes \xa0 so an intentional &nbsp; at an edge is not a diff.
const edgeSignature = (s: string) =>
  `${/^[ \t\n\r]*/.exec(s)![0].length}|${/[ \t\n\r]*$/.exec(s)![0].length}`;

const compile = async (source: string, filename: string) =>
  (
    await swc.transform(source, {
      filename,
      jsc: { parser: { syntax: "typescript", tsx: true } },
    })
  ).code as string;

describe("HTML entities in JSX text", () => {
  it("does not lose spaces around the entity's text run", async () => {
    await swc.loadBindings();

    const mangled: string[] = [];

    for (const file of tsxFiles(APP_ROOT)) {
      const source = readFileSync(file, "utf8");
      ENTITY.lastIndex = 0;
      if (!ENTITY.test(source)) continue;

      const relative = path.relative(APP_ROOT, file);
      const emitted = literals(await compile(source, file));
      const control = literals(
        await compile(source.replace(ENTITY, "X"), file),
      );

      if (emitted.length !== control.length) {
        mangled.push(
          `${relative}: emitted ${emitted.length} strings, control ${control.length}`,
        );
        continue;
      }
      for (let i = 0; i < emitted.length; i++) {
        if (edgeSignature(emitted[i]) !== edgeSignature(control[i])) {
          mangled.push(
            `${relative}: ${JSON.stringify(emitted[i])} (expected the edge whitespace of ${JSON.stringify(control[i])})`,
          );
        }
      }
    }

    expect(mangled).toEqual([]);
  });
});
