# Platypus Roadmap

This document describes where Platypus is going and, just as importantly, where it
isn't. It exists to align contributors _before_ they invest time — if you're
considering a substantial PR, read the [How to read this roadmap](#how-to-read-this-roadmap)
and [Non-goals](#non-goals) sections first, then open a discussion.

It is intentionally **not** a dated release plan. Platypus is maintained by a small
team; horizons signal direction and sequencing, not delivery dates.

## Vision

> **Platypus is a self-hostable, multi-tenant platform where one technical builder
> equips their whole team with always-on AI Agents.**

The primary user is the **technical builder** — the Org Admin or Workspace Owner who
wires up Agents, Tool sets, Sandboxes, MCPs, and schedules. Everyone else on the team
is a **consumer** of what that builder ships. Making Platypus approachable matters, but
the goal is to make _one person able to equip many_, not to turn agent-building into a
no-code activity for non-technical users.

Teams self-host Platypus for four reasons:

1. **Sovereignty.** Runs against local or in-house models (vLLM, Qwen, Ollama, …) so
   internal data never leaves your infrastructure. This is the sharpest reason to reach
   for Platypus over a cloud assistant.
2. **Always-on.** Agents run in the background on shared infrastructure — not on a
   laptop that has to stay awake and plugged in overnight.
3. **Under one roof.** Agents, Boards, Dashboards, Sandboxes, MCP, schedules, and Memory
   in one platform, rather than a stack of stitched-together services.
4. **Provider-agnostic.** Local _or_ frontier models, chosen per Agent and per task, so
   you control the cost/capability trade-off yourself.

## How to read this roadmap

Items are grouped by **horizon**, which signals sequencing and how involved the
maintainers are:

- **Now** — actively being worked on by the maintainers. Coordinate before duplicating.
- **Next** — directionally agreed and well-shaped, but not started. These are the prime
  contribution targets. Talk to us first so the effort lands well.
- **Later / Exploring** — wanted, but the design isn't settled. Proposals are welcome and
  will usually start with a discussion or an ADR before any code.

Where an item is a good contribution opportunity, it says so.

## Now

### Additional Sandbox backends

The Sandbox interface is pluggable; today the only reference backend is Docker
(single-node / self-hosted). We want more: SSH to a remote host, hosted
sandbox-as-a-service (Daytona, Modal), remote VMs, and so on.

> **Contributions welcome.** A new backend implements the existing `SandboxBackend`
> interface and self-registers at boot. This is a well-scoped, well-isolated entry point
> for a first contribution — open a discussion describing the target backend before
> starting.

### Documentation

Filling the gaps in user- and contributor-facing docs so that self-hosting, configuring,
and extending Platypus doesn't require reading the source. This covers setup and
deployment guides, the domain model, and the extension points contributors are most
likely to reach for.

> **Contributions welcome.** Docs are one of the easiest ways to make a first contribution
> — fixing a confusing setup step or documenting an undocumented feature is always useful.

## Next

### Extension / plugin system

A first-class way to extend Platypus **without maintaining a fork**. A _plugin_ is a
distributable bundle (one package, one version, one config namespace, one enable/disable
switch) that contributes to one or more **typed extension points**. Extension points are
defined by core; plugins fill them. A single plugin may contribute to several — e.g. a
Daytona plugin could ship both a Sandbox backend and a management Tool set, sharing one
credential block.

- Initial extension points: **Sandbox backends** and **Tool sets**. The messaging
  gateway (below) becomes a third when it lands.
- Plugins are **installed by the Operator at deploy time** and run **in-process**
  (no isolation) — so the trust boundary is the deployment, not an in-app install button.
- Inspired by the VS Code `contributes` manifest model: borrow the manifest and the
  fixed set of contribution points; _not_ the marketplace, hot-loading, or sandboxed
  extension host.

**MCP remains the canonical path for connecting to external tool servers.** Plugins
extend Platypus's _own_ capabilities; they don't duplicate MCP.

> The loading model, manifest format, and config mechanics will be settled in an ADR
> before implementation.

## Later / Exploring

### Deterministic, code-driven workflows

A way to run multi-step pipelines where most steps are deterministic and only some need a
model. The shape we're exploring is a **DAG / state-machine executor** whose nodes are
either **script steps** (run inside a Sandbox) or **Agent steps**, connected by explicit
success/failure transitions — so the model is invoked only where reasoning genuinely adds
value, and a single bad step can't silently derail the whole run.

This sits _alongside_ the existing LLM-as-orchestrator Sub-Agent model, not in place of
it: the dispatcher pattern stays for open-ended work; the DAG is for known pipelines.

> This **updates an earlier position** — we'd previously leaned on models improving rather
> than building deterministic orchestration. The cost, fragility, and silent-failure modes
> of LLM-driven pipelines (especially with local models) make it worth exploring. It is a
> significant architectural commitment and a deliberately **lean** one — orchestration
> glue shaped like AWS Step Functions, _not_ a kitchen-sink automation platform like n8n.
> It requires an ADR before any code and is sequenced after Sandbox backends mature, since
> script steps execute in a Sandbox.

### Messaging gateway

A **decoupled service** (deployed alongside the frontend and backend) that exposes
Platypus to **bring-your-own chat surfaces** — Telegram, Slack, Discord, and others.
It is **bidirectional**: agents notify you on your phone _and_ you can reply, chat, and
approve from the channel. This subsumes external notifications and human-in-the-loop
**approvals** into a single capability.

- Each channel is a **gateway adapter** — a plugin extension point, the same pattern as
  Sandbox backends.
- **Outbound** rides the existing webhook event bus; **inbound** messages drive Chat turns
  via the API.
- **Platypus owns identity.** A channel account is _linked_ to a Platypus account in a few
  clicks; the gateway relays and Platypus authorizes. The gateway is never an auth
  authority — which is what keeps multi-tenancy intact.
- A third-party gateway _may_ integrate by speaking the contract, but the default is a
  thin first-party reference gateway. Platypus will not become a messaging platform.

> Sequenced after the extension/plugin system, since channels are plugins.

## Non-goals

These are deliberate. PRs in these directions are unlikely to be accepted — please open a
discussion first if you think one of them should change.

1. **Not a no-code Agent builder for non-technical users.** The builder persona is
   technical; non-technical members consume what builders ship (via blueprints).
2. **Not a kitchen-sink automation platform.** If code-driven workflows happen, they stay
   lean orchestration glue (Step Functions-shaped), not a visual mega-tool with hundreds
   of built-in integrations.
3. **No messaging/notification stack inside the backend.** Channels live in the decoupled
   gateway as adapters. The backend will not grow a sprawling in-process messaging
   integration.
4. **MCP stays the canonical path for external tool servers.** The plugin system extends
   Platypus's own capabilities; it does not replace or duplicate MCP for connecting out.

## How to contribute or propose

Contributions are very welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming
and commit conventions.

For anything beyond a small fix, **open a discussion or comment on the relevant issue
before investing time in a PR**, especially for items in _Next_ and _Later / Exploring_.
Aligning early is much cheaper than reworking a large PR that doesn't fit the direction
above. A rough "we'd like to build X, here's how we'd approach it" goes a long way.
