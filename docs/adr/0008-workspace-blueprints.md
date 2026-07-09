---
status: accepted
---

# Workspace Blueprints and admin-only Workspace creation

A **Blueprint** is a named, Organization-scoped **macro**: applied to a Workspace it
creates, in one step, the **Attachments** for a chosen set of Shared resources (ADR-0007)
that an Org Admin would otherwise wire in by hand. It runs **once** at provisioning and is
re-runnable on demand — it is **not** a living binding. Together with a change making
Workspace creation **Org-Admin-only**, Blueprints are how an Org Admin hands a new member a
ready-to-use Workspace instead of an empty one.

## Snapshot, not a living binding

Applying a Blueprint stamps Attachments at that moment; later edits to the Blueprint affect
only _future_ applications, never already-provisioned Workspaces. Re-application is additive
and idempotent (re-attaching is a no-op), so an admin can top up a Workspace later.

A living binding (Workspaces stay subscribed; Blueprint edits propagate) was rejected. The
two outcomes it appears to offer — Shared resources being **configured identically** across
Workspaces, and a Workspace Owner being **unable to remove** them — are _already guaranteed
by ADR-0007_ (single source of truth; admin-governed Attachments). The only thing a living
binding adds over a snapshot is automatic propagation of set-_additions_ to a group — an
ergonomics gain, not a capability — and its removal direction (deleting a line silently
detaches an Agent from every subscribed Workspace) would **contradict** ADR-0007's rule that
mass-removal is guarded (deletion blocked while attached). Continuous-governance "policy"
semantics are therefore deliberately out of scope.

## What a Blueprint may carry (v1)

- **Tier 1 — Attach Shared resources.** Agents, Skills, MCPs, Providers. The core.
- **Tier 2 — Set Workspace pointer-settings.** The Workspace's `taskModelProviderId` and
  memory provider fields, and an optional default Context — all _references_ to org-scoped
  things, so consistent with the attachment-macro model.
- **Tier 3 — DEFERRED.** Seeding Workspace-_owned_ resources (notably a Sandbox from a
  template, or editable starter Agents/Skills) is copy-not-reference and drags in ADR-0006
  credential/reach provisioning; it needs its own design pass. Consequence: a Blueprint
  whose Agents rely on the Sandbox tool set ships those tools absent until an admin creates
  the Workspace's one Sandbox by hand (graceful per ADR-0001).

## Application — Org Admins only

- **On an invitation.** The invitation carries an optional _ordered set_ of Blueprints
  (refined from the original single `blueprintId` — see ADR-0009) and an optional Workspace
  name (default `"<member>'s Workspace"`). **Accepting an invitation always creates a
  Workspace owned by the accepting member**; any Blueprints set are applied in order. A
  Blueprint-less invite yields an empty Workspace, not no Workspace.
- **Ad-hoc re-apply.** An Org Admin runs a Blueprint against an existing Workspace from the
  Organization surface.
- Members never select Blueprints themselves (that would let a non-admin attach
  admin-governed Shared resources). A future "self-serviceable Blueprint" feature could
  relax this; deferred.

## Workspace creation is Org-Admin-only

Workspace creation is restricted to Org Admins — no per-org switch. This closes the gap
where a member provisioned into a governed Workspace could simply create empty, ungoverned
ones beside it (the contractor-sandboxing case), and aligns with the roadmap vision of one
builder equipping a team of consumers. It is a deliberate behavior change for existing
installs (members could previously self-create).

## Considered Options

- **Living-binding Blueprints** — rejected; see above.
- **A per-org "who can create Workspaces" switch** (anyone / admins-only) — rejected in
  favour of the simpler hard rule; the switch's flexibility wasn't worth the governance
  ambiguity, and the goal is to _enforce_ the provisioned-Workspace model.

## Consequences

- **`ownerId` becomes admin-assignable.** The create handler no longer forces owner to the
  caller (`workspace.ts:34`); an admin names the owner, and the invite-accept path sets owner
  to the accepting member. Existing member-owned Workspaces are grandfathered.
- **Deletion guard extended (Edit 1).** A Shared resource cannot be deleted while it is
  _either_ attached to a Workspace _or_ listed in a Blueprint — nothing still pointed-at is
  deletable.
- **Org-scoped MCP remains a prerequisite** (ADR-0007) before Blueprints can list one.
- **Blueprint management** lives on the Organization admin surface alongside org Providers
  and Shared resources; create/edit/delete is Org-Admin-only.
