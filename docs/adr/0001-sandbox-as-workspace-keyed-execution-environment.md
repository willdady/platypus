# Sandbox is a persistent, Workspace-keyed execution environment parallel to Provider

A Sandbox is a configured, isolated execution environment registered on a Workspace, exposing a fixed set of shell and filesystem tools to Agents. We model it as a sibling of Provider — a `sandbox` row per Workspace with a `backend` discriminator and a JSON `config`, resolved by an in-tree adapter registry at Chat-turn time — rather than as a Provider variant, an MCP server, or a generic plugin system. State (filesystem, environment) is keyed on `(orgId, workspaceId)` and is expected to persist across Chat turns; this is what makes Hermes/Claude-Code-style workflows possible. Scope is Workspace-only in v1.

## Considered Options

- **Provider variant.** Rejected: Provider carries credentials for an AI vendor and is referenced by an Agent's model selection; conflating it with a stateful execution environment muddles the glossary.
- **MCP server.** Rejected: MCP is the open-ended "expose arbitrary tools" surface. Sandbox is the _opposite_ — a fixed contract every backend implements. Keeping them separate preserves both stories.
- **Ephemeral per Chat turn.** Rejected: kills the filesystem-state-across-turns workflow that is the entire point of the feature. Workspaces are single-user (see `CONTEXT.md`), so persistent shared fs state inside a Workspace has no cross-tenant risk.
- **Many Sandboxes per Workspace.** Rejected: requires an additional disambiguator in the tool context and a UX for picking between them. Defer until there's evidence of demand.
- **Org-scoped Sandboxes.** Rejected for v1: filesystem state doesn't generalise across Workspaces, so sharing would only share credentials — minor benefit, extra config layer. Revisit if multi-Workspace credential reuse becomes painful.

## Consequences

- DB shape: `sandbox(id, workspaceId UNIQUE, backend, name, config jsonb, credentials jsonb, ...)`.
- Adapter authors implement a fixed `SandboxBackend` interface (see ADR-0002).
- `destroy(ctx, config, credentials)` is required on every adapter and must be idempotent. On user-initiated row delete: synchronous, fail-loud, with a force-delete escape hatch. On user-initiated row update that changes `backend`: same fail-loud semantics — the previous adapter's `destroy()` fires inline against the old row before the new backend is written, with the same `?force=true` escape hatch. On Workspace cascade: best-effort with a `sandbox_teardown_failure` ledger; never blocks Workspace deletion.
- Credentials are stored as plaintext, consistent with existing Provider/MCP patterns. Not encrypted at rest.
- The Agent-side tool set id `"sandbox"` is registered unconditionally; if a Workspace has no Sandbox configured, the tools are absent that turn (same graceful-degradation pattern as Providers).
