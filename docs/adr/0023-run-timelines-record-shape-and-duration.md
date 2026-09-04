---
status: accepted-pending-implementation
implemented-by: "#647"
---

# A Run timeline records shape and duration, never payloads

> **In the code today.** A **Trigger run** persists one row of aggregates — a
> `stats` blob of step and tool-call counts plus token usage — and nothing
> per-step. There are no Run events, no run detail page, and a delegated run
> leaves no trace at all. See `apps/backend/src/runs/sinks/trigger-sink.ts`.

A **Trigger run** reduces to one row of aggregates, so "why did this take 90
seconds?" has no answer, and a run that fans out to Sub-Agents records nothing
about the delegates at all. #647 adds a durable, timestamped **Run timeline**
and renders it as a waterfall on a run detail page.

The decision is what that timeline is *for*, because the obvious next step from
"record what happened" is to keep recording more of it until the feature is a
second-rate observability platform. **A Run timeline answers where a single
run's time went — and only that.** Each **Run event** records a type, a start,
a duration and a terminal status. It does not record tool inputs, tool outputs,
reasoning content, or model messages. Where a question needs more than the
shape and duration of one run — cross-run percentiles, failure clustering,
flame graphs over many runs of the same Trigger — the answer is to export to
OpenTelemetry, not to grow this.

The rejected alternative was the one #647 originally proposed: capture tool
inputs and outputs from the start, with byte caps and a redaction layer to keep
secrets out. It was rejected because the caps and the redaction are the tell.
Tool payloads are unbounded and arbitrary, so capturing them means inventing a
truncation policy, and they carry whatever the Tool touched, so it means
inventing a redaction policy — and a redaction policy over arbitrary content is
a promise that cannot be kept, since the one secret shape nobody anticipated is
the one that leaks. Worse, `trigger_run` is readable by any Workspace member
while the credentials those payloads would contain are redacted from Providers
and MCPs unless the Organization delegated them (ADR-0006), so payload capture
would have made Run events a way around that rule. Recording no payloads makes
all of it moot rather than merely handled.

The consequences worth naming. The timeline can say a Tool ran for 5.9 seconds
and failed; it cannot say what it was called with, so some debugging still ends
at "reproduce it in a Chat". Error *strings* are the deliberate exception —
captured, capped, and explicitly marked when truncated — because a timeline
that cannot explain a failure answers half the question it exists for; they may
echo fragments of a failed request, and that is a known and accepted limit
rather than something the redaction argument above pretends away. The final
assistant text is the other exception, kept because "what did it conclude" is
the first thing anyone asks of a headless run and it is exactly one value per
run rather than a stream. Both exceptions are bounded and named; anything
further is the OTEL boundary, and this ADR is what a future reader should be
pointed at before widening it.
