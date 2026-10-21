---
status: accepted
---

# Native file types are declared, not inferred

A model's Passthrough file types are what the Operator declares on its model
entry, and nothing else. There is no Provider-type default: an entry with none
declared ingests nothing natively, and its files are inlined, extracted or
refused. The same reasoning as ADR-0018 applies: no vendor exposes a model's
input modalities through a common API, and a model behind a proxy such as
LiteLLM, or one of OpenRouter's many, may not accept what its Provider type
suggests. A Provider-type default is a guess that is right for some models and
wrong for others under the same Provider, and it hid the fact that nothing had
been declared.

## Considered options

- **Keep the Provider-type default, shown as a "Use provider default" switch in
  the model dialog** — rejected. It keeps the guess, just more visibly, and one
  Anthropic model may read images while another does not.
- **Look capabilities up** (e.g. OpenRouter's model catalog) — rejected. It works
  for one vendor and none of the proxies, so it would still need declaring
  everywhere else.

## Consequences

- **Existing entries are backfilled, not changed.** A data migration writes the
  default each entry was inheriting into every entry with none declared, so no
  Provider changes behaviour on upgrade. Only newly added models start empty.
  Dev databases, where `drizzle-kit push` skips data migrations, need re-ticking
  by hand.
- **"Accept nothing natively" becomes expressible**, which the inherit-on-empty
  rule made impossible.
