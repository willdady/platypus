import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_LIST_ENTRIES,
  MAX_LIST_OUTPUT_BYTES,
  MAX_READ_BYTES,
  MAX_SHELL_OUTPUT_BYTES,
  MAX_SHELL_TIMEOUT_MS,
} from "./index.ts";
import { buildFindArgs, createPosixSandbox, parseFindOutput } from "./posix.ts";
import {
  SandboxPathExistsError,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxTransport,
} from "./transport.ts";
import type { SandboxContext } from "./types.ts";

// The Sandbox contract, proved once against an in-memory transport. This is the
// suite that used to exist twice — against a dockerode fake and an ssh2 fake —
// re-proving the same rules through two sets of plumbing. Every adapter that
// goes through `createPosixSandbox` inherits what is asserted here, so an
// adapter's own suite is free to test only that it drives its client correctly.
//
// No Docker daemon and no SSH host: the transport is five functions.

const ctx: SandboxContext = {
  orgId: "org-1",
  workspaceId: "ws-abc",
  userId: "user-1",
};

const ROOT = "/workspace";

type ExecCall = { argv: string[]; opts: SandboxExecOptions };

// A transport whose every primitive is steerable, recording what it was asked
// to do. Files live in a plain map keyed by absolute path.
const makeTransport = (
  overrides: Partial<{
    rootDir: string;
    exec: (
      argv: string[],
      opts: SandboxExecOptions,
    ) => Partial<SandboxExecResult>;
    files: Map<string, Buffer>;
  }> = {},
) => {
  const execCalls: ExecCall[] = [];
  const writes: Array<{
    path: string;
    bytes: Buffer;
    mode: "create" | "overwrite";
  }> = [];
  const files = overrides.files ?? new Map<string, Buffer>();
  const destroyed: SandboxContext[] = [];
  const rootDirCalls: SandboxContext[] = [];

  const transport: SandboxTransport = {
    rootDir: (c) => {
      rootDirCalls.push(c);
      return Promise.resolve(overrides.rootDir ?? ROOT);
    },
    exec: (_c, argv, opts) => {
      execCalls.push({ argv, opts });
      const result = overrides.exec?.(argv, opts) ?? {};
      return Promise.resolve({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        durationMs: 1,
        ...result,
      });
    },
    readFile: (_c, absPath, cap) => {
      const found = files.get(absPath);
      if (!found) {
        return Promise.reject(new Error(`No such file: ${absPath}`));
      }
      // Bytes only — the cap is applied, but whether that counts as truncated
      // is core's to decide, which is exactly what these tests check.
      return Promise.resolve(found.subarray(0, cap));
    },
    writeFile: (_c, absPath, bytes, mode) => {
      if (mode === "create" && files.has(absPath)) {
        return Promise.reject(new SandboxPathExistsError(absPath));
      }
      writes.push({ path: absPath, bytes, mode });
      files.set(absPath, bytes);
      return Promise.resolve();
    },
    destroy: (c) => {
      destroyed.push(c);
      return Promise.resolve();
    },
  };

  return { transport, execCalls, writes, files, destroyed, rootDirCalls };
};

const findOutput = (
  rows: Array<[type: string, size: string | number, path: string]>,
): Buffer =>
  Buffer.from(rows.map(([t, s, p]) => `${t}\t${s}\t${p}`).join("\n") + "\n");

