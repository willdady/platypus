import { raceAbort } from "../utils/abort-race.ts";
import type { SandboxContext } from "./types.ts";

// The seam beneath a Sandbox adapter (ADR-0002/0003/0012).
//
// A `SandboxBackend` is the five model-facing tools plus every Platypus-defined
// bound they must honour. Almost none of that is adapter business: the find(1)
// output parser, the unique-`oldString` rule, strict UTF-8 decoding, line
// counting, the truncation convention and the timeout clamp are the *contract*,
// and two adapters implementing them separately means two chances to drift and
// two places to fix a bug. What genuinely differs between Docker and SSH is the
// transport — dockerode `exec`/`putArchive` versus ssh2 `exec`/SFTP.
//
// So the seam sits here instead, one level below the backend. An adapter
// supplies these five primitives; {@link createPosixSandbox} implements the five
// tools on top of them once, and owns the bounds for every adapter rather than
// trusting each to honour them. A backend that cannot be expressed as a POSIX
// transport is free to implement `SandboxBackend` directly — this is a shortcut
// for the common case, not a new requirement.
//
// Every method takes the {@link SandboxContext} the tool call arrived with, for
// the same reason `SandboxBackend` does: an adapter may serve more than one
// Workspace from one instance, and `ctx.workspaceId` is the identity key it
// finds or provisions its resource by.

/** What a transport is asked to run one command under. */
export interface SandboxExecOptions {
  /**
   * Absolute working directory inside the sandbox. Resolved by core against the
   * transport's own {@link SandboxTransport.rootDir}, so it is already a real
   * path on the far side rather than anything the model wrote.
   */
  cwd?: string;
  /** Environment for this command, already merged by the layers above. */
  env?: Record<string, string>;
  /** Wall-clock budget. Core has already clamped it to the Platypus maximum. */
  timeoutMs: number;
  /** Stop accumulating stdout past this many bytes (keep draining). */
  stdoutCap: number;
  /** Stop accumulating stderr past this many bytes (keep draining). */
  stderrCap: number;
  /**
   * Fires when core has stopped waiting for this command — the turn was
   * cancelled, or the run hit a timeout.
   *
   * Honour it where the command actually runs, and honour it from the *first*
   * await: the per-command timer is armed only after the unbounded daemon or
   * connection calls that precede it, so those are exactly where an abort has
   * nothing else to recover it (issue #921).
   *
   * Reject when it fires, rather than resolving with an exit code — the command
   * did not finish, core stopped listening. Optional: core races the whole tool
   * call against the same signal, so a transport that ignores this still cannot
   * hold the turn open; ignoring it only means the command runs on as an orphan
   * until its own timeout, exactly as it does today.
   */
  signal?: AbortSignal;
}

/**
 * One finished command. Buffers rather than strings: decoding is the contract's
 * business — `shell.exec` is lenient about invalid UTF-8 where `fs.read` is
 * strict — and a transport that decoded early would take that choice away.
 */
export interface SandboxExecResult {
  stdout: Buffer;
  stderr: Buffer;
  /**
   * The command's exit status, and `124` when it was killed for outrunning
   * `timeoutMs` — the code a shell reports for exactly that, which is why a
   * timeout needs no flag of its own alongside it.
   */
  exitCode: number;
  durationMs: number;
}

/**
 * A byte-capped output accumulator, for the `stdoutCap` / `stderrCap` half of
 * {@link SandboxExecOptions}.
 *
 * Here rather than in each transport because the cap is a Platypus-defined
 * bound like any other, and because getting it wrong is quiet: the sink keeps
 * *accepting* chunks past the cap and merely stops storing them, so the
 * underlying stream still drains. A transport that instead unsubscribed at the
 * cap would leave the command blocked on a full pipe, and the failure would look
 * like a hang rather than a truncation.
 */
export const createCappedSink = (cap: number) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  return {
    push(chunk: Buffer): void {
      if (bytes >= cap) return;
      const room = cap - bytes;
      const take = chunk.length <= room ? chunk : chunk.subarray(0, room);
      chunks.push(take);
      bytes += take.length;
    },
    collect(): Buffer {
      return Buffer.concat(chunks);
    },
  };
};

