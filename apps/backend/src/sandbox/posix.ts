import {
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_LIST_ENTRIES,
  MAX_LIST_OUTPUT_BYTES,
  MAX_READ_BYTES,
  MAX_SHELL_OUTPUT_BYTES,
  MAX_SHELL_TIMEOUT_MS,
} from "./index.ts";
import { SandboxPathExistsError, type SandboxTransport } from "./transport.ts";
import type {
  FsEditInput,
  FsEditOutput,
  FsListEntry,
  FsListInput,
  FsListOutput,
  FsReadInput,
  FsReadOutput,
  FsWriteInput,
  FsWriteOutput,
  SandboxBackend,
  SandboxContext,
  ShellExecInput,
  ShellExecOutput,
} from "./types.ts";

// The fixed five-tool core (ADR-0002), implemented once over a {@link
// SandboxTransport}. Every Platypus-defined bound lives here — the timeout
// clamp, the output caps, the `truncated` convention, strict UTF-8, line
// counting, the unique-`oldString` rule and the find(1) contract — so core
// honours them *for* an adapter rather than trusting each adapter to.

// Resolve a workspace-relative path against the transport's root. The input
// schema already rejects a leading slash; stripping again is belt-and-braces
// against a caller that bypasses it, since a doubled slash would silently
// address a different file.
const absPath = (rootDir: string, relative: string): string =>
  `${rootDir}/${relative.replace(/^\/+/, "")}`;

/**
 * Decode as strict UTF-8. The fs.* tools deal in text and a lossy decode would
 * hand the model mojibake it cannot tell from the real file, so an unreadable
 * file is an error rather than a best guess. (`shell.exec` is deliberately
 * lenient — arbitrary command output is not claimed to be text.)
 */
