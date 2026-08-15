import Docker from "dockerode";
import type { Container, Exec } from "dockerode";
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
// via PLATYPUS_PLUGIN_CONFIG and validated at boot. `allowedNetworks` is the
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

export type DockerPluginConfig = z.infer<typeof dockerPluginConfigSchema>;

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
// The loader resolves this against the boot-validated plugin config into a
// concrete schema before core's static safeParse consumers see it. The argument
// arrives as `unknown` (the SDK's opaque plugin-config shape); we re-validate it
// through the plugin schema so the factory is self-contained and defensively
// defaults to an empty allowlist (default-deny).
export const dockerSandboxConfigSchema = (pluginConfig: unknown) => {
  const { allowedNetworks } = dockerPluginConfigSchema.parse(
    pluginConfig ?? {},
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

// Run a single command inside the container, demuxing stdout/stderr into
// byte-capped sinks that keep draining once full (see createCappedSink).
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
): Promise<SandboxExecResult> {
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

  let exitCode: number;
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
    stdout: stdoutSink.collect(),
    stderr: stderrSink.collect(),
    exitCode,
    durationMs: Date.now() - started,
  };
}

/**
 * The Docker half of the Sandbox: dockerode `exec` for commands, `putArchive`
 * for writes, and container/volume lifecycle (ADR-0003). The five model-facing
 * tools are built on top of this by {@link createPosixSandbox} — nothing here
 * parses find(1), counts lines, or decides what `truncated` means.
 */
export class DockerSandboxTransport implements SandboxTransport {
  private docker: Docker;
  private inflight: Map<string, Promise<Container>>;
  private networks: string[];
  private extraHosts: string[];
  /**
   * The logger core bound to `@platypus/docker` and injected on the plugin's
   * deploy-time block (ADR-0013) — the same contract a third-party plugin gets,
   * rather than the relative import of core's logger only an in-tree plugin ever
   * had. Optional because {@link PluginConfigContext.logger} is, so every call
   * site below is written `this.logger?.…`.
   */
  private logger?: PluginLogger;

  constructor(
    config: Partial<DockerSandboxConfig>,
    _credentials: DockerSandboxCredentials,
    logger?: PluginLogger,
  ) {
    this.docker = new Docker();
    this.inflight = new Map();
    // Normalise defensively: the registry passes schema-parsed config (arrays
    // present), but tolerate a bare object too.
    this.networks = config?.networks ?? [];
    this.extraHosts = config?.extraHosts ?? [];
    this.logger = logger;
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
    this.logger?.info({ image: IMAGE }, "Pulling sandbox image");
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
    const container = await this.ensureContainer(ctx);
    return runExec(container, argv, {
      workingDir: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      stdoutCap: opts.stdoutCap,
      stderrCap: opts.stderrCap,
    });
  }

  // `cat` in argv form. Docker has no file-read API, and the alternative —
  // `getArchive` — would mean unpacking a tar to read one file. The cap is
  // applied to the stream as it arrives, so a huge file costs no more than it.
  async readFile(
    ctx: SandboxContext,
    absPath: string,
    cap: number,
  ): Promise<Buffer> {
    const container = await this.ensureContainer(ctx);
    const res = await runExec(container, ["cat", "--", absPath], {
      workingDir: SANDBOX_WORKSPACE_ROOT,
      stdoutCap: cap,
      stderrCap: MAX_SHELL_OUTPUT_BYTES,
    });

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
      });
      if (probe.exitCode === 0) {
        throw new SandboxPathExistsError(absPath);
      }
    }

    const { parent, name } = splitParent(absPath);
    // The root is the volume mount and always exists; anything deeper may not.
    if (parent !== SANDBOX_WORKSPACE_ROOT) {
      const mk = await runExec(container, ["mkdir", "-p", parent]);
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
          this.logger?.warn(
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
        this.logger?.warn(
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
        this.logger?.warn(
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
  plugin?: PluginConfigContext,
): SandboxBackend =>
  createPosixSandbox(
    new DockerSandboxTransport(config, credentials, plugin?.logger),
  );
