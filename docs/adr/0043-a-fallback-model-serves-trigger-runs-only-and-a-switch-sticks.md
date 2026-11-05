---
status: accepted
---

# A Fallback model serves Trigger runs only, and a switch sticks for the run

An Agent may carry an optional **Fallback model**: a second Provider and model,
where the model may be one of that Provider's aliases. Only a **Trigger run**
uses it, and so does a Sub-Agent run inside one, which uses the Sub-Agent's own
fallback. A Chat turn never uses it, A2A included. The run switches when the
primary Provider cannot serve the request: it can't be reached, times out,
returns 429 or 5xx, refuses the credentials (401/403), or still fails after one
retry by the SDK. A request the Provider rejects as invalid never switches:
400, a refused Tool schema, context overflow. Those are faults in how the Agent
is set up, and a second Provider would hide the fault and charge for it twice.
Once a run switches, it stays on the fallback for every remaining step. Every
new run tries the primary first.

The reason is cost and who is there. Each model has its own prompt cache, so
every switch throws the cache away and bills the whole Transcript again at full
input price. A Chat is long-lived and someone is reading it, so they can retry
or choose another model themselves. A flaky Provider would make the Chat switch
back and forth, paying for a cold cache every time. A Trigger run pays that cost
once at most, and nobody is there to retry a scheduled run that missed its
window. Staying on the fallback limits the cost to a single switch. Prior art
(OpenRouter, LiteLLM, Portkey, Vercel AI Gateway, Mastra) also switches mid-run,
but per request: the next step tries the primary again. Staying on the fallback
for the rest of the run is our own choice (#1803).

## Considered Options

- **Fall back in Chat too.** Rejected for the cache reason above, and because a
  person is already there to recover.
- **Track Provider health with a cooldown** (as LiteLLM does with
  `allowed_fails` / `cooldown_time`). Rejected for now. It saves only the first
  failed call, and the state it needs breaks down in a multi-instance
  deployment unless it lives in the database.
- **An alias as the fallback.** Rejected. An alias cannot span Providers
  (ADR-0017), so it cannot survive the outage this feature exists for.
- **A same-Provider warning on the Agent form.** Rejected. OpenRouter routes to
  several upstream providers, so "same Provider" does not mean "same outage".

## Consequences

- Resolution failure is still a hard error (ADR-0017). A reference that resolves
  to nothing is a configuration fault, not an outage, and never switches.
- On a switch, the fallback's plan is resolved with the Agent's own settings,
  but its Provider's Reasoning map, model ceilings and guardrails. The Step
  ceiling counts across the whole run. Reasoning parts and vendor-only metadata
  are removed from the Transcript before the switch, while text, tool calls and
  tool results are kept.
- A switch shows up as a Run event and a marker on the run, and the
  `trigger_run.*` webhook payload names both models. Usage already splits by
  `(Provider, model)`. If the fallback fails too, the run's error names both
  failures.
- The fallback Provider is referenced like the primary: deleting a Provider an
  Agent uses is refused, a Shared Agent's fallback must be a Shared Provider,
  and a fallback identical to the primary is rejected when the Agent is saved.
