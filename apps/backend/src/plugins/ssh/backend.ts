import {
  Client,
  type ClientChannel,
  type ConnectConfig,
  type OpenMode,
  type SFTPWrapper,
} from "ssh2";
import { constants as osConstants } from "node:os";
import { z } from "zod";
import type {
  PluginConfigContext,
  PluginLogger,
} from "@platypuschat/plugin-sdk";
import {
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_DIAGNOSTIC_BYTES,
} from "../../sandbox/index.ts";
import { createPosixSandbox } from "../../sandbox/posix.ts";
import {
  createCappedSink,
  raceCancellation,
  SandboxCancelledError,
  SandboxPathExistsError,
  shQuote,
  toShellCommand,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxTransport,
  type StreamCap,
} from "../../sandbox/transport.ts";
import type { SandboxBackend, SandboxContext } from "../../sandbox/types.ts";

const DEFAULT_SSH_PORT = 22;
const DEFAULT_ROOT_DIR_NAME = "platypus-workspace";

const IDLE_TIMEOUT_MS = 60_000;

const LOST_EXIT_CODE = 255;

export const sshSandboxConfigSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(DEFAULT_SSH_PORT),
    user: z.string().min(1),
    rootDir: z.string().min(1).optional(),
    hostKey: z.string().min(1).optional(),
  })
  .strict();

export const sshSandboxCredentialsSchema = z
  .object({
    privateKey: z.string().min(1),
    passphrase: z.string().optional(),
  })
  .strict();

export type SshSandboxConfig = z.infer<typeof sshSandboxConfigSchema>;
export type SshSandboxCredentials = z.infer<typeof sshSandboxCredentialsSchema>;

type Connection = {
  client: Client;
  rootDir: string;
  sftp: SFTPWrapper | null;
};

function sftpStatExists(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    sftp.stat(path, (err) => resolve(!err));
  });
}

function sftpMkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (err) => (err ? reject(err) : resolve()));
  });
}

function sftpOpen(
  sftp: SFTPWrapper,
  path: string,
  flag: OpenMode,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(path, flag, (err, handle) =>
      err ? reject(err) : resolve(handle),
    );
  });
}

function sftpClose(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.close(handle, (err) => (err ? reject(err) : resolve()));
  });
}

function sftpFstatSize(sftp: SFTPWrapper, handle: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    sftp.fstat(handle, (err, stats) =>
      err ? reject(err) : resolve(stats.size),
    );
  });
}

