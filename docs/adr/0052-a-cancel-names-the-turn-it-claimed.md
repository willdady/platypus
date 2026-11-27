---
status: accepted
---

# An A2A cancel names the turn it claimed, not the moment it was decided

ADR-0054 said a cancel carries the moment it was decided, so it stops only a run
claimed before then. That compares clocks from two instances: a run's start time
comes from the instance running it, while `canceledAt` comes from the instance
that took the cancel. Skew between them let a cancel stop the Chat's next turn —
for example a run started by a regenerate of the canceled turn — and the sweep
over canceled Tasks had the same flaw, measuring the cancel's stamp against the
oldest run this instance holds. A cancel now names the **turn** it means to
stop: the Chat turn id, the user message that started the run. A run registers
the turn it is for, a cancel carries that turn, and the registry stops the run
only when the two ids match. No clock is read, so skew cannot reach the wrong
run.

`cancelTask` passes the claimed Task's `messageId`, which is the turn id the
A2A run registered. The sweep for a cancel whose NOTIFY was lost matches each
held run's turn against the canceled Tasks' turns the same way, in place of its
cancel-stamp window. A run registers the user message its turn belongs to: a
submit its own id, a regenerate the message it answers, and an approvals
continuation the user message its approved reply answers, so every run of a
turn is stopped and settled by the turn's id alike. A cancel that names no
turn, as a User's cancel of a Chat does, still stops whatever run this
instance holds, because the User means the Chat's current run.

## Considered Options

- **Keep the moment and tolerate the skew.** Rejected: the wrong run is
  expensive to stop, and a regenerate that starts within the skew is exactly
  the turn the User wants to keep.
- **Record a run id on the Task when the run starts.** Rejected: it needs a new
  column, a write at run start that races the cancel, and it identifies no more
  than the turn id already does for an A2A Task.

## Consequences

- A canceled Task's `canceledAt` now means one thing: the cancel is owed to a
  run that may still be going. The run's own end clears it, so the sweep only
  finds a cancel while its run has not ended. A regenerate of the canceled turn
  starts after that run's terminal write, so it is spared; only a run that was
  already going when the cancel was claimed is stopped.
- No run before this change ever cleared `canceledAt`, so the deploy clears the
  stamp on every settled Task (migration `0108_clear_settled_a2a_canceled_at`)
  to give the stamp its one meaning from the first sweep onward.
- A `run_cancel` payload now carries `turnId` in place of `startedBefore`, so an
  instance still sending the old key is ignored as an unknown shape during a
  rolling deploy, as ADR-0054 already accepts for payloads it does not know.
