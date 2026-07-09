---
status: accepted
---

# Invitations carry an ordered set of Blueprints

Extends ADR-0008. That ADR had the invitation carry a single optional `blueprintId`. Because
an Organization may keep its Blueprints decomposed along _functional_ axes (e.g. "web search",
"org knowledge base") rather than role axes, a single invitee's one provisioned Workspace
often wants the **union of several** Blueprints. We therefore make an invitation carry an
_ordered set_ of zero-or-more Blueprints, applied in order to the Workspace at accept-time.
Everything else in ADR-0008 (snapshot-not-binding semantics, the three tiers, admin-only
application, ad-hoc re-apply, the Shared-resource deletion guard) is unchanged.

## Decisions

- **Ordered set, not a single reference.** The "an org has many Blueprints" observation alone
  only justifies _per-invitation choice_ (a single FK already gives that). What justifies a
  multi-valued invitation is functional decomposition: composing N Blueprints onto one
  Workspace without forcing admins to pre-name every combination as its own meta-Blueprint
  (combinatorial explosion). Composable Blueprints were the alternative; the ordered set on
  the invitation was simpler and is the only place the multi-ness is _intrinsic_.
- **Order matters: last-write-wins on Tier 2.** Tier 1 (Attachments) is a set, so the union
  composes with no conflict. Tier 2 pointer-settings (`taskModelProviderId`, memory provider
  fields, default Context) are single-valued slots; when two Blueprints set the same slot, the
  **later** Blueprint in the list wins. This mirrors the timeline semantics ADR-0008 already
  established for repeated ad-hoc applies (apply X then Y → Y's Tier 2 overwrites X's).
  Surfacing conflicts as a creation-time validation error was considered and rejected as
  friction; ordering is the model the codebase already implies.
- **The set is intrinsic to invitations only; ad-hoc re-apply stays single-at-a-time.** An
  existing Workspace can already be topped up by repeated single applies (additive +
  idempotent), so multi-select there is purely ergonomic and is deferred. An invitation can't
  be "repeated" — the Workspace doesn't exist yet — so the set genuinely belongs on it.
- **Stored as a junction table** `invitation_blueprint (invitation_id, blueprint_id,
position)`, mirroring `attachment` / `blueprint_item`. `position` makes the order
  first-class rather than an implicit array index, and a real `blueprint_id` FK supports the
  deletion guard below.

## Consequences

- **Deletion guard extended a second link.** ADR-0008 blocks deleting a Shared resource while
  any Blueprint lists it; we now also block deleting a **Blueprint while a _live pending_
  invitation references it** — the literal generalization of "nothing still pointed-at is
  deletable." The chain is Shared resource ← Blueprint ← pending invitation.
- **The guard predicate is `status = 'pending' AND expiresAt > now()`.** Invitation expiry in
  this codebase is _lazy with write-back_ (`user-invitation.ts`): a row stays `pending` until
  read, then flips to `expired` if past `expiresAt`. The guard must therefore exclude
  already-elapsed invites itself rather than trust `status` alone.
- **FK is `ON DELETE CASCADE`, guard enforced in app code — no DB backstop.** A `RESTRICT`
  backstop is untenable: the DB can't cheaply evaluate `expiresAt > now()`, so it would
  over-block on lazily-expired-but-still-`pending` rows, and this codebase deliberately has no
  sweep job to keep `status` truthful. The app-level guard is the single source of truth
  (consistent with expiry itself being app-enforced); CASCADE merely cleans up the historical
  junction rows once a Blueprint is legitimately deletable.
