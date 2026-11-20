---
status: accepted
---

# Job settings live on the Provider, per pointer

A Provider's own background jobs (the task model's titles and Transcript summaries; memory extraction) call the model directly and sent no Reasoning controls or sampling parameters, so a thinking model always thought at its server default (#1922). We store **Job settings** on the Provider, one block beside each of `taskModelId` and `memoryExtractionModelId`, with the same fields and resolution as ADR-0040 (an empty field sends nothing; a set value beats the job's built-in default; Thinking, Effort and Thinking budget follow the chosen model's Reasoning map). The form offers only declared Model entries for the two pointers, so a Reasoning map is reachable. The API does not enforce it, because a pointer saved before this change must keep saving.

## Considered Options

- **Settings on the Model entry, as defaults for everything.** Rejected. An entry is one per concrete model id, so it cannot say "thinking on for Chats, off for extraction" on the same model, which is the motivating case. It would also add a layer under Agents and Chats and change ADR-0040's resolution rules.
- **One block shared by every job on the Task model.** Rejected for now: titles and summaries share the Task model's block; split later if someone needs it.

## Consequences

- A Transcript summary that falls back to the Chat's model sends no Job settings. They belong to the task model and may not be valid for the Chat's model. When the task model is the Chat's model, the task block applies to the Chat's own call, and there is no plain retry on the same model.
- Reasoning resolves only once a Reasoning control the model offers is set. A block with none set — empty, sampling alone, or only a value kept from a model that offered a control this one does not — sends no fragment, not even the Reasoning map's `always` and `default` a turn would get, so a Provider nobody has touched sends its jobs as before. A kept value stays stored, as on an Agent, and applies again on a model that offers its control. Once an offered control is set, the block resolves exactly as ADR-0040.
- A job's built-in default, such as extraction's `temperature: 0.3`, counts as set sampling: it is removed from the map's fragment, so only a Temperature in the block replaces it.
- Output caps stay internal.
- Existing Providers whose pointer is not a declared entry keep working; the form flags the stale id.
