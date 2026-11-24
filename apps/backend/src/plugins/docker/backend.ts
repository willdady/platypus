import Docker from "dockerode";
import type { Container, Exec } from "dockerode";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { z } from "zod";
import type {
  PluginConfigContext,
  PluginLogger,
} from "@platypuschat/plugin-sdk";
import {
  MAX_DIAGNOSTIC_BYTES,
  SANDBOX_WORKSPACE_ROOT,
} from "../../sandbox/index.ts";
import { createPosixSandbox } from "../../sandbox/posix.ts";
import {
  createCappedSink,
  raceCancellation,
  SandboxCancelledError,
  SandboxPathExistsError,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxTransport,
  type StreamCap,
} from "../../sandbox/transport.ts";
import type { SandboxBackend, SandboxContext } from "../../sandbox/types.ts";
import { errorMessage } from "../../utils/error-message.ts";

const IMAGE = "debian:stable-slim";
const LABEL_SANDBOX = "platypus.sandbox";
const LABEL_WORKSPACE_ID = "platypus.sandbox.workspaceId";

const PIDS_LIMIT = 256;
const MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const NANO_CPUS = 2 * 1_000_000_000;
const SECURITY_OPT = ["no-new-privileges:true"];

export const dockerPluginConfigSchema = z
  .object({
    allowedNetworks: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type DockerPluginConfig = z.infer<typeof dockerPluginConfigSchema>;

export function readAllowedDockerNetworks(
  pluginConfig: DockerPluginConfig | undefined,
): string[] {
  return pluginConfig?.allowedNetworks ?? [];
}

const EXTRA_HOST_PATTERN =
  /^[A-Za-z0-9.-]+:(?:host-gateway|[0-9.]+|[0-9A-Fa-f:]+)$/;

const dockerSandboxConfigBase = z
  .object({
    networks: z.array(z.string().min(1)).default([]),
    extraHosts: z
      .array(
        z.string().regex(EXTRA_HOST_PATTERN, {
          message:
            "extraHosts entries must be `hostname:target` where target is `host-gateway`, an IPv4, or an IPv6 address",
        }),
      )
      .default([]),
  })
  .strict();

export type DockerSandboxConfig = z.infer<typeof dockerSandboxConfigBase>;

export const dockerSandboxConfigSchema = (
  plugin: PluginConfigContext<DockerPluginConfig>,
) => {
  const allowed = new Set(plugin.config.allowedNetworks);
  return dockerSandboxConfigBase.superRefine((cfg, ctx) => {
    for (const n of cfg.networks) {
      if (!allowed.has(n)) {
        ctx.addIssue({
          code: "custom",
          path: ["networks"],
          message: `Network '${n}' is not in the operator allowlist (@platypus/docker plugin config 'allowedNetworks')`,
        });
      }
    }
  });
};

export const dockerSandboxCredentialsSchema = z.object({}).strict();

export type DockerSandboxCredentials = z.infer<
  typeof dockerSandboxCredentialsSchema
>;

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

// why: hand-rolled because tar-stream is not a direct dependency and pnpm's strict resolver misses it
function buildSingleFileTar(name: string, content: Buffer): Buffer {
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`tar entry name too long (>100 bytes): ${name}`);
  }

  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  header.write("0000644 ", 100, 8, "utf8");
  header.write("0000000 ", 108, 8, "utf8");
  header.write("0000000 ", 116, 8, "utf8");
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
  header.write("        ", 148, 8, "utf8");
  header.write("0", 156, 1, "utf8");
  header.write("ustar  ", 257, 8, "utf8");

  let sum = 0;
  for (const byte of header) sum += byte;
  const chk = sum.toString(8).padStart(6, "0") + "\0 ";
  header.write(chk, 148, 8, "utf8");

  const pad = (512 - (content.length % 512)) % 512;
  const contentBlock = Buffer.concat([content, Buffer.alloc(pad, 0)]);

  const trailer = Buffer.alloc(1024, 0);

  return Buffer.concat([header, contentBlock, trailer]);
}

