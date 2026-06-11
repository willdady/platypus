---
status: proposed
---

# Chat Context Compaction

Chats hard-fail when message history exceeds a model's context window. This ADR
records **how** we decided to keep them alive and **why** the obvious simpler
options were rejected. The implementation spec (the _how_) lives in
`context-compaction-plan.md`; this ADR is the _why_ and the gate that
implementation answers to.

Status is **proposed** until step 1 (window resolution + estimator + schema)
confirms the foundation holds; promote to **accepted** then. If implementation
forces a different choice, supersede with a new ADR rather than editing this one.

## Decision

A **two-tier, view-not-delete** compaction model, fed by a **single token
estimator**, with all durable state mutated through a **single versioned CAS
writer**, and an always-on **recovery net** for overflow errors the proactive
path misses.

### Two tiers, not one

- **Tier 1 — cross-turn, durable.** Runs in `prepareChatTurn` before a response.
  Summarizes/prunes old history, persists a summary + watermark. Owns durable
  state.
- **Tier 2 — intra-turn, throwaway.** Runs in the AI SDK `prepareStep` hook to
  keep a single heavy response (many tool/sub-agent calls) executable mid-loop.
  Not persisted — the SDK's canonical message list commits to history as normal,
  and next turn Tier 1 folds it into the durable summary.

One tier cannot cover both cases: a single response can blow the window without
any cross-turn history growth (Tier 2's job), and durable history must be
compacted before a turn even starts (Tier 1's job). Sub-agents — which start
fresh each invocation with no cross-turn history — therefore use **Tier 2 only**.

### Compaction is a view, not a delete

The watermark + summary change _what is sent to the model_, never _what is
stored_. Raw messages persist in the DB untouched. This makes forced/automatic
compaction non-destructive in the data sense (a user can still read full
history; a future "expand summary" UI is free), and reduces "irreversible data
loss" objections to a UX-courtesy confirmation rather than a correctness
concern.

### One estimator

Token counting lives in exactly one function over one neutral structure
(`CountUnit[]`). Tier 1 (UIMessages) and Tier 2 (ModelMessages) both normalize
into it, counting only model-bound parts. Divergence between the two tiers is
impossible by construction rather than monitored — a tier cannot fire on a
number the other never sees.

### One durable writer (versioned CAS)

All mutations of compaction state (`summaryWatermark`, `contextSummary`,
`compactionDirty`) go through a single compare-and-swap function keyed on a
`version` column. Concurrent runs on one chat (e.g. a trigger run and a user
run), and the interaction between compaction and history-edit invalidation, are
resolved by **version**, not by comparing watermark values — so a watermark that
moves _backward_ on an edit cannot be misread as "not yet advanced" and produce a
stale summary over mutated history.

### Recovery is the net, not the plan

A `400/413` context-overflow error is caught, the messages aggressively trimmed
in-memory (via the same Tier 2 adapter), and the call retried **once**. Recovery
never writes durable state directly — it flags `compactionDirty`, and the next
turn's Tier 1 does the durable compaction. Recovery stays on even when proactive
compaction is globally disabled; it is the last line of defense, not a risk
surface.

### Char/4 estimate, not a real tokenizer

Pre-call token counting uses a `char/4` heuristic (text parts only; a modality
table for images) on the **first turn only**. Every later turn uses the
provider-reported real `usage.inputTokens`. We accept first-turn imprecision
(guarded by a 1.15 margin and the recovery net) rather than ship a per-provider
tokenizer dependency.

### Window source: API → litellm registry → default

Resolve the context window per-model: manual override → provider API auto-detect
(Google/OpenRouter/vLLM expose it) → the community-maintained litellm registry
JSON (covers OpenAI/Anthropic/Bedrock, which don't) → a conservative 8192
default. We do **not** maintain our own context-window table.

## Considered Options

- **Single-tier compaction (cross-turn only)** — rejected. Cannot rescue a
  single response whose own tool loop overflows the window; would force the whole
  response to fail even though durable history was fine.
- **One estimator per tier** — rejected. Two estimators over two message shapes
  drift; one tier ends up firing on a count the other never computes, making
  contention and threshold bugs undebuggable. Collapsed to one estimator + two
  adapters.
- **Hard-delete / truncate old messages** — rejected. Irreversible, and the
  "drops the middle silently" failure mode seen in gateway truncation (OpenRouter)
  and silent clipping (Ollama). View-not-delete keeps the data and makes the
  action auditable (a visible `context-compacted` event).
- **Homegrown context-window lookup table** — rejected. Unmaintainable across
  providers and model churn; the litellm registry is the industry "don't maintain
  your own table" answer (AnythingLLM dropped its hardcoded table for it).
- **A real pre-call tokenizer** — rejected for v1. Per-provider tokenizers are a
  heavy dependency for a number that the provider returns accurately after the
  first call anyway.
- **Optimistic-without-version concurrency (compare watermark values)** —
  rejected. Breaks when history-edit invalidation moves the watermark backward;
  the versioned CAS removes the monotonicity assumption entirely.
- **Compacting to the trigger threshold** — rejected; it re-fires every turn
  (the Cline #5616 thrash). Trigger and target ratios are deliberately distinct
  (0.8 vs 0.5 of the input budget) for hysteresis.

## Consequences

- **Schema additions.** `provider.modelMeta` (JSONB, per-model window/output
  overrides); chat/run gain `contextSummary`, `summaryWatermark`,
  `compactionDirty`, and `version`. All additive nullable columns.
- **Lazy rollout, no backfill.** Existing chats compact only on their next turn;
  no eager backfill job (it would create a thundering herd of summarize calls).
- **A summarize call costs money and latency.** Stage 1 prunes without a model
  call first; Stage 2 summarizes only when pruning is insufficient, using the task
  model (falling back to the main model).
- **First-turn token estimates are imprecise**, especially for
  image-heavy/CJK/JSON content; the recovery net absorbs the misses and a
  divergence metric tunes the image constants over time.
- **A global `COMPACTION_ENABLED` kill switch** disables proactive compaction in
  prod without a deploy; recovery is unaffected.
- **Observability is part of the contract** — compaction/recovery/CAS-conflict
  metrics gate the two deferred optimizations (CAS contention, projected-input
  ring arc); without the metrics those decisions are guesses.
- **Frontend gains a context-usage ring** (window resolved from the _selected_
  model, neutral when unknown) and a per-message stats popover, reusing the
  existing tool-call timing mechanism.
