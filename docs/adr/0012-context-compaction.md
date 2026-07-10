---
status: accepted
---

# Chat Context Compaction

Chats hard-fail when message history exceeds a model's context window. This ADR
records the design we shipped to keep them alive, **why** the obvious simpler
options were rejected, and the named parts the implementation refers back to.

It is self-contained: every decision, mechanism, and trade-off the code cites
lives in a section below. Code comments reference this ADR by section name (e.g.
_"ADR-0012 §Tier 1"_, _"ADR-0012 §Summary invalidation"_) rather than by any
external plan or chunk number.

If a future change forces a different choice, supersede with a new ADR rather
than editing this one.

## Context

The AI SDK (`ai@6`) reports real token usage **after** each call
(`usage.inputTokens`/`outputTokens`/`totalTokens`) but exposes **no**
context-window metadata on the model interface and **no** pre-call tokenizer.
Providers diverge on whether the window is discoverable: Google
(`inputTokenLimit`), OpenRouter (`context_length`), and vLLM/OpenAI-compatible
(`max_model_len`) expose it via API; OpenAI, Anthropic, and Bedrock do not.
Error handling previously covered only auth/rate-limit/5xx — a context-overflow
rejection killed the turn. Top-level chats and sub-agents both run through the
shared `agent-runner`/`ToolLoopAgent`, so one implementation covers both.

## Decision

A **two-tier, view-not-delete** compaction model, fed by a **single token
estimator**, with all durable state mutated through a **single versioned CAS
writer**, an always-on **recovery net** for overflow errors the proactive path
misses, and a deterministic **context-editing** pass that prunes stale bulky
tool results without a model call.

## Principles (load-bearing)

### View, not delete

The watermark + summary change _what is sent to the model_, never _what is
stored_. Raw messages persist in the DB untouched. Forced/automatic compaction
is therefore non-destructive in the data sense — a user can still read full
history; a future "expand summary" UI is free — which reduces "irreversible data
loss" objections to a UX-courtesy confirmation rather than a correctness concern.
Never hard-delete a summarized message.

### One estimator

Token counting lives in exactly one function over one neutral structure
(`CountUnit[]`). Tier 1 (UIMessages) and Tier 2 (ModelMessages) both normalize
into it, counting only **model-bound** parts (`text`, `tool-call`,
`tool-result`, `file`, `image`). UI-only parts (`reasoning`, `source`,
`step-start`, `data-*`) are excluded on both sides. Divergence between the tiers
is impossible by construction rather than monitored — a tier cannot fire on a
number the other never sees.

### One durable writer

All mutations of compaction state (`summaryWatermark`, `contextSummary`,
`compactionDirty`) go through a single compare-and-swap function keyed on a
`version` column. Concurrent runs on one chat (e.g. a trigger run and a user
run), and the interaction between compaction and history-edit invalidation, are
resolved by **version**, not by comparing watermark values — so a watermark that
moves _backward_ on an edit cannot be misread as "not yet advanced" and produce a
stale summary over mutated history. On a CAS conflict the loser re-reads the row:
if the winner already covered its prefix it **skips** (safe no-op); otherwise it
retries **once**, then skips with a contended warning. No recompute-loop, no
livelock. A covered-skip deliberately does **not** clear `compactionDirty`: a
concurrent invalidation also bumps the version but intentionally leaves dirty set
(it resets the summary without shrinking history), so clearing dirty on a skip
could drop a forced compaction the overflow demanded. Leaving it set is strictly
safe — worst case is one extra compaction next turn.

### Recovery is the net

A `400/413` context-overflow error is caught, the messages aggressively trimmed
in-memory (via the same Tier 2 adapter — no bespoke trimmer), and the call
retried **once**. Recovery never writes durable summary/watermark state directly —
it flags `compactionDirty` on detection (before the retry outcome), and the next
turn's Tier 1 does the durable compaction. Recovery stays on even when proactive
compaction is globally disabled; it is the last line of defense, not a risk
surface.

## Mechanisms

### Window resolution