function splitParent(absPath: string): { parent: string; name: string } {
  const idx = absPath.lastIndexOf("/");
  return {
    parent: idx <= 0 ? "/" : absPath.slice(0, idx),
    name: absPath.slice(idx + 1),
  };
}

const EXEC_MARKER_VAR = "PLATYPUS_EXEC_ID";

// why: repeats because a child forked mid-sweep survives one pass; PidsLimit caps a fork bomb
const KILL_SCRIPT = `
n=0
while [ "$n" -lt 10 ]; do
  found=
  for d in /proc/[0-9]*; do
    if grep -qxzF -- "${EXEC_MARKER_VAR}=$1" "$d/environ" 2>/dev/null; then
      kill -9 "\${d#/proc/}" 2>/dev/null && found=1
    fi
  done
  [ -z "$found" ] && exit 0
  n=$((n + 1))
done
echo "processes still running after $n passes" >&2
exit 1
`;

const KILL_TIMEOUT_MS = 5_000;

const READ_TIMEOUT_MS = 30_000;

const EXIT_CODE_ATTEMPTS = 10;
const EXIT_CODE_RETRY_MS = 50;

type ExecLog = { logger: PluginLogger; workspaceId: string };

type RunExecResult = SandboxExecResult & { timedOut: boolean };

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function settleWithin<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise.catch(() => undefined), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

async function killExec(
  container: Container,
  marker: string,
  log: ExecLog,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KILL_TIMEOUT_MS);
  try {
    const res = await runExec(
      container,
      ["/bin/sh", "-c", KILL_SCRIPT, "sh", marker],
      {
        timeoutMs: KILL_TIMEOUT_MS,
        signal: controller.signal,
        log,
        // why: killing the kill recurses; KILL_TIMEOUT_MS bounds it instead
        killUnfinished: false,
      },
    );
    if (res.exitCode !== 0) {
      throw new Error(
        res.timedOut
          ? "kill timed out"
          : res.stderr.toString("utf8").trim() || `exit ${res.exitCode}`,
      );
    }
  } catch (err) {
    log.logger.warn(
      { workspaceId: log.workspaceId, err },
      "sandbox exec: could not kill an unfinished command (it may still be running)",
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readExitCode(exec: Exec): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    let info: Awaited<ReturnType<Exec["inspect"]>>;
    try {
      info = await exec.inspect();
    } catch (cause) {
      const detail = errorMessage(cause);
      throw new Error(`could not read the command's exit status: ${detail}`, {
        cause,
      });
    }
    if (!info.Running && typeof info.ExitCode === "number") {
      return info.ExitCode;
    }
    if (attempt >= EXIT_CODE_ATTEMPTS) {
      throw new Error("the daemon never recorded the command's exit code");
    }
    await delay(EXIT_CODE_RETRY_MS);
  }
}

