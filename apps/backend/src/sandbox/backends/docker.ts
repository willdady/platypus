import Docker from "dockerode";
import type { Container, Exec } from "dockerode";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { logger } from "../../logger.ts";
import {
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_LIST_ENTRIES,
  MAX_READ_BYTES,
  MAX_SHELL_OUTPUT_BYTES,
  MAX_SHELL_TIMEOUT_MS,
  SANDBOX_WORKSPACE_ROOT,
} from "../index.ts";
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
} from "../types.ts";

const IMAGE = "debian:stable-slim";
const LABEL_SANDBOX = "platypus.sandbox";
const LABEL_WORKSPACE_ID = "platypus.sandbox.workspaceId";

// Container resource and security limits. Hardcoded for v1; sane defaults
// rather than configurable knobs. See ADR-0003 for rationale.
const PIDS_LIMIT = 256;
const MEMORY_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const NANO_CPUS = 2 * 1_000_000_000; // 2 CPUs
const SECURITY_OPT = ["no-new-privileges:true"];

// Default ExtraHosts entry: gives sandbox containers a Docker-convention
// hostname (`host.docker.internal`) that resolves to the host's gateway IP,
// so agent-written code can reach services the operator publishes on the
// host (local model inference, transcription, the Platypus
// internal-resource-proxy, etc.) without hardcoded IPs. See ADR-0005.
//
// Configurable via PLATYPUS_SANDBOX_EXTRA_HOSTS:
//   - unset           → DEFAULT_EXTRA_HOSTS below
//   - empty string    → no ExtraHosts at all (opt out)
//   - "name:ip,..."   → exact comma-separated list (replaces default)
//
// Reads the env per call so operators can adjust without rebuilding the
// image; only takes effect on newly-created containers (existing
// containers keep their old config until destroyed and recreated, per
// ADR-0003).
const DEFAULT_EXTRA_HOSTS = ["host.docker.internal:host-gateway"];

// Validate a single ExtraHosts entry. We accept the Docker daemon's own
// format `host:ip-or-magic` where the right side is either an IPv4
// address, an IPv6 address, or one of Docker's documented magic tokens
// (currently `host-gateway`). Anything else is rejected — the daemon
// would also reject it, but failing early gives a clearer error.
const EXTRA_HOST_PATTERN =
  /^[A-Za-z0-9.-]+:(?:host-gateway|[0-9.]+|[0-9A-Fa-f:]+)$/;

function readExtraHosts(): string[] {
  const raw = process.env.PLATYPUS_SANDBOX_EXTRA_HOSTS;
  if (raw === undefined) return DEFAULT_EXTRA_HOSTS;
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  return trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      if (!EXTRA_HOST_PATTERN.test(entry)) {
        throw new Error(
          `Invalid PLATYPUS_SANDBOX_EXTRA_HOSTS entry: ${JSON.stringify(entry)}`,
        );
      }
      return entry;
    });
}

export const dockerSandboxConfigSchema = z.object({}).strict();
export const dockerSandboxCredentialsSchema = z.object({}).strict();

export type DockerSandboxConfig = z.infer<typeof dockerSandboxConfigSchema>;
export type DockerSandboxCredentials = z.infer<
  typeof dockerSandboxCredentialsSchema
>;

// 404-aware error guard. dockerode rejects with an Error that carries
// `statusCode` (and sometimes only `message` containing "no such ...").
function is404(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { statusCode?: number; message?: string };
  if (e.statusCode === 404) return true;
  const msg = (e.message ?? "").toLowerCase();
  return (
    msg.includes("no such container") ||
    msg.includes("no such image") ||
    msg.includes("no such volume")
  );
}

function containerName(workspaceId: string): string {
  return `platypus-sandbox-${workspaceId}`;
}

function volumeName(workspaceId: string): string {
  return `platypus-sandbox-vol-${workspaceId}`;
}

