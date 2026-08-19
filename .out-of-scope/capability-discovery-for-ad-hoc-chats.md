# Capability Discovery for Ad-hoc (Bare-Model) Chats

Platypus does **not** give a Chat on a bare Provider + model access to Tool
sets, Skills or Sub-Agents. A Direct (no-Agent) chat stays a plain conversation
with a model, and the **Agent** remains the only thing that grants capability.
There is no per-chat switch handing a bare model the Workspace catalogue, and no
setting on an Agent meaning "see everything in this Workspace" in place of its
`toolSetIds` / `skillIds` / `subAgentIds`.

This rejects the **ad-hoc discovery mode** and the **attachment-model route to
it**, not the token problem underneath. The per-step cost of a large tool
catalogue is real and well-evidenced (#179), and one direction for attacking it
generically stays open — see "What remains open" below.

## Why ad-hoc mode is out of scope

### It inverts what an Agent is

`CONTEXT.md` defines an Agent as "a configurable preset that pins a Provider,
model, Instructions, generation parameters, Tools, Skills, and Sub-Agents.
Selecting an Agent on a Chat turn replaces direct Provider/model selection."
Today that yields one teachable rule: **an Agent grants capability, and a bare
model is bare.**

Handing a bare model the whole catalogue inverts it. The Agent stops being the
thing that grants and becomes a thing that _narrows_, plus Instructions — and
capability arrives from two unrelated places depending on a per-chat toggle.
That is a change to what the central noun means, which is the same bar
[`mcp-profiles.md`](./mcp-profiles.md) was rejected on. Direct chats are basic
by design, and that is the intended shape rather than a gap.

### "The Agent subscribes to its Workspace" dies on tool-name collisions

The proposed attachment-model fix — an enum on the Agent meaning "see everything
here", resolved at turn start — is the maximum-collision configuration by
construction: every MCP in the Workspace attached to one Agent at once. Platypus
resolves a collision by last-write-wins plus a server-side log line:

```ts
// apps/backend/src/tools/index.ts
logger.warn(
  { tool, toolSet: owner.toolSetId /* … */ },
  "Two tool sets contribute the same tool name; the later one wins this turn",
);
```

Nothing reaches the user. #467 documents the damage in the one case found so
far: an MCP server exposing `web_search` takes the Web-search card and its real
payload silently disappears from the transcript.

There is a second failure mode that namespacing cannot reach — two
_differently_ named tools with overlapping purpose and similar descriptions,
such as the built-in `fetchUrl` alongside an MCP that exposes its own web
search. The model simply has two plausible options and may pick the wrong one.
Auto-attachment maximises exactly this, and the only lever on it is fewer,
better-differentiated tools in the prompt at one time.

The proposal also concedes it makes the token problem "strictly worse", since
"everything" is then eagerly loaded on every turn.

### A crowded roster is answered by the Workspace boundary first

The request came from a Workspace holding 15+ Agents, ~20 Skills and 5 MCP
servers, driving five separate pipelines. The Workspace _is_ Platypus's scoping
boundary, and splitting is deliberately cheap: Shared resources (ADR-0007) let
the MCPs and Skills live once at Organization scope and attach to every
Workspace, and a Blueprint (ADR-0008) provisions each one in a single macro.
Five Workspaces of ~3 Agents each dissolves the selection problem with no new
concepts.

The residual cost is real and is the thing to watch: a Chat binds to one
Workspace, so a single conversation spanning all five pipelines is foreclosed.

### The newcomer case is already provisioned for

"A newcomer faces an unpleasant first screen" is answered by machinery that
already exists rather than by discovery at turn time. A Blueprint provisions a
Workspace with exactly the Shared resources it should have, and an invitation
carries an ordered set of Blueprints applied on accept (ADR-0009, and #549 for
the redemption path). A Workspace provisioned with one Agent presents no
selection problem at all.

## What remains open

The token cost underneath this request is real, and one direction for attacking
it generically survives: **per-step `activeTools` gating** — declare the full
tool set as today, render a name + description index into the system prompt
exactly as Skills already do, and narrow per step to the meta-tools plus
whatever the model has asked for. That is the "dynamic tool discovery" recorded
when #179 was closed, and it adds no new data-model concept.

It is gated on measuring what opening MCP tool sessions actually costs. #557
carries that measurement and the design constraints that go with it.

Also proposed here and **not** taken: caching each MCP's tool listing,
invalidated when the MCP row is edited. A server redeploy edits no row, so it
reintroduces the same staleness this request complains about. The underlying
want — stop re-listing every turn — is live, and belongs to #557 rather than
here.

## Prior requests

- #464 — "Direction wanted: capability discovery for ad-hoc chats, instead of
  hand-maintained Orchestrator Agents"

Related but distinct: [`mcp-profiles.md`](./mcp-profiles.md) rejects _static,
hand-curated_ tool subsetting as a data-model concept. This file rejects the
_dynamic, discover-everything_ route to the same problem. The direction left
standing by both is progressive disclosure at the runtime layer.
