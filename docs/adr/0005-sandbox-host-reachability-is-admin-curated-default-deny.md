# Sandbox host reachability is an admin-curated, default-deny capability bounded by an operator allowlist

The Docker reference Sandbox adapter exposes host/service reachability as two per-Sandbox config fields — `networks` (Docker networks to attach) and `extraHosts` (host-gateway aliases) — both defaulting to empty: a new Sandbox can reach no host service until reachability is explicitly granted. The eligible set is declared by the Operator at deployment time via `PLATYPUS_SANDBOX_DOCKER_ALLOWED_NETWORKS`; an Org Admin selects a subset per Sandbox; the submitted subset is validated server-side against the allowlist. Both fields are org-admin-only (a non-admin Workspace Owner receives 403). Reach changes take effect only on container recreate, honoring ADR-0003's frozen-container rule.

## Considered Options

- **Single global process env applied verbatim to every container** (the original PR #146 — `PLATYPUS_SANDBOX_EXTRA_HOSTS` written to `HostConfig.ExtraHosts`). Rejected: one deployment-wide knob cannot express per-Sandbox isolation — a contractor's Sandbox and a personal Sandbox on the same host get the same reachability or none. Worse, it defaulted to `host.docker.internal:host-gateway`, i.e. default-_allow_, the opposite of the isolation posture we want.
- **Per-Sandbox `extraHosts` field editable by the Workspace Owner** (the first redesign). Rejected: Workspaces are single-user, so the Owner edits their own Sandbox via `requireWorkspaceAccess` — the contractor _is_ the Owner and would grant reach to themselves. A per-Sandbox knob without an admin gate hands control to the very actor it is meant to restrict.
- **`extraHosts` only (drop networks).** Rejected: `extraHosts`/host-gateway is all-or-nothing — every host-published port becomes reachable, or none. Docker networks let the Operator segment services onto separate networks so the Admin can attach a meaningful subset rather than granting all-or-nothing reach.
- **`networks` only (drop extraHosts).** Rejected: a Docker network reaches only _containers_. A non-containerized host process (bare-metal Ollama, an internal proxy) is unreachable without host-gateway. Retaining both — admin-only and default-deny — closes the gap at negligible cost.
- **Platform super-admin (Operator) gate on the in-app field.** Rejected: the Docker backend is scoped to single-node self-hosted deployments (ADR-0003), not multi-tenant. Org-admin is consistent with the rest of the authorization model (ADR-0006), and the operator allowlist already bounds the blast radius.

## Consequences

- `dockerSandboxConfigSchema` gains `networks: string[]` and `extraHosts: string[]`, both `default([])`. New Sandboxes have no host reachability until an Org Admin grants it.
- Authority chain is honest: **Operator** declares the eligible networks (deployment env, _not_ an in-app screen) → **Org Admin** selects a per-Sandbox subset → **Workspace Owner** cannot change it. Out-of-allowlist entries are rejected server-side.
- A `GET .../sandbox/networks` endpoint surfaces the allowlist for an admin-only multi-select; the control is absent/disabled for non-admins.
- Reach edits are pending until container recreate (a "Pending — applies on recreate" badge plus an explicit "Recreate now" button), consistent with ADR-0003's container-config-is-frozen clause and with how resource limits already behave.
- The "Platypus database remains unreachable" property holds only insofar as the database's network is not in the allowlist — it is an Operator configuration outcome, not a structural guarantee.
- The host-gateway default from PR #146 is removed. Operators that want it set it explicitly per Sandbox, or run host services as containers on an allowed network.
- Per-backend env naming: `PLATYPUS_SANDBOX_DOCKER_ALLOWED_NETWORKS` carries the `DOCKER` segment (matching `PLATYPUS_SANDBOX_DOCKER_ENABLED`) so future backends declare their own allowlists without collision.
- Supersedes the draft ADR-0005 that shipped in the now-closed PR #146.
