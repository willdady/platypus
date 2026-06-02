---
status: accepted
---

# Organization-scoped Shared resources, referenced by Workspaces

To let an Org Admin define an Agent, Skill, or MCP once and use it across many
Workspaces — without duplication or configuration drift — a resource may be
**Promoted** to Organization scope, becoming a **Shared resource**. Workspaces
**reference** (never copy) it through an explicit **Attachment**; there is a single
source of truth, edited only by Org Admins and surfaced as locked to Workspace Owners.
This follows the existing dual-scope shape of `Provider` (a row carries either an
`organizationId` or a `workspaceId`), so no new scoping concept is introduced — only
its application to more resource types and an Attachment join between Workspaces and
Shared resources.

The defining rule is **no implicit sharing**: a Shared resource may reference only
other Shared resources. Promotion is blocked until every reference (`providerId`,
`skillIds`, `subAgentIds`, MCP-backed tool sets) is itself Organization-scoped — the UI
presents a fix-this checklist. Sharing is therefore always explicit and per-resource,
never cascading.

## Considered Options

- **Workspace inheritance** (ancestor → descendant mirroring). Rejected: Workspaces are
  deliberately flat (no parent/child in the schema), "mirroring" implies copies and
  hence drift, and it forces a hierarchy onto a flat org structure.
- **Peer-to-peer sharing** (a Workspace Owner shares with other Workspaces). Rejected: a
  Workspace Owner can't see other Workspaces (`authorization.ts`), so there's no coherent
  way to target a share; it also needs an opt-in handshake and muddies "a Workspace is
  owned by exactly one User." Making sharing an **Org Admin** action — the one role that
  sees every Workspace — dissolves this entirely.
- **Copy-on-share.** Rejected: reintroduces the drift the feature exists to eliminate.
- **Implicit/transitive sharing** (sharing an Agent cascades shares to its Skills/MCPs).
  Rejected: creates intractable lifecycle questions (when to revoke an implicit share,
  whether it's used elsewhere, orphaning on detach). The explicit-prerequisite rule above
  makes all of them vanish.
- **A second `workspaceId` column on a Shared resource** (to retain origin edit rights).
  Rejected: the Workspace↔Shared-resource relationship is many-to-many (share with
  _specific_ Workspaces), so it belongs in an Attachment table, not a column. Edit rights
  are role-based instead (see Consequences), which preserves the author's edit/test loop
  without overloading the scope discriminator.

## Consequences

- **Reference buckets.** A Shared Agent's references fall into three buckets:
  _travels-with_ (Provider, Skills, sub-Agents, MCPs — must be Organization-scoped),
  _rebinds-per-Workspace_ (the Sandbox tool set resolves to the invoking Workspace's
  0-or-1 Sandbox at Chat-turn time), and _always-available_ (statically registered tool
  sets). This matches the roadmap's "shared Agent definitions run against the invoking
  Workspace's resources."
- **Org-scoped MCP is a prerequisite.** MCPs must gain Organization scope (like
  `Provider`) before a Shared Agent can reference one; Chat-turn MCP resolution, today
  workspace-scoped, must also resolve Organization-scoped MCPs. A down Shared MCP has
  org-wide blast radius, so its resolution should fail soft rather than throw.
- **Role-based editing (Edit 1).** A Shared resource is edited **only on the
  Organization management surface**; it is locked in every Workspace — to Workspace
  Owners _and_ Org Admins alike (the Workspace renders it as a locked card that links out
  to the Organization editor). Because only Org Admins can Promote, the author is always
  an Org Admin; a non-admin who authored a resource is locked out of editing it once it is
  Shared — intentional, consistent with ADR-0006 (high-blast-radius config is
  admin-managed). _Originally specified as also editable in place in the Workspace where
  attached; narrowed to org-surface-only so there is a single edit locus and no
  "which-Workspace-do-I-open?" ambiguity, matching how Skills already behaved._
- **Visibility.** A Shared resource appears in a Workspace only where attached; Promotion
  auto-attaches the origin Workspace. Org Admins see and manage every Shared resource,
  attached or not, only on the Organization management surface — not implicitly inside
  every Workspace.
- **Deletion.** Deleting a Shared resource is blocked while any Attachment exists.
  **(Edit 1)** On delete, the resource's id is scrubbed from every Agent that referenced
  it (`skillIds`, `subAgentIds`, and MCP-backed `toolSetIds`), in the same transaction, so
  deletion never leaves dangling references; `providerId` needs no scrub as it is a
  foreign key with `onDelete: restrict`. **Detach** is deliberately _not_ scrubbed — it is
  reversible, so an Agent's reference is preserved and resolves again if the resource is
  re-attached.
