---
status: accepted
---

# Trigger runs are bounded by an Operator-set run-rate breaker, counted per entity

The debounce folds a rapid burst of events into one run, but nothing else stops
a slow loop: two Event Triggers can hand a record back and forth, each event
arriving after the run that caused it finished, and the self-actor guard only
blocks an Agent's own writes. Each lap costs a full Drive. So every Event and
Inbound Trigger firing passes a breaker: at most `TRIGGER_BREAKER_MAX_RUNS` runs
per Trigger per entity in a rolling `TRIGGER_BREAKER_WINDOW_SECONDS`. A firing
past the ceiling is recorded as a `suppressed` run, which is how the trip shows
on the runs page, and no Agent starts.

- **The ceiling is the Operator's, in the environment, not a Trigger field.** A
  limit the Workspace Owner can raise is not a ceiling. A malformed value fails
  startup rather than falling back to a default nobody chose.
- **It counts per entity.** A busy Card must not hold back a Trigger's work on
  another. A firing that names no single entity (a bulk event) is exempt:
  counting it would trip a Trigger after N unrelated deletions.
- **Suppressed rows do not count.** Counting them would hold a Trigger down for
  as long as events keep arriving, instead of letting the window roll.
- **It is checked when the run would start, after the debounce.** A burst then
  folds into one firing before the count, so it cannot manufacture suppressed
  rows. An inbound call is counted when it is accepted, because its response
  owes the verdict.
- **Retention keeps every run inside the window.** A Trigger keeps its newest
  `maxRunsToKeep` runs plus every run started within the window, so pruning can
  never delete the rows the count reads; at `maxRunsToKeep: 1` the ceiling could
  otherwise never trip. Suppressed rows have their own retention budget, so a
  runaway's suppressions do not evict the runs that explain it. A window longer
  than the default is logged at boot, since it grows run history for its whole
  length.

## Considered options

- **A per-Trigger limit set by the Workspace Owner.** Rejected: it is a tunable,
  not a safety property, and `maxRunsToKeep` already shows the harm of letting a
  retention setting govern run-rate behaviour.
