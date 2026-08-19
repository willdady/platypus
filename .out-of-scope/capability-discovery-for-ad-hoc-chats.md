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

## Also rejected: caching MCP tool listings, invalidated on edit

Filed alongside the above as the "smallest change", and it does not hold up as
specified. The invalidation trigger is a Platypus-side edit of the MCP row, and
a redeploy of the server behind the URL edits no row — so a tool removed
upstream keeps being advertised until the model calls it and fails mid-turn, and
a tool added upstream stays invisible indefinitely. That is the same staleness
class the request itself complains about, one layer down and with no human act
to clear it. (#179's Profiles design had the identical hole: "persist tool
inventory on `/mcp/test`; clear it on parent URL change".)

MCP's own answer, `notifications/tools/list_changed`, requires holding the
connection open — which is what the cache exists to avoid — and is optional for
servers. A periodic background refresh scales with rows _configured_ rather than
rows _used_ and still only bounds staleness, which a lazy TTL does more cheaply.

It is also worth being clear about the payoff: a listing cache saves **no
tokens**, because the schemas still go into the prompt in full. Since #513 made
a delegate's tools load on first delegation, it saves only the parent Agent's
own `tools/list` round-trips.

## What remains open

**Per-step `activeTools` gating.** Declare the full tool set at the top-level
call as today, render a name + description index into the system prompt exactly
as Skills already do, and use `prepareStep`'s `activeTools` to expose only the
meta-tools plus whatever the model has asked for on each step. This is the
"dynamic tool discovery" direction recorded when #179 was closed: it attacks the
base-catalogue cost generically, needs no per-server cooperation, self-selects
rather than relying on curation, and adds **no new data-model concept**.

Two constraints to carry into any such design:

- It cuts tokens and improves tool selection. It does **not** cut connections —
  to declare a tool you need its schema, so every attached MCP is still opened
  and listed every turn.
- `prepareStep` cannot _add_ tools on `ai@7.0.48`: `PrepareStepResult` exposes
  `model`, `toolChoice`, `activeTools`, `toolOrder`, `instructions`, `messages`,
  `toolsContext`, `runtimeContext` and `providerOptions`, and `activeTools` can
  only narrow the declared set. Declaring everything up front is what makes the
  approach work without a new SDK capability.

Nothing should be built here before the connection cost is measured. Tool
sessions open MCPs **sequentially** — the loop in
`apps/backend/src/tools/tool-session.ts` awaits each server in turn, because
collision reporting needs each tool set to see the names claimed before it — so
an Agent with five MCPs pays five sequential connect-and-list round-trips before
its first token. Nobody has put a number on that, and it decides whether the
remaining latency work is worth anything. It also means that fixing tool-name
collisions at the naming layer (#467) may allow those connections to overlap,
which would deliver most of what a listing cache was reaching for without any
staleness question at all.

## A correction owed to the reporter

#464 argued that lever 2 of the #179 rejection (dedicated-agent-as-sub-agent)
carried an unaccounted per-turn cost, because `createSubAgentTools` resolved
every sub-agent's Provider and called `loadTools` — opening every sub-agent's
MCP connections — before the parent generated a token. **That was accurate when
the issue was filed and was fixed the following day** by #513, which made a
delegate's tools load on its first invocation, memoized. What remains eager per
parent turn is one generation-plan resolution per sub-agent: database lookups,
no MCP connections. The lever-2 gap that reopened #179 has closed.

## Prior requests

- #464 — "Direction wanted: capability discovery for ad-hoc chats, instead of
  hand-maintained Orchestrator Agents"

Related but distinct: [`mcp-profiles.md`](./mcp-profiles.md) rejects _static,
hand-curated_ tool subsetting as a data-model concept. This file rejects the
_dynamic, discover-everything_ route to the same problem. The direction left
standing by both is progressive disclosure at the runtime layer.
