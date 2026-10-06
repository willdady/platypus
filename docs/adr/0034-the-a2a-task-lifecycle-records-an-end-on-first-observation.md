---
status: accepted
---

# The A2A Task lifecycle records an end on first observation

An **A2A Task** (ADR-0032) reads its state from its Chat's run while the run is going. Once the run ends, its end is recorded on the Task with the reply it wrote, and **the first end recorded stands**: a later end, a cancel, a regenerate or a delete of the reply changes nothing the Task reads. One lifecycle owns every write of that end and every decision that a push is owed. It records an end from the run's terminal transaction, after the run's end commits, for a run that died, for a cancel, and on any read through it that finds an end not yet recorded.

So a read through the lifecycle may write. That is deliberate. Until an end is recorded, it is derived from the Chat: its status, its active leaf, and the first reply under the Task's message. Every one of those can change after the run ends. The Owner can regenerate the reply, delete it, or send the next turn. An unrecorded end is therefore unstable: a client that reads `completed` once could read `failed` on the next call. Recording it the first time anyone reads it is what makes the first end the one that stands. It also means the end is pushed once, whoever noticed it.

The dependency direction follows from that:

- **The read model** derives a Task's status from what is in the database and never writes or pushes. A derived end it cannot vouch for is handed back as unrecorded.
- **Delivery** posts a recorded end to the client's push configs: the egress guard, the per-Task cap, config registration. It imports only the read model, and pushes only an end already recorded.
- **The lifecycle** imports both. It records ends, decides which Tasks owe a push, and exports the reconciling reads that routes and services use.

Callers reach the Task through the lifecycle, the lifecycle reaches the read model and delivery, and delivery reaches the read model. Nothing points back, so no module needs a callback injected to break a cycle.

## Considered Options

- **Reads never write; only the run's end records.** Rejected. A run's end can be lost when its instance dies between the run and its commit, and a Task can be made just as its run ends. Such a Task would read whatever the Chat says now, and that drifts as the Owner works in the Chat. The sweep would eventually record something, but not necessarily what the client was told.
- **Keep recording inside the read model.** Rejected. It is what the code did before. The read model then called delivery to push what it recorded, and delivery called the read model to read what it pushed. That cycle hid the write in a function named for reading, and every fix to how a Task ends touched four to nine files.
- **Break the cycle with an injected push callback.** Rejected. It hides the same dependency behind a late binding and leaves the write where it was.

## Consequences

- **Every write of a Task's end is in one module.** A change to how a Task ends is made there, and its tests run against Postgres in one place.
- **A read may cost a write.** It is one conditional update, made once per Task, and only for a Task whose end was not yet recorded.
- **Delivery cannot record.** A caller that registers a push config reads the Task through the lifecycle first, so an end the Task has reached is recorded and the config is pushed at once.
