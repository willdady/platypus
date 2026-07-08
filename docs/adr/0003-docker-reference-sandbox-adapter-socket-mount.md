# Docker reference Sandbox adapter mounts the host Docker socket

> **Update — superseded in part by [ADR-0013](0013-plugin-system-manifest-driven-in-process-extension-points.md):**
> the `PLATYPUS_SANDBOX_DOCKER_ENABLED` env gate described below has been retired.
> The Docker adapter now ships as the core plugin `@platypus/docker`; enable it by
> listing `@platypus/docker` in `PLATYPUS_PLUGINS` — list membership _is_ the enable
> switch. The opt-in `compose.sandbox.yaml` overlay and the socket-mount security
> posture are unchanged. The rest of this ADR stands as originally decided.

Platypus ships a reference Sandbox adapter (`backend: "docker"`) that spawns one container per Workspace via the host's Docker daemon, accessed by bind-mounting `/var/run/docker.sock` into the backend container. The mount is gated behind an opt-in `compose.sandbox.yaml` overlay and an env flag (`PLATYPUS_SANDBOX_DOCKER_ENABLED`); the default compose stack does not include it. The adapter is scoped to development and single-node self-hosted deployments only — explicitly _not_ for multi-tenant or hostile-tenant environments. Sandbox containers are siblings of the backend container on Docker's default bridge, not on `platypus-network`, so they cannot reach the Platypus database directly.

## Considered Options

- **Docker-in-Docker (DinD).** Rejected: requires `--privileged`, conflicts with overlayfs storage drivers, and gives the backend container strictly _more_ host capabilities (kernel modules, arbitrary mounts, all devices) than a socket mount does.
- **Privileged sidecar service.** Considered: a small `sandbox-daemon` container owns the socket and exposes a narrower API to the backend. Smaller blast radius. Rejected for v1 because it adds a new service, image, and protocol to maintain for a feature explicitly scoped to dev / single-node. Can be added later without changing the `SandboxBackend` interface.
- **No reference adapter; require external service.** Rejected: leaves the feature dark for anyone not paying for Modal/E2B/Daytona and leaves contributors with no canonical adapter to read.
- **Host-directory adapter** (`shell.exec` runs directly on the host). Rejected: insecure by construction and dangerous because it _works_ — users would inevitably run it in production.

## Consequences

- Mounting the Docker socket grants the backend container effective root on the host. This is documented loudly at the top of `compose.sandbox.yaml`.
- The backend image gains `dockerode` (npm) for socket-protocol access; no Docker CLI binary is shelled out.
- Adapter registration is env-gated: if `PLATYPUS_SANDBOX_DOCKER_ENABLED` is unset/false, the `"docker"` backend type is not registered, preventing un-runnable Sandbox rows.
- Operators see sandbox containers in `docker ps` on the host. The adapter's `destroy()` and a startup-time orphan-reaper (keyed on a Platypus-managed container label) keep this bounded.
- A single canonical image (e.g. `debian:stable-slim`) is used. Richer or domain-specific environments are a job for third-party adapters, not for variants of the reference adapter.
- Hardcoded resource and security limits are applied at container creation: `PidsLimit=256` (fork-bomb defence), `Memory=2GB` + `MemorySwap=2GB` (host-OOM defence), `NanoCpus=2_000_000_000` (host-CPU defence), `SecurityOpt=["no-new-privileges:true"]` (blocks setuid escalation). Not user-configurable in v1; existing containers from before these defaults keep their old config until destroyed and recreated. `CapDrop`, `ReadonlyRootfs`, non-root user, and custom seccomp profiles were considered and deferred — they all break either `apt install` or the "agent grows the environment" workflow.
- Horizontal-scaled deployments must use a remote backend (Modal, Daytona, E2B, …); the Docker adapter is not viable in that topology because each backend pod has its own host daemon and no shared state.
