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

## Notes

Added when Tool-result clearing (issue #524) shipped, consuming this ADR's
`contextWindow` and `contextOccupancy` as its trigger. The Context, Decision and
Consequences above are unchanged; this section records what clearing needed
from them that the original decision left open or silent.

- **Clearing reads the fraction against the declared TOTAL window, not the
  total less the Output ceiling.** The Decision explicitly left output-headroom
  reservation "to auto-compaction, which is the only thing that needs it" — this
  is that promise being kept rather than quietly broken. Both `contextWindow`
  and `maxOutputTokens` are independently optional, so a reservation would put
  the trigger at a different effective fraction in each of the four
  declared/undeclared combinations, which an Operator has no way to predict from
  the one number they set. Clearing's job is also different in kind from
  auto-compaction's: it exists to bend the growth curve of a long tool-using
  turn, not to prove the next call fits under a ceiling. This records clearing's
  answer only — a future auto-compaction pass is free to want the reservation
  the Decision reserved for it, and should not read this as having settled that
  question.
- **The persisted output-token count is now load-bearing.** The Consequences
  above observe that storing it alongside occupancy "makes the next turn's
  starting size derivable exactly." Clearing is the first consumer of that
  derivation, reading it to gate the first model call of a turn — before that
  turn's own first step has reported anything. Dropping the output-token figure
  from what is persisted would silently disable clearing on exactly the call it
  is most needed on, with no error to say so.

## Notes: the composer meter shows Projected occupancy

Added when the Chat meter was corrected to read forward. The
Decision above is unchanged — Context occupancy is still one call's input count,
measured and never estimated — and this records only which quantity the meter
renders.

- **The meter was showing the wrong one of two right numbers.** It rendered
  `contextOccupancy.inputTokens`: what the last call was sent. But it sits in the
  composer, where the question is what the _next_ call will be sent, and that
  includes the reply the last call produced, because the Transcript is re-sent in
  full. On a short turn the gap is the whole assistant message — 222 shown
  against 340 actually queued up.
- **Nothing new is measured.** The figure is the last reading's input plus its
  output, both vendor-reported. The derivation now has a name (**Projected
  occupancy**, `CONTEXT.md`) and one implementation (`nextTurnOccupancy` in
  `packages/schemas`) rather than being open-coded where each consumer needed it.
- **"Derivable exactly" above is too strong, and measurement says so.** Three
  consecutive turns on a reasoning model projected 275 against an actual 260, and
  855 against an actual 946. Two causes pull opposite ways. A thinking turn bills
  its reasoning tokens as output and then does NOT resend them — the first turn
  there carried a 272-character `reasoning` part alongside 265 characters of
  text, and only the text came back — so the projection reads HIGH by whatever
  the model thought. And it cannot include the next message, which is the draft
  nothing local can count, so it reads LOW by however much someone types. The
  figure is an upper-ish bound on the conversation so far, not an arithmetic
  identity. It is still far closer than the input-only figure it replaced, which
  was low by 38% on that same turn, and the reasoning-token error is in the
  conservative direction — the same direction an under-declared window already
  errs in. A future ADR wanting an exact projection would need the vendor to
  report resent-token counts, which none does.
- **This closes a real divergence, not just a cosmetic one.** Tool-result
  clearing's backend gate for a turn's first call already summed input and output
  (`initialOccupancyFrom`); the frontend mirror that renders results as cleared
  was fed the meter's input-only figure. Around the 0.7 threshold the two
  straddled — with a 16k window, 11,000 in and 500 out reads 0.69 to the browser
  and 0.72 to the server — so the UI could show results as live that the model
  was no longer being given. The mirror's own comment claimed this could not
  happen. Both now call the shared derivation.
- **"One turn stale" becomes "one draft stale".** The Consequences above note the
  meter cannot account for an unsent draft, and that is still true and still
  unfixable here — counting tokens locally is the estimate this ADR rejects. What
  it no longer omits is the last reply. The user-facing docs previously told
  readers not to read the meter forward; that instruction was correct for the old
  numerator and is now wrong, so it changed with the code.
- **A Trigger run's stats deliberately do NOT change.** That page reports a
  finished run retrospectively, where the last call's input count is the honest
  figure and no projection is meaningful. `RunStats.contextOccupancy` is also a
  bare integer carrying no output count, so the derivation is not available there
  even in principle. Two surfaces therefore show different quantities on purpose,
  and the glossary names both so the difference is not read as a bug.
