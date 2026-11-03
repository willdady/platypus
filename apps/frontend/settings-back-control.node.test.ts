import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Organization and user settings resource pages draw their Back from the
 * shell header. A page or loading file that also passes `backFallbackHref` to
 * `ResourcePage` puts a second, labelled Back above the title.
 */

const settingsRoots = ["app/[orgId]/settings", "app/settings"].map((dir) =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), dir),
);

function sourceFiles(dir: string) {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((entry) => /\.(ts|tsx)$/.test(entry))
    .filter((entry) => !/\.test\.(ts|tsx)$/.test(entry))
    .map((entry) => path.join(dir, entry));
}

describe("settings Back controls", () => {
  it("leaves the shell header as the only Back on settings pages", () => {
    const offenders = settingsRoots
      .flatMap(sourceFiles)
      .filter((file) =>
        readFileSync(file, "utf8").includes("backFallbackHref"),
      );

    expect(offenders).toEqual([]);
  });
});