// why: ssh2's write() splits oversized buffers into packets, so one call writes it all
function sftpWriteAll(
  sftp: SFTPWrapper,
  handle: Buffer,
  buf: Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (buf.length === 0) {
      resolve();
      return;
    }
    sftp.write(handle, buf, 0, buf.length, 0, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

async function sftpReadCapped(
  sftp: SFTPWrapper,
  handle: Buffer,
  cap: number,
): Promise<Buffer> {
  const buf = Buffer.alloc(cap);
  let total = 0;
  while (total < cap) {
    const bytesRead = await new Promise<number>((resolve, reject) => {
      sftp.read(handle, buf, total, cap - total, total, (err, n) =>
        err ? reject(err) : resolve(n),
      );
    });
    if (bytesRead <= 0) break;
    total += bytesRead;
  }
  return buf.subarray(0, total);
}

function endQuietly(client: Client): void {
  try {
    client.end();
  } catch {}
}

function signalExitCode(signalName: string | undefined): number {
  const num = signalName
    ? (osConstants.signals as Record<string, number | undefined>)[signalName]
    : undefined;
  return num === undefined ? LOST_EXIT_CODE : 128 + num;
}

function parseHostKeyPin(pin: string): Buffer {
  const firstLine = pin
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  if (!firstLine) {
    throw new Error("SSH sandbox: `hostKey` is empty or comment-only");
  }
  const tokens = firstLine.split(/\s+/);
  const blob =
    tokens.find((t) => t.startsWith("AAAA")) ??
    (tokens.length === 1 ? tokens[0] : undefined);
  if (!blob) {
    throw new Error(
      "SSH sandbox: could not find a base64 host key in `hostKey` " +
        "(expected `ssh-keyscan` output or a base64 key blob)",
    );
  }
  const decoded = Buffer.from(blob, "base64");
  if (decoded.length === 0) {
    throw new Error("SSH sandbox: `hostKey` did not decode to a valid key");
  }
  return decoded;
}

class SshSandboxTransport implements SandboxTransport {
  private config: SshSandboxConfig;
  private credentials: SshSandboxCredentials;
  private connection: Connection | null;
  private inflight: Promise<Connection> | null;
  private idleTimer: NodeJS.Timeout | null;
  private activeOps: number;
  private generation: number;
  private logger: PluginLogger;

  constructor(
    config: SshSandboxConfig,
    credentials: SshSandboxCredentials,
    logger: PluginLogger,
  ) {
    this.config = config;
    this.credentials = credentials;
    this.connection = null;
    this.inflight = null;
    this.idleTimer = null;
    this.activeOps = 0;
    this.generation = 0;
    this.logger = logger;
  }

  private ensureConnection(): Promise<Connection> {
    if (this.connection) return Promise.resolve(this.connection);
    if (this.inflight) return this.inflight;

    const generation = this.generation;
    const p = this.connect()
      .then((conn) => {
        this.inflight = null;
        if (generation !== this.generation) {
          endQuietly(conn.client);
          throw new Error(
            "SSH sandbox: the connection was closed while it was being opened",
          );
        }
        this.connection = conn;
        return conn;
      })
      .catch((err) => {
        this.inflight = null;
        throw err;
      });
    this.inflight = p;
    return p;
  }

  private async connect(): Promise<Connection> {
    const { host, port, user, hostKey } = this.config;
    const { privateKey, passphrase } = this.credentials;

    const expectedHostKey = hostKey ? parseHostKeyPin(hostKey) : null;
    if (!expectedHostKey) {
      this.logger.warn(
        { host, port },
        "SSH sandbox connecting WITHOUT host-key verification — session and injected env are exposed to a MITM. Set `hostKey` to pin the host.",
      );
    }

    const client = new Client();
    const connectConfig: ConnectConfig = {
      host,
      port,
      username: user,
      privateKey,
      ...(passphrase ? { passphrase } : {}),
    };

    let hostKeyMismatch = false;
    if (expectedHostKey) {
      const expected = expectedHostKey;
      connectConfig.hostVerifier = (presented: Buffer): boolean => {
        const match = presented.equals(expected);
        if (!match) hostKeyMismatch = true;
        return match;
      };
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        client.removeListener("ready", onReady);
        if (hostKeyMismatch) {
          reject(
            new Error(
              `SSH sandbox: host-key verification failed for ${host}:${port} — the presented host key does not match the pinned \`hostKey\`. Refusing to connect.`,
              { cause: err },
            ),
          );
          return;
        }
        reject(err);
      };
      const onReady = () => {
        client.removeListener("error", onError);
        client.on("error", (err: Error) => {
          this.logger.warn(
            { host, port, err },
            "SSH sandbox connection error; dropping the connection",
          );
          this.dropConnection(client);
        });
        client.on("close", () => this.dropConnection(client));
        client.on("end", () => this.dropConnection(client));
        resolve();
      };
      client.once("ready", onReady);
      client.once("error", onError);
      client.connect(connectConfig);
    });

    const rootExpr = this.config.rootDir
      ? shQuote(this.config.rootDir)
      : `"$HOME/${DEFAULT_ROOT_DIR_NAME}"`;
    const resolveCmd =
      `ROOT=${rootExpr}; ` +
      `case "$ROOT" in /*) ;; *) ROOT="$HOME/$ROOT" ;; esac; ` +
      `mkdir -p "$ROOT" && printf %s "$ROOT"`;

    const res = await this.runExec(
      client,
      resolveCmd,
      DEFAULT_SHELL_TIMEOUT_MS,
      { head: MAX_DIAGNOSTIC_BYTES },
      { head: MAX_DIAGNOSTIC_BYTES },
    );
    if (res.exitCode !== 0) {
      const detail = res.stderr.toString("utf8").trim() || "unknown error";
      endQuietly(client);
      throw new Error(
        `SSH sandbox: failed to create workspace root on ${host}: ${detail}`,
      );
    }
    const rootDir = res.stdout.toString("utf8").trim();

    return { client, rootDir, sftp: null };
  }

  private touchIdleTimer(): void {
    this.clearIdleTimer();
    if (this.activeOps > 0 || !this.connection) return;
    this.idleTimer = setTimeout(() => {
      this.closeConnection();
    }, IDLE_TIMEOUT_MS);
    this.idleTimer.unref();
  }

  private async withConnection<T>(
    fn: (conn: Connection) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.activeOps += 1;
    this.clearIdleTimer();
    try {
      const conn = signal
        ? await raceCancellation(signal, () => this.ensureConnection())
        : await this.ensureConnection();
      return await fn(conn);
    } finally {
      this.activeOps -= 1;
      this.touchIdleTimer();
    }
  }

  private dropConnection(client: Client): void {
    if (this.connection?.client !== client) return;
    this.connection = null;
    this.clearIdleTimer();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private closeConnection(): void {
    this.generation += 1;
    this.clearIdleTimer();
    const conn = this.connection;
    this.connection = null;
    if (conn) endQuietly(conn.client);
  }

  private runExec(
    client: Client,
    command: string,
    timeoutMs: number,
    stdoutCap: StreamCap,
    stderrCap: StreamCap,
    signal?: AbortSignal,
  ): Promise<SandboxExecResult> {
    return new Promise<SandboxExecResult>((resolve, reject) => {
      const started = Date.now();
      let settled = false;
      let cancelled = false;
      let stream: ClientChannel | undefined;

      const onAbort = () => {
        cancelled = true;
        if (!stream) {
          settle(() => reject(new SandboxCancelledError()));
          return;
        }
        try {
          stream.close();
        } catch {}
      };
      const settle = (act: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        act();
      };

      if (signal?.aborted) {
        reject(new SandboxCancelledError());
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      client.exec(command, (err: Error | undefined, channel: ClientChannel) => {
        if (err) {
          settle(() => reject(err));
          return;
        }
        stream = channel;
        if (cancelled) {
          try {
            channel.close();
          } catch {}
        }

        const stdoutSink = createCappedSink(stdoutCap);
        const stderrSink = createCappedSink(stderrCap);
        let exitCode: number | null = null;
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          try {
            channel.close();
          } catch {}
        }, timeoutMs);
        timer.unref();

        channel.on("data", (chunk: Buffer) => stdoutSink.push(chunk));
        channel.stderr.on("data", (chunk: Buffer) => stderrSink.push(chunk));
        channel.on("exit", (code: number | null, signalName?: string) => {
          exitCode =
            typeof code === "number" ? code : signalExitCode(signalName);
        });
        channel.on("close", () => {
          clearTimeout(timer);
          settle(() =>
            cancelled
              ? reject(new SandboxCancelledError())
              : resolve({
                  stdout: stdoutSink.collect(),
                  stderr: stderrSink.collect(),
                  exitCode: timedOut ? 124 : (exitCode ?? LOST_EXIT_CODE),
                  durationMs: Date.now() - started,
                }),
          );
        });
        channel.on("error", (streamErr: Error) => {
          clearTimeout(timer);
          settle(() => reject(streamErr));
        });
      });
    });
  }

  rootDir(_ctx: SandboxContext): Promise<string> {
    return this.withConnection((conn) => Promise.resolve(conn.rootDir));
  }

  async exec(
    _ctx: SandboxContext,
    argv: string[],
    opts: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    const command = toShellCommand(argv, opts);

    // why: a reconnect is unbounded and precedes the command timer, so the signal races it too
    return this.withConnection(
      (conn) =>
        this.runExec(
          conn.client,
          command,
          opts.timeoutMs,
          opts.stdoutCap,
          opts.stderrCap,
          opts.signal,
        ),
      opts.signal,
    );
  }

  async readFile(
    _ctx: SandboxContext,
    absPath: string,
    cap: number,
  ): Promise<Buffer> {
    return this.withConnection(async (conn) => {
      const sftp = await this.getSftp(conn);

      const handle = await sftpOpen(sftp, absPath, "r");
      try {
        const size = await sftpFstatSize(sftp, handle);
        return await sftpReadCapped(sftp, handle, Math.min(size, cap));
      } finally {
        await sftpClose(sftp, handle);
      }
    });
  }

  async writeFile(
    _ctx: SandboxContext,
    absPath: string,
    bytes: Buffer,
    mode: "create" | "overwrite",
  ): Promise<void> {
    return this.withConnection(async (conn) => {
      const sftp = await this.getSftp(conn);

      await this.ensureParentDirs(sftp, conn.rootDir, absPath);

      let handle: Buffer;
      try {
        handle = await sftpOpen(sftp, absPath, mode === "create" ? "wx" : "w");
      } catch (cause) {
        if (mode === "create" && (await sftpStatExists(sftp, absPath))) {
          throw new SandboxPathExistsError(absPath, { cause });
        }
        throw cause;
      }

      try {
        await sftpWriteAll(sftp, handle, bytes);
      } finally {
        await sftpClose(sftp, handle);
      }
    });
  }

  private getSftp(conn: Connection): Promise<SFTPWrapper> {
    if (conn.sftp) return Promise.resolve(conn.sftp);
    return new Promise<SFTPWrapper>((resolve, reject) => {
      conn.client.sftp((err, sftp) => {
        if (err) {
          reject(err);
          return;
        }
        conn.sftp = sftp;
        resolve(sftp);
      });
    });
  }

  private async ensureParentDirs(
    sftp: SFTPWrapper,
    rootDir: string,
    absPath: string,
  ): Promise<void> {
    const idx = absPath.lastIndexOf("/");
    if (idx === -1) return;
    const parent = absPath.slice(0, idx);
    // why: never mkdir at or above rootDir; the host's tree outside it isn't ours
    if (!parent.startsWith(`${rootDir}/`)) return;

    const segments = parent
      .slice(rootDir.length + 1)
      .split("/")
      .filter((s) => s.length > 0);
    let dir = rootDir;
    for (const seg of segments) {
      dir = `${dir}/${seg}`;
      if (!(await sftpStatExists(sftp, dir))) {
        await sftpMkdir(sftp, dir);
      }
    }
  }

  destroy(_ctx: SandboxContext): Promise<void> {
    return this.close();
  }

  close(): Promise<void> {
    this.closeConnection();
    return Promise.resolve();
  }
}

export const createSshSandboxBackend = (
  config: SshSandboxConfig,
  credentials: SshSandboxCredentials,
  plugin: PluginConfigContext,
): SandboxBackend =>
  createPosixSandbox(
    new SshSandboxTransport(config, credentials, plugin.logger),
  );
