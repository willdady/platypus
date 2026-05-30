# Sandbox workspace-default env vars are Platypus-merged at exec time, opaque to the model

A Sandbox carries a workspace-default `env: Record<string, string>` (top-level column on the `sandbox` row). On every `shell.exec`, the Sandbox route merges the workspace env on top of the model-provided `input.env` (workspace wins on key collision) and calls the adapter with the merged map. Values never appear in the system prompt, tool-call transcripts, or logs; the orientation block lists keys only. The motivating use case is API keys (`OPENAI_API_KEY`, `GITHUB_TOKEN`, …) so agent-written code can call third-party services without those values transiting the LLM.

## Considered Options

- **Per-call only (status quo).** Rejected: the model would have to be handed the secret value as a tool argument, which is exactly the leak we're trying to avoid.
- **Adapter-level handling — extend `SandboxBackend` / `SandboxContext` with global env.** Rejected: "global" semantics would drift per adapter (some bake into `/etc/profile`, some merge per-exec), breaking the portability story that ADR-0002 protects. Cross-cutting concerns above the five-tool core stay above the adapter.
- **Store env inside `sandbox.credentials` or `sandbox.config`.** Rejected: both are per-adapter jsonb validated by adapter-supplied schemas. Env is adapter-agnostic; pushing it through every adapter's `credentialsSchema` leaks the concept into N places. A new top-level column keeps adapter schemas clean.
- **Per-entry `secret: boolean` flag with differentiated rendering.** Rejected: introduces a default-choice footgun (`OPENAI_API_KEY` accidentally marked non-secret leaks into the prompt). Treating every entry as opaque/sensitive is simpler and the cost is one cheap `echo $VAR` if the model wants a non-secret value.
- **Per-call wins on key collision.** Rejected: lets the model shadow workspace secrets with arbitrary or empty values. Workspace wins; the model can still inline `KEY=value command` in the command string when it genuinely wants a per-call override.
- **Credential-broker model — values never reachable from the shell.** Considered as a stricter threat model (`echo $OPENAI_API_KEY` would still leak the value to the model via stdout). Rejected for v1: substantial new surface (path-policy enforcement or auth-proxy wrappers per binary). The accepted threat model is "values are not in the prompt or tool args; the agent is trusted to _use_ them, not exfiltrate them" — same as CI systems and Claude Code.

## Consequences

- DB shape: new `env jsonb NOT NULL DEFAULT '{}'` column on `sandbox`. Plaintext at rest, consistent with the existing credentials posture from ADR-0001.
- Merge happens in the Sandbox route/runner before calling `backend.shellExec`. `SandboxBackend` is unchanged; future adapters (Modal, E2B, Daytona) inherit the behaviour with no per-adapter work.
- Env applies to `shell.exec` only. `fs.*` tools have no env channel and don't need one.
- Changing the env on a `sandbox` row takes effect on the _next_ `shell.exec`. The container is not recreated and `destroy()` is not called. Long-lived processes started in earlier turns keep their old env — same as any Linux box.
- Validation, Platypus-enforced (not adapter-enforced):
  - Key regex: `^[A-Za-z_][A-Za-z0-9_]*$`.
  - Max 64 entries per Sandbox.
  - Max 4 KB per value.
  - No reserved-key denylist; users overriding `PATH`/`HOME` break their own Sandbox, not the security model. `no-new-privileges:true` (ADR-0003) already neuters `LD_PRELOAD`-style escalation.
- Orientation block (`apps/backend/src/system-prompt.ts`) gains a fragment listing key names only when the workspace env is non-empty, plus a one-liner that workspace defaults override any `env:` the model passes.
- Logging: the merged env map is never emitted in structured logs or error messages. The model-facing `input.env` continues to be echoed in tool-call transcripts (the model wrote it; no new exposure).

## Amendment: two-tier admin/user env (see ADR-0006)

The single workspace-default `env` map is split into two top-level columns — `adminEnv` (Org-Admin-managed) and `userEnv` (Workspace-Owner-managed) — to support the field-level authorization in ADR-0006: an Owner manages their own secrets without an admin round-trip, while an admin can pin secrets the Owner cannot touch.

- **Exec-time precedence, highest wins:** `adminEnv` ▸ `userEnv` ▸ model-provided `input.env`. Implemented as the merge `{ ...input.env, ...userEnv, ...adminEnv }`. This preserves both original rules — values never transit the model, and the model's per-call env stays _lowest_ precedence — and inserts the admin/user split above the model layer.
- **The Owner can never override an admin key.** Enforced twice: rejected at write (4xx) if `userEnv` would set a key already present in `adminEnv`, and `adminEnv` is spread last at merge as a runtime backstop against any stale collision.
- **Visibility:** admin key _names_ are shown to the Owner read-only ("managed by admin"), consistent with the keys-only rule above; admin values never leave the server.
- The existing validation (key regex, max entries, max value size) applies per map.