const decodeUtf8Strict = (
  bytes: Buffer,
  tool: string,
  path: string,
): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${tool}: file is not valid UTF-8 (${path})`);
  }
};

/**
 * Lines in a chunk of text: newline-separated, with a trailing newline
 * terminating the last line rather than starting an empty one. Empty content is
 * zero lines.
 */
const countLines = (content: string): number => {
  if (content.length === 0) return 0;
  const lines = content.split("\n").length;
  return content.endsWith("\n") ? lines - 1 : lines;
};

/**
 * The 1-indexed, inclusive `[start, end]` window of `content`, each selected
 * line re-terminated with a newline (matching `sed -n 'start,end p'`).
 *
 * Sliced here rather than server-side because the byte cap has already been
 * applied: on a file past {@link MAX_READ_BYTES} the window is taken from the
 * capped prefix, so lines beyond the cap are not reachable through `lineRange`.
 */
const sliceLines = (
  content: string,
  [start, end]: [number, number],
): string => {
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = body.length === 0 ? [] : body.split("\n");
  return lines
    .slice(start - 1, end)
    .map((line) => `${line}\n`)
    .join("");
};

/**
 * Replace the one occurrence of `oldString`, or explain which rule it broke.
 * Uniqueness is the point of the tool: a model that cannot say precisely which
 * text it means should be made to widen its context, not silently edit the
 * first of several matches.
 */
const replaceUnique = (original: string, input: FsEditInput): string => {
  const first = original.indexOf(input.oldString);
  if (first === -1) {
    throw new Error(`fs.edit: oldString not found in ${input.path}`);
  }
  if (original.indexOf(input.oldString, first + 1) !== -1) {
    throw new Error(`fs.edit: oldString is not unique in ${input.path}`);
  }
  return (
    original.slice(0, first) +
    input.newString +
    original.slice(first + input.oldString.length)
  );
};

/**
 * The `find` argv behind `fs.list`. argv, not a command line: quoting is the
 * transport's business, so nothing here is escaped.
 *
 * Truncation is done in Node rather than by piping to `head`, so `find` is
 * never told to stop and the count of what it *would* have emitted stays
 * knowable — that is what makes `truncated` honest.
 */
export const buildFindArgs = (
  target: string,
  input: Pick<FsListInput, "recursive" | "glob">,
): string[] => {
  const args = ["find", target];
  if (!input.recursive) args.push("-maxdepth", "1");
  args.push("-mindepth", "1");
  if (input.glob) {
    // `-name` matches a bare filename; a pattern containing a slash or `**` has
    // to go through `-path`, which matches the whole path. `**` collapses to a
    // single `*` because find(1) has no globstar — lossy, and documented in the
    // tool description, but it keeps the common `**/*.ts` shape working.
    if (input.glob.includes("/") || input.glob.includes("**")) {
      args.push("-path", `*/${input.glob.replace(/\*\*/g, "*")}`);
    } else {
      args.push("-name", input.glob);
    }
  }
  // Single argv element carrying find's own escapes — find(1) interprets `\t`
  // and `\n` itself.
  args.push("-printf", "%y\\t%s\\t%P\\n");
  return args;
};

/**
 * Parse `find -printf '%y\t%s\t%P\n'` output into entries, capped at {@link
 * MAX_LIST_ENTRIES}.
 *
 * Every row is parsed before the cap is applied, so `truncated` counts entries
 * dropped rather than *rows* dropped. Those differ whenever `find` emitted
 * something this tool does not model — a symlink, a socket, a device — and
 * conflating them reports a listing as truncated when nothing was actually cut.
 */
export const parseFindOutput = (stdout: string): FsListOutput => {
  const entries: FsListEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const tab1 = line.indexOf("\t");
    const tab2 = line.indexOf("\t", tab1 + 1);
    if (tab1 === -1 || tab2 === -1) continue;
    const typeChar = line.slice(0, tab1);
    // Only files and directories are modelled; a symlink, socket or device has
    // no meaning for the fs.* tools and is dropped rather than guessed at.
    if (typeChar !== "f" && typeChar !== "d") continue;
    const size = Number.parseInt(line.slice(tab1 + 1, tab2), 10);
    entries.push({
      path: line.slice(tab2 + 1),
      type: typeChar === "f" ? "file" : "dir",
      // An unparseable size is omitted rather than reported as 0 or NaN — the
      // field is optional precisely so it can be absent.
      ...(Number.isFinite(size) ? { size } : {}),
    });
  }
  return {
    entries: entries.slice(0, MAX_LIST_ENTRIES),
    truncated: entries.length > MAX_LIST_ENTRIES,
  };
};

// Read a file through the transport, attributing a failure to the tool that
// asked. A transport reports why it could not read; naming the tool is core's
// job, so the same underlying error reads correctly from fs.read and fs.edit.
const readForTool = async (
  transport: SandboxTransport,
  ctx: SandboxContext,
  tool: string,
  rootDir: string,
  path: string,
): Promise<Buffer> => {
  try {
    return await transport.readFile(
      ctx,
      absPath(rootDir, path),
      MAX_READ_BYTES,
    );
  } catch (cause) {
    const detail =
      cause instanceof Error ? cause.message.trim() : String(cause);
    throw new Error(`${tool}: ${detail || `${tool} failed`}`, { cause });
  }
};

/**
 * Build a {@link SandboxBackend} — the five model-facing tools — from a {@link
 * SandboxTransport}.
 *
 * The transport supplies exec, file read/write, the workspace root and
 * teardown; everything the model actually sees is assembled here, identically
 * for every adapter that goes through this door.
 */
export const createPosixSandbox = (
  transport: SandboxTransport,
): SandboxBackend => ({
  async shellExec(
    ctx: SandboxContext,
    input: ShellExecInput,
  ): Promise<ShellExecOutput> {
    const rootDir = await transport.rootDir(ctx);
    // The clamp is core's, not the schema's: the schema bounds what a model may
    // ask for, this bounds what any adapter will actually wait for.
    const timeoutMs = Math.min(
      input.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
      MAX_SHELL_TIMEOUT_MS,
    );

    const res = await transport.exec(ctx, ["/bin/sh", "-c", input.command], {
      cwd: input.cwd ? absPath(rootDir, input.cwd) : rootDir,
      env: input.env,
      timeoutMs,
      stdoutCap: MAX_SHELL_OUTPUT_BYTES,
      stderrCap: MAX_SHELL_OUTPUT_BYTES,
    });

    return {
      stdout: res.stdout.toString("utf8"),
      stderr: res.stderr.toString("utf8"),
      exitCode: res.exitCode,
      // A stream sitting exactly on its cap cannot be told apart from one that
      // overran it, so `>=` is the convention: err towards warning the model
      // that it may not have the whole picture.
      truncated:
        res.stdout.length >= MAX_SHELL_OUTPUT_BYTES ||
        res.stderr.length >= MAX_SHELL_OUTPUT_BYTES,
      durationMs: res.durationMs,
    };
  },

  async fsRead(ctx: SandboxContext, input: FsReadInput): Promise<FsReadOutput> {
    const rootDir = await transport.rootDir(ctx);
    const bytes = await readForTool(
      transport,
      ctx,
      "fs.read",
      rootDir,
      input.path,
    );

    const decoded = decodeUtf8Strict(bytes, "fs.read", input.path);
    const content = input.lineRange
      ? sliceLines(decoded, input.lineRange)
      : decoded;

    return {
      content,
      lineCount: countLines(content),
      // The same `>=` convention `shell.exec` uses, applied here rather than in
      // each transport so no adapter can disagree about a file that lands
      // exactly on the cap. Reported for the file, not the `lineRange` window:
      // it means "there was more file", which is what the model needs to know.
      truncated: bytes.length >= MAX_READ_BYTES,
    };
  },

  async fsWrite(
    ctx: SandboxContext,
    input: FsWriteInput,
  ): Promise<FsWriteOutput> {
    const rootDir = await transport.rootDir(ctx);
    const bytes = Buffer.from(input.content, "utf8");

    try {
      await transport.writeFile(
        ctx,
        absPath(rootDir, input.path),
        bytes,
        input.mode,
      );
    } catch (cause) {
      // Re-stated in terms the model can act on: it asked about a relative
      // path and never saw the absolute one the transport reports.
      if (cause instanceof SandboxPathExistsError) {
        throw new Error(
          `fs.write: path already exists (mode=create): ${input.path}`,
          { cause },
        );
      }
      throw cause;
    }

    return { bytesWritten: bytes.length };
  },

  async fsEdit(ctx: SandboxContext, input: FsEditInput): Promise<FsEditOutput> {
    const rootDir = await transport.rootDir(ctx);
    const bytes = await readForTool(
      transport,
      ctx,
      "fs.edit",
      rootDir,
      input.path,
    );

    const updated = replaceUnique(
      decodeUtf8Strict(bytes, "fs.edit", input.path),
      input,
    );

    await transport.writeFile(
      ctx,
      absPath(rootDir, input.path),
      Buffer.from(updated, "utf8"),
      "overwrite",
    );

    return { replacements: 1 };
  },

  async fsList(ctx: SandboxContext, input: FsListInput): Promise<FsListOutput> {
    const rootDir = await transport.rootDir(ctx);
    const target = input.path ? absPath(rootDir, input.path) : rootDir;

    const res = await transport.exec(ctx, buildFindArgs(target, input), {
      cwd: rootDir,
      timeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
      stdoutCap: MAX_LIST_OUTPUT_BYTES,
      stderrCap: MAX_SHELL_OUTPUT_BYTES,
    });

    // find exits non-zero on a partial failure — an unreadable subdirectory —
    // while still printing everything it could reach. Returning those rows is
    // more useful than failing the call, so only a run that produced nothing at
    // all is treated as an error.
    if (res.exitCode !== 0 && res.stdout.length === 0) {
      const detail = res.stderr.toString("utf8").trim();
      throw new Error(`fs.list: ${detail || "fs.list failed"}`);
    }

    return parseFindOutput(res.stdout.toString("utf8"));
  },

  destroy(ctx: SandboxContext): Promise<void> {
    return transport.destroy(ctx);
  },
});