`resolveContextWindow(provider, modelId)` resolves per-model in order: manual
override (`provider.modelMeta`) → provider API auto-detect (Google / OpenRouter /
vLLM) → the community-maintained **litellm registry** JSON (covers
OpenAI/Anthropic/Bedrock, which don't expose it) → a conservative `8192` default.
We do **not** maintain our own context-window table.

- **Key normalization.** Registry keys don't match `resolvedModelId` 1:1. Lookup
  order: `exact → strip provider prefix → lowercase → alias map → family
heuristic → MISS`. The family heuristic uses boundary-safe separators
  (`"-"`, `"."`, `":"`, `"/"`) so `gpt-4.5-preview` never resolves via a stale
  `gpt-4` entry. Every MISS warns (it falls to default — must be visible).
- **Caching & eviction.** Results cache in-memory per provider+model with a TTL.
  Editing a `modelMeta` override **immediately** evicts (`evict(providerId)`) in
  the provider PUT handler — TTL is only a backstop. `source:"default"` results
  use a short TTL (60 s) so a registry miss or transient API blip doesn't pin
  8192 for the full hour. API fetches use a 5 s timeout and single-flight
  (`#inflight`) to avoid a cold-cache stampede.
- When the window is default/unknown the ring renders **neutral**, never a
  guessed ramp. `maxOutputTokens` is resolved the same way (needed for the budget
  math).

### Token estimation

Char/4 over **text parts only** (never char/4 a base64 image); a modality table
sizes non-text parts (`anthropic`/`openai`/`default` constants, dimensions from a
cheap PNG/JPEG header parse when bytes are in hand). Used **only on the first
turn** before any provider `usage` exists; every later turn uses the
provider-reported real `usage.inputTokens`. We accept first-turn imprecision
(guarded by a 1.15 cold-start margin and the recovery net) rather than ship a
per-provider tokenizer. The Tier 1 estimate runs **after** file inlining so the
payload counted is the real one. Where image `detail` is unset (the common case)
we assume `high` — **over-counting beats overflow**. A turn-2 divergence check is
a designed-in feedback hook: compare the cold-start estimate against the real
`usage.inputTokens` and warn when they diverge by >50%, to tune the image
constants over time (currently log-only).

### Tier 1 — cross-turn compaction (durable)

Runs in `prepareChatTurn` before a response, over durable history (UIMessages).

- **Budget math.** Trigger and target are fractions of the **input** budget, not
  the raw window: `inputBudget = window − maxOutputReserve − safetyReserve`
  (safety = `reserveRatio × window`, default 0.05). `triggerTokens = 0.8 ×
inputBudget`, `targetTokens = 0.5 × inputBudget`. Per-turn **overhead** (system
  prompt + tool schemas + skill list) is counted toward the trigger and
  subtracted from the effective target, since it consumes the same window but is
  invisible to a message-only estimate. When `maxOutputTokens` is unknown the
  output reserve falls back to `min(4096, 0.25 × window)`.
- **Trigger projection.** `projected = max(charBasedEstimate, lastInputTokens)`
  where `lastInputTokens` is the prior turn's provider-reported
  `usage.inputTokens` (threaded from the last assistant message's
  `metadata.stats.contextTokens`). The cold-start ×1.15 margin applies only on
  turn 1 when no provider baseline exists. Compact when `projected ≥ trigger`.
- **Hysteresis.** Compaction must reduce the conversation to `≤ targetTokens`,
  well below the trigger, so it does **not** re-fire next turn. The trigger (0.8)
  and target (0.5) ratios are deliberately distinct. Config is global/env-only
  (no submitted schema to validate), so the runtime clamps `target → trigger ×
0.9` when an operator sets `COMPACTION_TARGET_RATIO ≥ COMPACTION_TRIGGER_RATIO`.
- **Staged, cheap-first.** Stage 1 **prunes** the older prefix without a model
  call (soft-trim bulky tool/RAG results to head+tail, then placeholder over
  `minPrunableChars`); only if still above target does Stage 2 **summarize** the
  prefix into one synthetic summary message. Tool-call/result pairs are atomic and
  never split across the keep boundary. Output: `[system, summary, …kept recent]`.
  A visible `context-compacted` event makes it fail-loud.
- **Summarizer model & map-reduce.** Summarize uses the task model
  (`taskModelId`), falling back to the main model; same-provider only. When the
  prefix exceeds the summarizer's own window it is chunked and map-reduced (a
  large cold-start/imported history can't be sent whole). Summarization is
  **incremental**: each turn only the messages _after_ the watermark are
  summarized and folded into the existing summary, then the watermark advances.
- **Summary invalidation.** If a message at/below `summaryWatermark` is
  edited/deleted/regenerated the summary is stale. The handler bumps version +
  clears `contextSummary` + resets the watermark in one CAS write. Because the CAS
  loser compares **version** (not watermark value), a compaction racing an
  invalidation sees a conflict and re-reads the reset state — it can never write a
  stale summary over mutated history. The invalidation compares the **un-inlined**
  submission (file URLs match on both sides) with stable key ordering (jsonb is
  re-ordered by Postgres), against the pre-overwrite DB snapshot loaded before the
  sink overwrites the row.

### Tier 2 — intra-turn compaction (in-memory)

For a single heavy response (many tool/sub-agent calls) that bloats the window
mid-loop. Runs in the AI SDK `prepareStep` hook on both `streamText` and
`generateText`, over ModelMessages, summarizing old completed tool results while
keeping recent steps verbatim and preserving call/result pairing. Fires **only
when genuinely near the limit** (no per-step overhead on a small loop). **Not
persisted** — the SDK's canonical message list commits to history as normal, and
next turn Tier 1 folds it into the durable summary. One tier cannot cover both
cases: a single response can blow the window without any cross-turn growth (Tier
2's job), and durable history must be compacted before a turn starts (Tier 1's
job).

### Recovery

`isContextOverflowError` matches `APICallError` with status `400/413` and a
per-provider body regex (OpenAI/vLLM, Anthropic, Google, Bedrock — fixture-tested
matrix). The recovery middleware wraps the model in **both** `streamText` and
`generateText`, so every step of a tool loop gets detect → flag `compactionDirty`
(persisted on detection, via the durable writer) → trim via the **same Tier 2
adapter** (system head pinned, keep-recent halved with a floor of 2, forced past
the estimate gate since the provider already rejected the prompt) → retry once. A
second failure surfaces "Conversation too large — start a new chat". Durable
compaction happens on the **next** `prepareChatTurn`, which sees the dirty flag.
Headless runs (no chat row) still get the in-memory trim + retry, but cannot flag
`compactionDirty` — there is nothing to persist to.

### Sub-agents

Sub-agents start fresh each invocation (only a `task` string, no cross-turn
history), so they have nothing for Tier 1 to compact — they use **Tier 2 only**.
Each resolves its own model's window/output and passes it through; recovery covers
them too because `agent-runner` is shared.

### Config & kill switch

Compaction behavior is **global** (`DEFAULT_COMPACTION_CONFIG`); only window/output
**size** is per-model (via §Window resolution / `provider.modelMeta`). Per-agent
tuning was shipped and then removed — no surveyed tool (Hermes/Codex/Claude
Code/Cline) exposes per-agent knobs, and the ratios self-normalize to the model
window, so per-agent variance bought nothing measurable. The env
`COMPACTION_ENABLED` (default true) disables **all proactive** compaction (Tier 1

- Tier 2) in prod without a deploy; **recovery ignores it**. A single-agent
  opt-out, if ever needed, would be per-model or per-workspace — not per-agent.

### Context-usage ring

The frontend shows a small SVG ring next to the model selector, fill =
`usedTokens / contextWindow`, ramping green → amber (≥0.7) → red (≥0.9), and
**neutral grey when the window is unknown/default**. The window comes from the
**currently selected model** (not the last assistant message's metadata, else it
shows the previous model's window after a switch); the numerator is the last
response's `contextTokens` (the **last step's** `usage.inputTokens` — peak context
fullness, not the run-wide sum, which would over-count multi-step loops). A
required tooltip states the ring reflects the last response, not the unsent
composer input.

### Per-message stats

An `(i)` action under each assistant response shows input/output tokens, TTFT, and
total generation time, reusing the existing tool-call timing mechanism. Stats are
stamped on `message.metadata.stats` at the `applyToolCompletions` point (the
`messageMetadata` callback fires at message start, before timing/usage exist).
TTFT/total are server-measured; cost figures use the run-wide token sums.

### Force-compact on demand

The ring is clickable: `POST /chats/:id/compact` runs Tier 1 once **regardless of
threshold** (force), persists via the durable writer, and returns the post-compact
usage so the ring refreshes immediately. If a response is streaming the click is
**deferred** (pending badge, disabled, fires on finish); a confirm dialog appears
only when the drop is significant — `messagesDropped > keepRecentMessages` **or**
an estimated reduction `> 30%` of history — below that it runs immediately. Per
§View-not-delete this is not destructive regardless.

### Compaction trace in the timeline

Compaction is surfaced as a synthetic `compact_context` tool-call + tool-result
pair, reusing the existing tool-call UI (Running spinner → collapsed "Completed"
expander). It emits **live, in two phases**: a `tool-input-available` chunk the
instant a model summary _begins_ (badge shows "Running"), then a
`tool-output-available` chunk once the summary lands (flips to "Completed"). The
**Input carries the before-stats** (`tokensBefore`, `messagesBefore`) shown during
the Running phase; the **Output carries the after-stats** (`tokensAfter`,
`tokensSaved`, `reductionPct`, `messagesDropped`, `summaryExcerpt`). A single
`compactionTracePayloads(trace)` helper builds both payloads so the auto and
force paths render identically.

For the **Tier 1 (auto)** path, `agentRunner.stream()` opens the client UI stream
(`createUIMessageStream({ execute })`) **before** `prepare` runs, and the summarizer
fires a one-shot `onSummarizeStart(before)` callback that writes the in-progress
chunk mid-prepare; the terminal chunk is written once `prepare` returns. Because
the in-progress chunk fires only when Stage 2's model call actually begins, it never
appears on prune-only / no-op turns. **Invariant:** once the in-progress chunk is
written a terminal chunk always follows — if the summary ran but produced no durable
trace (CAS version race, or a swallowed `summarize` throw), the runner writes a
_degraded Done_ (a benign note) rather than leaving the badge stuck on "Running".

The **force-compact** path (no live stream) persists a standalone synthetic
assistant message **above** the watermark; the frontend also shows an optimistic
in-progress part at POST time that it swaps for the persisted Done trace on
success (removed on error). The trace part is **stripped before
`convertToModelMessages`** at both call sites so it never replays to the provider
as a phantom tool call; a trace-only message is dropped entirely. The trace is
emitted only when an actual model summary ran (not for prune-only or
dirty-within-target no-ops).

Note: the auto path's before/after basis includes per-turn overhead (system + tool
schemas); the force path's excludes it (overhead is not passed there). The two
numbers are therefore not directly comparable _across_ paths — each is
self-consistent within its own path.

