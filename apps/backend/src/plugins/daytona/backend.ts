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
  type StreamCap,
} from "../../sandbox/transport.ts";
import type { SandboxBackend, SandboxContext } from "../../sandbox/types.ts";

const LABEL_WORKSPACE_ID = "platypus.sandbox.workspaceId";
const ROOT_DIR_NAME = "workspace";

// why: the SDK's HTTP wait outlasts our timer, so a timeout is ours and reports as exit 124
const HTTP_GRACE_MS = 5_000;

const UTILITY_EXEC: Omit<SandboxExecOptions, "signal"> = {
  timeoutMs: 30_000,
  stdoutCap: { head: 4_096 },
  stderrCap: { head: 4_096 },
};

const listEntry = z
  .string()
  .regex(/^[^,\s]+$/, { message: "must not contain a comma or whitespace" });

export const daytonaPluginConfigSchema = z
  .object({
    apiUrl: z.url().optional(),
    target: z.string().min(1).optional(),
    snapshot: z.string().min(1).optional(),
    autoStopInterval: z.number().int().min(0).default(15),
    networkBlockAll: z.boolean().optional(),
    networkAllowList: z.array(listEntry).optional(),
    domainAllowList: z.array(listEntry).optional(),
  })
  .strict();

export const daytonaPluginCredentialsSchema = z
  .object({
    apiKey: z.string().min(1),
    outboundProxyUrl: z.url().optional(),
  })
  .strict();

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
  private provisioned: Map<string, Promise<Provisioned>>;

  constructor(
    plugin: PluginConfigContext<DaytonaPluginConfig, DaytonaPluginCredentials>,
  ) {
    this.config = plugin.config;
    const { apiKey, outboundProxyUrl } = plugin.credentials;
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

    // why: Daytona's default user isn't root, so the root lives under $HOME
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
      // why: another backend process created it between our get and create
      if (err instanceof DaytonaConflictError) return this.daytona.get(name);
      throw err;
    }
  }

  async rootDir(ctx: SandboxContext): Promise<string> {
    return (await this.ensureSandbox(ctx)).rootDir;
  }

  async exec(
    ctx: SandboxContext,
    argv: string[],
    opts: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    const { sandbox } = await raceCancellation(opts.signal, () =>
      this.ensureSandbox(ctx),
    );
    return this.run(ctx, sandbox, argv, opts, opts.signal);
  }

  private async run(
    ctx: SandboxContext,
    sandbox: Sandbox,
    argv: string[],
    opts: Omit<SandboxExecOptions, "signal">,
    signal?: AbortSignal,
  ): Promise<SandboxExecResult> {
    const started = Date.now();
    const sessionId = `platypus-${randomUUID()}`;
    await raceCancellation(signal, () =>
      sandbox.process.createSession(sessionId),
    );

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), opts.timeoutMs);
    });
    try {
      const res = await raceCancellation(signal, () =>
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
      const capStream = (s: string | undefined, shape: StreamCap) => {
        const sink = createCappedSink(shape);
        sink.push(Buffer.from(s ?? "", "utf8"));
        return sink.collect();
      };
      return {
        stdout: capStream(res.stdout, opts.stdoutCap),
        stderr: capStream(res.stderr, opts.stderrCap),
        exitCode: res.exitCode,
        durationMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
      // why: deleting the session is what ends a command that timed out or was cancelled
      sandbox.process.deleteSession(sessionId).catch((err: unknown) => {
        this.logger.warn(
          { workspaceId: ctx.workspaceId, err },
          "sandbox exec: could not delete the session (its command may still be running)",
        );
      });
    }
  }

  async readFile(
    ctx: SandboxContext,
    absPath: string,
    cap: number,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const { sandbox } = await this.ensureSandbox(ctx);
    const stream = await sandbox.fs.downloadFileStream(absPath, { signal });
    const sink = createCappedSink({ head: cap });
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
    // why: uploadFile always overwrites; this probe races, but a Sandbox is single-user
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

export const createDaytonaSandboxBackend = (
  plugin: PluginConfigContext<DaytonaPluginConfig, DaytonaPluginCredentials>,
): SandboxBackend => createPosixSandbox(new DaytonaSandboxTransport(plugin));
