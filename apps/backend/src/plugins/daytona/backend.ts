import {
  Daytona,
  DaytonaConflictError,
  DaytonaNotFoundError,
  SandboxState,
  type Sandbox,
} from "@daytonaio/sdk";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import type {
  PluginConfigContext,
  PluginLogger,
} from "@platypuschat/plugin-sdk";
import { createPosixSandbox } from "../../sandbox/posix.ts";
import {
  createCappedSink,
  raceCancellation,
  SandboxPathExistsError,
  toShellCommand,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxTransport,
} from "../../sandbox/transport.ts";
import type { SandboxBackend, SandboxContext } from "../../sandbox/types.ts";

// The Daytona Sandbox adapter. Provisions one Daytona sandbox per Workspace,
// found again by a deterministic name, and supplies the transport core builds
// the fixed tool core on. Commands run in a throwaway toolbox session (which
// keeps stdout and stderr apart, unlike `executeCommand`); files move over the
// toolbox file API.
//
// Platypus owns the sandbox: `destroy()` deletes it, as the Docker adapter
// removes its container and volume. Between turns Daytona's own auto-stop parks
// it, and the next tool call starts it again.

const LABEL_WORKSPACE_ID = "platypus.sandbox.workspaceId";
const ROOT_DIR_NAME = "workspace";

// The HTTP wait on a command outlives its own timeout by this much, so our
// timer — not the SDK's — decides a timeout and reports it as exit 124.
const HTTP_GRACE_MS = 5_000;

// The adapter's own housekeeping commands (root and parent-directory setup).
const UTILITY_EXEC: SandboxExecOptions = {
  timeoutMs: 30_000,
  stdoutCap: 4_096,
  stderrCap: 4_096,
};

const listEntry = z
  .string()
  .regex(/^[^,\s]+$/, { message: "must not contain a comma or whitespace" });

// Plugin-level, Operator-owned config for @platypus/daytona (ADR-0013),
// supplied via PLATYPUS_PLUGIN_CONFIG_DAYTONA and validated at boot. One
// Daytona account serves every Workspace in the deployment.
export const daytonaPluginConfigSchema = z
  .object({
    // Self-hosted Daytona, or a non-default region endpoint.
    apiUrl: z.string().url().optional(),
    // Daytona region, e.g. "us" or "eu". The account default when unset.
    target: z.string().min(1).optional(),
    // Snapshot new sandboxes are created from. Daytona's default when unset.
    snapshot: z.string().min(1).optional(),
    // Minutes idle before Daytona stops a sandbox; 0 disables.
    autoStopInterval: z.number().int().min(0).default(15),
    // Network egress for new sandboxes, passed through to Daytona. Daytona
    // takes the allowlists comma-joined, so an entry may not hold one.
    networkBlockAll: z.boolean().optional(),
    networkAllowList: z.array(listEntry).optional(),
    domainAllowList: z.array(listEntry).optional(),
  })
  .strict();

export const daytonaPluginCredentialsSchema = z
  .object({
    apiKey: z.string().min(1),
    // Routes sandbox HTTP(S) egress through this proxy. A credential because
    // the URL may embed the proxy's own username and password.
    outboundProxyUrl: z.string().url().optional(),
  })
  .strict();

// No per-Workspace settings: the deploy-time block above is the whole surface.
export const daytonaSandboxConfigSchema = z.object({}).strict();
export const daytonaSandboxCredentialsSchema = z.object({}).strict();

export type DaytonaPluginConfig = z.infer<typeof daytonaPluginConfigSchema>;
export type DaytonaPluginCredentials = z.infer<
  typeof daytonaPluginCredentialsSchema
>;
export type DaytonaSandboxConfig = z.infer<typeof daytonaSandboxConfigSchema>;
export type DaytonaSandboxCredentials = z.infer<
  typeof daytonaSandboxCredentialsSchema
>;

