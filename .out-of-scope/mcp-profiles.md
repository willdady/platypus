# MCP Profiles / Static Per-Agent MCP Tool Subsets

Platypus does **not** add a first-class, persisted "Profile" concept — an
optional named tool subset that lives under a parent MCP (its own
`mcp_profile` table or `mcp.profiles` jsonb) and attaches to agents like a
standalone MCP. More broadly, this rejects **hand-curated, statically-stored
tool subsetting as an in-app data-model concept**, whether expressed as
Profiles, `agent.mcpToolSelections`, or duplicate MCP rows per subset.

This rejects the _curation mechanism_, not the underlying problem. The token
bloat the request documents is real and well-evidenced (see #179): an attached
MCP's full tool catalog is injected into model context on every step, and
sub-agents re-pay it too. What is out of scope is solving it with a static
curation layer baked into the app.

## Why static curation is out of scope

The unfiltered load is real and lives here: `loadTools` calls
`mcpClient.tools()` and `Object.assign(tools, mcpTools)` with no filter
(`apps/backend/src/services/chat-execution.ts:890`), and sub-agents re-enter
the _same_ `loadTools` path (`:995`), so each sub-agent re-injects the whole
catalog per its own turn. So the cost being weighed against Profiles is **not**
the table or the resolution logic — those are small. It's a **permanent new
concept in the data model and the agent/MCP config surface** that every future
feature has to reason about, added to solve something three existing levers
already address for most cases:

1. **Upstream / server-side filtering is the MCP author's responsibility.** A
   server that emits 70+ tools is over-asking of every client, and
   well-behaved ones already expose the knob — e.g. the GitHub remote server's
   toolset filtering via request headers / URL scoping. When a server is
   bloated and offers _no_ such control, the right move is an issue on _that_
   server, not a curation layer baked into every downstream client.

2. **The dedicated-agent-as-sub-agent pattern already exists.** Attach the
   heavy MCP to one focused agent ("read Jira", "write Confluence") and wire it
   in as a sub-agent. The orchestrator's context then carries only the
   sub-agent's name + description, not the MCP catalog — most of what Profiles
   buys, using primitives that ship today (`loadSubAgents` /
   `createSubAgentTools`). **Known limit:** this is not good for sustained,
   high-frequency repeated calls to the same MCP — each sub-agent hop has
   overhead, and it relocates the catalog cost off the orchestrator rather than
   reducing its absolute size.

3. **A thin MCP proxy solves it out-of-app, today.** Put a proxy in front of a
   bloated server that filters the `tools/list` it advertises — per-deployment
   subsetting with no schema or UI changes here, and it works for _any_ client,
   not just Platypus.

## Counters on record (why this may be revisited)

The reporter raised cases the three levers don't fully reach. Recording them so
the decision can be re-weighed honestly later:

- **OAuth duplication.** Getting different tool subsets from one source via
  levers (1)/(3) can force connecting the _same_ provider as multiple MCP rows
  with separate auth — the duplicate-authorization problem Platypus's
  single-connection model exists to avoid.
- **Sub-agents relocate, don't reduce.** Lever (2) hides the catalog from the
  orchestrator but does not shrink the absolute per-turn token cost — each
  sub-agent still injects the full catalog every turn.
- **Proxy must be scope-aware.** Lever (3) needs Platypus to pass agent-scoped
  context (e.g. header placeholders resolved to the agent name) for the proxy
  to subset correctly, so it isn't purely out-of-app either.

These are the signals that would move the decision — if these cases can't be
reached in a real pipeline, that's the thing to bring back.

## If this is ever reconsidered

The blocker is directional, not technical — the Profiles design is sound and
the reporter shipped a working DB-level PoC. Reconsidering means deciding that a
**static, human-curated tool-subset concept belongs in the data model and
config surface** after all. Delete this file only if that directional decision
changes.

## Prior requests

- #179 — "MCP tool-set bloat inflates agent context on every step — introduce optional MCP Profiles (tool subsets)"