async function runExec(
  container: Container,
  cmd: string[],
  opts: {
    workingDir?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    stdoutCap?: StreamCap;
    stderrCap?: StreamCap;
    signal?: AbortSignal;
    log: ExecLog;
    killUnfinished?: boolean;
  },
): Promise<RunExecResult> {
  const started = Date.now();
  const signal = opts.signal;
  const marker = randomUUID();
  const killIfUnfinished = () =>
    opts.killUnfinished === false
      ? Promise.resolve()
      : killExec(container, marker, opts.log);

  const exec: Exec = await raceCancellation(signal, () =>
    container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: opts.workingDir,
      Env: [
        ...Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
        `${EXEC_MARKER_VAR}=${marker}`,
      ],
    }),
  );

  type ExecStream = Awaited<ReturnType<Exec["start"]>>;
  let starting: Promise<ExecStream> | undefined;
  let stream: ExecStream;
  try {
    stream = await raceCancellation(
      signal,
      () => (starting = exec.start({ hijack: true, stdin: false })),
    );
  } catch (err) {
    if (err instanceof SandboxCancelledError && starting) {
      const late = await settleWithin(starting, KILL_TIMEOUT_MS);
      late?.destroy();
      await killIfUnfinished();
    }
    throw err;
  }

  const stdoutSink = createCappedSink(
    opts.stdoutCap ?? { head: Number.POSITIVE_INFINITY },
  );
  const stderrSink = createCappedSink(
    opts.stderrCap ?? { head: Number.POSITIVE_INFINITY },
  );

  const stdoutPass = new PassThrough();
  const stderrPass = new PassThrough();
  stdoutPass.on("data", (c: Buffer) => stdoutSink.push(c));
  stderrPass.on("data", (c: Buffer) => stderrSink.push(c));

  (
    container as unknown as {
      modem: {
        demuxStream: (s: unknown, out: unknown, err: unknown) => void;
      };
    }
  ).modem.demuxStream(stream, stdoutPass, stderrPass);

  let timedOut = false;
  const streamEnd = new Promise<void>((resolve) => {
    stream.on("end", () => resolve());
    stream.on("close", () => resolve());
    stream.on("error", () => resolve());
  });

  const destroyStream = () => {
    try {
      (stream as unknown as { destroy: () => void }).destroy();
    } catch {
      // why: best-effort; killIfUnfinished ends the command whether or not this throws
    }
  };

  const timeoutMs = opts.timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      destroyStream();
    }, timeoutMs);
  }

  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    destroyStream();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  try {
    await streamEnd;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (timer) clearTimeout(timer);

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set in a callback, which TS narrowing does not track
  if (cancelled || timedOut) await killIfUnfinished();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set in a callback, which TS narrowing does not track
  if (cancelled) throw new SandboxCancelledError();

  stdoutPass.end();
  stderrPass.end();

  let exitCode = 124;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set in a callback, which TS narrowing does not track
  if (!timedOut) {
    try {
      exitCode = await readExitCode(exec);
    } catch (err) {
      await killIfUnfinished();
      throw err;
    }
  }

  return {
    stdout: stdoutSink.collect(),
    stderr: stderrSink.collect(),
    exitCode,
    durationMs: Date.now() - started,
    timedOut,
  };
}

class DockerSandboxTransport implements SandboxTransport {
  private docker: Docker;
  private inflight: Map<string, Promise<Container>>;
  private networks: string[];
  private extraHosts: string[];
  private logger: PluginLogger;

  constructor(
    config: DockerSandboxConfig,
    _credentials: DockerSandboxCredentials,
    logger: PluginLogger,
  ) {
    this.docker = new Docker();
    this.inflight = new Map();
    this.networks = config.networks;
    this.extraHosts = config.extraHosts;
    this.logger = logger;
  }

  private execLog(ctx: SandboxContext): ExecLog {
    return { logger: this.logger, workspaceId: ctx.workspaceId };
  }

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

    const candidate = this.docker.getContainer(name);
    try {
      const info = await candidate.inspect();
      if (info.State.Running) return candidate;
      await candidate.start();
      return candidate;
    } catch (err) {
      if (!is404(err)) throw err;
    }

    await this.ensureImage();