const sandboxName = (ctx: SandboxContext): string =>
  `platypus-${ctx.orgId}-${ctx.workspaceId}`;

type Provisioned = { sandbox: Sandbox; rootDir: string };

class DaytonaSandboxTransport implements SandboxTransport {
  private daytona: Daytona;
  private config: DaytonaPluginConfig;
  private outboundProxyUrl: string | undefined;
  private logger: PluginLogger;
  // Per backend instance — one Chat turn — so a sandbox is looked up once per
  // turn, and concurrent first calls share the one lookup.
  private provisioned: Map<string, Promise<Provisioned>>;

  constructor(plugin: PluginConfigContext) {
    this.config = daytonaPluginConfigSchema.parse(plugin.config ?? {});
    const { apiKey, outboundProxyUrl } = daytonaPluginCredentialsSchema.parse(
      plugin.credentials,
    );
    this.outboundProxyUrl = outboundProxyUrl;
    this.daytona = new Daytona({
      apiKey,
      apiUrl: this.config.apiUrl,
      target: this.config.target,
    });
    this.logger = plugin.logger;
    this.provisioned = new Map();
  }

  private ensureSandbox(ctx: SandboxContext): Promise<Provisioned> {
    let p = this.provisioned.get(ctx.workspaceId);
    if (!p) {
      p = this.provision(ctx);
      // A failed lookup is not cached, so the next tool call tries again.
      p.catch(() => this.provisioned.delete(ctx.workspaceId));
      this.provisioned.set(ctx.workspaceId, p);
    }
    return p;
  }

  private async provision(ctx: SandboxContext): Promise<Provisioned> {
    const sandbox = await this.findOrCreate(ctx);
    if (sandbox.state === SandboxState.STARTING) {
      await sandbox.waitUntilStarted();
    } else if (sandbox.state !== SandboxState.STARTED) {
      await sandbox.start();
    }

    // The default Daytona user is not root, so the workspace root lives under
    // its home rather than at SANDBOX_WORKSPACE_ROOT. The model only ever sees
    // relative paths, so the physical root is free.
    const res = await this.run(
      ctx,
      sandbox,
      [
        "sh",
        "-c",
        `mkdir -p "$HOME/${ROOT_DIR_NAME}" && cd "$HOME/${ROOT_DIR_NAME}" && pwd`,
      ],
      UTILITY_EXEC,
    );
    if (res.exitCode !== 0) {
      throw new Error(
        `could not create the workspace root: ${res.stderr.toString("utf8")}`,
      );
    }
    return { sandbox, rootDir: res.stdout.toString("utf8").trim() };
  }

  private async findOrCreate(ctx: SandboxContext): Promise<Sandbox> {
    const name = sandboxName(ctx);
    try {
      return await this.daytona.get(name);
    } catch (err) {
      if (!(err instanceof DaytonaNotFoundError)) throw err;
    }
    try {
      return await this.daytona.create({
        name,
        snapshot: this.config.snapshot,
        labels: { [LABEL_WORKSPACE_ID]: ctx.workspaceId },
        autoStopInterval: this.config.autoStopInterval,
        networkBlockAll: this.config.networkBlockAll,
        networkAllowList: this.config.networkAllowList?.join(","),
        domainAllowList: this.config.domainAllowList?.join(","),
        outboundProxyUrl: this.outboundProxyUrl,
      });
    } catch (err) {
      // Another backend process created it first.
      if (err instanceof DaytonaConflictError) return this.daytona.get(name);
      throw err;
    }
  }

  async rootDir(ctx: SandboxContext): Promise<string> {
    return (await this.ensureSandbox(ctx)).rootDir;
  }

  // Each command gets its own session, deleted afterwards: nothing it does to
  // shell state leaks into the next, and deleting the session is what ends a
  // command that timed out or was cancelled.
  async exec(
    ctx: SandboxContext,
    argv: string[],
    opts: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    const { sandbox } = await raceCancellation(opts.signal, () =>
      this.ensureSandbox(ctx),
    );
    return this.run(ctx, sandbox, argv, opts);
  }