// Build a minimal POSIX (ustar) tar archive containing a single file. We avoid
// depending on `tar-stream` here because it isn't a direct dependency and
// hoisting from the pnpm store is not reliable for the strict resolver.
// @internal — exported for tests
export function buildSingleFileTar(name: string, content: Buffer): Buffer {
  // Strip any leading slash; tar entry names are relative to extraction root.
  const entryName = name.replace(/^\/+/, "");
  if (Buffer.byteLength(entryName) > 100) {
    throw new Error(`tar entry name too long (>100 bytes): ${entryName}`);
  }

  const header = Buffer.alloc(512, 0);
  header.write(entryName, 0, 100, "utf8");
  header.write("0000644 ", 100, 8, "utf8"); // mode
  header.write("0000000 ", 108, 8, "utf8"); // uid
  header.write("0000000 ", 116, 8, "utf8"); // gid
  // size: 11-octal-digits + space
  header.write(
    content.length.toString(8).padStart(11, "0") + " ",
    124,
    12,
    "utf8",
  );
  header.write(
    Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0") + " ",
    136,
    12,
    "utf8",
  );
  // Placeholder checksum (8 spaces) for computation.
  header.write("        ", 148, 8, "utf8");
  header.write("0", 156, 1, "utf8"); // typeflag: regular file
  header.write("ustar  ", 257, 8, "utf8"); // GNU-flavoured magic+version

  // Compute checksum: sum of all unsigned header bytes (with checksum field
  // as spaces, which we already placed above).
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  const chk = sum.toString(8).padStart(6, "0") + "\0 ";
  header.write(chk, 148, 8, "utf8");

  // File content padded to 512.
  const pad = (512 - (content.length % 512)) % 512;
  const contentBlock = Buffer.concat([content, Buffer.alloc(pad, 0)]);

  // Two zero blocks terminate the archive.
  const trailer = Buffer.alloc(1024, 0);

  return Buffer.concat([header, contentBlock, trailer]);
}

// Resolve a workspace-relative path to an absolute path inside the container.
// The schema already enforces the path is relative.
function absPath(relative: string | undefined): string {
  if (!relative) return SANDBOX_WORKSPACE_ROOT;
  return `${SANDBOX_WORKSPACE_ROOT}/${relative}`;
}

// Split the result of a tar `putArchive` target / `fsWrite` path into the
// parent directory (passed as `path` to putArchive) and the file name (used
// as the tar entry).
function splitParent(relative: string): { parent: string; name: string } {
  const cleaned = relative.replace(/^\/+/, "");
  const idx = cleaned.lastIndexOf("/");
  if (idx === -1) {
    return { parent: SANDBOX_WORKSPACE_ROOT, name: cleaned };
  }
  return {
    parent: `${SANDBOX_WORKSPACE_ROOT}/${cleaned.slice(0, idx)}`,
    name: cleaned.slice(idx + 1),
  };
}

type ExecResult = {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
};

// Run a single command inside the container, demuxing stdout/stderr. Optional
// stdout byte cap; on cap-hit we stop accumulating but continue draining.
async function runExec(
  container: Container,
  cmd: string[],
  opts: {
    workingDir?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    stdoutCap?: number;
    stderrCap?: number;
  } = {},
): Promise<ExecResult> {
  const started = Date.now();
  const exec: Exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: opts.workingDir,
    Env: opts.env
      ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)
      : undefined,
  });

  const stream = await exec.start({ hijack: true, stdin: false });

  const stdoutCap = opts.stdoutCap ?? Number.POSITIVE_INFINITY;
  const stderrCap = opts.stderrCap ?? Number.POSITIVE_INFINITY;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;

  const stdoutPass = new PassThrough();
  const stderrPass = new PassThrough();
  stdoutPass.on("data", (c: Buffer) => {
    if (stdoutBytes < stdoutCap) {
      const room = stdoutCap - stdoutBytes;
      const take = c.length <= room ? c : c.subarray(0, room);
      stdoutChunks.push(take);
      stdoutBytes += take.length;
    }
  });
  stderrPass.on("data", (c: Buffer) => {
    if (stderrBytes < stderrCap) {
      const room = stderrCap - stderrBytes;
      const take = c.length <= room ? c : c.subarray(0, room);
      stderrChunks.push(take);
      stderrBytes += take.length;
    }
  });

  // dockerode-attached demuxer
  (
    container as unknown as { modem: { demuxStream: Function } }
  ).modem.demuxStream(stream, stdoutPass, stderrPass);

  let timedOut = false;
  const streamEnd = new Promise<void>((resolve) => {
    stream.on("end", () => resolve());
    stream.on("close", () => resolve());
    stream.on("error", () => resolve());
  });

  const timeoutMs = opts.timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      // Best-effort destroy of the exec stream; on timeout we also issue a
      // KILL to the container's exec process group via a sidecar exec.
      try {
        (stream as unknown as { destroy: () => void }).destroy();
      } catch {
        // ignore
      }
    }, timeoutMs);
  }

  await streamEnd;
  if (timer) clearTimeout(timer);

  // Drain the pass-throughs.
  stdoutPass.end();
  stderrPass.end();

  let exitCode = 0;
  if (timedOut) {
    exitCode = 124;
  } else {
    try {
      const info = await exec.inspect();
      exitCode = info.ExitCode ?? 0;
    } catch {
      exitCode = 0;
    }
  }

  return {
    stdout: Buffer.concat(stdoutChunks),
    stderr: Buffer.concat(stderrChunks),
    exitCode,
    durationMs: Date.now() - started,
    timedOut,
  };
}

