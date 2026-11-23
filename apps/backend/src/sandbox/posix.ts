import {
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_LIST_ENTRIES,
  MAX_LIST_OUTPUT_BYTES,
  MAX_DIAGNOSTIC_BYTES,
  MAX_READ_BYTES,
  MAX_SHELL_OUTPUT_BYTES,
  MAX_SHELL_TIMEOUT_MS,
  SHELL_STREAM_CAP,
} from "./index.ts";
import {
  raceCancellation,
  SandboxPathExistsError,
  type SandboxTransport,
} from "./transport.ts";
import type {
  FsEditInput,
  FsEditOutput,
  FsListEntry,
  FsListInput,
  FsListOutput,
  FsReadBytesInput,
  FsReadInput,
  FsReadOutput,
  FsWriteBytesInput,
  FsWriteInput,
  FsWriteOutput,
  SandboxBackend,
  SandboxCallOptions,
  SandboxContext,
  ShellExecInput,
  ShellExecOutput,
} from "./types.ts";

const absPath = (rootDir: string, relative: string): string =>
  `${rootDir}/${relative.replace(/^\/+/, "")}`;

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

const countLines = (content: string): number => {
  if (content.length === 0) return 0;
  const lines = content.split("\n").length;
  return content.endsWith("\n") ? lines - 1 : lines;
};

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

export const buildFindArgs = (
  target: string,
  input: Pick<FsListInput, "recursive" | "glob">,
): string[] => {
  const args = ["find", target];
  if (!input.recursive) args.push("-maxdepth", "1");
  args.push("-mindepth", "1");
  if (input.glob) {
    if (input.glob.includes("/") || input.glob.includes("**")) {
      args.push("-path", `*/${input.glob.replace(/\*\*/g, "*")}`);
    } else {
      args.push("-name", input.glob);
    }
  }
  args.push("-printf", "%y\\t%s\\t%P\\n");
  return args;
};

export const parseFindOutput = (stdout: string): FsListOutput => {
  const entries: FsListEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const tab1 = line.indexOf("\t");
    const tab2 = line.indexOf("\t", tab1 + 1);
    if (tab1 === -1 || tab2 === -1) continue;
    const typeChar = line.slice(0, tab1);
    if (typeChar !== "f" && typeChar !== "d") continue;
    const size = Number.parseInt(line.slice(tab1 + 1, tab2), 10);
    entries.push({
      path: line.slice(tab2 + 1),
      type: typeChar === "f" ? "file" : "dir",
      ...(Number.isFinite(size) ? { size } : {}),
    });
  }
  return {
    entries: entries.slice(0, MAX_LIST_ENTRIES),
    truncated: entries.length > MAX_LIST_ENTRIES,
  };
};

const readForTool = async (
  transport: SandboxTransport,
  ctx: SandboxContext,
  tool: string,
  rootDir: string,
  path: string,
  signal: AbortSignal,
  cap = MAX_READ_BYTES,
): Promise<Buffer> => {
  try {
    return await raceCancellation(signal, () =>
      transport.readFile(ctx, absPath(rootDir, path), cap, signal),
    );
  } catch (cause) {
    const detail =
      cause instanceof Error ? cause.message.trim() : String(cause);
    throw new Error(`${tool}: ${detail || `${tool} failed`}`, { cause });
  }
};

const resolveRoot = (
  transport: SandboxTransport,
  ctx: SandboxContext,
  options: SandboxCallOptions,
): Promise<string> =>
  raceCancellation(options.signal, () => transport.rootDir(ctx));

