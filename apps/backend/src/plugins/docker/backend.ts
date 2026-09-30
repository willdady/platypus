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
  MAX_SHELL_OUTPUT_BYTES,
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
} from "../../sandbox/transport.ts";
import type { SandboxBackend, SandboxContext } from "../../sandbox/types.ts";

const IMAGE = "debian:stable-slim";
const LABEL_SANDBOX = "platypus.sandbox";
const LABEL_WORKSPACE_ID = "platypus.sandbox.workspaceId";

// Container resource and security limits. Hardcoded for v1; sane defaults
// rather than configurable knobs. See ADR-0003 for rationale.
const PIDS_LIMIT = 256;
const MEMORY_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const NANO_CPUS = 2 * 1_000_000_000; // 2 CPUs
const SECURITY_OPT = ["no-new-privileges:true"];

// Plugin-level, Operator-owned config for @platypus/docker (ADR-0013), supplied
// via PLATYPUS_PLUGIN_CONFIG_DOCKER and validated at boot. `allowedNetworks` is the
// Operator-declared allowlist of Docker networks a Sandbox may attach to
// (ADR-0005), defaulting to `[]` — an empty allowlist keeps the default-deny
// posture when the Operator lists the plugin but supplies no config block. Pure
// JSON array (no comma-separated string). Docker has no plugin-level secrets, so
// there is no companion credentialsSchema.
export const dockerPluginConfigSchema = z
  .object({
    allowedNetworks: z.array(z.string().min(1)).default([]),
  })
  .strict();

// Read the Operator network allowlist out of @platypus/docker's boot-resolved
// plugin config. Defensive-parses so a caller can pass the raw registry value;
// an absent/invalid block yields `[]` (default-deny). Feeds the admin
// multi-select endpoint (GET .../sandbox/networks).
export function readAllowedDockerNetworks(pluginConfig: unknown): string[] {
  const parsed = dockerPluginConfigSchema.safeParse(pluginConfig ?? {});
  return parsed.success ? parsed.data.allowedNetworks : [];
}

// A single ExtraHosts entry: `hostname:target` where target is `host-gateway`,
// an IPv4 address, or an IPv6 address. Anything else is rejected (the daemon
// would reject it too; failing at validation time gives a clearer error).
const EXTRA_HOST_PATTERN =
  /^[A-Za-z0-9.-]+:(?:host-gateway|[0-9.]+|[0-9A-Fa-f:]+)$/;

// Per-Sandbox host reachability (ADR-0005). Both default to empty: a new Sandbox
// reaches no host service until an org admin grants it.
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

