# Credential- and reach-bearing configuration is admin-managed; composition is owner-managed

Resources that introduce credentials, external reach, or code execution — **Providers, Sandboxes, and MCPs** — are configured by an Org Admin by default. Resources that merely compose already-sanctioned capabilities — **Agents, Skills, Chats** — remain editable by the Workspace Owner. Because Workspaces are single-user, the Owner is exactly the actor (e.g. a contractor) the default is meant to constrain, so leaving credential-bearing config owner-editable would defeat the control.

Two independent per-Workspace flags (admin-set, default off) let an Org Admin grant the Owner self-management of **workspace-scoped Providers** and **MCPs** respectively, for legitimate personal-credential cases (e.g. an MCP for the Owner's own email account, where handing the credential to an admin is worse, not better). **Sandbox is never delegatable.** Within a Sandbox the gate is field-level: only reach/execution-determining fields are admin-only.

## Considered Options

- **Leave all Workspace config owner-editable** (status quo — every route guarded only by `requireWorkspaceAccess`, which grants the Owner access even as a non-admin `member`). Rejected: a non-admin Owner (contractor) can bring their own Provider, MCP, or Sandbox credentials and wire up external reach the Organization never sanctioned.
- **Whole-Sandbox admin-only (no field split).** Rejected: it forces an admin round-trip for the Owner's own `env` secrets — the same personal-credential friction we reject for MCP. The reach/execution fields carry the risk; once they are locked, `env` is the Owner's own concern.
- **Flat "MCP = admin-only" with no delegation.** Rejected: breaks personal-reach MCPs (the Owner's own email/calendar) by forcing the Owner to share personal credentials with an admin.
- **Lift Sandboxes to Organization scope.** Rejected: filesystem state does not generalize across Workspaces (ADR-0001), and admin-only config already removes the contractor risk, so org-scoping would only share credentials — deferred per ADR-0001 until credential reuse is actually painful.
- **Default-allow + admin lock-down.** Rejected: a fresh contractor Workspace would have reach until an admin intervened. Default-deny is the safe posture.
- **Platform super-admin (Operator) gate.** Rejected: org-admin is consistent across the model and sufficient for the single-node self-hosted scope (ADR-0003).

## Consequences

- Workspace-scoped Provider, Sandbox, and MCP mutation routes require org-admin, except where a delegation flag applies (Provider, MCP only).
- Two boolean columns on `workspace` (e.g. `providerSelfManagement`, `mcpSelfManagement`), default `false`, settable only by an Org Admin.
- Sandbox routes enforce field-level gating: `backend`, `credentials`, `networks`, `extraHosts`, `adminEnv`, and creation are admin-only; `name` and `userEnv` stay owner-editable (see ADR-0005 for the reach fields, ADR-0004 for the env split).
- The stale "admin only" comment on the workspace-scoped Provider create route becomes accurate for the non-delegated path.
- Frontend: admin-only config sections render read-only or hidden for non-admin Owners lacking the grant; an admin surface toggles the per-Workspace delegation flags.
- Agent/Skill/Chat authorization is unchanged.
