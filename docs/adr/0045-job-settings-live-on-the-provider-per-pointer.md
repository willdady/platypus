---
status: accepted-pending-implementation
implemented-by: "#1922"
---

# Job settings live on the Provider, per pointer

> **Today:** the Provider's background jobs send no Reasoning controls or sampling parameters, and `taskModelId` and `memoryExtractionModelId` are free-text ids. None of this is built yet.

A Provider's own background jobs (the task model's titles and Transcript summaries; memory extraction) call the model directly and sent no Reasoning controls or sampling parameters, so a thinking model always thought at its server default (#1922). We store **Job settings** on the Provider, one block beside each of `taskModelId` and `memoryExtractionModelId`, with the same fields and resolution as ADR-0040 (an empty field sends nothing; a set value beats the job's built-in default; Thinking, Effort and Thinking budget follow the chosen model's Reasoning map). The two pointers must name a declared Model entry, so a Reasoning map is always reachable.

## Considered Options

- **Settings on the Model entry, as defaults for everything.** Rejected. An entry is one per concrete model id, so it cannot say "thinking on for Chats, off for extraction" on the same model, which is the motivating case. It would also add a layer under Agents and Chats and change ADR-0040's resolution rules.
- **One block shared by every job on the Task model.** Rejected for now: titles and summaries share the Task model's block; split later if someone needs it.

## Consequences

- A Transcript summary that falls back to the Chat's model sends no Job settings. They belong to the task model and may not be valid for the Chat's model. When the task model is the Chat's model, the task block applies.
- Output caps stay internal.
- Existing Providers whose pointer is not a declared entry keep working; the form flags the stale id.
