import { describe, it, expect } from "vitest";
import { zipSync, unzipSync, strToU8 } from "fflate";
import { ValidationError } from "../errors.ts";
import {
  bundleHash,
  buildSkillZip,
  parseSkillZip,
} from "./skill-bundle-format.ts";

const PDF_SKILL_MD = `---
name: pdf
description: Use this skill whenever the user wants to do anything with PDF files.
license: Proprietary. LICENSE.txt has complete terms
---

# PDF Processing Guide

See [forms.md](forms.md).
`;

describe("parseSkillZip", () => {
  it("parses a bundle nested under one top-level directory", () => {
    const zip = zipSync({
      "pdf/SKILL.md": strToU8(PDF_SKILL_MD),
      "pdf/forms.md": strToU8("# Forms"),
      "pdf/LICENSE.txt": strToU8("All rights reserved"),
      "pdf/scripts/check.py": strToU8("print('hi')"),
    });

    const bundle = parseSkillZip(zip);

    expect(bundle.fields).toEqual({
      name: "pdf",
      description:
        "Use this skill whenever the user wants to do anything with PDF files.",
      body: "# PDF Processing Guide\n\nSee [forms.md](forms.md).",
      disableModelInvocation: false,
      argumentHint: null,
    });
    expect(bundle.frontmatter).toEqual({
      license: "Proprietary. LICENSE.txt has complete terms",
    });
    expect(bundle.files.map((f) => f.path).sort()).toEqual([
      "LICENSE.txt",
      "forms.md",
      "scripts/check.py",
    ]);
  });
});

const skillMd = (frontmatter: string, body = "Do the thing.\n") =>
  strToU8(`---\n${frontmatter}\n---\n${body}`);
const minimal = () => skillMd("name: demo\ndescription: Demo");

/**
 * Rewrites every size a single-entry zip declares for its file to 1 byte, so a
 * parser trusting them would read a bomb as tiny.
 */
const understateSizes = (zip: Uint8Array): Uint8Array => {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  let cd = view.getUint32(eocd + 16, true);
  for (let n = view.getUint16(eocd + 10, true); n > 0; n--) {
    view.setUint32(cd + 24, 1, true);
    view.setUint32(view.getUint32(cd + 42, true) + 22, 1, true);
    cd +=
      46 +
      view.getUint16(cd + 28, true) +
      view.getUint16(cd + 30, true) +
      view.getUint16(cd + 32, true);
  }
  return zip;
};

describe("parseSkillZip rejections", () => {
  const cases: [string, () => Uint8Array, RegExp][] = [
    [
      "more than 25 MiB unpacked, sizes understated",
      () =>
        understateSizes(
          zipSync({
            "SKILL.md": minimal(),
            "bomb.bin": new Uint8Array(26 * 1024 * 1024),
          }),
        ),
      /unpacks to more than 25 MiB/,
    ],
    [
      "more than 500 entries",
      () =>
        zipSync({
          "SKILL.md": minimal(),
          ...Object.fromEntries(
            Array.from({ length: 500 }, (_, i) => [`f${i}.md`, strToU8("x")]),
          ),
        }),
      /more than 500 entries/,
    ],
    [
      "a .. path",
      () => zipSync({ "SKILL.md": minimal(), "a/../../x.md": strToU8("x") }),
      /'\.\.'/,
    ],
    [
      "an absolute path",
      () => zipSync({ "SKILL.md": minimal(), "/etc/x.md": strToU8("x") }),
      /absolute/,
    ],
    [
      "a backslash",
      () => zipSync({ "SKILL.md": minimal(), "a\\b.md": strToU8("x") }),
      /backslash/,
    ],
    [
      "a symlink entry",
      () =>
        zipSync({
          "SKILL.md": minimal(),
          link: [strToU8("/etc/passwd"), { os: 3, attrs: 0o120777 << 16 }],
        }),
      /symlink/,
    ],
    [
      "a symlink entry from a non-Unix host",
      () =>
        zipSync({
          "SKILL.md": minimal(),
          link: [strToU8("/etc/passwd"), { os: 0, attrs: 0o120777 << 16 }],
        }),
      /symlink/,
    ],
    [
      "duplicate paths after normalisation",
      () =>
        zipSync({
          "SKILL.md": minimal(),
          "a.md": strToU8("x"),
          "./a.md": strToU8("y"),
        }),
      /duplicate path: a\.md/,
    ],
    [
      "no SKILL.md",
      () => zipSync({ "demo/README.md": strToU8("x") }),
      /SKILL\.md must be at the zip root/,
    ],
    [
      "SKILL.md nested two directories deep",
      () => zipSync({ "a/b/SKILL.md": minimal() }),
      /SKILL\.md must be at the zip root/,
    ],
    [
      "malformed YAML",
      () => zipSync({ "SKILL.md": skillMd("name: demo\ndescription: [oops") }),
      /not valid YAML at line \d/,
    ],
    [
      "frontmatter that is not a mapping",
      () => zipSync({ "SKILL.md": skillMd("- a\n- b") }),
      /must be a YAML mapping/,
    ],
    [
      "a missing description",
      () => zipSync({ "SKILL.md": skillMd("name: demo") }),
      /missing required field `description`/,
    ],
    [
      "a name that is not kebab-case",
      () =>
        zipSync({ "SKILL.md": skillMd("name: Demo Skill\ndescription: d") }),
      /`name` is invalid/,
    ],
    [
      "no frontmatter",
      () => zipSync({ "SKILL.md": strToU8("# Just a body") }),
      /must open with a `---` frontmatter block/,
    ],
    [
      "frontmatter over 16 KB",
      () =>
        zipSync({
          "SKILL.md": skillMd(
            `name: demo\ndescription: d\nnotes: ${"x".repeat(16 * 1024)}`,
          ),
        }),
      /larger than 16 KiB/,
    ],
    [
      "a body that is only whitespace",
      () =>
        zipSync({
          "SKILL.md": skillMd("name: demo\ndescription: d", "  \n\t\n  "),
        }),
      /SKILL\.md body is invalid/,
    ],
  ];

  it.each(cases)("rejects %s", (_label, build, message) => {
    expect(() => parseSkillZip(build())).toThrow(ValidationError);
    expect(() => parseSkillZip(build())).toThrow(message);
  });
});