describe("createPosixSandbox — shell.exec", () => {
  it("runs the command under /bin/sh -c in the workspace root", async () => {
    const { transport, execCalls } = makeTransport();
    await createPosixSandbox(transport).shellExec(ctx, { command: "ls -la" });

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].argv).toEqual(["/bin/sh", "-c", "ls -la"]);
    expect(execCalls[0].opts.cwd).toBe(ROOT);
  });

  it("resolves cwd against the transport's root", async () => {
    const { transport, execCalls } = makeTransport({ rootDir: "/srv/agent" });
    await createPosixSandbox(transport).shellExec(ctx, {
      command: "ls",
      cwd: "sub/dir",
    });

    expect(execCalls[0].opts.cwd).toBe("/srv/agent/sub/dir");
  });

  it("passes the caller's env through untouched", async () => {
    const { transport, execCalls } = makeTransport();
    await createPosixSandbox(transport).shellExec(ctx, {
      command: "env",
      env: { FOO: "bar" },
    });

    expect(execCalls[0].opts.env).toEqual({ FOO: "bar" });
  });

  it("returns the transport's streams, exit code and duration", async () => {
    const { transport } = makeTransport({
      exec: () => ({
        stdout: Buffer.from("out"),
        stderr: Buffer.from("err"),
        exitCode: 3,
        durationMs: 42,
      }),
    });

    await expect(
      createPosixSandbox(transport).shellExec(ctx, { command: "x" }),
    ).resolves.toEqual({
      stdout: "out",
      stderr: "err",
      exitCode: 3,
      truncated: false,
      durationMs: 42,
    });
  });

  it("defaults the timeout and caps output at the Platypus bounds", async () => {
    const { transport, execCalls } = makeTransport();
    await createPosixSandbox(transport).shellExec(ctx, { command: "x" });

    expect(execCalls[0].opts).toMatchObject({
      timeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
      stdoutCap: MAX_SHELL_OUTPUT_BYTES,
      stderrCap: MAX_SHELL_OUTPUT_BYTES,
    });
  });

  it("honours a caller timeout below the maximum", async () => {
    const { transport, execCalls } = makeTransport();
    await createPosixSandbox(transport).shellExec(ctx, {
      command: "x",
      timeoutMs: 5_000,
    });

    expect(execCalls[0].opts.timeoutMs).toBe(5_000);
  });

  it("clamps a caller timeout above the maximum", async () => {
    // The bound is core's, so no adapter can be talked into waiting longer —
    // this is the clamp both adapters used to hold a private copy of.
    const { transport, execCalls } = makeTransport();
    await createPosixSandbox(transport).shellExec(ctx, {
      command: "x",
      timeoutMs: MAX_SHELL_TIMEOUT_MS + 60_000,
    });

    expect(execCalls[0].opts.timeoutMs).toBe(MAX_SHELL_TIMEOUT_MS);
  });

  it("flags truncated when stdout sits on the cap", async () => {
    const { transport } = makeTransport({
      exec: () => ({ stdout: Buffer.alloc(MAX_SHELL_OUTPUT_BYTES, 0x61) }),
    });

    const res = await createPosixSandbox(transport).shellExec(ctx, {
      command: "x",
    });
    expect(res.stdout).toHaveLength(MAX_SHELL_OUTPUT_BYTES);
    expect(res.truncated).toBe(true);
  });

  it("flags truncated when only stderr sits on the cap", async () => {
    const { transport } = makeTransport({
      exec: () => ({ stderr: Buffer.alloc(MAX_SHELL_OUTPUT_BYTES, 0x61) }),
    });

    await expect(
      createPosixSandbox(transport).shellExec(ctx, { command: "x" }),
    ).resolves.toMatchObject({ truncated: true });
  });

  it("reports a timed-out command's exit code rather than throwing", async () => {
    const { transport } = makeTransport({
      exec: () => ({ exitCode: 124 }),
    });

    await expect(
      createPosixSandbox(transport).shellExec(ctx, { command: "sleep 999" }),
    ).resolves.toMatchObject({ exitCode: 124 });
  });
});

