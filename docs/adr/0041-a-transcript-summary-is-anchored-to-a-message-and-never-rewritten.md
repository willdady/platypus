---
status: accepted
---

# A Transcript summary is anchored to a message, and never rewritten

A long **Chat** re-sends its whole **Transcript** on every turn until the
Provider rejects the request and the turn fails. **Tool-result clearing** bends
that curve only for read-only tool results; a Chat that is mostly text keeps
growing. The answer is to let a model read a durable condensation of the older
Transcript in place of those messages, while the stored Transcript — every
message, every **Alternative** — stays exactly as it was, for the reasons
ADR-0026 gives for the tree and ADR-0018 gives for measuring rather than
estimating.

## Decision

A **Transcript summary** is a row saying "everything on the **Active path**
from the root through message X, condensed". X is always an assistant message,
because a summary cuts at a turn boundary, and the row carries the ids of the
live path it covered (`coveredIds`), the summary text, and the model and
token counts that produced it.

**Rows are never updated.** There is no version column and no
compare-and-swap writer. The two hazards a CAS would have solved both became
impossible by construction: a watermark moving backward on a history edit
cannot happen now that an edit or a regenerate adds an **Alternative** (a
sibling) rather than rewriting the path to an existing anchor, and two runs
racing over one Chat is prevented across instances by the one-run claim
(#1253). The remaining hazard — a **Delete** inside a summarised range — is
caught when the summary is read: a summary is usable only while its
`coveredIds` are exactly the live path from the root through its anchor. A
delete breaks that equality, the summary is skipped, and the next one up (or
none) is used. Nothing has to be invalidated, so nothing can be invalidated
wrongly.

**A stale reading is a decision to compact again, not a smaller number.** A
summary a Delete has broken makes the last occupancy reading describe a view
the next turn will not send. Each assistant message therefore records which
summary its reading was taken through, and a reading whose summary is no longer
usable makes the next turn due for the backstop.

**The summary is read at send time, never stored as a message.** It reaches the
model as a labelled leading text part of the first message kept verbatim —
always a user message, because the anchor ends a turn — never as a message of
its own (two user messages in a row break some vLLM chat templates) and never in
the **System prompt** (ADR-0020 keeps that byte-identical while a Chat is
active). Skill bodies loaded inside the summarised range are re-injected after
the summary, once per Skill, latest load, skipping any Skill the kept tail still
loads.

**Hysteresis is the rule for any context reduction**, not a detail of this one.
Compaction fires at one fraction of the declared **Context window** and leaves a
clearly smaller tail: the trigger is 0.8 and the kept tail four turns, shrinking
to one turn when the reading that triggered it already ran with a summary in
place. **Tool-result clearing** keeps its own lower trigger (0.7) so the cheaper
mechanism always gets the first try, and may adopt the same trigger/target shape
later under this ADR rather than a new one.

**Both passes are off the response path, with a backstop that is not.** After a
turn whose final **Projected occupancy** crossed the trigger, a summary is
started without blocking the reply; the next turn finds it waiting. If a turn
starts at 0.95 of the window with no usable summary — or with a stale reading —
it waits for one, joining a pass already in flight for that Chat rather than
starting a second, and emits a visible status as the turn's first Run event
(ADR-0023).

**The Chat's own model writes the summary, passed in as a parameter.** It always
has the window being protected and is always reachable. Its input is
incremental: the previous usable summary plus the messages after its anchor, so
a pass costs about one window's worth, never the whole Chat. Tool-result clearing
is applied to that input unconditionally, and an overflow retries once with an
earlier anchor. A summary failure is logged and never fatal.

## Considered options

- **The versioned CAS writer from #261** — rejected. It existed to settle a
  backward watermark and two racing runs, and neither can now occur; keeping it
  would mean maintaining a lock for a race the tree model deleted.
- **A summary column on the Chat, or a watermark index** — rejected. A Chat is a
  tree of Alternatives with different paths; a summary is a fact about a path.
  A column would have to be rewritten (and invalidated) on every branch switch.
- **Storing the summary as a `chat_message`** — rejected. It would appear as
  something the model or the User said, and would be re-sent as a message rather
  than replacing the range it condenses.
- **Summarising synchronously before every turn** — rejected. It puts a
  model call's latency in front of every turn that crosses the trigger, where a
  pass started after the previous turn costs the User nothing.
- **An estimator or tokenizer to size the tail by tokens** — rejected
  (ADR-0018). The kept tail is counted in turns, and a summary that lands large
  is correct again on the next pass.
- **A cheaper summariser model in v1** — deferred, not rejected; see below.
- **Summarising a Trigger run or a Sub-Agent run** — rejected. They start with
  no Transcript; they rely on clearing and on overflow recovery.

## Consequences

- **A Chat with no declared Context window never summarises**, exactly as it
  gets no Tool-result clearing (ADR-0018). The docs say so.
- **Cost is real and visible only to the Operator.** A pass can send a window's
  worth of input to the Chat's most capable model. Those tokens belong to no
  turn's **Token usage**; `stats` records the model and the vendor's input and
  output counts from day one.
- **Taking a summary invalidates the cached prefix once.** Hysteresis makes it
  rare, and every later turn caches against the new, shorter prefix.
- **A Delete can make a Chat momentarily larger.** Deleting inside a summarised
  range retires the summary, so the next turn sends from the next summary up, or
  from the root. The stale-reading rule makes that turn take a fresh summary
  before it calls the model, so it does not simply overflow.
- **The divider is a record, not a control.** The Chat renders it only for the
  summary it actually reads. There is no "discard this summary" control.

## Deferred, with the constraint already in place

Each of these is deliberately not built yet. The constraint that makes it cheap
later is in the code today, so the issue can be closed and the constraint
survives.

| Deferred                                              | Constraint already in place                                                                                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A "discard this summary" control                      | It is `/compact` (#1111): a new summary supersedes the old by being newer at the same anchor. `chat_summary` needs no `discardedAt` column for it.                           |
| A cheaper summariser model, or the Workspace's one    | The summariser takes its model as a parameter and records the model id in `stats`, so switching is a resolver change, not a schema change.                                   |
| Showing what a summary cost                           | `stats` stores the model and the vendor's input and output counts from day one. Usage never recorded could never be shown.                                                   |
| A live "compacting…" trace in more places             | The backstop's status is a Run event (ADR-0023), not a one-off UI flag. A later trace is the same event rendered in more places, not a second mechanism.                     |
| The general in-call trim (R2 of #1263)                | Overflow is caught at the summary pass, which is the seam a general retry plugs into. **At most one retry per step, whichever strategy takes it** is the rule this ADR sets. |
| Summarising older steps inside a long tool-using turn | This ADR's hysteresis rule is stated generally, so an in-turn pass adopts it under the same decision rather than a new one.                                                  |
| An ingestion cap for MCP results and `fetchUrl`       | One wording and one shape for "too large; request less" is used by the summary pass's overflow retry, so the cap and the recovery path teach the model one pattern.          |
| Batch clearing for cache hits (`clear_at_least`)      | Trigger/target hysteresis is stated here as the rule for any context reduction, so clearing can adopt it later under this ADR.                                               |

## Notes

- **`/compact` (#1111) takes a summary on demand.** It is the same pass, steered
  by the User's instruction, with no turn kept verbatim: the anchor is the
  Active path's last assistant message, and the summary rides the next user
  message sent. It needs no declared **Context window**, so "a Chat with no
  declared Context window never summarises" now reads "never summarises on its
  own". Built-in command names are reserved: a Skill may not take one.

## References

- #1263 (the umbrella), #1716 (this tier), #1111 (`/compact`), #1253 (one run
  per Chat).
- ADR-0018 (declared windows, Projected occupancy, clearing's Notes), ADR-0020
  (stable System prompt), ADR-0021 (read-only hint), ADR-0023 (Run timelines),
  ADR-0026 (the Chat as a tree of message rows, Delete included).