describe("parseSkillZip contents", () => {
  it("trims the whitespace around the body, keeping what is inside it", () => {
    const zip = zipSync({
      "SKILL.md": skillMd(
        "name: demo\ndescription: d",
        "   \n\n  # Steps\n\n  1. Indented\n\n \t\n",
      ),
    });

    expect(parseSkillZip(zip).fields.body).toBe("# Steps\n\n  1. Indented");
  });

  it("classifies by content, not extension", () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0,
    ]);
    const bundle = parseSkillZip(
      zipSync({
        "SKILL.md": minimal(),
        LICENSE: strToU8("MIT License"),
        "image.md": png,
      }),
    );
    const isText = Object.fromEntries(
      bundle.files.map((f) => [f.path, f.isText]),
    );
    expect(isText).toEqual({ LICENSE: true, "image.md": false });
  });

  it("keeps spaces, non-ASCII names and case-only differences apart", () => {
    const bundle = parseSkillZip(
      zipSync({
        "SKILL.md": minimal(),
        "My Notes.md": strToU8("notes"),
        "résumé/日本.md": strToU8("unicode"),
        "Forms.md": strToU8("upper"),
        "forms.md": strToU8("lower"),
      }),
    );
    const contents = Object.fromEntries(
      bundle.files.map((f) => [f.path, new TextDecoder().decode(f.data)]),
    );
    expect(contents).toEqual({
      "My Notes.md": "notes",
      "résumé/日本.md": "unicode",
      "Forms.md": "upper",
      "forms.md": "lower",
    });
  });

  it("ignores __MACOSX and .DS_Store, and stores nested zips as files", () => {
    const bundle = parseSkillZip(
      zipSync({
        "demo/SKILL.md": minimal(),
        "demo/.DS_Store": new Uint8Array([0, 1]),
        "__MACOSX/demo/._SKILL.md": new Uint8Array([0, 1]),
        "demo/inner.zip": zipSync({ "x.md": strToU8("x") }),
      }),
    );
    expect(bundle.files.map((f) => f.path)).toEqual(["inner.zip"]);
  });

  it("maps the invocation keys to columns", () => {
    const { fields, frontmatter } = parseSkillZip(
      zipSync({
        "SKILL.md": skillMd(
          "name: deploy\ndescription: d\ndisable-model-invocation: true\nargument-hint: <env>\ncompatibility: needs git",
        ),
      }),
    );
    expect(fields.disableModelInvocation).toBe(true);
    expect(fields.argumentHint).toBe("<env>");
    expect(frontmatter).toEqual({ compatibility: "needs git" });
  });
});

describe("buildSkillZip", () => {
  it("round-trips to the same bundle hash and file set", () => {
    const original = parseSkillZip(
      zipSync({
        "pdf/SKILL.md": strToU8(
          PDF_SKILL_MD.replace(
            "license:",
            "argument-hint: <file>\nmetadata:\n  version: 2\nlicense:",
          ),
        ),
        "pdf/forms.md": strToU8("# Forms"),
        "pdf/scripts/check.py": strToU8("print('hi')"),
        "pdf/logo.png": new Uint8Array([0x89, 0, 1, 2]),
      }),
    );

    const exported = buildSkillZip(original);
    expect(Object.keys(unzipSync(exported))).toContain("pdf/SKILL.md");
    const reimported = parseSkillZip(exported);

    expect(bundleHash(reimported)).toBe(bundleHash(original));
    expect(reimported.files.map((f) => [f.path, f.sha256]).sort()).toEqual(
      original.files.map((f) => [f.path, f.sha256]).sort(),
    );
  });

  it("changes the hash when the body changes", () => {
    const bundle = parseSkillZip(zipSync({ "SKILL.md": minimal() }));
    const edited = { ...bundle, fields: { ...bundle.fields, body: "Other" } };
    expect(bundleHash(edited)).not.toBe(bundleHash(bundle));
  });
});