// Factory form (ADR-0013): the per-Workspace config schema closes over the
// Operator's `allowedNetworks` from the plugin config injected at load, so an
// out-of-allowlist `networks` entry is rejected at config-save time (ADR-0005).
// The loader resolves this against the boot-validated plugin block into a
// concrete schema before core's static safeParse consumers see it. `config`
// arrives as `unknown` (the SDK's opaque plugin-config shape); we re-validate it
// through the plugin schema so the factory is self-contained and defensively
// defaults to an empty allowlist (default-deny).
export const dockerSandboxConfigSchema = (plugin: PluginConfigContext) => {
  const { allowedNetworks } = dockerPluginConfigSchema.parse(
    plugin.config ?? {},
  );
  const allowed = new Set(allowedNetworks);
  return dockerSandboxConfigBase.superRefine((cfg, ctx) => {
    for (const n of cfg.networks) {
      if (!allowed.has(n)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
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

// Split an absolute in-container path into the directory `putArchive` extracts
// into and the file name that becomes the tar entry.
function splitParent(absPath: string): { parent: string; name: string } {
  const idx = absPath.lastIndexOf("/");
  return {
    parent: idx <= 0 ? "/" : absPath.slice(0, idx),
    name: absPath.slice(idx + 1),
  };
}

// Every exec carries a unique marker in its environment, and everything it
// starts inherits it. Ending a command that did not finish means killing
// whatever carries its marker — which reaches a child that left the command's
// process group (`setsid`, a daemonising `&`) or was reparented to the
// container's init, where a process-group kill would miss it (issue #1128). A
// process that scrubs its own environment (`env -i`) escapes; that is the price
// of reaching the rest.
// @internal — exported for tests
export const EXEC_MARKER_VAR = "PLATYPUS_EXEC_ID";

// Run as `sh -c KILL_SCRIPT sh <marker>`. SIGKILLs every process whose
// environment holds the marker, and repeats while it still finds one, so a
// child forked mid-sweep is caught on the next pass. A killed process is a
// zombie with an empty environ until reaped, so it does not match again. Bounded
// to ten passes, exiting non-zero if the tenth still found one so the survivor
// is logged; a fork bomb outrunning that is what `PidsLimit` is for. Only POSIX
// sh, GNU grep and /proc — all present in the Debian base image.
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

// How long the kill itself may take. It is a daemon call like any other, and a
// daemon that hangs on it must not turn a timed-out command into a hung one.
const KILL_TIMEOUT_MS = 5_000;

// How long a file read may take. A read of a regular file under the cap is
// quick; what this bounds is a FIFO with no writer, which blocks on open.
const READ_TIMEOUT_MS = 30_000;

// The attached stream can close a beat before the daemon records the exit
// code, so a missing one is polled for briefly before it counts as a failure.
const EXIT_CODE_ATTEMPTS = 10;
const EXIT_CODE_RETRY_MS = 50;

/** Where a failure to kill an unfinished command is reported. */
type ExecLog = { logger: PluginLogger; workspaceId: string };

type RunExecResult = SandboxExecResult & { timedOut: boolean };

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// `promise`'s value if it resolves within `ms`, else `undefined`. Never rejects.
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

// Kill every process started by the exec tagged `marker`. Best-effort and
// bounded: a failure is logged, never thrown, because the caller is already
// reporting the command's own outcome (a timeout or a cancellation).
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
        // Killing the kill would only recurse; it is bounded by its own timer.
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

// The exec's exit code, once the daemon has recorded it. Rejects rather than
// guessing: a failed inspect, or one that never reports a code, says nothing
// about whether the command succeeded.
async function readExitCode(exec: Exec): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    let info: Awaited<ReturnType<Exec["inspect"]>>;
    try {
      info = await exec.inspect();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
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

// Run a single command inside the container, demuxing stdout/stderr into
// byte-capped sinks that keep draining once full (see createCappedSink).
//
// `signal` is honoured from the first await, not just once the command is
// streaming: creating and starting the exec are unbounded calls to the daemon
// and they run *before* the timeout timer is armed, so an unresponsive daemon
// is precisely where nothing else would recover the call (issue #921).
//
// A command that times out or is cancelled is killed in the container, along
// with everything it started (see EXEC_MARKER_VAR). Destroying the attached
// stream only stops *us* listening; the process would otherwise run on and
// count against `PidsLimit` (issue #1128).
async function runExec(
  container: Container,
  cmd: string[],
  opts: {
    workingDir?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    stdoutCap?: number;
    stderrCap?: number;
    signal?: AbortSignal;
    log: ExecLog;
    /** Kill the command in the container if it does not finish. Default true. */
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
      // The marker goes last so a caller's env cannot shadow it.
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
    // A start we stopped waiting for may still land and run the command. Give
    // it a bounded chance to, so the sweep runs after the process exists
    // rather than before it; a start that was never sent has nothing to kill.
    if (err instanceof SandboxCancelledError && starting) {
      const late = await settleWithin(starting, KILL_TIMEOUT_MS);
      late?.destroy();
      await killIfUnfinished();
    }
    throw err;
  }

  const stdoutSink = createCappedSink(
    opts.stdoutCap ?? Number.POSITIVE_INFINITY,
  );
  const stderrSink = createCappedSink(
    opts.stderrCap ?? Number.POSITIVE_INFINITY,
  );

  const stdoutPass = new PassThrough();
  const stderrPass = new PassThrough();
  stdoutPass.on("data", (c: Buffer) => stdoutSink.push(c));
  stderrPass.on("data", (c: Buffer) => stderrSink.push(c));

  // dockerode-attached demuxer
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

  // Best-effort destroy of the exec stream. This stops us listening; the
  // command itself is killed afterwards by `killIfUnfinished`.
  const destroyStream = () => {
    try {
      (stream as unknown as { destroy: () => void }).destroy();
    } catch {
      // ignore
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

  // A cancelled turn ends the command the same way its timeout would: the
  // stream is destroyed, `streamEnd` settles, the command is killed, and the
  // call rejects rather than reporting an exit code for a command that did not
  // finish.
  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    destroyStream();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  // An abort that landed between the last await above and that subscription
  // would never be delivered — a listener added to an already-aborted signal
  // does not fire — and the command would run to its timeout and report an exit
  // code for a turn that was already over.
  if (signal?.aborted) onAbort();

  try {
    await streamEnd;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (timer) clearTimeout(timer);

  if (cancelled || timedOut) await killIfUnfinished();
  if (cancelled) throw new SandboxCancelledError();

  // Drain the pass-throughs.
  stdoutPass.end();
  stderrPass.end();

  let exitCode = 124;
  if (!timedOut) {
    try {
      exitCode = await readExitCode(exec);
    } catch (err) {
      // The stream ended without a recorded exit — a dropped connection to the
      // daemon, say — so the command may still be running. End it too.
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

/**
 * The Docker half of the Sandbox: dockerode `exec` for commands, `putArchive`
 * for writes, and container/volume lifecycle (ADR-0003). The five model-facing
 * tools are built on top of this by {@link createPosixSandbox} — nothing here
 * parses find(1), counts lines, or decides what `truncated` means.
 */
class DockerSandboxTransport implements SandboxTransport {
  private docker: Docker;
  private inflight: Map<string, Promise<Container>>;
  private networks: string[];
  private extraHosts: string[];
  /**
   * The logger core bound to `@platypus/docker` and injected on the plugin's
   * deploy-time block (ADR-0013) — the same contract a third-party plugin gets,
   * rather than the relative import of core's logger only an in-tree plugin ever
   * had. Required, as {@link PluginConfigContext.logger} has been since API v2.
   */
  private logger: PluginLogger;

  constructor(
    config: Partial<DockerSandboxConfig>,
    _credentials: DockerSandboxCredentials,
    logger: PluginLogger,
  ) {
    this.docker = new Docker();
    this.inflight = new Map();
    // Normalise defensively: the registry passes schema-parsed config (arrays
    // present), but tolerate a bare object too.
    this.networks = config?.networks ?? [];
    this.extraHosts = config?.extraHosts ?? [];
    this.logger = logger;
  }

  private execLog(ctx: SandboxContext): ExecLog {
    return { logger: this.logger, workspaceId: ctx.workspaceId };
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
        // A minimal init as PID 1, so the orphans of a killed command are
        // reaped. `sleep infinity` would leave their zombies holding PIDs
        // against PidsLimit (issue #1128).
        Init: true,
        Memory: MEMORY_BYTES,
        MemorySwap: MEMORY_BYTES,
        NanoCpus: NANO_CPUS,
        SecurityOpt: SECURITY_OPT,
        // Host reachability (ADR-0005). Default-deny: empty unless an admin
        // granted entries. The first network becomes the container's primary
        // network; the rest are attached after start.
        ExtraHosts: this.extraHosts,
        ...(this.networks.length > 0 ? { NetworkMode: this.networks[0] } : {}),
      },
    });
    await container.start();

    // Attach any additional networks beyond the primary one.
    for (const net of this.networks.slice(1)) {
      await this.docker.getNetwork(net).connect({ Container: container.id });
    }

    // Make sure the workspace root exists with sane perms (volume-mount
    // creates it as the root of the mount, but `mkdir -p` is idempotent).
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

  // The workspace root is a fixed mount point inside a container we control, so
  // this is a constant — but it is still the call that guarantees the container
  // is up, which is why core makes it first in every tool.
  async rootDir(ctx: SandboxContext): Promise<string> {
    await this.ensureContainer(ctx);
    return SANDBOX_WORKSPACE_ROOT;
  }

  // argv goes straight to the daemon: there is no shell between us and the
  // process, so nothing needs quoting and no model-supplied value can be
  // reinterpreted as syntax on the way.
  async exec(
    ctx: SandboxContext,
    argv: string[],
    opts: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    // Provisioning is unbounded — an image pull, a container create — and it
    // is shared with every other caller for this Workspace, so an abort stops
    // *this* call waiting on it rather than cancelling the shared work.
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

  // `head -c` in argv form. Docker has no file-read API, and the alternative —
  // `getArchive` — would mean unpacking a tar to read one file. `head` stops
  // reading at the cap in the container, so a huge file — or an endless one
  // like /dev/zero — costs no more than the cap; core's truncation rule is
  // `>= cap`, so no byte past it is needed. The timeout bounds what `head`
  // cannot: a FIFO with no writer blocks on open forever.
  async readFile(
    ctx: SandboxContext,
    absPath: string,
    cap: number,
  ): Promise<Buffer> {
    const container = await this.ensureContainer(ctx);
    const res = await runExec(
      container,
      ["head", "-c", String(cap), "--", absPath],
      {
        workingDir: SANDBOX_WORKSPACE_ROOT,
        timeoutMs: READ_TIMEOUT_MS,
        stdoutCap: cap,
        stderrCap: MAX_SHELL_OUTPUT_BYTES,
        log: this.execLog(ctx),
      },
    );

    if (res.timedOut) {
      throw new Error(`read timed out after ${READ_TIMEOUT_MS / 1000}s`);
    }
    if (res.exitCode !== 0) {
      // The reason only: core names the tool that asked.
      throw new Error(res.stderr.toString("utf8").trim() || "read failed");
    }

    return res.stdout;
  }

  // Writes go in as a single-entry tar through `putArchive`, which takes the
  // path literally — there is no shell to quote against and no `sh -c echo >`
  // redirection to get wrong.
  async writeFile(
    ctx: SandboxContext,
    absPath: string,
    bytes: Buffer,
    mode: "create" | "overwrite",
  ): Promise<void> {
    const container = await this.ensureContainer(ctx);

    // `putArchive` overwrites unconditionally, so create-mode needs its own
    // probe. Not atomic — a file appearing between the probe and the extract
    // wins — but Docker offers nothing better, and a Sandbox is single-user.
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
    // The root is the volume mount and always exists; anything deeper may not.
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

    // Stop.
    try {
      await this.docker.getContainer(name).stop({ t: 5 });
    } catch (err) {
      if (!is404(err)) {
        // Already stopped is 304 — swallow that too.
        const e = err as { statusCode?: number };
        if (e.statusCode !== 304) {
          this.logger.warn(
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
        this.logger.warn(
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
        this.logger.warn(
          { workspaceId: ctx.workspaceId, err },
          "sandbox destroy: volume remove failed",
        );
      }
    }
  }
}

/**
 * The Docker Sandbox backend: this plugin's transport under core's fixed
 * five-tool core. What the model sees comes from {@link createPosixSandbox}, so
 * this adapter cannot drift from the SSH one on anything but the transport.
 */
export const createDockerSandboxBackend = (
  config: Partial<DockerSandboxConfig>,
  credentials: DockerSandboxCredentials,
  plugin: PluginConfigContext,
): SandboxBackend =>
  createPosixSandbox(
    new DockerSandboxTransport(config, credentials, plugin.logger),
  );