/**
 * Thrown by {@link SandboxTransport.writeFile} when `mode: "create"` finds the
 * path already taken. A distinct type rather than a message because the message
 * an Operator sees names the *workspace-relative* path the model asked for, and
 * a transport only ever sees the resolved absolute one — core translates.
 */
export class SandboxPathExistsError extends Error {
  constructor(absPath: string, options?: { cause?: unknown }) {
    super(`path already exists: ${absPath}`, options);
    this.name = "SandboxPathExistsError";
  }
}

/**
 * Thrown by a transport when {@link SandboxExecOptions.signal} fired before the
 * command finished. A distinct type rather than a message because it is not a
 * failure of the command — nothing ran badly, core stopped listening — and the
 * layers above must not report it as one.
 */
export class SandboxCancelledError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("sandbox: turn cancelled", options);
    this.name = "SandboxCancelledError";
  }
}

/**
 * Run `work` under `signal`, and stop waiting the moment it fires.
 *
 * The one way anything on the Sandbox path honours an abort, so all of them
 * report it identically: the race is {@link raceAbort}'s, shared with the
 * Web-search backend, and what is added here is the verdict — an abort that
 * fired becomes a {@link SandboxCancelledError}, and anything else the work
 * threw passes through untouched.
 *
 * An absent signal is a plain call. Nothing in core drives a turn without one;
 * a transport primitive invoked outside a tool call (provisioning, teardown) has
 * no turn to be cancelled with.
 */
export const raceCancellation = <T>(
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> => {
  if (!signal) return work();
  return raceAbort(signal, work).catch((cause) => {
    if (signal.aborted) throw new SandboxCancelledError({ cause });
    throw cause;
  });
};

/**
 * The five primitives an adapter supplies. Everything the model sees is built
 * from these by {@link createPosixSandbox}.
 *
 * This is the *whole* adapter surface: an implementation that finds itself
 * parsing find(1) output, counting lines, or deciding what `truncated` means has
 * taken on work the contract already owns.
 */
export interface SandboxTransport {
  /**
   * The absolute workspace root every relative path resolves against, and the
   * lazy-initialisation hook: core calls it first in every tool, so this is
   * where an adapter provisions its container or opens its connection. Called
   * once per tool call, so it must be cheap on the warm path and safe under
   * concurrent callers.
   */
  rootDir(ctx: SandboxContext): Promise<string>;

  /**
   * Run one command. `argv` is a command and its arguments already split, never
   * a shell line — quoting is the transport's business, because only it knows
   * whether one is needed (Docker passes argv straight to the daemon; SSH has a
   * login shell in the way and must quote every element).
   *
   * Resolves for a command that failed or timed out — a non-zero `exitCode` is
   * data, not an error. Reject only when the command could not be run at all.
   */
  exec(
    ctx: SandboxContext,
    argv: string[],
    opts: SandboxExecOptions,
  ): Promise<SandboxExecResult>;

  /**
   * Read at most `cap` bytes of an absolute path. Rejects when the file cannot
   * be read; core prefixes the message with the tool that asked, so the reason
   * (and only the reason) belongs in it.
   *
   * Bytes only — whether that counts as *truncated* is core's call, from the
   * one `>= cap` rule it applies to every adapter. A transport reporting its
   * own verdict is how the two adapters used to disagree about a file sitting
   * exactly on the cap, and reading the size first (SFTP can, `cat` cannot) is
   * not worth reopening that.
   */
  readFile(ctx: SandboxContext, absPath: string, cap: number): Promise<Buffer>;

  /**
   * Write bytes to an absolute path, creating any missing parent directories.
   * `mode: "create"` must reject an existing path with a {@link
   * SandboxPathExistsError}; `mode: "overwrite"` replaces whatever is there.
   */
  writeFile(
    ctx: SandboxContext,
    absPath: string,
    bytes: Buffer,
    mode: "create" | "overwrite",
  ): Promise<void>;

  /**
   * Release whatever this adapter owns for the Sandbox. MUST be idempotent —
   * safe to call on a resource that is already gone (ADR-0001). An adapter
   * attached to a machine it does not own tears down its own connection and
   * nothing else.
   */
  destroy(ctx: SandboxContext): Promise<void>;
}