  private async run(
    ctx: SandboxContext,
    sandbox: Sandbox,
    argv: string[],
    opts: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    const started = Date.now();
    const sessionId = `platypus-${randomUUID()}`;
    await raceCancellation(opts.signal, () =>
      sandbox.process.createSession(sessionId),
    );

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), opts.timeoutMs);
    });
    try {
      const res = await raceCancellation(opts.signal, () =>
        Promise.race([
          sandbox.process.executeSessionCommand(
            sessionId,
            { command: toShellCommand(argv, opts) },
            Math.ceil((opts.timeoutMs + HTTP_GRACE_MS) / 1000),
          ),
          timedOut,
        ]),
      );
      if (!res) {
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: 124,
          durationMs: Date.now() - started,
        };
      }
      if (typeof res.exitCode !== "number") {
        throw new Error("Daytona did not report the command's exit status");
      }
      const cap = (s: string | undefined, n: number) => {
        const sink = createCappedSink(n);
        sink.push(Buffer.from(s ?? "", "utf8"));
        return sink.collect();
      };
      return {
        stdout: cap(res.stdout, opts.stdoutCap),
        stderr: cap(res.stderr, opts.stderrCap),
        exitCode: res.exitCode,
        durationMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
      // Not awaited: the caller has its answer, and a leaked session is only
      // an idle shell until Daytona stops the sandbox.
      sandbox.process.deleteSession(sessionId).catch((err: unknown) => {
        this.logger.warn(
          { workspaceId: ctx.workspaceId, err },
          "sandbox exec: could not delete the session (its command may still be running)",
        );
      });
    }
  }

  // Streamed so only `cap` bytes are ever pulled, however large the file.
  async readFile(
    ctx: SandboxContext,
    absPath: string,
    cap: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const { sandbox } = await this.ensureSandbox(ctx);
    const stream = await sandbox.fs.downloadFileStream(absPath, { signal });
    const sink = createCappedSink(cap);
    let bytes = 0;
    try {
      for await (const chunk of stream) {
        sink.push(chunk as Buffer);
        bytes += (chunk as Buffer).length;
        if (bytes >= cap) break;
      }
    } finally {
      stream.destroy();
    }
    return sink.collect();
  }

  async writeFile(
    ctx: SandboxContext,
    absPath: string,
    bytes: Buffer,
    mode: "create" | "overwrite",
  ): Promise<void> {
    const { sandbox } = await this.ensureSandbox(ctx);
    // The upload overwrites unconditionally, so create-mode probes first. Not
    // atomic, as with Docker, but a Sandbox is single-user.
    const res = await this.run(
      ctx,
      sandbox,
      [
        "sh",
        "-c",
        'if [ "$1" = create ] && [ -e "$2" ]; then exit 17; fi; mkdir -p "$3"',
        "sh",
        mode,
        absPath,
        dirname(absPath),
      ],
      UTILITY_EXEC,
    );
    if (res.exitCode === 17) throw new SandboxPathExistsError(absPath);
    if (res.exitCode !== 0) {
      throw new Error(
        `failed to create parent directory: ${res.stderr.toString("utf8")}`,
      );
    }
    await sandbox.fs.uploadFile(bytes, absPath);
  }

  async destroy(ctx: SandboxContext): Promise<void> {
    this.provisioned.delete(ctx.workspaceId);
    try {
      await (await this.daytona.get(sandboxName(ctx))).delete();
    } catch (err) {
      if (!(err instanceof DaytonaNotFoundError)) throw err;
    }
  }
}

/**
 * The Daytona Sandbox backend: this plugin's transport under core's fixed
 * five-tool core.
 */
export const createDaytonaSandboxBackend = (
  plugin: PluginConfigContext,
): SandboxBackend => createPosixSandbox(new DaytonaSandboxTransport(plugin));
