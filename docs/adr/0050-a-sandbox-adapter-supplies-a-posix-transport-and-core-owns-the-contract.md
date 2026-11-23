---
status: accepted
---

# A Sandbox adapter supplies a POSIX transport, and core owns the contract

The five Sandbox tools (ADR-0002) and the two byte-transfer members (ADR-0027)
are implemented once, in core, over a transport of five primitives that each
adapter supplies: `rootDir`, `exec`, `readFile`, `writeFile` and `destroy`, plus
an optional `close`. What differs between Docker, SSH and Daytona is only how a
command runs and how bytes cross; everything the model sees is assembled above
that line, identically for every adapter.

Core owns every Platypus-defined bound: the timeout clamp, the output caps and
the `>=` rule that sets `truncated`, strict UTF-8 for the `fs.*` tools, line
counting, the unique-`oldString` rule, parsing `find(1)` output, and the
transfer `maxBytes` rule. A transport returns bytes and exit codes, never a
verdict, so no two adapters can disagree about a file sitting exactly on a cap.

The transport contract:

- `rootDir` is the lazy-initialisation hook. Core calls it first in every tool,
  so it provisions the container or opens the connection, must be cheap when
  warm, and must be safe under concurrent callers. Core races it against the
  turn's signal (ADR-0025) without telling it to stop, because the work is
  shared with any other call warming the same Sandbox.
- `exec` takes an argv, never a shell line. Quoting is the transport's business,
  because only it knows whether a shell is in the way. It resolves for a command
  that failed or timed out, reporting a timeout as exit code `124`, and rejects
  only when the command could not be run. It honours the signal from its first
  await and rejects with a cancellation, not an exit code, when it fires.
- Output streams through core's capped sink, which keeps accepting chunks past
  its cap and only stops storing them. A transport that stopped reading at the
  cap would leave the command blocked on a full pipe, and the failure would look
  like a hang rather than a truncation.
- `writeFile` with `mode: "create"` rejects an existing path with a distinct
  error type, so core can restate it in the workspace-relative path the model
  asked for; the transport only sees the absolute one.
- `destroy` is idempotent (ADR-0001).

A backend that cannot be expressed as a POSIX transport may still implement
`SandboxBackend` directly, and must then apply the bounds itself.

## Considered Options

- **Each adapter implements `SandboxBackend` directly.** Rejected: every adapter
  carries its own copy of the contract and its own suite proving it, the copies
  drift, and every bug has one place to fix per adapter.
- **The transport reports `truncated` itself, reading the file size first.**
  Rejected: SFTP can stat a file but `cat` over `exec` cannot, so the verdict
  would depend on the adapter again.