export class DockerSandboxBackend implements SandboxBackend {
  private docker: Docker;
  private inflight: Map<string, Promise<Container>>;

  constructor(
    _config: DockerSandboxConfig,
    _credentials: DockerSandboxCredentials,
  ) {
    this.docker = new Docker();
    this.inflight = new Map();
  }

  // Idempotent, concurrency-safe provisioning. Concurrent callers for the
  // same workspaceId share a single in-flight promise.
  private ensureContainer(ctx: SandboxContext): Promise<Container> {
    const existing = this.inflight.get(ctx.workspaceId);
    if (existing) return existing;
    const p = this.provisionContainer(ctx).finally(() => {
      this.inflight.delete(ctx.workspaceId);
    });
    this.inflight.set(ctx.workspaceId, p);
    return p;
  }

  private async provisionContainer(ctx: SandboxContext): Promise<Container> {
    const name = containerName(ctx.workspaceId);
    const vol = volumeName(ctx.workspaceId);

    // 1. Try existing container.
    const candidate = this.docker.getContainer(name);
    try {
      const info = await candidate.inspect();
      if (info.State.Running) return candidate;
      // Stopped — restart it.
      await candidate.start();
      return candidate;
    } catch (err) {
      if (!is404(err)) throw err;
    }

    // 2. Ensure image is present.
    await this.ensureImage();

    // 3. Ensure volume exists.
    try {
      await this.docker.getVolume(vol).inspect();
    } catch (err) {
      if (!is404(err)) throw err;
      await this.docker.createVolume({ Name: vol });
    }

    // 4. Create + start the container.
    const container = await this.docker.createContainer({
      name,
      Image: IMAGE,
      Cmd: ["sleep", "infinity"],
      WorkingDir: SANDBOX_WORKSPACE_ROOT,
      Labels: {
        [LABEL_SANDBOX]: "true",
        [LABEL_WORKSPACE_ID]: ctx.workspaceId,
      },
      HostConfig: {
        Binds: [`${vol}:${SANDBOX_WORKSPACE_ROOT}`],
        AutoRemove: false,
        PidsLimit: PIDS_LIMIT,
        Memory: MEMORY_BYTES,
        MemorySwap: MEMORY_BYTES,
        NanoCpus: NANO_CPUS,
        SecurityOpt: SECURITY_OPT,
        ExtraHosts: readExtraHosts(),
      },
    });
    await container.start();

    // Make sure the workspace root exists with sane perms (volume-mount
    // creates it as the root of the mount, but `mkdir -p` is idempotent).
    await runExec(container, [
      "/bin/sh",
      "-c",
      `mkdir -p ${SANDBOX_WORKSPACE_ROOT}`,
    ]);

    return container;
  }

  private async ensureImage(): Promise<void> {
    try {
      await this.docker.getImage(IMAGE).inspect();
      return;
    } catch (err) {
      if (!is404(err)) throw err;
    }
    logger.info({ image: IMAGE }, "Pulling sandbox image");
    const stream = (await this.docker.pull(IMAGE)) as NodeJS.ReadableStream;
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err: Error | null) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  async shellExec(
    ctx: SandboxContext,
    input: ShellExecInput,
  ): Promise<ShellExecOutput> {
    const container = await this.ensureContainer(ctx);
    const timeoutMs = Math.min(
      input.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
      MAX_SHELL_TIMEOUT_MS,
    );
    const workingDir = input.cwd
      ? `${SANDBOX_WORKSPACE_ROOT}/${input.cwd}`
      : SANDBOX_WORKSPACE_ROOT;

    const res = await runExec(container, ["/bin/sh", "-c", input.command], {
      workingDir,
      env: input.env,
      timeoutMs,
      stdoutCap: MAX_SHELL_OUTPUT_BYTES,
      stderrCap: MAX_SHELL_OUTPUT_BYTES,
    });

    const stdout = res.stdout.toString("utf8");
    const stderr = res.stderr.toString("utf8");
    // truncated if we hit the cap on either stream (we cannot distinguish
    // "exactly at cap" from "exceeded cap" here, but the buffer length being
    // === cap is a strong signal and consistent with the contract).
    const truncated =
      res.stdout.length >= MAX_SHELL_OUTPUT_BYTES ||
      res.stderr.length >= MAX_SHELL_OUTPUT_BYTES;

    return {
      stdout,
      stderr,
      exitCode: res.exitCode,
      truncated,
      durationMs: res.durationMs,
    };
  }

