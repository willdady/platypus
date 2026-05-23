# Sandbox containers reach host services via host-gateway

The Docker reference Sandbox adapter sets `HostConfig.ExtraHosts` on every Sandbox container at creation. The default entry, `host.docker.internal:host-gateway`, lets agent-written code resolve the host's gateway IP using the canonical Docker convention, so the sandbox can participate in a local multi-service stack (Ollama, local Whisper, the Platypus `internal-resource-proxy`, …) without hardcoded IPs or per-deployment glue. The entry list is operator-controlled via `PLATYPUS_SANDBOX_EXTRA_HOSTS`: unset uses the default, empty string opts out entirely, and a comma-separated list replaces the default with a custom set.

## Considered Options

- **Hardcoded, non-configurable** (ADR-0003 spirit of "minimal v1 knobs"). Rejected: operators have legitimate reasons to want this off (stricter isolation requirements) or to add aliases (additional internal hostnames). An env-only knob is the smallest possible surface that addresses both.
- **Per-Sandbox row config column**. Rejected: keeps adapter `config` schema clean (ADR-0001) and avoids leaking what is fundamentally a host-deployment concern into per-workspace data.
- **Join sandbox to `platypus-network`**. Rejected: explicitly violates ADR-0003's blast-radius bound by giving sandbox containers direct database reachability.
- **`network_mode: host`**. Rejected: removes network namespace isolation entirely.
- **Document a workaround (operator-run everything in Docker on the platypus network)**. Rejected: pushes operator complexity for what is the most common self-hosted single-node deployment shape.
- **OS-conditional defaults (Linux needs `host-gateway`, Mac doesn't strictly)**. Rejected: `host-gateway` works on both since Docker 20.10. Conditional adds complexity for no benefit.

## Consequences

- Requires Docker daemon 20.10+ for `host-gateway` resolution. Documented in README and `.env.example`.
- Sandbox can reach any service the operator publishes on the host. Sandbox cannot reach `platypus-network` services that are not published on the host (the database remains unreachable).
- The trust model from ADR-0004 (agent is trusted to use secrets, not exfiltrate them) is unchanged; this ADR exposes additional reachable surfaces only, not new authority.
- Existing containers built before this change continue to run without the new entries until destroyed and recreated, consistent with ADR-0003's existing-container clause.
- Env var is read per container creation, so operators can adjust without rebuilding the image. Entries are validated at creation time; an invalid entry fails the sandbox provisioning loudly rather than silently.
- The default entry is `host.docker.internal:host-gateway`. Operators wanting strict isolation set `PLATYPUS_SANDBOX_EXTRA_HOSTS=` (empty) to disable the alias entirely.