describe("createPosixSandbox — fs.read", () => {
  const withFile = (content: string, path = `${ROOT}/notes.txt`) =>
    makeTransport({ files: new Map([[path, Buffer.from(content)]]) });

  it("reads a file, counting its lines", async () => {
    const { transport } = withFile("one\ntwo\nthree\n");

    await expect(
      createPosixSandbox(transport).fsRead(ctx, { path: "notes.txt" }),
    ).resolves.toEqual({
      content: "one\ntwo\nthree\n",
      lineCount: 3,
      truncated: false,
    });
  });

  it("counts a trailing line with no newline", async () => {
    const { transport } = withFile("a\nb\nc");

    await expect(
      createPosixSandbox(transport).fsRead(ctx, { path: "notes.txt" }),
    ).resolves.toMatchObject({ lineCount: 3 });
  });

  it("reads an empty file as zero lines", async () => {
    const { transport } = withFile("");

    await expect(
      createPosixSandbox(transport).fsRead(ctx, { path: "notes.txt" }),
    ).resolves.toEqual({ content: "", lineCount: 0, truncated: false });
  });

  it("asks the transport for at most MAX_READ_BYTES", async () => {
    const files = new Map([[`${ROOT}/big.txt`, Buffer.alloc(10, 0x61)]]);
    const { transport } = makeTransport({ files });
    const spy = vi.spyOn(transport, "readFile");

    await createPosixSandbox(transport).fsRead(ctx, { path: "big.txt" });

    expect(spy).toHaveBeenCalledWith(ctx, `${ROOT}/big.txt`, MAX_READ_BYTES);
  });

  it("flags truncated when the read came back filling the cap", async () => {
    // Core owns this verdict, from the one `>= cap` rule it applies to every
    // adapter. Leaving it to the transport is how the two adapters used to
    // disagree about a file sitting exactly on the cap.
    const { transport } = makeTransport({
      files: new Map([
        [`${ROOT}/big.txt`, Buffer.alloc(MAX_READ_BYTES + 100, 0x61)],
      ]),
    });

    const res = await createPosixSandbox(transport).fsRead(ctx, {
      path: "big.txt",
    });
    expect(res.content).toHaveLength(MAX_READ_BYTES);
    expect(res.truncated).toBe(true);
  });

  it("does not flag a short read as truncated", async () => {
    const { transport } = makeTransport({
      files: new Map([[`${ROOT}/small.txt`, Buffer.from("abc")]]),
    });

    await expect(
      createPosixSandbox(transport).fsRead(ctx, { path: "small.txt" }),
    ).resolves.toMatchObject({ truncated: false });
  });

  it("rejects a file that is not valid UTF-8", async () => {
    const { transport } = makeTransport({
      files: new Map([[`${ROOT}/bin.dat`, Buffer.from([0xff, 0xfe, 0xff])]]),
    });

    await expect(
      createPosixSandbox(transport).fsRead(ctx, { path: "bin.dat" }),
    ).rejects.toThrow(/fs\.read: file is not valid UTF-8 \(bin\.dat\)/);
  });

  it("slices the requested line window, re-counting the slice", async () => {
    const { transport } = withFile("one\ntwo\nthree\nfour\nfive\n");

    await expect(
      createPosixSandbox(transport).fsRead(ctx, {
        path: "notes.txt",
        lineRange: [2, 4],
      }),
    ).resolves.toEqual({
      content: "two\nthree\nfour\n",
      lineCount: 3,
      truncated: false,
    });
  });

  it("attributes a transport read failure to fs.read", async () => {
    const { transport } = makeTransport();

    await expect(
      createPosixSandbox(transport).fsRead(ctx, { path: "missing.txt" }),
    ).rejects.toThrow(/^fs\.read: No such file: \/workspace\/missing\.txt$/);
  });
});

describe("createPosixSandbox — fs.write", () => {
  it("writes UTF-8 bytes at the resolved path and reports the byte count", async () => {
    const { transport, writes } = makeTransport();

    await expect(
      createPosixSandbox(transport).fsWrite(ctx, {
        path: "a/b.txt",
        content: "hello",
        mode: "create",
      }),
    ).resolves.toEqual({ bytesWritten: 5 });

    expect(writes[0]).toMatchObject({
      path: `${ROOT}/a/b.txt`,
      mode: "create",
    });
    expect(writes[0].bytes.toString("utf8")).toBe("hello");
  });

  it("counts bytes, not characters", async () => {
    const { transport } = makeTransport();

    await expect(
      createPosixSandbox(transport).fsWrite(ctx, {
        path: "e.txt",
        content: "héllo 👋",
        mode: "overwrite",
      }),
    ).resolves.toEqual({ bytesWritten: Buffer.byteLength("héllo 👋", "utf8") });
  });

  it("writes zero-length content", async () => {
    const { transport } = makeTransport();

    await expect(
      createPosixSandbox(transport).fsWrite(ctx, {
        path: "empty.txt",
        content: "",
        mode: "create",
      }),
    ).resolves.toEqual({ bytesWritten: 0 });
  });

  it("restates a create-collision in terms of the path the model asked for", async () => {
    // The transport only ever sees the absolute path; the model asked about a
    // relative one, and that is what the message has to name.
    const { transport } = makeTransport({
      files: new Map([[`${ROOT}/taken.txt`, Buffer.from("old")]]),
    });

    await expect(
      createPosixSandbox(transport).fsWrite(ctx, {
        path: "taken.txt",
        content: "new",
        mode: "create",
      }),
    ).rejects.toThrow("fs.write: path already exists (mode=create): taken.txt");
  });

  it("lets an unrelated write failure through untranslated", async () => {
    const { transport } = makeTransport();
    vi.spyOn(transport, "writeFile").mockRejectedValue(
      new Error("Permission denied"),
    );

    await expect(
      createPosixSandbox(transport).fsWrite(ctx, {
        path: "x.txt",
        content: "y",
        mode: "overwrite",
      }),
    ).rejects.toThrow(/^Permission denied$/);
  });

  it("overwrites an existing file without complaint", async () => {
    const { transport, files } = makeTransport({
      files: new Map([[`${ROOT}/taken.txt`, Buffer.from("old")]]),
    });

    await createPosixSandbox(transport).fsWrite(ctx, {
      path: "taken.txt",
      content: "new",
      mode: "overwrite",
    });

    expect(files.get(`${ROOT}/taken.txt`)?.toString("utf8")).toBe("new");
  });
});

