---
status: accepted
---

# A Trigger run's Chat is read-only

A Trigger run keeps its Transcript as a Chat (ADR-0044) so an Agent can read
what actually happened, which only holds while the record is what the run
produced. Every mutating Chat operation therefore refuses a Chat carrying a
`triggerRunId` with a `409`: a turn — regenerate and approval answers included —
compaction, a message delete, an Active-path switch, a rename, and deleting the
Chat. Reading it and cancelling its run stay open, since the Chat's id is the
run's id. A run Chat is still removed with its run when Max Runs to Keep prunes
it or the run is deleted; that path removes rows directly, never through a Chat
route.

## Considered Options

- **Let the Workspace Owner edit a run's record as commentary.** Rejected:
  nothing distinguishes the run's output from the User's revision once written,
  and the record's purpose is the Agent reading what happened.
- **Refuse only the writes that change the model's next input.** Rejected as
  arbitrary: a title or pin is still part of the record a reader sees, and one
  guard over every mutation is easier to keep complete than a per-route
  judgement.