    try {
      await this.docker.getVolume(vol).inspect();
    } catch (err) {
      if (!is404(err)) throw err;
      await this.docker.createVolume({ Name: vol });
    }

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
        Init: true,
        Memory: MEMORY_BYTES,
        MemorySwap: MEMORY_BYTES,
        NanoCpus: NANO_CPUS,
        SecurityOpt: SECURITY_OPT,
        ExtraHosts: this.extraHosts,
        ...(this.networks.length > 0 ? { NetworkMode: this.networks[0] } : {}),
      },
    });
    await container.start();

    for (const net of this.networks.slice(1)) {
      await this.docker.getNetwork(net).connect({ Container: container.id });
    }

    await runExec(
      container,
      ["/bin/sh", "-c", `mkdir -p ${SANDBOX_WORKSPACE_ROOT}`],
      { log: this.execLog(ctx) },
    );

    return container;
  }

  private async ensureImage(): Promise<void> {
    try {
      await this.docker.getImage(IMAGE).inspect();
      return;
    } catch (err) {
      if (!is404(err)) throw err;
    }
    this.logger.info({ image: IMAGE }, "Pulling sandbox image");
    const stream = await this.docker.pull(IMAGE);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err: Error | null) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  async rootDir(ctx: SandboxContext): Promise<string> {
    await this.ensureContainer(ctx);
    return SANDBOX_WORKSPACE_ROOT;
  }

  async exec(
    ctx: SandboxContext,
    argv: string[],
    opts: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    // why: provisioning is shared per Workspace, so an abort ends this wait, not the shared work
    const container = await raceCancellation(opts.signal, () =>
      this.ensureContainer(ctx),
    );
    return runExec(container, argv, {
      workingDir: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      stdoutCap: opts.stdoutCap,
      stderrCap: opts.stderrCap,
      signal: opts.signal,
      log: this.execLog(ctx),
    });
  }

  async readFile(
    ctx: SandboxContext,
    absPath: string,
    cap: number,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const container = await this.ensureContainer(ctx);
    const res = await runExec(
      container,
      ["head", "-c", String(cap), "--", absPath],
      {
        workingDir: SANDBOX_WORKSPACE_ROOT,
        timeoutMs: READ_TIMEOUT_MS,
        stdoutCap: { head: cap },
        stderrCap: { head: MAX_DIAGNOSTIC_BYTES },
        signal,
        log: this.execLog(ctx),
      },
    );

    if (res.timedOut) {
      throw new Error(`read timed out after ${READ_TIMEOUT_MS / 1000}s`);
    }
    if (res.exitCode !== 0) {
      throw new Error(res.stderr.toString("utf8").trim() || "read failed");
    }

    return res.stdout;
  }

  async writeFile(
    ctx: SandboxContext,
    absPath: string,
    bytes: Buffer,
    mode: "create" | "overwrite",
  ): Promise<void> {
    const container = await this.ensureContainer(ctx);

    // why: putArchive always overwrites; this probe races, but Docker has no exclusive create
    if (mode === "create") {
      const probe = await runExec(container, ["test", "-e", absPath], {
        workingDir: SANDBOX_WORKSPACE_ROOT,
        log: this.execLog(ctx),
      });
      if (probe.exitCode === 0) {
        throw new SandboxPathExistsError(absPath);
      }
    }

    const { parent, name } = splitParent(absPath);
    if (parent !== SANDBOX_WORKSPACE_ROOT) {
      const mk = await runExec(container, ["mkdir", "-p", parent], {
        log: this.execLog(ctx),
      });
      if (mk.exitCode !== 0) {
        throw new Error(`failed to create parent directory: ${parent}`);
      }
    }

    await container.putArchive(buildSingleFileTar(name, bytes), {
      path: parent,
    });
  }

  async destroy(ctx: SandboxContext): Promise<void> {
    const name = containerName(ctx.workspaceId);
    const vol = volumeName(ctx.workspaceId);

    try {
      await this.docker.getContainer(name).stop({ t: 5 });
    } catch (err) {
      if (!is404(err)) {
        const e = err as { statusCode?: number };
        if (e.statusCode !== 304) {
          this.logger.warn(
            { workspaceId: ctx.workspaceId, err },
            "sandbox destroy: stop failed (continuing)",
          );
        }
      }
    }

    try {
      await this.docker.getContainer(name).remove({ force: true, v: false });
    } catch (err) {
      if (!is404(err)) {
        this.logger.warn(
          { workspaceId: ctx.workspaceId, err },
          "sandbox destroy: container remove failed (continuing)",
        );
      }
    }

    try {
      await this.docker.getVolume(vol).remove();
    } catch (err) {
      if (!is404(err)) {
        this.logger.warn(
          { workspaceId: ctx.workspaceId, err },
          "sandbox destroy: volume remove failed",
        );
      }
    }
  }
}

export const createDockerSandboxBackend = (
  config: DockerSandboxConfig,
  credentials: DockerSandboxCredentials,
  plugin: PluginConfigContext,
): SandboxBackend =>
  createPosixSandbox(
    new DockerSandboxTransport(config, credentials, plugin.logger),
  );
