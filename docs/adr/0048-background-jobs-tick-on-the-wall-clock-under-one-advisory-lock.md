---
status: accepted
---

# Background jobs tick on the wall clock under one advisory lock, and a sweep is safe by age, not by the lock

Every backend instance runs the same scheduler, so its jobs have to be safe
when they run on several instances at once. Each job runs at absolute clock
boundaries (`:00`, `:01`, …), not on a `setInterval` that starts at boot. That
way every instance contends for the Postgres advisory lock at the same moment,
and only one wins each cycle. A tick that loses does not wait for the lock. The
stop handle a shutdown calls clears the pending tick. A tick already running
still finishes but schedules no further tick, and the memory-extraction worker
stops at the next Chat boundary rather than mid-write.

One lock, taken once per tick, covers the Trigger and Chat recovery sweeps, the
One-off reap, the A2A missed-end sweep, the token reminders and the claiming
of due Cron Triggers, in that order. Recovery runs every tick, so a crash heals
without a restart. Each step is wrapped on its own, so one step failing does
not skip the others. The Chat sweep runs before the A2A sweep, so a Task whose
Chat it just failed is seen in the same tick.

The lock only keeps two sweeps from running at the same time. It does not keep
a sweep away from a peer's live run, which executes outside the lock in the
process that started it. A sweep is safe because it only touches rows old
enough that no live owner can remain:

- **Trigger run, `running`:** older than `TRIGGER_PER_RUN_TIMEOUT_MS` plus a
  5-minute buffer. Any live instance would have aborted the run by then. The
  buffer lets the normal timeout path write the failure first. The cutoff comes
  from the Trigger per-run timeout, not the run registry's 10-minute fallback,
  which Trigger runs never use. A cutoff based on that fallback failed live runs
  at 15 minutes that were allowed 60. The setting is read per process, so
  instances sharing a database must use the same value.
- **Inbound Trigger run, `pending`:** older than the buffer alone. A pending
  run has not started, so no per-run timeout bounds it, and it holds its
  record's dedup (ADR-0030).
- **Chat, `running`:** its run heartbeat is stale. An instance holding a run
  stamps it every few seconds, so a Chat not stamped for a minute has no owner,
  whatever the Chat per-run timeout. A swept Chat is marked `failed`, not
  `cancelled`, because nobody asked for a cancellation. Run events left open
  are closed with the run's status and no duration, since nobody saw them end.

Claiming a due Cron Trigger is one conditional `UPDATE … RETURNING` that writes
its next schedule (or disables a One-off) and matches only while the Trigger is
enabled, due and not already running. A Trigger therefore fires once however
many ticks race for it, and a crash after the claim never leaves it without a
schedule. Counting the running runs and then claiming relies on the lock, so no
peer claims between the two. `SCHEDULE_MAX_CONCURRENT` caps Cron runs across the
whole cluster. Event Trigger runs are not counted. A due Trigger still running
from its last firing is skipped to its next slot and takes no slot.

Work started under the lock is never awaited: neither a fired run nor an A2A
push for a swept Chat. One long run or a slow client URL would otherwise stop
every sweep on every instance until it ended (#1158).

Per-process state is acceptable where a peer repeating the work is harmless.
The token reminder sweep runs at most hourly per process, because its thresholds
are days long and each reminder claim is conditional.

## Considered Options

- **Gate sweeps on the lock alone.** Rejected: the lock does not see a peer's
  live run, so a sweep would fail work that is still running.
- **`setInterval` from boot.** Rejected: instances would contend at random
  offsets, which makes lock ownership and sweep timing unpredictable.
