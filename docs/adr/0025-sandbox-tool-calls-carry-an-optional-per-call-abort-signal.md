---
status: accepted
---

# Sandbox tool calls carry an optional per-call abort signal, and core races it

The five `SandboxBackend` tool methods — `shellExec`, `fsRead`, `fsWrite`,
`fsEdit`, `fsList` — take a `SandboxCallOptions` as an **optional appended**
third argument, carrying the `AbortSignal` for that call. Core supplies it on
every call and **races it against the backend's promise**, so the run settles on
the abort whether or not the adapter ever reads the signal. ADR-0002's fixed
five-tool core is unchanged: no tool is added, renamed, or re-signed, and
nothing about the model-facing tool surface moves.

The problem was #921. An abort during a `shell.exec` left the executor promise
pending, so the drive's snapshot stream never drained, its `finally` never ran,
and the run's terminal write never happened. The chat row stayed
`status: "running"` — sidebar spinner, stuck stop button, 3s poll — with both
run timers already cleared by the cancel, so nothing was left to recover it.
That is permanent rather than merely delayed.

## Considered Options

- **Hand the signal to adapters and stop there.** Rejected: honouring it is
  optional, and a third-party Contribution that ignores it would pin a turn open
  forever. Whether a run reaches a terminal status cannot rest on a
  Contribution's cooperation, so core races the abort itself. The adapter's
  cooperation buys the _command_ being stopped; it must never buy the _turn_
  being closed.
- **Make the parameter required, or add a sixth method.** Rejected: both break
  every adapter written against the existing contract. ADR-0013's append-only
  rule allows new capability only as an optional member within a major version,
  which is exactly the shape taken here — and the same shape ADR-0014's
  Web-search executors already take.
- **Put the signal on `SandboxContext`.** Rejected: the context is
  per-workspace, and the abort is per-call. A signal with the wrong lifetime
  would cancel the wrong work.
- **Synthesise a result when the signal fires.** Rejected: a transport rejects
  on abort rather than reporting an exit code, because the command did not
  finish and a fabricated result would enter the Transcript as though it had.

## Consequences

- An adapter written before this argument existed declares two parameters, still
  satisfies `SandboxBackend`, and still works untouched. Ignoring the signal is
  a supported choice; it costs a command that runs on holding a container, a
  connection, or a billed sandbox minute for an answer nobody will read.
- The race lives on a shared helper (`apps/backend/src/utils/abort-race.ts`),
  replacing the local one the Web-search deadline wrapper carried, so both
  extension points state the same discipline once.
- Both reference adapters honour the signal **from their first await** — not
  once a command is streaming. Resolving the workspace root, creating a Docker
  exec, and opening an SSH channel are unbounded calls that run before any
  per-command timeout is armed, which is precisely where an abort has nothing
  else behind it.
- The five tools are unchanged as far as the model is concerned. This is a
  parameter on the adapter contract, not on the tool surface, so no prompt and
  no tool description moves.
- `AbortSignal` is a platform global the SDK does not declare, so an adapter
  whose `tsconfig.json` has `"lib": ["esnext"]` and no `@types/node` will not
  compile against the new signature until it adds one or the other.

## Update (2026-09-26): required from API v3

[#1048](https://github.com/willdady/platypus/issues/1048) makes the argument **required** under plugin API v3 (see ADR-0013's API v3 update). The "make the parameter required" option above was rejected _within a major_; the v3 bump is the windowed major that permits it. An adapter declaring two parameters still satisfies `SandboxBackend`, so implementers are unaffected; only callers must now pass it. Core passes a never-firing signal on the one path the AI SDK leaves without one. The race is unchanged.