describe("createPosixSandbox — fs.edit", () => {
  const withFile = (content: string) =>
    makeTransport({
      files: new Map([[`${ROOT}/code.ts`, Buffer.from(content)]]),
    });

  it("replaces the single occurrence and writes it back", async () => {
    const { transport, files } = withFile("const a = 1;\nconst b = 2;\n");

    await expect(
      createPosixSandbox(transport).fsEdit(ctx, {
        path: "code.ts",
        oldString: "const b = 2;",
        newString: "const b = 99;",
      }),
    ).resolves.toEqual({ replacements: 1 });

    expect(files.get(`${ROOT}/code.ts`)?.toString("utf8")).toBe(
      "const a = 1;\nconst b = 99;\n",
    );
  });

  it("writes the edit back as an overwrite", async () => {
    const { transport, writes } = withFile("x");

    await createPosixSandbox(transport).fsEdit(ctx, {
      path: "code.ts",
      oldString: "x",
      newString: "y",
    });

    expect(writes[0]).toMatchObject({
      path: `${ROOT}/code.ts`,
      mode: "overwrite",
    });
  });

  it("rejects when oldString is absent, leaving the file alone", async () => {
    const { transport, writes } = withFile("hello");

    await expect(
      createPosixSandbox(transport).fsEdit(ctx, {
        path: "code.ts",
        oldString: "nope",
        newString: "y",
      }),
    ).rejects.toThrow("fs.edit: oldString not found in code.ts");
    expect(writes).toHaveLength(0);
  });

  it("rejects when oldString is not unique, leaving the file alone", async () => {
    const { transport, writes } = withFile("abc abc");

    await expect(
      createPosixSandbox(transport).fsEdit(ctx, {
        path: "code.ts",
        oldString: "abc",
        newString: "z",
      }),
    ).rejects.toThrow("fs.edit: oldString is not unique in code.ts");
    expect(writes).toHaveLength(0);
  });

  it("allows an empty newString (a deletion)", async () => {
    const { transport, files } = withFile("keep DROP keep");

    await createPosixSandbox(transport).fsEdit(ctx, {
      path: "code.ts",
      oldString: " DROP",
      newString: "",
    });

    expect(files.get(`${ROOT}/code.ts`)?.toString("utf8")).toBe("keep keep");
  });

  it("rejects a file that is not valid UTF-8", async () => {
    const { transport } = makeTransport({
      files: new Map([[`${ROOT}/bin.dat`, Buffer.from([0xff, 0xfe])]]),
    });

    await expect(
      createPosixSandbox(transport).fsEdit(ctx, {
        path: "bin.dat",
        oldString: "a",
        newString: "b",
      }),
    ).rejects.toThrow(/fs\.edit: file is not valid UTF-8/);
  });

  it("attributes a transport read failure to fs.edit", async () => {
    const { transport } = makeTransport();

    await expect(
      createPosixSandbox(transport).fsEdit(ctx, {
        path: "missing.txt",
        oldString: "a",
        newString: "b",
      }),
    ).rejects.toThrow(/^fs\.edit: No such file/);
  });
});

