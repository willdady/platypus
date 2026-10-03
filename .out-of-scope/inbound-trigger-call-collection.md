# Collecting Inbound Trigger Calls for a Busy Record

Platypus does **not** keep the inputs of an Inbound Trigger call that arrives
for a record whose run is still pending or running, and it does not start a
follow-up run that hands the Agent every call collected in the meantime. A call
for a busy record gets `202 { runId, deduplicated: true }` with the active
run's id, and its inputs are dropped. That stays the behaviour, and queueing is
the caller's job.

This rejects **the platform owning the queue**, not the underlying need. A
second comment on an issue ("also add the risks") sent while the Agent is still
answering the first one is real work, and losing it is a reasonable thing to
want fixed. What is out of scope is the backend collecting calls and deciding
how to replay them.

## Why it is out of scope

### A run over many collected inputs is not the same run

The proposal assumes one run over several collected calls behaves like several
runs over one call each, just cheaper. It doesn't. The Agent gets a prompt
made of several labelled input blocks, some of them stale or contradicting
each other, plus a line saying they arrived while an earlier run was working.
How a model resolves that is unpredictable: it may weigh the blocks unevenly,
merge instructions that were meant separately, or lose one in the context. The
context grows with every call kept, and quality drops as it does.

An unattended Trigger run is already the least predictable thing Platypus
does. Making what the Agent is handed depend on how many calls happened to
arrive during the previous run adds a second source of variance that an Owner
can't see in the Trigger's configuration and can't reproduce afterwards.

### It makes the endpoint conditional, and that has to be explained

Today the rule is one sentence: one run per record, and calls for a busy record
are dropped. Collection turns that into "dropped, unless kept, in which case
handled later together with the others, unless the cap was reached, or the run
was cancelled, or the token was revoked". Every one of those branches is
behaviour a Workspace Owner has to understand before wiring a caller to it. An
opt-in setting per Trigger would not remove the branches, only add a switch in
front of them.

### Deduplicated calls stop being free

A deduplicated call takes the record's lock, reads the active run and returns.
It writes nothing. That is why it can be answered with `202` however busy the
server is (the concurrency cap only applies to a call that would start a run).
Collection turns each deduplicated call into a write of caller data, stored
and retained under the same rules as `event_data`. A per-record cap bounds the
rows, but a caller re-firing hundreds of times a second still costs a locked
read and a refusal per call, on top of up to N writes per active run, across
every busy record at once. The cheap path is cheap because it stores nothing.

### The caller already knows, and can already queue

Nothing is dropped silently from the caller's side. `deduplicated: true` is in
every response, and the response carries the active run's id, so the caller
can poll the run's status and send the call again once the run has finished.
The caller is also the only party that knows whether its second event means
something new or repeats the first; Platypus can't tell an issue moved to
_AI ready_ twice from a new instruction.

For callers whose Agent reads the record itself, such as an issue and its
comment thread, a single call after the run finishes is enough: the new run
reads everything that arrived in the meantime. A caller that needs every call
handled on its own can use a finer record key (a comment id) and accept
parallel runs on one record.

The docs say all of this in "The record key" on the Triggers page.

## What would change our mind

- **Evidence that caller-side queueing doesn't work for common callers**: an
  automation tool that can neither poll a run nor re-fire later, used widely
  enough that this blocks real deployments.
- **A conversational inbound surface.** Follow-ups that belong to one ongoing
  conversation are what a Chat is for. If inbound integrations need that, the
  answer is a Chat behind the Gateway, not a queue on Trigger runs.

## Prior requests

- #1228 — "collect Inbound Trigger calls for a busy record and run them
  together afterwards, instead of dropping them". Raised while testing Inbound
  Triggers end to end with Jira Automation, and listed as gap 2 in #1231.
