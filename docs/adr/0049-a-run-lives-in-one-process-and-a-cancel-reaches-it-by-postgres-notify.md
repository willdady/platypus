---
status: accepted
---

# A run lives in one process, and a cancel reaches it by Postgres NOTIFY, at most once

A run's abort controller and its step and run timers live in the run registry
of the process that claimed it, and nowhere else. The registry refuses a second
claim on a run id only within that process. What the deployment shares lives in
Postgres: a Chat's one-run lock is its row's `running` status, and a cancel is
passed between instances on the `run_cancel` channel.

A cancel first tries the local registry. Only when this process does not hold
the run does it send a `NOTIFY`, which every instance's listener receives and
the one holding the run acts on. A cancel carries the moment it was decided, so
it stops only a run claimed before then and never the Chat's next turn.

Delivery is at most once. A cancel sent while an instance's listener is
reconnecting is missed, and nothing retries it. That is accepted because the
run's per-run timeout still bounds it, and an A2A Task's cancel is also written
to its Task row, which that instance's sweep finds (ADR-0032).

The payload is read strictly. A cancel carrying any key `cancelRun` does not
write, such as a field from a newer version during a rolling deploy, is logged
and dropped rather than half-read. A payload that does not parse never throws,
because the handler runs on the shared listener connection, and one bad
notification must not take the channel down for every other cancel.