describe("buildFindArgs", () => {
  it("lists one level by default", () => {
    expect(buildFindArgs("/workspace", {})).toEqual([
      "find",
      "/workspace",
      "-maxdepth",
      "1",
      "-mindepth",
      "1",
      "-printf",
      "%y\\t%s\\t%P\\n",
    ]);
  });

  it("drops -maxdepth when recursive", () => {
    expect(buildFindArgs("/workspace", { recursive: true })).not.toContain(
      "-maxdepth",
    );
  });

  it("matches a bare glob with -name", () => {
    const args = buildFindArgs("/workspace", { glob: "*.ts" });
    expect(args[args.indexOf("-name") + 1]).toBe("*.ts");
    expect(args).not.toContain("-path");
  });

  it("matches a slashed glob with -path", () => {
    const args = buildFindArgs("/workspace", { glob: "src/*.ts" });
    expect(args[args.indexOf("-path") + 1]).toBe("*/src/*.ts");
  });

  it("collapses ** to a single * for find(1)", () => {
    const args = buildFindArgs("/workspace", { glob: "**/*.ts" });
    expect(args[args.indexOf("-path") + 1]).toBe("*/*/*.ts");
  });

  it("leaves every element unquoted — quoting is the transport's job", () => {
    const args = buildFindArgs("/workspace/it's", { glob: "*.ts" });
    expect(args).toContain("/workspace/it's");
  });
});

describe("parseFindOutput", () => {
  it("parses type, size and path", () => {
    expect(
      parseFindOutput(
        findOutput([
          ["f", 12, "a.txt"],
          ["d", 4096, "sub"],
        ]).toString("utf8"),
      ),
    ).toEqual({
      entries: [
        { path: "a.txt", type: "file", size: 12 },
        { path: "sub", type: "dir", size: 4096 },
      ],
      truncated: false,
    });
  });

  it("drops entries that are neither file nor dir", () => {
    const { entries } = parseFindOutput(
      findOutput([
        ["f", 1, "real.txt"],
        ["l", 7, "link"],
        ["s", 0, "sock"],
        ["c", 0, "dev"],
      ]).toString("utf8"),
    );
    expect(entries).toEqual([{ path: "real.txt", type: "file", size: 1 }]);
  });

  it("omits size when find printed something unparseable", () => {
    const { entries } = parseFindOutput(
      findOutput([["f", "?", "weird.txt"]]).toString("utf8"),
    );
    expect(entries).toEqual([{ path: "weird.txt", type: "file" }]);
  });

  it("returns nothing for empty output", () => {
    expect(parseFindOutput("")).toEqual({ entries: [], truncated: false });
  });

  it("skips malformed rows rather than failing the listing", () => {
    const { entries } = parseFindOutput("f\t1\tgood.txt\nnot-a-row\n");
    expect(entries).toEqual([{ path: "good.txt", type: "file", size: 1 }]);
  });

  it("keeps a path containing tabs beyond the second separator", () => {
    const { entries } = parseFindOutput("f\t1\thas\ttab.txt\n");
    expect(entries).toEqual([{ path: "has\ttab.txt", type: "file", size: 1 }]);
  });

  it("caps at MAX_LIST_ENTRIES and flags truncated", () => {
    const rows = Array.from(
      { length: MAX_LIST_ENTRIES + 5 },
      (_, i) => ["f", 1, `f${i}.txt`] as [string, number, string],
    );
    const out = parseFindOutput(findOutput(rows).toString("utf8"));

    expect(out.entries).toHaveLength(MAX_LIST_ENTRIES);
    expect(out.truncated).toBe(true);
  });

  it("does not flag truncated at exactly MAX_LIST_ENTRIES", () => {
    const rows = Array.from(
      { length: MAX_LIST_ENTRIES },
      (_, i) => ["f", 1, `f${i}.txt`] as [string, number, string],
    );
    const out = parseFindOutput(findOutput(rows).toString("utf8"));

    expect(out.entries).toHaveLength(MAX_LIST_ENTRIES);
    expect(out.truncated).toBe(false);
  });

  it("does not flag truncated when the only dropped rows were unmodelled types", () => {
    // The bug both adapters shipped: `truncated` was derived from the row count
    // rather than the entry count, so a listing that filled exactly to the cap
    // and skipped one symlink claimed to have been cut when nothing was.
    const rows: Array<[string, number, string]> = [
      ...Array.from(
        { length: MAX_LIST_ENTRIES },
        (_, i) => ["f", 1, `f${i}.txt`] as [string, number, string],
      ),
      ["l", 7, "a-symlink"],
    ];
    const out = parseFindOutput(findOutput(rows).toString("utf8"));

    expect(out.entries).toHaveLength(MAX_LIST_ENTRIES);
    expect(out.truncated).toBe(false);
  });
});

