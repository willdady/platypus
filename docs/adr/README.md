# Architecture Decision Records

Sequentially numbered, `NNNN-slug.md`. Each records one decision, why it was
made, and what was rejected. Take the highest existing number and increment.

Format and the "is this worth an ADR" test live in
`.agents/skills/domain-modeling/ADR-FORMAT.md`. This file records only the
conventions specific to this repo.

## Status vocabulary

Every ADR carries a `status` in its frontmatter.

| Status                            | Means                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `accepted`                        | Decided, **and the code matches**. The default, and where an ADR should end up.   |
| `accepted-pending-implementation` | Decided, but not built yet. The ADR describes a target, not the current codebase. |
| `superseded-by-NNNN`              | A later ADR replaced this decision.                                               |
| `deprecated`                      | No longer applies, and nothing replaced it.                                       |

`accepted-pending-implementation` exists because an ADR and the change it
describes often land in separate PRs — a decision is worth recording the day it
is made, while the implementation waits on a ticket. Without the distinction, a
reader goes looking for code that does not exist and assumes the ADR is stale or
that they have misread the codebase.

An ADR in that state must also carry:

- an `implemented-by` frontmatter key naming the issue or PR that will build it, and
- a short admonition immediately under the title saying what the code does
  **today**, so nobody has to diff the ADR against the repo to find out.

**Flipping it to `accepted` is part of the implementing PR**, alongside the code.
An ADR left at `accepted-pending-implementation` after its change has shipped is
worse than one that never had the status, so the implementing ticket should carry
it as an acceptance criterion.

## Amending an existing ADR

Never rewrite an accepted ADR's history — a reader needs to see what was decided
at the time, not a tidied version. Append an `## Amended by ADR-NNNN` section to
the older ADR stating which of its claims are narrowed or withdrawn, and let the
newer ADR carry the reasoning. Same for a full supersede: the old ADR keeps its
text and gains a pointer.
