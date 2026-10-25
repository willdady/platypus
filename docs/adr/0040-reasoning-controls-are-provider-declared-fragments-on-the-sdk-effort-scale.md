---
status: accepted-pending-implementation
implemented-by: "#1521"
---

# Reasoning controls are provider-declared request fragments on the SDK's effort scale

> **Today:** Platypus sends no reasoning control to any Provider. A reasoning
> model runs at whatever its server or vendor defaults to, and the only way to
> change that is a server-wide flag or a second gateway alias per mode. This ADR
> describes the target; #1521 builds it.

Reasoning models served by self-hosted backends are steered by request fields
that differ per model family — `chat_template_kwargs.enable_thinking`,
`chat_template_kwargs.reasoning_effort` with family-specific value sets,
`thinking_token_budget`, Ollama's `think` — and a wrong value can be a 500.
Platypus owns one fixed vocabulary, the AI SDK's `reasoning` scale (`none`,
`minimal`, `low`, `medium`, `high`, `xhigh`, `max`), and lets an Org Admin
declare on each Model entry a **Reasoning map**: which controls the model has,
and the raw request-body fragment each step becomes. An Agent, or a Chat turn
with no Agent, stores a choice on that scale beside its sampling parameters;
the run merges the declared fragments into the Provider's `providerOptions`
namespace, which `@ai-sdk/openai-compatible` copies into the body unchanged.
Native Providers need no map: the same choice is handed to the SDK's own
`reasoning` option and translated by the vendor adapter.

## Considered options

- **A free-form per-Agent `extraBody`** — rejected. Same plumbing, but it moves
  model-family knowledge into every Agent instead of the one Model entry, gives
  a Workspace Owner a JSON box instead of a switch and a slider, and cannot hide
  steps the model lacks or refuse a fragment that rewrites `messages`.
- **Per-family presets maintained in code** — rejected. Every model release
  would need a Platypus release, and the fragments are not verifiable without
  the checkpoint in front of you. The examples live in the docs as snippets to
  copy and verify.
- **A Platypus-owned scale with its own steps** (`very_high`, no `minimal`) —
  rejected. Every step the SDK cannot express is a lossy mapping row for native
  Providers; mirroring the SDK makes the two paths one vocabulary.
- **Letting a Chat amend an Agent's reasoning choice** — rejected, as the same
  override `.out-of-scope/per-chat-model-override.md` refused for the model. An
  Agent resolves the whole of a turn.

## Consequences

- **A model with no map is byte-identical to today.** No control shows, nothing
  is sent, and existing Agents and Chats carry nulls.
- **Platypus sends what the map says; it cannot verify the model obeys.** A
  template switch only changes how the prompt is built, and some families keep
  reasoning with thinking "off". The docs teach admins to verify per checkpoint.
- **A fragment is a request body, so it is bounded.** The schema refuses any
  top-level key Platypus itself controls (`model`, `messages`, `tools`,
  `tool_choice`, `stream`, `stream_options`, `n`, `max_tokens`,
  `max_completion_tokens`, `response_format`), in every fragment and as the
  budget field, and caps the map's size.
- **An undeclared step is never sent.** A stored choice the current map lacks —
  a Direct Chat switched to another model, a map edited after the fact — resolves
  to the map's default. Thinking off suppresses effort and budget.
- **Mode-dependent sampling is not a fragment's job.** A `thinking.off` fragment
  may carry any field, but Platypus does not let it override an Agent's own
  temperature; hidden precedence between two settings pages is the kind of rule
  nobody can state.