  async fsRead(ctx: SandboxContext, input: FsReadInput): Promise<FsReadOutput> {
    const container = await this.ensureContainer(ctx);
    const target = absPath(input.path);

    // Use argv form (no shell) so paths can't be interpreted as shell syntax.
    const cmd = input.lineRange
      ? [
          "sed",
          "-n",
          `${input.lineRange[0]},${input.lineRange[1]}p`,
          "--",
          target,
        ]
      : ["cat", "--", target];

    const res = await runExec(container, cmd, {
      workingDir: SANDBOX_WORKSPACE_ROOT,
      stdoutCap: MAX_READ_BYTES,
      stderrCap: MAX_SHELL_OUTPUT_BYTES,
    });

    if (res.exitCode !== 0) {
      const msg = res.stderr.toString("utf8").trim() || "fs.read failed";
      throw new Error(`fs.read: ${msg}`);
    }

    // Reject non-UTF-8 by decoding with the strict TextDecoder.
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(res.stdout);
    } catch {
      throw new Error(`fs.read: file is not valid UTF-8 (${input.path})`);
    }

    const truncated = res.stdout.length >= MAX_READ_BYTES;
    // lineCount: count newlines + 1 if there's any trailing content without a
    // newline. Empty content → 0 lines.
    let lineCount = 0;
    if (content.length > 0) {
      lineCount = content.split("\n").length;
      if (content.endsWith("\n")) lineCount -= 1;
    }