export const createPosixSandbox = (
  transport: SandboxTransport,
): Required<SandboxBackend> => ({
  async shellExec(
    ctx: SandboxContext,
    input: ShellExecInput,
    options: SandboxCallOptions,
  ): Promise<ShellExecOutput> {
    const rootDir = await resolveRoot(transport, ctx, options);
    const timeoutMs = Math.min(
      input.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
      MAX_SHELL_TIMEOUT_MS,
    );

    const res = await transport.exec(ctx, ["/bin/sh", "-c", input.command], {
      cwd: input.cwd ? absPath(rootDir, input.cwd) : rootDir,
      env: input.env,
      timeoutMs,
      signal: options.signal,
      stdoutCap: SHELL_STREAM_CAP,
      stderrCap: SHELL_STREAM_CAP,
    });

    return {
      stdout: res.stdout.toString("utf8"),
      stderr: res.stderr.toString("utf8"),
      exitCode: res.exitCode,
      truncated:
        res.stdout.length >= MAX_SHELL_OUTPUT_BYTES ||
        res.stderr.length >= MAX_SHELL_OUTPUT_BYTES,
      durationMs: res.durationMs,
    };
  },

  async fsRead(
    ctx: SandboxContext,
    input: FsReadInput,
    options: SandboxCallOptions,
  ): Promise<FsReadOutput> {
    const rootDir = await resolveRoot(transport, ctx, options);
    const bytes = await readForTool(
      transport,
      ctx,
      "fs.read",
      rootDir,
      input.path,
      options.signal,
    );

    const decoded = decodeUtf8Strict(bytes, "fs.read", input.path);
    const content = input.lineRange
      ? sliceLines(decoded, input.lineRange)
      : decoded;

    return {
      content,
      lineCount: countLines(content),
      truncated: bytes.length >= MAX_READ_BYTES,
    };
  },

  async fsWrite(
    ctx: SandboxContext,
    input: FsWriteInput,
    options: SandboxCallOptions,
  ): Promise<FsWriteOutput> {
    const rootDir = await resolveRoot(transport, ctx, options);
    const bytes = Buffer.from(input.content, "utf8");

    try {
      await raceCancellation(options.signal, () =>
        transport.writeFile(
          ctx,
          absPath(rootDir, input.path),
          bytes,
          input.mode,
        ),
      );
    } catch (cause) {
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

  async fsEdit(
    ctx: SandboxContext,
    input: FsEditInput,
    options: SandboxCallOptions,
  ): Promise<FsEditOutput> {
    const rootDir = await resolveRoot(transport, ctx, options);
    const bytes = await readForTool(
      transport,
      ctx,
      "fs.edit",
      rootDir,
      input.path,
      options.signal,
    );

    const updated = replaceUnique(
      decodeUtf8Strict(bytes, "fs.edit", input.path),
      input,
    );

    await raceCancellation(options.signal, () =>
      transport.writeFile(
        ctx,
        absPath(rootDir, input.path),
        Buffer.from(updated, "utf8"),
        "overwrite",
      ),
    );

    return { replacements: 1 };
  },

  async fsList(
    ctx: SandboxContext,
    input: FsListInput,
    options: SandboxCallOptions,
  ): Promise<FsListOutput> {
    const rootDir = await resolveRoot(transport, ctx, options);
    const target = input.path ? absPath(rootDir, input.path) : rootDir;

    const res = await transport.exec(ctx, buildFindArgs(target, input), {
      cwd: rootDir,
      timeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
      signal: options.signal,
      stdoutCap: { head: MAX_LIST_OUTPUT_BYTES },
      stderrCap: { head: MAX_DIAGNOSTIC_BYTES },
    });

    if (res.exitCode !== 0 && res.stdout.length === 0) {
      const detail = res.stderr.toString("utf8").trim();
      throw new Error(`fs.list: ${detail || "fs.list failed"}`);
    }

    return parseFindOutput(res.stdout.toString("utf8"));
  },

  async fsReadBytes(
    ctx: SandboxContext,
    input: FsReadBytesInput,
    options: SandboxCallOptions,
  ): Promise<Uint8Array> {
    const rootDir = await resolveRoot(transport, ctx, options);
    const bytes = await readForTool(
      transport,
      ctx,
      "fs.readBytes",
      rootDir,
      input.path,
      options.signal,
      input.maxBytes + 1,
    );
    if (bytes.length > input.maxBytes) {
      throw new Error(
        `fs.readBytes: file is larger than ${input.maxBytes} bytes: ${input.path}`,
      );
    }
    return bytes;
  },

  async fsWriteBytes(
    ctx: SandboxContext,
    input: FsWriteBytesInput,
    options: SandboxCallOptions,
  ): Promise<void> {
    const rootDir = await resolveRoot(transport, ctx, options);
    const { buffer, byteOffset, byteLength } = input.bytes;
    await raceCancellation(options.signal, () =>
      transport.writeFile(
        ctx,
        absPath(rootDir, input.path),
        Buffer.from(buffer, byteOffset, byteLength),
        "overwrite",
      ),
    );
  },

  destroy(ctx: SandboxContext): Promise<void> {
    return transport.destroy(ctx);
  },

  close(): Promise<void> {
    return transport.close?.() ?? Promise.resolve();
  },
});
