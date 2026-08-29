---
status: accepted
implemented-by: "#668"
---

# Event causation is ambient run context, not a plugin-boundary parameter

> **In the code today.** `dispatchEvent` reads the ambient causation chain
> established by the Drive that is running (parent Agent, then each delegate),
> and skips an Event Trigger when the Trigger's own Agent appears anywhere in
> it. A human write establishes no chain and is never suppressed, including
> where the record it touched carries stale Agent attribution from an earlier
> edit. See `apps/backend/src/event-causation.ts` and
> `apps/backend/src/services/event-dispatch.ts`.

A Workspace write emits a **Webhook event**, and an **Event Trigger** may run an
Agent in response. Where the Agent that caused the write is the Trigger's own,
running it again is a loop: the run writes, the write fires the Trigger, the
Trigger starts the run. #267 closed that by having each write path hand
`dispatchEvent` the acting Agent's id, which the dispatcher compares against the
Trigger's `agentId`.

That design makes every write path responsible for volunteering its own cause,
and one already forgot. The Notification Tool set has the Agent id in hand — it
writes it into the row it is inserting — and then dispatches three events
without it, so `notification.*` has never engaged the guard for any Agent at any
depth. Nothing caught it: a missing optional argument is indistinguishable from
a human-originated write, which is precisely the case that argument exists to
leave unguarded. The obvious extension — also hand each call site the
originating Trigger, to fix the delegation hole in #668 — would have doubled
what a call site has to remember, and extended that obligation across the plugin
boundary to third-party Tool sets this project never reviews.

The decision is that **causation is ambient to a run, and read by the
dispatcher, never passed by the writer**. A **Drive** establishes what caused it
— the chain of Agents acting, parent through delegates — and `dispatchEvent`
reads that context directly. A write path says nothing about its own cause and
cannot get it wrong; a human-originated HTTP write establishes no context and so
remains unsuppressed, as before.

The rejected alternative was to widen `ToolSetContext` with the ancestor Agents
(or the originating Trigger id). It is the more explicit design and it is where
`agentId` already crosses. It was rejected because that type is a published,
versioned SDK surface (`@platypuschat/plugin-sdk`, API v2, released on its own
cadence), so the correctness of the loop guard would come to depend on every
plugin author forwarding causation faithfully — generalising the failure that
produced the Notification gap to code outside this repo. Keeping causation
backend-internal also leaves the boundary as ADR-0013 drew it: ids the plugin
needs to do its job, and no model of who is responsible for the run.

The consequences worth naming. A Tool set cannot opt out of the guard by
omission, and the Notification gap closes with no change to its call sites.
Because the ambient record carries the whole acting chain rather than the leaf,
an Agent's Sub-Agent writes are attributed to it, which is what makes the
glossary's rule ("an Agent's own writes never fire that Agent's own Event
Trigger") true at any delegation depth rather than only at depth zero. The cost
is that the attribution is implicit: a Tool that detaches work outside the run's
context loses it, and the guard then silently does not apply — a failure that
reads as a spurious Trigger run, not as an error. Suppressing a _cycle between
different Triggers_ (#669) is a different rule that this one cannot express, since
no Agent appears in the other Trigger's chain; the ambient record is the
extension point where the originating Trigger id belongs when that is built.
