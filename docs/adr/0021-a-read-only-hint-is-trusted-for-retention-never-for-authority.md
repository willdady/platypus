---
status: accepted-pending-implementation
implemented-by: "#626"
---

# A tool's read-only hint is trusted for retention, never for authority

> **In the code.** Nothing here is built yet. Today Platypus holds no notion of
> whether a Tool reads or writes: **Tool-result clearing** consults
> `CLEARABLE_TOOL_NAMES`, a fixed set of five core Tool names, and every MCP Tool
> is denied by default. The MCP client's `annotations` never reach core, because
> the Tool session resolves an MCP through the combined `tools()` call and the
> definitions-to-Tools conversion inside it reads `annotations.title` and drops
> the rest. To be built by [#626](https://github.com/willdady/platypus/issues/626).

The MCP specification lets a server declare `readOnlyHint` on a Tool, meaning the
Tool does not modify its environment. The specification is also unambiguous about
what that declaration is worth: every property of `ToolAnnotations` is "**not
guaranteed to provide a faithful description of tool behavior**", and a client
"**MUST** consider tool annotations to be untrusted unless they come from trusted
servers". So the hint is a third party's self-declaration about its own side
effects, arriving over the same channel as everything else that server says.

Platypus wants it anyway, because **Tool-result clearing** cannot function for MCP
without it. Clearing removes an older Tool result from what a model call receives,
which is safe for a read and unsafe for a write — a model that no longer sees the
record of a write may repeat it. Core cannot tell the two apart, so clearing
shipped with an allowlist of core Tool names and excluded MCP entirely. MCP is the
largest and least predictable population of Tools in a deployment and gets no
benefit at all until the hint is available.

The decision is that **a read-only hint is trusted in proportion to what acting on
it can cost, decided per consumer, and never once for all consumers**. Concretely:
it is sufficient grounds to clear a Tool result, and it is **not** sufficient
grounds to skip an approval prompt, weaken an authorisation check, or make any
other decision a User would want to have been asked about. A later feature that
wants to act on the hint decides that for itself, on its own risk, rather than
inheriting a trust level set here.

The alternative worth naming is treating **attachment as the trust signal** —
reasoning that an MCP row is created by an Org Admin or Workspace Owner, so an
attached server is by definition a trusted one, and its hints are simply true.
This is rejected. It makes the trust decision once, invisibly, at configuration
time, and hands the result to every future consumer; the person who attached a
server was deciding whether it was useful, not underwriting its self-reports
against features that did not exist yet. That is the shape by which a cheap
retention decision silently becomes an approval bypass two features later. A
per-MCP "trust this server's annotations" flag was also considered and deferred:
it is a real option, but it is a new admin-facing control bought for a benefit
nobody has asked for, and it stays available if approvals later need it.

## Consequences

- **Undeclared means writes.** A missing, malformed, or non-boolean hint reads as
  undeclared, and every consumer today treats undeclared as "writes". This matches
  the specification's own default of `false`. Well-behaved servers that simply omit
  annotations get no benefit, which is accepted: the failure direction is a lost
  optimisation rather than a lost write.
- **The hint is resolved per turn and never stored.** It lives on the **Tool
  session** and dies with it. Persisting it would put an unverified third-party
  claim into durable storage, where it can go stale against the server that made
  it — and staleness here means clearing a write. The cost is that a Tool result
  whose server is no longer attached stops being clearable, which is the
  conservative direction.
- **Three states, not two.** Core distinguishes "declared read-only", "declared
  writes", and "undeclared", even though every consumer today collapses the last
  two. The distinction costs nothing to carry and is unrecoverable if discarded at
  the boundary; a future approval prompt may legitimately word "this tool writes"
  and "this tool has not said" differently.
- **Which Tools a turn treated as read-only is reported to the client.** The Chat
  UI mirrors the staleness rule to draw its marker, and it cannot re-derive a
  per-turn hint it never saw. The turn reports the read-only Tools it actually
  called, so the client holds no clearability policy of its own. A dedicated
  endpoint was rejected: MCP Tool names are only knowable by connecting, so
  serving one would re-pay the turn's handshakes on every Chat open.
- **Chats predating this carry no such report**, so a marker may be missing on
  their oldest results. Accepted: it needs a declared **Context window**, occupancy
  past the clearing threshold, and a Chat older than the change, and it fails by
  showing no marker rather than a wrong one.
- **Plugin-contributed Tool sets cannot declare this.** Core Tools remain a literal
  allowlist. Making them declarative would mean deriving that allowlist from
  contributions and retiring a set whose coverage test exists to police it — a
  distinct change, not blocked by this one.