    return { content, lineCount, truncated };
  }

  async fsWrite(
    ctx: SandboxContext,
    input: FsWriteInput,
  ): Promise<FsWriteOutput> {
    const container = await this.ensureContainer(ctx);
    const target = absPath(input.path);

    if (input.mode === "create") {
      // argv form — path can't escape into shell syntax.
      const probe = await runExec(container, ["test", "-e", target], {
        workingDir: SANDBOX_WORKSPACE_ROOT,
      });
      if (probe.exitCode === 0) {
        throw new Error(
          `fs.write: path already exists (mode=create): ${input.path}`,
        );
      }
    }

    // Ensure the parent directory exists before extracting the tar.
    const { parent, name } = splitParent(input.path);
    if (parent !== SANDBOX_WORKSPACE_ROOT) {
      const mk = await runExec(container, ["mkdir", "-p", parent]);
      if (mk.exitCode !== 0) {
        throw new Error(
          `fs.write: failed to create parent directory: ${parent}`,
        );
      }
    }

    const contentBuf = Buffer.from(input.content, "utf8");
    const tar = buildSingleFileTar(name, contentBuf);
    await container.putArchive(tar, { path: parent });

    return { bytesWritten: contentBuf.length };
  }

  async fsEdit(ctx: SandboxContext, input: FsEditInput): Promise<FsEditOutput> {
    const container = await this.ensureContainer(ctx);
    const target = absPath(input.path);

    // argv form — path is never shell-interpreted.
    const readRes = await runExec(container, ["cat", "--", target], {
      workingDir: SANDBOX_WORKSPACE_ROOT,
      stdoutCap: MAX_READ_BYTES,
    });
    if (readRes.exitCode !== 0) {
      const msg = readRes.stderr.toString("utf8").trim() || "fs.edit failed";
      throw new Error(`fs.edit: ${msg}`);
    }

    let original: string;
    try {
      original = new TextDecoder("utf-8", { fatal: true }).decode(
        readRes.stdout,
      );
    } catch {
      throw new Error(`fs.edit: file is not valid UTF-8 (${input.path})`);
    }

    const first = original.indexOf(input.oldString);
    if (first === -1) {
      throw new Error(`fs.edit: oldString not found in ${input.path}`);
    }
    const second = original.indexOf(input.oldString, first + 1);
    if (second !== -1) {
      throw new Error(`fs.edit: oldString is not unique in ${input.path}`);
    }

    const updated =
      original.slice(0, first) +
      input.newString +
      original.slice(first + input.oldString.length);

    const { parent, name } = splitParent(input.path);
    const tar = buildSingleFileTar(name, Buffer.from(updated, "utf8"));
    await container.putArchive(tar, { path: parent });

    return { replacements: 1 };
  }

  async fsList(ctx: SandboxContext, input: FsListInput): Promise<FsListOutput> {
    const container = await this.ensureContainer(ctx);
    const target = absPath(input.path);
    // Argv form throughout — no shell, no path/glob interpolation.
    // Truncation is done in Node instead of `| head`.
    const args: string[] = ["find", target];
    if (!input.recursive) args.push("-maxdepth", "1");
    args.push("-mindepth", "1");
    if (input.glob) {
      // -name handles a simple file-name glob; -path handles patterns that
      // include slashes or **. `**` collapses to `*` for find(1) — a lossy
      // but pragmatic translation; document the limitation in tool description.
      if (input.glob.includes("/") || input.glob.includes("**")) {
        args.push("-path", `*/${input.glob.replace(/\*\*/g, "*")}`);
      } else {
        args.push("-name", input.glob);
      }
    }
    args.push("-printf", "%y\\t%s\\t%P\\n");

    const res = await runExec(container, args, {
      workingDir: SANDBOX_WORKSPACE_ROOT,
      stdoutCap: 4 * 1024 * 1024,
      stderrCap: MAX_SHELL_OUTPUT_BYTES,
    });

    if (res.exitCode !== 0 && res.stdout.length === 0) {
      const msg = res.stderr.toString("utf8").trim() || "fs.list failed";
      throw new Error(`fs.list: ${msg}`);
    }

    const lines = res.stdout
      .toString("utf8")
      .split("\n")
      .filter((l) => l.length > 0);

    const entries: FsListEntry[] = [];
    let truncated = false;
    for (const line of lines) {
      const tab1 = line.indexOf("\t");
      const tab2 = line.indexOf("\t", tab1 + 1);
      if (tab1 === -1 || tab2 === -1) continue;
      const typeChar = line.slice(0, tab1);
      const sizeStr = line.slice(tab1 + 1, tab2);
      const path = line.slice(tab2 + 1);
      let type: "file" | "dir";
      if (typeChar === "f") type = "file";
      else if (typeChar === "d") type = "dir";
      else continue; // ignore symlinks / sockets / devices in v1
      const size = Number.parseInt(sizeStr, 10);
      entries.push({
        path,
        type,
        ...(Number.isFinite(size) ? { size } : {}),
      });
      if (entries.length >= MAX_LIST_ENTRIES) {
        // If find emitted more entries beyond what we kept, mark truncated.
        truncated = entries.length < lines.length;
        break;
      }
    }

    return { entries, truncated };
  }

  async destroy(ctx: SandboxContext): Promise<void> {
    const name = containerName(ctx.workspaceId);
    const vol = volumeName(ctx.workspaceId);

    // Stop.
    try {
      await this.docker.getContainer(name).stop({ t: 5 });
    } catch (err) {
      if (!is404(err)) {
        // Already stopped is 304 — swallow that too.
        const e = err as { statusCode?: number };
        if (e.statusCode !== 304) {
          logger.warn(
            { workspaceId: ctx.workspaceId, err },
            "sandbox destroy: stop failed (continuing)",
          );
        }
      }
    }

    // Remove container.
    try {
      await this.docker.getContainer(name).remove({ force: true, v: false });
    } catch (err) {
      if (!is404(err)) {
        logger.warn(
          { workspaceId: ctx.workspaceId, err },
          "sandbox destroy: container remove failed (continuing)",
        );
      }
    }

    // Remove volume.
    try {
      await this.docker.getVolume(vol).remove();
    } catch (err) {
      if (!is404(err)) {
        logger.warn(
          { workspaceId: ctx.workspaceId, err },
          "sandbox destroy: volume remove failed",
        );
      }
    }
  }
}
