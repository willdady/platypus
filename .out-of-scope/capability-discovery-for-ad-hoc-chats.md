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

## What remains open, and what it now costs

The token cost underneath this request is real, and one direction for attacking
it generically survives in principle: **per-step `activeTools` gating** —
declare the full tool set as today, render a name + description index into the
System prompt exactly as Skills already do, and narrow per step to the
meta-tools plus whatever the model has asked for. That is the "dynamic tool
discovery" recorded when #179 was closed, and it adds no new data-model
concept.

#581 re-raised it as its step 4. Triaging #581 established what it costs, which
the #464 record did not know and which changes the case materially:

- `activeTools` narrows at the **wire level**, not merely in the TypeScript
  result type. `filterActiveTools` (`ai@7.0.48`, `dist/index.js:3062`) rebuilds
  the tools object with `Object.fromEntries(...filter(...))`, and that filtered
  result is what `prepareTools` sends to the Provider. So the saving is real —
  and so is the invalidation.
- Tool definitions render at position 0, ahead of the System prompt and ahead
  of the entire transcript (ADR-0020). A set that changes **between steps**
  therefore discards the prefix mid-turn, re-processing the whole conversation
  on every step that follows a disclosure.
- Appending rather than removing does not rescue it. An appended definition is
  inserted _before_ the System prompt, not at the end of the request, so
  everything behind the insertion point is discarded anyway. `toolOrder` keeps
  the stable core byte-identical and can do nothing about what follows it.
- Delivering disclosed schemas in a tail channel after the messages — the one
  position where appending would be safe — is the option ADR-0020 has already
  rejected: the `{role: "system"}` form throws on Google and Bedrock and is
  model-gated on Anthropic, and tail content is never cached in any case.
- Today the tools block is stable **within** a turn (`run-plan.ts` passes
  `tools` once at the top-level call, and `prepareStep` overrides only
  `messages`) and **across** turns. Every disclosure scheme spends one or both.
  Narrowing once per turn from the User's message is stable within a turn but
  changes on every turn; per-step disclosure changes within the turn as well.
  There is no cache-improving variant — only degrees of cost.

The consequence for the case, as opposed to the mechanism: under a warm prefix
the schemas are re-read at roughly a tenth of price, so the headline "55k
tokens of definitions" is a first-turn cost rather than a per-turn one, and
deferral trades a cached cost for an uncached one. What survives untouched is
the **selection-quality** argument — a model's ability to pick the right tool
degrades past roughly 30-50 of them, and no amount of caching improves that.
Anything built here should be argued on selection quality and sized against the
cache cost above, never proposed as a straightforward token saving.

Not gated on #557, contrary to what was recorded when #464 closed. #557
measures connection latency, which no form of progressive disclosure changes.
The two are independent and can proceed in either order.

Also proposed here and **not** taken: caching each MCP's tool listing,
invalidated when the MCP row is edited. A server redeploy edits no row, so it
reintroduces the same staleness this request complains about. The underlying
want — stop re-listing every turn — is live, and belongs to #557 rather than
here.

## The #581 re-raise, and why the subscription still does not land

#581 returned to the subscription with two of the three objections above
answered. #467 has since landed, so a tool-name collision renames rather than
overwrites; and #581 sequenced progressive disclosure _ahead_ of the
subscription so that "everything is eagerly loaded" would no longer follow. It
also offered two smaller forms: a subscription covering only Skills and
Sub-Agents, where no version of the collision argument applies, and — in place
of any subscription — a prompt on the Skill and MCP create forms asking which
Agents should receive the new resource, plus an "unattached" badge in the
Workspace list.

All three were declined, on the ground beneath the objections rather than on
the objections themselves. The motivating problem is a Workspace holding 15+
Agents whose lists go stale by hand, and the evidence that this is a general
shape rather than one reporter's Workspace is not there. The Workspace boundary
answer above remains the first response to a crowded roster. A mitigation for a
problem not established as general does not earn a new concept, a new form
field or a new badge — and if the creation-time prompt is worth building, it is
worth its own issue argued on plain usability grounds by whoever feels the
friction.

## Prior requests

- #464 — "Direction wanted: capability discovery for ad-hoc chats, instead of
  hand-maintained Orchestrator Agents"
- #581 — "Direction wanted: separate \"which model runs\" from \"what it can
  reach\", and make a large catalogue affordable" (steps 4 and 5 of six; see
  also [`per-chat-model-override.md`](./per-chat-model-override.md) for its
  step 6)

Related but distinct: [`mcp-profiles.md`](./mcp-profiles.md) rejects _static,
hand-curated_ tool subsetting as a data-model concept. This file rejects the
_dynamic, discover-everything_ route to the same problem. The direction left
standing by both is progressive disclosure at the runtime layer.
