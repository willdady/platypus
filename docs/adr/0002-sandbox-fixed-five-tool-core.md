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

## Amended by ADR-0025

ADR-0025 narrows one claim above: "Adapters cannot add tools, rename tools, or
change signatures." Adapters still cannot — but **core** appended an optional
`SandboxCallOptions` argument to all five tool methods, carrying the call's
`AbortSignal`. The fixed five-tool core, the stateless shell semantics, and the
model-facing tool surface are all unchanged. See ADR-0025 for the reasoning.

## Amended by ADR-0027

ADR-0027 withdraws "exactly five tools" for the `sandbox` Tool set, which gains a
sixth, core-built tool: `fsDownload`, offered only when the backend implements
`fsReadBytes`. `SandboxBackend` gains two optional members, `fsReadBytes` and
`fsWriteBytes`, which are adapter capabilities and never Tools. The
adapter-facing five-tool contract, the stateless shell semantics and the output
bounds are unchanged. See ADR-0027 for the reasoning.
