---
status: accepted
---

# Context windows are declared, not discovered

## Context

Auto-compaction needs to know how close a Chat is to its model's limit, and
nothing in the stack can tell it. `LanguageModelV4` — the complete model
interface in `@ai-sdk/provider@4.0.4`, as used by `ai@7.0.48` — has exactly five
members (`specificationVersion`, `provider`, `modelId`, `supportedUrls`,
`doGenerate`, `doStream`). There is no capability metadata: grepping
`maxInputTokens|contextWindow|contextLength` across `@ai-sdk/provider`,
`@ai-sdk/openai` and `@ai-sdk/anthropic` returns nothing, and the only
token-limit field anywhere in the SDK is `maxOutputTokens`, a request setting.
Nor is there a token counter — the SDK's own compaction example hand-rolls
`JSON.stringify(messages).length / 4`. Vendors publish context lengths as prose
on marketing pages, in no common format, and a model reached through a proxy
such as LiteLLM may not have the capacity its name implies.

## Decision

An Org Admin **declares** a model's Context window as an optional
`contextWindow` integer on the per-model config object inside `provider.modelIds`
— the same place `alias`, `passthroughFileTypes` and `maxExtractedTextChars`
live. No new table, no new column, no discovery call.

It is a single number meaning the vendor's **published total** window, not a
separate input cap. Reserving output headroom from that total is left to
auto-compaction, which is the only thing that needs it.

Context occupancy is **measured, never estimated**, from the input-token count
the vendor reports for the **last model call of a turn**. Where a Provider
reports no usage, occupancy is unknown and Platypus computes nothing.

## Considered options

- **A separate `maxInputTokens` alongside `maxOutputTokens`** — rejected. It is
  the quantity auto-compaction actually wants, and an earlier code comment in
  `packages/schemas` anticipated exactly that name. But no vendor publishes it as
  a distinct figure, so the field would be filled in by guesswork; the total is
  the only number an Org Admin can look up and verify. The comment has been
  corrected rather than honoured.
- **Making the field required** — rejected. `modelIds` is a jsonb column and
  `drizzle-kit push` applies DDL only, so existing rows would need a backfill —
  and there is no correct value to backfill with. Inventing context windows for
  models you cannot query is the precise problem this ADR exists to avoid. A
  narrower "required only for newly added model entries" rule was designed
  (diffing incoming against stored `modelIds` by `id`, reusing the machinery in
  `model-alias-migration.ts`) and then dropped as machinery disproportionate to
  the benefit.
- **A closed enum of preset sizes** — rejected as the storage type, kept as the
  UI affordance. Under-declaring is harmless and over-declaring hard-fails at the
  vendor, so a proxy exposing a model whose true window sits _below_ the nearest
  preset must remain expressible. Presets plus a Custom escape; the stored value
  is always a plain integer.
- **Falling back to a `length / 4` estimate when a Provider reports no usage** —
  rejected. An estimate feeding a compaction trigger produces either surprise
  truncation or surprise vendor errors, and neither is attributable after the
  fact. Unknown stays unknown and the meter hides, matching the existing
  `truncatedByTokenLimit` convention of making a degraded state visible.
- **Deriving `maxExtractedTextChars` from the declared window** — rejected. The
  derivation needs a chars-per-token ratio, which is the estimate rejected above,
  and it would silently change file-handling behaviour for every Provider that
  gains a `contextWindow`.

## Consequences

- **Occupancy is a last value, not a sum, and the wrong number looks right.**
  The conversation is re-sent in full on every Chat turn, so occupancy replaces
  rather than accumulates; summing across turns over-counts badly. Worse, two
  plausible-looking figures inside a single turn are also sums:
  `addLanguageModelUsage` (`ai/dist/index.js:2636`) folds `inputTokens` across
  steps, so the terminal `finish` part's `totalUsage.inputTokens` is a sum of
  context sizes — on a twenty-step agent turn it reads roughly an order of
  magnitude high — and `RunStats.inputTokens` accumulates the same way. Both are
  correct as billing figures. Neither is occupancy. Occupancy comes from the last
  `finish-step` part's `usage.inputTokens`, which is confirmed inclusive of cache
  reads and writes (Anthropic computes
  `total: inputTokens + cacheCreationTokens + cacheReadTokens`; OpenAI
  `total: promptTokens`) and is therefore the true full context size.
- **Occupancy is emitted per step, not once at the end, for abort resilience.**
  `messageMetadata` receives the raw `TextStreamPart` union and fires on every
  part, and its return value is deep-merged, so returning the figure on each
  `finish-step` leaves the last one standing. The terminal `finish` part is never
  emitted on an aborted run, and cancelling a long turn is exactly when the
  context got large — so emitting once on `finish` would lose the reading that
  matters most. The cost is that `mergeObjects` skips `undefined` overrides, so a
  later step reporting no usage would leave an earlier value looking current.
  Returning nothing in that case is what _causes_ the stale reading rather than
  preventing it — an earlier draft of this ADR named the failure and then
  prescribed it. The guard is the opposite: a step with no input count returns a
  concrete `contextOccupancy: null`, which the merge does apply, and a reported
  input count with no output count writes `outputTokens: null` rather than
  omitting the key. Only where no step of the turn has reported a count is
  nothing returned, so a Provider that reports no usage at all still records no
  occupancy — the key is absent, and absent and `null` both read as unknown.
- **Optional means auto-compaction will silently not engage.** When compaction
  lands, a model with no declared window simply will not compact. The provider
  form's hint on the field is the only guardrail against that being a mystery,
  which makes it load-bearing rather than decorative. It states today's
  consequence — the meter is hidden — rather than forward-referencing a feature
  that does not exist yet.
- **Users will under-declare, and the meter must not treat that as a fault.**
  Because under-declaring is the safe direction, a 128k declaration against a
  real 200k model is expected. The meter clamps its bar at 100% and shows the
  true numbers rather than reporting 117% or clipping.
- **The meter is one turn stale, and hides for two different reasons.** It cannot
  account for an unsent draft, because nothing can count tokens locally. It hides
  when the window is undeclared _or_ when occupancy is unknown — one state, two
  causes, rather than a third display mode showing a numerator with no
  denominator, which answers none of the questions a meter exists to answer.
- **Trigger runs get their own field rather than a reinterpretation.**
  `trigger_run.stats` already carries `inputTokens`/`outputTokens` as cross-step
  sums, rendered on the trigger runs page. Those are legitimate billing figures;
  repurposing them would silently change a displayed number's meaning, so
  occupancy is added alongside, sourced from the final step.
- **Sub-Agent turns and one-shot Provider executions are out of scope.** A
  sub-Agent holds a separate context that no parent-level meter can meaningfully
  display, and one-shot calls (metadata generation, memory extraction) are
  single-turn by construction and cannot grow. The declared field still applies
  wherever those resolve a model; only the measurement is scoped.
- **"Context" now carries a third meaning.** The glossary already distinguished
  User Context from the composed System prompt; a model's Context window is a
  third. `CONTEXT.md` defines Context window and Context occupancy and disclaims
  the collision on the existing Context entry, and the user-facing docs extend
  their own "two different things are called Context" section to three.
