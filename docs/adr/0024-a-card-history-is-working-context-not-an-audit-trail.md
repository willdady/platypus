---
status: accepted
---

# A Card history is working context, not an audit trail

A Card carries no record of its own past, so "why is this in Blocked?" has no
answer, and an Agent picking a Card up sees a position with no path to it.
#795 adds a **Card history**: an ordered, capped series of **history entries**
naming what changed, when, and who changed it, readable by an Agent through
`getCard` and by a person on the Card dialog.

The decision is what that history is _for_, because the obvious next step from
"record what changed" is to keep recording more of it until the feature is the
compliance log nobody scoped. **A Card history answers how one Card reached
its current state — and only that.** It is working context for whoever acts on
the Card next. It is not an audit trail, not compliance evidence, not a Board
activity feed, and not analytics. Where a question needs durable, complete,
exportable board activity, the answer is the `card.*` Webhook stream, which
already exists for exactly that and is the boundary here in the way OTEL is the
boundary for a **Run timeline** (ADR-0023).

That boundary is what licenses the three properties a reader would otherwise
file as bugs. Entries are **capped at 50 per Card and the oldest are dropped**,
not archived — a cap is indefensible in an audit trail and unremarkable in
working context, and the constant is fixed rather than Operator-configurable
precisely so the boundary is enforced by the code and not by a default someone
can raise to ten thousand. The history **cascades with the Card**, which also
means `card.deleted` is unloggable by construction: the row recording the
deletion would be deleted by it. And the history is **scoped to field writes
addressed to one Card**, so a Board-level Label deletion — which strips that
Label from every Card carrying it — appears in no Card's history at all. The
alternative, fanning an entry out to every affected Card, turns one click into
unbounded write amplification for the rarest write on the Board.

Two narrower decisions follow the same logic and are recorded here because a
reader will otherwise assume the opposite.

**The `body` field records only that it changed, never its before and after.**
Every other tracked field — title, labels, assignees, due date, priority,
column — stores both values. Body is unbounded Markdown, and storing it twice
per edit is the case ADR-0023 already refused: the moment a capture needs a
truncation policy, the capture is wrong. "Body edited by Ana on Tuesday" is the
useful part at none of the cost. Body edits are therefore legible but not
recoverable, which is the accepted limit.

**A history entry is written inside the Card's own transaction, by the service
function performing the write — not from the event dispatcher.** Hanging it off
`dispatch()` would have caught every write path from one place, and that is
the shape ADR-0022 argues for in general: it rejected making each write path
volunteer its own causation, because one path forgot. The analogy does not hold
here. `dispatchEvent` returns `void` and is unawaited, so a history write hung
off it lands outside the transaction — a rolled-back `moveCard` would still
record the move, and a failed insert would be an unobserved rejection. A
history that can disagree with the Card it describes is worse than no history.
And there is nothing here for a call site to get wrong: history attribution
comes from the explicit `KanbanActor` parameter already threaded through every
Kanban service function, deliberately _not_ from the ambient causation chain,
so an entry and the Card's own `lastEditedBy*` columns can never disagree. That
also means a Sub-Agent's write is attributed to the Sub-Agent, matching the
Card rather than the loop guard, which reasons over the whole acting chain for
its own separate purpose.

The consequence worth naming is the one ADR-0022 predicted: the obligation now
lives at each write path that changes a Card — creation, update, move, copy and
bulk-edit, deletion needing none — and a further path added later can omit it
silently and leave a Card whose history quietly stops being true. Every entry
goes through one writer, which is what appends and trims, so the shape and the
cap cannot drift between call sites; only the call itself can be forgotten, and
it cannot be centralised without giving up the transaction that makes the entry
trustworthy.
