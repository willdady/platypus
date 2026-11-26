import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

type Swc = {
  loadBindings: () => Promise<unknown>;
  transform: (
    source: string,
    options: {
      filename: string;
      jsc: { parser: { syntax: string; tsx: boolean } };
    },
  ) => Promise<{ code: string }>;
};

const swc = createRequire(import.meta.url)("next/dist/build/swc") as Swc;

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]{1,10}|#\d+|#x[0-9a-fA-F]+);/g;

function tsxFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...tsxFiles(full));
    else if (full.endsWith(".tsx")) found.push(full);
  }
  return found;
}

function literals(code: string): string[] {
  const found: string[] = [];
  const re = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code))) found.push(match[1] ?? match[2]);
  return found;
}

function edgeSignature(s: string) {
  return `${/^[ \t\n\r]*/.exec(s)![0].length}|${/[ \t\n\r]*$/.exec(s)![0].length}`;
}

async function compile(source: string, filename: string) {
  return (
    await swc.transform(source, {
      filename,
      jsc: { parser: { syntax: "typescript", tsx: true } },
    })
  ).code;
}

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
