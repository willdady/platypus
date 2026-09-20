---
status: accepted
---

# Sandbox interface is a fixed five-tool core with stateless shell semantics

The `SandboxBackend` interface defines exactly five tools — `shell.exec`, `fs.read`, `fs.write`, `fs.edit`, `fs.list` — with Platypus-defined parameter shapes, return shapes, and output bounds. Adapters cannot add tools, rename tools, or change signatures. `shell.exec` is stateless: each call gets a fresh shell with an explicit `cwd`, no session state survives between calls, and a mandatory timeout applies. The system prompt receives a fixed adapter-agnostic orientation block whenever the `"sandbox"` tool set is granted.

## Considered Options

- **Open contract — adapters declare their own tools** (MCP-style). Rejected: ties an Agent's prompt to a specific backend, breaking the "swap Modal for Daytona without re-prompting" portability story. MCP already exists for the open-ended case.
- **Hybrid — fixed core plus adapter extensions.** Rejected for v1: doubles the registration surface and the portability story for negligible benefit. Can be added later without breaking the v1 contract.
- **Stateful interactive shell sessions.** Rejected: requires per-session shell-process pools and `cwd`/`env` scoping in every adapter; the model is also demonstrably worse at maintaining shell state than at passing explicit `cwd` per call.
- **Patch-format `fs.edit`.** Rejected: agents are worse at producing valid diffs than at unique-string-replace. We adopt Claude Code's `oldString`/`newString` semantics for free prompt-engineering transfer.
- **Adapter-defined output bounds.** Rejected: a prompt that works on backend X would silently misbehave on backend Y when an adapter chose smaller caps.

## Consequences

- All paths are workspace-root-relative; the workspace root is conventionally `/workspace`. Absolute paths are rejected.
- `fs.write` requires explicit `mode: "create" | "overwrite"` — no silent create-or-overwrite.
- Every response carries a `truncated` flag with Platypus-defined byte/entry caps; adapters that can't honour the cap natively must truncate themselves.
- `shell.exec` has a default 60s timeout and a hard cap of 600s. No `fs.delete`/`mkdir`/`move`/`copy` — the shell handles those.
- The orientation block lives in `apps/backend/src/system-prompt.ts` alongside existing per-tool-set fragments. It teaches the model the load-bearing facts that aren't visible from individual tool descriptions: persistence across turns, statelessness of the shell, root path, truncation behaviour, and timeouts.
- Concurrency is _not_ serialised at the Platypus layer; tool calls are forwarded to adapters concurrently. The "Sandbox is a Linux box" mental model — i.e. parallel commands may race — is the contract.

## Amendment — the five tools take an optional per-call signal (#921)

This ADR says adapters cannot change signatures, and that stands: an adapter
still cannot re-sign a tool. What changed is that **core** appended an optional
third parameter to all five, `SandboxCallOptions`, carrying the `AbortSignal`
for the call — the growth path ADR-0013's append-only rule allows within a
major, and the shape ADR-0014's Web-search executors already take.

Optional and appended, never required and never a new method: an adapter
written against the previous contract declares two parameters, still satisfies
`SandboxBackend`, and still works untouched.

The signal alone was never the fix. Honouring it is optional, so core **races**
the abort against the backend call rather than merely handing the signal over —
the same discipline the Web-search backend's deadline wrapper states, now on a
helper the two share. Before this, an abort during a `shell.exec` left the
executor promise pending, the drive's snapshot stream undrained, and the run's
terminal write unwritten; the chat row stayed `running` with both run timers
already cleared by the cancel, so nothing was left to recover it. That a turn is
not pinned open cannot rest on a Contribution's cooperation.

Consequences:

- The five tools are unchanged as far as the model is concerned — no new tool,
  no rename, no change to any input or output shape. This is a parameter on the
  adapter contract, not on the tool surface.
- A cooperative adapter's command is stopped rather than orphaned. Both
  reference adapters honour it, and from their _first_ await: creating a Docker
  exec and opening an SSH channel are unbounded calls that run before the
  per-command timeout timer is armed, which is where an abort has nothing else
  behind it.
- A transport rejects on the signal rather than reporting an exit code. The
  command did not finish, and a synthesised result would enter the transcript as
  though it had.