describe("createPosixSandbox — fs.list", () => {
  const listing = (
    rows: Array<[string, string | number, string]>,
    exitCode = 0,
    stderr = "",
  ) =>
    makeTransport({
      exec: () => ({
        stdout: findOutput(rows),
        stderr: Buffer.from(stderr),
        exitCode,
      }),
    });

  it("runs find under the workspace root with the list bounds", async () => {
    const { transport, execCalls } = listing([["f", 1, "a.txt"]]);
    await createPosixSandbox(transport).fsList(ctx, {});

    expect(execCalls[0].argv[0]).toBe("find");
    expect(execCalls[0].argv[1]).toBe(ROOT);
    expect(execCalls[0].opts).toMatchObject({
      cwd: ROOT,
      timeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
      stdoutCap: MAX_LIST_OUTPUT_BYTES,
      stderrCap: MAX_SHELL_OUTPUT_BYTES,
    });
  });

  it("lists a subpath resolved against the root", async () => {
    const { transport, execCalls } = listing([]);
    await createPosixSandbox(transport).fsList(ctx, { path: "src" });

    expect(execCalls[0].argv[1]).toBe(`${ROOT}/src`);
  });

  it("returns parsed entries", async () => {
    const { transport } = listing([
      ["f", 12, "a.txt"],
      ["d", 4096, "sub"],
    ]);

    await expect(
      createPosixSandbox(transport).fsList(ctx, {}),
    ).resolves.toEqual({
      entries: [
        { path: "a.txt", type: "file", size: 12 },
        { path: "sub", type: "dir", size: 4096 },
      ],
      truncated: false,
    });
  });

  it("returns an empty listing for an empty directory", async () => {
    const { transport } = makeTransport();

    await expect(
      createPosixSandbox(transport).fsList(ctx, {}),
    ).resolves.toEqual({ entries: [], truncated: false });
  });

  it("returns the partial rows find printed before it failed", async () => {
    // find exits non-zero on an unreadable subdirectory while still printing
    // what it reached — those rows are more useful than an error.
    const { transport } = listing(
      [["f", 1, "reachable.txt"]],
      1,
      "Permission denied",
    );

    await expect(
      createPosixSandbox(transport).fsList(ctx, { recursive: true }),
    ).resolves.toMatchObject({
      entries: [{ path: "reachable.txt", type: "file", size: 1 }],
    });
  });

  it("throws with find's stderr when it failed and printed nothing", async () => {
    const { transport } = makeTransport({
      exec: () => ({
        exitCode: 1,
        stderr: Buffer.from(
          "find: '/workspace/nope': No such file or directory\n",
        ),
      }),
    });

    await expect(
      createPosixSandbox(transport).fsList(ctx, { path: "nope" }),
    ).rejects.toThrow(/fs\.list: find: .*No such file or directory/);
  });

  it("falls back to a generic message when find failed silently", async () => {
    const { transport } = makeTransport({ exec: () => ({ exitCode: 1 }) });

    await expect(createPosixSandbox(transport).fsList(ctx, {})).rejects.toThrow(
      "fs.list: fs.list failed",
    );
  });
});

describe("createPosixSandbox — lifecycle", () => {
  it("delegates destroy to the transport with the context", async () => {
    const { transport, destroyed } = makeTransport();
    await createPosixSandbox(transport).destroy(ctx);

    expect(destroyed).toEqual([ctx]);
  });

  it("resolves the root before every tool call, so a transport can lazily connect", async () => {
    const { transport, rootDirCalls } = makeTransport({
      files: new Map([[`${ROOT}/a.txt`, Buffer.from("x")]]),
    });
    const sandbox = createPosixSandbox(transport);

    await sandbox.shellExec(ctx, { command: "x" });
    await sandbox.fsRead(ctx, { path: "a.txt" });
    await sandbox.fsWrite(ctx, { path: "b.txt", content: "y", mode: "create" });
    await sandbox.fsEdit(ctx, {
      path: "a.txt",
      oldString: "x",
      newString: "z",
    });
    await sandbox.fsList(ctx, {});

    expect(rootDirCalls).toHaveLength(5);
    expect(rootDirCalls.every((c) => c === ctx)).toBe(true);
  });
});
