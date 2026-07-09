import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import { z } from "zod";
import { logger } from "../../logger.ts";
import {
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_SHELL_OUTPUT_BYTES,
  MAX_SHELL_TIMEOUT_MS,
} from "../../sandbox/index.ts";
import type {
  FsEditInput,
  FsEditOutput,
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
} from "../../sandbox/types.ts";

// The SSH reference Sandbox adapter (ADR-0012). Attaches to a pre-existing,
// operator-owned host over SSH (public-key auth only) and runs the fixed tool
// core against it — this slice carries only `shell.exec`; the `fs.*` tools land
// in follow-up slices. The adapter never provisions or destroys the machine.

const DEFAULT_SSH_PORT = 22;
// rootDir default (ADR-0012): resolved to `$HOME/platypus-workspace` on the host
// at connect time. SFTP does not expand `~`, so $HOME is resolved once per
// connection and the physical root is absolute.
const DEFAULT_ROOT_DIR_NAME = "platypus-workspace";

// Self-managed connection lifecycle (ADR-0012): a single connection is reused
// across all tool calls within a Chat turn and closed by this idle reaper after
// inactivity. The timer is `unref()`'d so it never keeps the process alive.
const IDLE_TIMEOUT_MS = 60_000;

// Per-Workspace Sandbox config/credentials (ADR-0001/0006). These remain
// per-Workspace settings — ADR-0013's deploy-time *plugin* config does not apply
// here. Every field except a hypothetical display name is admin-only (ADR-0006);
// the route enforces that gating, so no per-field logic is needed here.
export const sshSandboxConfigSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(DEFAULT_SSH_PORT),
    user: z.string().min(1),
    // Optional; defaults to `$HOME/platypus-workspace`, resolved on connect. A
    // relative value is resolved against the login `$HOME`; an absolute value is
    // used verbatim.
    rootDir: z.string().min(1).optional(),
    // Accepted now for forward-compatibility; strict host-key verification is a
    // follow-up slice (ADR-0012). This slice connects with a loud MITM warning
    // when it is absent — the shipped fallback.
    hostKey: z.string().min(1).optional(),
  })
  .strict();

// Public-key auth only (ADR-0012). `privateKey` is a PEM/OpenSSH private key;
// `passphrase` decrypts it when it is encrypted. Both are server-side secrets,
// never returned to non-admins or the model.
export const sshSandboxCredentialsSchema = z
  .object({
    privateKey: z.string().min(1),
    passphrase: z.string().optional(),
  })
  .strict();

export type SshSandboxConfig = z.infer<typeof sshSandboxConfigSchema>;
export type SshSandboxCredentials = z.infer<typeof sshSandboxCredentialsSchema>;

// A live, ready connection plus the absolute workspace root resolved on it.
type Connection = {
  client: Client;
  rootDir: string;
};

type ExecResult = {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
};

// Single-quote a value for safe interpolation into a `/bin/sh` command line.
// Wraps in single quotes and escapes embedded single quotes with the classic
// `'\''` idiom. Used for the operator-supplied rootDir and for model-supplied
// cwd/env values so neither can break out into shell syntax.
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// A valid POSIX environment-variable name. `adminEnv`/`userEnv` are already held
// to this by the schema, but the model-supplied `input.env` keys are not — so we
// guard here before interpolating a key into the shell string. A key that isn't
// a valid identifier can't be a usable env var anyway (`export 1FOO=…` errors),
// so dropping it is both safe and correct.
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Build the `export KEY=val;` prefix for the merged env (ADR-0004). Applied via
// export statements rather than the ssh2 `env` option, since sshd's `AcceptEnv`
// rejects arbitrary variables by default (ADR-0012). Keys are guarded to POSIX
// identifiers (above) so they can't inject shell syntax; values are single-quoted.
function buildEnvPrefix(env: Record<string, string> | undefined): string {
  if (!env) return "";
  return Object.entries(env)
    .filter(([k]) => ENV_KEY_PATTERN.test(k))
    .map(([k, v]) => `export ${k}=${shQuote(v)}; `)
    .join("");
}

