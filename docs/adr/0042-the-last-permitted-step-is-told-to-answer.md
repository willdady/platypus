---
status: accepted
---

# The last permitted step is told to answer, and keeps its tools

A turn that reaches its **Step ceiling** used to end wherever the model had got
to. If the model was still calling tools on its last allowed call, the loop
simply ended: the reply was often a Tool row with nothing after it. #261 measured
one such turn — 15 steps, 7 × `web_search`, 11 × `read_url` — that spent its
whole budget researching and never answered. #1263 does not cover it: nothing
here is a context problem. The decision is that the last call the ceiling allows
is an **answer step**. The model is told, in that request and in that request
only, that the turn ends after it, that no tool result it asks for can come back
to it, and that it must answer from what it has gathered and name what it could
not finish. The step counts **inside** the ceiling — a ceiling of one puts the
instruction on the only call, and no turn makes `maxSteps + 1` calls.

## Considered options

- **`toolChoice: "none"` on the last step.** The obvious reading of "reserve the
  step for an answer", and rejected on two measured grounds. On Bedrock the
  provider reads `none` by emptying its tool list, so the request declares no
  tools while the conversation it carries is still full of `toolUse` and
  `toolResult` blocks — exactly the shape the disabled-tools path exists to
  avoid, arriving at the vendor instead. Across every Provider type it also
  changes the front of the request, and the front is what is cached (ADR-0020):
  the whole research phase would be re-read at full price on the one call that is
  supposed to use it.
- **`activeTools: []`, or any Provider-type branch.** The same prefix problem
  without even the vendor-side guarantee, and a branch is what the caching seam
  deliberately does not have.
- **One extra step on top of `maxSteps`.** Rejected because it silently changes
  what the User's **Max steps** number means, and because the docs, the statistics
  and the A2A `max_steps` reason would all have to say "plus one".
- **A notice only, with no answer step.** This is what the code did. It leaves
  the common case — a model that would have answered if it had known — ending
  with no answer at all, and it offers the reader no remedy.

## Consequences

- **The instruction is a trailing user message, and nothing else changes.** No
  `tools`, `activeTools` or `toolChoice` override; `prepareStep` returns only a
  `messages` array, as it already did for Tool-result clearing and the Bedrock
  cache point. Every Provider coalesces a user message that follows tool results
  into the same turn, so there is one wire message, not two.
- **It exists in the request only.** `prepareStep`'s override never reaches the
  reducer's response messages, so nothing is persisted, rendered, or replayed on
  a later turn.
- **The Bedrock point still trails the request.** The point is placed after the
  instruction, because the instruction is the final message. The prefix in front
  of it is byte-identical to the previous step, which is what keeps the cache
  read.
- **A model that ignores it still cuts off visibly.** It calls a tool, the loop
  stops after that step, `stoppedAtStepLimit` is recorded and the "cut short at
  the step limit" notice is shown exactly as before. A model that stops on the
  answer step without writing anything is recorded the same way: the ceiling was
  reached and the turn is unanswered, and the notice is the fallback rather than
  a silent empty reply.
- **The terminal status does not change.** A **Trigger run** that reaches its
  ceiling is still `succeeded`, including when the answer step writes nothing.
  That is the counterpart of #1690 rather than a contradiction of it: an empty
  **Trigger run** at the **Output ceiling** is a reply the Provider broke off
  with nothing written, while a step-ceiling stop spent exactly the budget the
  Operator set and did the work it was allowed to do. Both are told to the
  reader; only the first is a failure.
- **The notices now name the remedy**, not just the fact: "Raise Max steps to
  let it finish." The field exists in every shape — an Agent's, a Sub-Agent's
  own, and a direct Chat's setting.

## References

- #1730 (this decision), #261 (the measurement), #1263 (the umbrella), #1690
  (the Output-ceiling analogue for Trigger runs), #540 and #324 (the notices and
  the empty-delegate fallback).
- ADR-0018 (declared context windows, tool-result clearing), ADR-0020 (the
  stable cached prefix, and the tail channel this ADR declines to build).