### Stage 0 — context editing (prune, don't summarize)

A deterministic, no-model-call pass that runs as **Stage 0 inside
`applyTier1Compaction`, before the trigger decision**, replacing the `output` of
**old bulky** tool results with a self-describing placeholder (names the tool +
elided size; tells the model to re-call). This mirrors Anthropic's
`clear_tool_uses` context editing. It keeps the tool-call block (pairing stays
valid), prunes by **recency count** of tool results (`keepRecentToolResults`,
default 4) above a **size gate** (`minEditableToolChars`, default 50 000), exempts
the newest message, and is idempotent + grow-guarded (never re-elides a
placeholder, never inflates a result smaller than the placeholder). Running it
before the trigger lets a lean view **avoid** summarization entirely (cheaper).
It needs **no durable state, no CAS, no version bump** — it is recomputed from raw
messages each turn, a sibling of the trace-stripping transform. Accepted fidelity
loss: an elided placeholder also flows into any prefix Stage 2 later summarizes
(a huge dump's head+tail is poor summary fodder anyway; raw stays in the DB).

### Hard window wall (recent-trim gate)

Missing the soft `targetTokens` is cheap (a hysteresis goal). The hard wall is
`inputBudget` (window − output reserve − safety). Recent (kept) messages are
trimmed **only** when `estimate(recent) + summary > inputBudget` (the call would
actually overflow), not on the soft-target miss — below the wall `recent` stays
full-fidelity and simply re-compacts next turn. The single newest message is
always exempt. A single result too large to fit _even as the newest_ is the
unsolved ingestion-cap case (an over-large dump as the last message will
hard-error) — out of scope here, would need an ingestion cap at storage time.

### Summarizer hardening

Tier-1 `summarize()` is a long blocking call inside `prepareChatTurn`, before the
response stream opens, and does not bump the per-step stall timer — the 120 s
watchdog once killed a slow summarize mid-call. Hardening: a **heartbeat** pings
`onActivity` (~every 10 s) so the watchdog keeps resetting; a `maxOutputTokens`
**ceiling** (≈4 000) backstops a degenerate runaway expansion (`finishReason ===
"length"` is logged); the summarize call is **cancellable** (`abortSignal`); and a
**structured handoff prompt** (intent · decisions/facts · files/tools · current
state) with an explicit length target reduces loss across repeated
re-compactions.

## Considered Options

- **Single-tier compaction (cross-turn only)** — rejected. Cannot rescue a single
  response whose own tool loop overflows the window.
- **One estimator per tier** — rejected. Two estimators over two message shapes
  drift; collapsed to one estimator + two adapters.
- **Hard-delete / truncate old messages** — rejected. Irreversible, and the
  "drops the middle silently" failure mode seen in gateway truncation. View-not-
  delete keeps the data and makes the action auditable.
- **Homegrown context-window lookup table** — rejected. Unmaintainable across
  providers; the litellm registry is the industry "don't maintain your own table"
  answer.
- **A real pre-call tokenizer** — rejected for v1. A heavy per-provider dependency
  for a number the provider returns accurately after the first call.
- **Optimistic concurrency by comparing watermark values** — rejected. Breaks when
  invalidation moves the watermark backward; versioned CAS removes the
  monotonicity assumption.
- **Compacting to the trigger threshold** — rejected; it re-fires every turn (the
  thrash failure). Trigger and target ratios are distinct for hysteresis.
- **Per-agent compaction tuning** — shipped then removed; no real tool exposes it
  and the ratios self-normalize to the model window.
- **Summarize-only (no context editing)** — insufficient. Bulky kept tool results
  dominate `tokensAfter`; deterministic prune-not-summarize is cheaper and lossless
  to the DB.
- **A token FLOOR on the trigger** (`max(window × pct, 64000)`) — rejected as an
  anti-pattern. It overflows sub-64k models (the trigger never fires). A floor
  belongs only on the _window fallback_ (`detected ?? DEFAULT`), never as
  `max(detected, FLOOR)`.
- **Sizing the window from litellm `max_tokens`** — rejected. Only
  `max_input_tokens` is trusted; `max_tokens` is the output cap, not the context
  window, and conflating them mis-sizes the budget.
- **A selectable compaction model in the provider UI** — rejected. Compaction
  already runs through `taskModelId` on the chat provider's own client
  (same-provider only); on a single-model provider a dropdown is a no-op, and
  `workspace.taskModelProviderId` (which routes _other_ task work) deliberately
  does not apply to compaction. Not worth the multi-provider wiring now.

## Open / deferred decisions

Consciously deferred, with rationale — recorded so the _why-not-yet_ isn't lost:

- **CAS-contention optimization (the per-turn full-history read + stringify)** is
  left unoptimized; the full-prefix compare is already correct, so this is gated on
  the `cas.conflict` metric actually showing waste before it's touched.
- **The estimate-vs-real divergence metric** (see §Token estimation) stays log-only
  until the image-constant tuning work is picked up.
- **Also deferred:** a message-count force-compact valve (a count-based backstop
  independent of the token estimate), a projected-input arc on the ring, persisting
  Tier 2 output, model-aware trim aggressiveness, and Anthropic's `count_tokens` for
  exact Claude counts — none are needed for the "no more hard fails" goal.
- **Latent invariant — content-type tool-result media.** The `content`-variant
  tool result currently serializes media bytes into the char/4 text blob. Fixing it
  must be **symmetric** across both adapters (extract media into `nonText` on the UI
  _and_ Model side) or it breaks the §One estimator equality — the load-bearing
  invariant. No current tool emits content-type media; fix it **before** the first
  one does, not after.

## Consequences

- **Schema additions.** `provider.modelMeta` (JSONB, per-model window/output
  overrides); chat/run gain `contextSummary`, `summaryWatermark`,
  `compactionDirty`, `version`. All additive, nullable/defaulted.
- **Lazy rollout, no backfill.** Existing chats compact only on their next turn; no
  eager backfill job (it would create a thundering herd of summarize calls).
- **A summarize call costs money and latency.** Stage 0 (context editing) and Stage
  1 (prune) run first without a model call; Stage 2 summarizes only when needed.
- **First-turn token estimates are imprecise** (image-heavy/CJK/JSON); the recovery
  net absorbs the misses.
- **Cross-tenant safety.** The submit route verifies the body `id` belongs to the
  caller's workspace before a run starts — the compaction store is keyed by chat id
  only, so an unvalidated id would otherwise let one workspace mutate another's
  summary/watermark.
- **A global `COMPACTION_ENABLED` kill switch** disables proactive compaction in
  prod without a deploy; recovery is unaffected.
- **Observability is part of the contract** — emitted as structured `metric:`-tagged
  log lines: `compaction.fired`, `summarize.latency_ms`, `recovery.*`,
  `context_window.fell_to_default`, `litellm.key_miss`, `cas.conflict`,
  `context_edited`.
- **Frontend gains a context-usage ring** (window from the selected model, neutral
  when unknown), a per-message stats popover, and a `compact_context` timeline
  trace, all reusing the existing tool-call timing/rendering mechanism.
- **Unsolved: the single oversized newest result.** A tool result too large to fit
  even as the newest message hard-errors; the fix is an ingestion cap at storage
  time, out of scope here.