// A method not carried by this slice. `fs.*` land in follow-up slices (ADR-0012);
// until then they fail loudly rather than silently misbehaving. The Sandbox tool
// set still exposes all five tools (there is no per-backend tool filtering), so a
// model that calls one gets this error as its tool result.
function notImplemented(tool: string): Promise<never> {
  return Promise.reject(
    new Error(
      `${tool} is not yet supported by the SSH sandbox backend (follow-up slice); only shell.exec is available.`,
    ),
  );
}

export class SshSandboxBackend implements SandboxBackend {
  private config: SshSandboxConfig;
  private credentials: SshSandboxCredentials;
  // Single reused connection and its in-flight promise (mirrors the Docker
  // adapter's ensureContainer): concurrent first-callers share one connect.
  private connection: Connection | null;
  private inflight: Promise<Connection> | null;
  private idleTimer: NodeJS.Timeout | null;

  constructor(config: SshSandboxConfig, credentials: SshSandboxCredentials) {
    this.config = config;
    this.credentials = credentials;
    this.connection = null;
    this.inflight = null;
    this.idleTimer = null;
  }

  // Lazy-connect on first use; reuse the single connection across all tool calls
  // in the turn. Concurrent callers before the connection is ready share the one
  // in-flight promise. Every call refreshes the idle reaper.
  private ensureConnection(): Promise<Connection> {
    if (this.connection) {
      this.touchIdleTimer();
      return Promise.resolve(this.connection);
    }
    if (this.inflight) return this.inflight;

    const p = this.connect()
      .then((conn) => {
        this.connection = conn;
        this.inflight = null;
        this.touchIdleTimer();
        return conn;
      })
      .catch((err) => {
        this.inflight = null;
        throw err;
      });
    this.inflight = p;
    return p;
  }

  // Open the SSH connection (public-key auth), then resolve $HOME and `mkdir -p`
  // the workspace root in a single exec, returning the absolute root.
  private async connect(): Promise<Connection> {
    const { host, port, user, hostKey } = this.config;
    const { privateKey, passphrase } = this.credentials;

    if (!hostKey) {
      // Shipped fallback for this slice (ADR-0012): connect without host-key
      // verification and warn loudly. Public-key auth still prevents credential
      // theft by an impostor host; the residual risk is session/output exposure
      // to a MITM. Pin `hostKey` on internet-facing hosts.
      logger.warn(
        { host, port },
        "SSH sandbox connecting WITHOUT host-key verification — session and injected env are exposed to a MITM. Set `hostKey` to pin the host.",
      );
    } else {
      // hostKey is accepted but strict verification is not wired yet — a
      // follow-up slice. Be explicit so an operator who pinned a key is not
      // misled into thinking it is enforced.
      logger.warn(
        { host, port },
        "SSH sandbox `hostKey` is set but strict verification is not yet enforced (follow-up slice); connecting without pinning.",
      );
    }

    const client = new Client();
    const connectConfig: ConnectConfig = {
      host,
      port: port ?? DEFAULT_SSH_PORT,
      username: user,
      privateKey,
      ...(passphrase ? { passphrase } : {}),
    };

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        client.removeListener("ready", onReady);
        reject(err);
      };
      const onReady = () => {
        client.removeListener("error", onError);
        resolve();
      };
      client.once("ready", onReady);
      client.once("error", onError);
      client.connect(connectConfig);
    });

    // Resolve $HOME and create the root in one round-trip. A relative rootDir is
    // resolved against $HOME; an absolute one is used verbatim. The command
    // prints the resolved absolute path on stdout.
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
    );
    if (res.exitCode !== 0) {
      const detail = res.stderr.toString("utf8").trim() || "unknown error";
      try {
        client.end();
      } catch {
        // ignore
      }
      throw new Error(
        `SSH sandbox: failed to create workspace root on ${host}: ${detail}`,
      );
    }
    const rootDir = res.stdout.toString("utf8").trim();

    return { client, rootDir };
  }

  // (Re)arm the idle reaper. Closes the connection after IDLE_TIMEOUT_MS of
  // inactivity. `unref()` so a pending timer never keeps the process alive.
  private touchIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.closeConnection();
    }, IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }

  // Close the connection (if any) and cancel the idle reaper. Idempotent.
  private closeConnection(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const conn = this.connection;
    this.connection = null;
    if (conn) {
      try {
        conn.client.end();
      } catch {
        // best-effort — the connection may already be gone
      }
    }
  }

  // Run a single command over `exec`, capping stdout/stderr at
  // MAX_SHELL_OUTPUT_BYTES and enforcing a timeout. On timeout the channel is
  // closed and exit code 124 is reported (a remote command may keep running as
  // an orphan — the host is not ours to reap; ADR-0012).
  private runExec(
    client: Client,
    command: string,
    timeoutMs: number,
  ): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      const started = Date.now();
      client.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          reject(err);
          return;
        }

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let exitCode = 0;
        let timedOut = false;
        let settled = false;

        const timer = setTimeout(() => {
          timedOut = true;
          try {
            stream.close();
          } catch {
            // ignore — resolve on the close event regardless
          }
        }, timeoutMs);
        timer.unref?.();

        const capture = (
          chunk: Buffer,
          chunks: Buffer[],
          bytes: number,
        ): number => {
          if (bytes >= MAX_SHELL_OUTPUT_BYTES) return bytes;
          const room = MAX_SHELL_OUTPUT_BYTES - bytes;
          const take = chunk.length <= room ? chunk : chunk.subarray(0, room);
          chunks.push(take);
          return bytes + take.length;
        };

        stream.on("data", (chunk: Buffer) => {
          stdoutBytes = capture(chunk, stdoutChunks, stdoutBytes);
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          stderrBytes = capture(chunk, stderrChunks, stderrBytes);
        });
        // The exit code arrives on `exit`; `close` fires afterwards and is when
        // we settle. A signal-killed process reports a null code.
        stream.on("exit", (code: number | null) => {
          if (typeof code === "number") exitCode = code;
        });
        stream.on("close", () => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          resolve({
            stdout: Buffer.concat(stdoutChunks),
            stderr: Buffer.concat(stderrChunks),
            exitCode: timedOut ? 124 : exitCode,
            durationMs: Date.now() - started,
            timedOut,
          });
        });
        stream.on("error", (streamErr: Error) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          reject(streamErr);
        });
      });
    });
  }

  async shellExec(
    _ctx: SandboxContext,
    input: ShellExecInput,
  ): Promise<ShellExecOutput> {
    const conn = await this.ensureConnection();
    const timeoutMs = Math.min(
      input.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
      MAX_SHELL_TIMEOUT_MS,
    );

    // Honour cwd by prefixing `cd <rootDir>/<cwd> && …` (no native WorkingDir
    // over SSH). cwd is model input (schema-validated relative); rootDir is
    // resolved-absolute. Both are single-quoted so neither escapes into shell
    // syntax. The merged env (ADR-0004) is applied via `export` statements.
    const cwd = input.cwd ? `${conn.rootDir}/${input.cwd}` : conn.rootDir;
    const envPrefix = buildEnvPrefix(input.env);
    const command = `cd ${shQuote(cwd)} && ${envPrefix}${input.command}`;

    const res = await this.runExec(conn.client, command, timeoutMs);
    this.touchIdleTimer();

    const truncated =
      res.stdout.length >= MAX_SHELL_OUTPUT_BYTES ||
      res.stderr.length >= MAX_SHELL_OUTPUT_BYTES;

    return {
      stdout: res.stdout.toString("utf8"),
      stderr: res.stderr.toString("utf8"),
      exitCode: res.exitCode,
      truncated,
      durationMs: res.durationMs,
    };
  }

  // fs.* are deferred to follow-up slices (ADR-0012). They will use SFTP for
  // read/write/edit and `find -printf` for list.
  fsRead(_ctx: SandboxContext, _input: FsReadInput): Promise<FsReadOutput> {
    return notImplemented("fs.read");
  }

  fsWrite(_ctx: SandboxContext, _input: FsWriteInput): Promise<FsWriteOutput> {
    return notImplemented("fs.write");
  }

  fsEdit(_ctx: SandboxContext, _input: FsEditInput): Promise<FsEditOutput> {
    return notImplemented("fs.edit");
  }

  fsList(_ctx: SandboxContext, _input: FsListInput): Promise<FsListOutput> {
    return notImplemented("fs.list");
  }

  // destroy() is a no-op beyond disconnecting (ADR-0012): the host is not
  // Platypus-owned, so we never mutate its filesystem. Just tear down our
  // connection so no socket or idle timer leaks.
  destroy(_ctx: SandboxContext): Promise<void> {
    this.closeConnection();
    return Promise.resolve();
  }
}
