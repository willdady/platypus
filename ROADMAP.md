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
wires up Agents, Tool sets, Sandboxes, MCPs, and Triggers. Everyone else on the team
is a **consumer** of what that builder ships. Making Platypus approachable matters, but
the goal is to make _one person able to equip many_, not to turn agent-building into a
no-code activity for non-technical users.

Teams self-host Platypus for four reasons:

1. **Sovereignty.** Runs against local or in-house models (vLLM, Qwen, Ollama, …) so
   internal data never leaves your infrastructure. This is the sharpest reason to reach
   for Platypus over a cloud assistant.
2. **Always-on.** Agents run in the background on shared infrastructure — not on a
   laptop that has to stay awake and plugged in overnight.
3. **Under one roof.** Agents, Boards, Dashboards, Sandboxes, MCP, Triggers, and Memory
   in one platform, rather than a stack of stitched-together services.
4. **Provider-agnostic.** Local _or_ frontier models, chosen per Agent and per task, so
   you control the cost/capability trade-off yourself.

## How to read this roadmap

Items are grouped by **horizon**, which signals sequencing and how involved the
maintainers are:

- **Now** — actively being worked on by the maintainers. Coordinate before duplicating.
- **Shipped** — done and released. Listed so nothing here reads as unbuilt when it isn't.
- **Later / Exploring** — wanted, but the design isn't settled. Proposals are welcome and
  will usually start with a discussion or an ADR before any code.

Where an item is a good contribution opportunity, it says so.

## Now

### Additional Sandbox backends

The Sandbox interface is pluggable. Two reference backends ship today: **Docker**
(single-node / self-hosted) and **SSH** (attach to a host you already run — the one
option viable in horizontally-scaled deployments). We want more: hosted
sandbox-as-a-service (Daytona, Modal), remote VMs, and so on.

> **Contributions welcome.** A new backend implements the existing `SandboxBackend`
> interface and is contributed through a Plugin manifest's `contributes.sandboxBackends`
> array. This is a well-scoped, well-isolated entry point for a first contribution —
> open a discussion describing the target backend before starting.

### Documentation

Filling the gaps in user- and contributor-facing docs so that self-hosting, configuring,
and extending Platypus doesn't require reading the source. This covers setup and
deployment guides, the domain model, and the Extension points contributors are most
likely to reach for.

> **Contributions welcome.** Docs are one of the easiest ways to make a first contribution
> — fixing a confusing setup step or documenting an undocumented feature is always useful.

## Shipped

Items that have left the roadmap. Kept here briefly so a returning reader isn't
told something is "not started" when it is running in production.

### Extension / Plugin system — 2.0.0

A first-class way to extend Platypus without maintaining a fork. A _Plugin_ is a
distributable bundle (one package, one version, one config namespace, one enable/disable
switch) contributing to typed **Extension points** that core owns. There are three:
**Sandbox backends** and **Tool sets** shipped with the Plugin system, and **Web-search
backends** followed it. Plugins are installed by the Operator at deploy
time, run in-process, and are enabled through `PLATYPUS_PLUGINS` and configured through
one `PLATYPUS_PLUGIN_CONFIG_<NAME>` variable per Plugin. The compile-time contract is published as
[`@platypuschat/plugin-sdk`](https://www.npmjs.com/package/@platypuschat/plugin-sdk);
third-party Plugins load from installed npm packages with their Contribution ids
namespaced by Plugin name. See the
[Extending guide](https://docs.platypus.chat/extending).

**MCP remains the canonical path for connecting to external tool servers.** Plugins
extend Platypus's _own_ capabilities; they don't duplicate MCP.

> **Contributions welcome.** New Extension points, and third-party Plugins in the wild,
> are both open.

### SSH Sandbox backend — 2.0.0

The second reference Sandbox backend, and the only one viable in horizontally-scaled
deployments. See [Additional Sandbox backends](#additional-sandbox-backends) for what's
still wanted here.

## Later / Exploring

### Deterministic, code-driven workflows

A way to run multi-step pipelines where most steps are deterministic and only some need a
model. The shape we're exploring is a **DAG / state-machine executor** whose nodes are
either **script steps** (run inside a Sandbox) or **Agent steps**, connected by explicit
success/failure transitions — so the model is invoked only where reasoning genuinely adds
value, and a single bad step can't silently derail the whole run.

This sits _alongside_ the existing Sub-Agent model — an Agent delegating to its
Sub-Agents through its one delegation Tool — not in place of it: delegation stays for
open-ended work; the DAG is for known pipelines.

> This **updates an earlier position** — we'd previously leaned on models improving rather
> than building deterministic orchestration. The cost, fragility, and silent-failure modes
> of LLM-driven pipelines (especially with local models) make it worth exploring. It is a
> significant architectural commitment and a deliberately **lean** one — orchestration
> glue shaped like AWS Step Functions, _not_ a kitchen-sink automation platform like n8n.
> It requires an ADR before any code and is sequenced after Sandbox backends mature, since
> script steps execute in a Sandbox.

### Agents over A2A

An Owner can expose an Agent as an **A2A server**, so other agents and chat platforms
can hold a conversation with it. Every conversation is an ordinary Chat the Owner can
read and continue in the UI. Runs are long, so callers follow them by polling, by
streaming or by push notification, not by holding a request open. The design is settled
in ADR-0032.

- **Chat platforms are reached through other projects' gateways**, such as Hermes Agent
  and OpenClaw, which call the Agent over A2A. Platypus does not maintain an adapter for
  each chat platform.
- **Access is a per-client bearer token on the Agent**, behind an Organization gate that is
  off by default. Each run acts as the Workspace Owner, and records which client started it.
- **Exposing Agents over MCP is likely later.** As of the 2026-07-28 spec, MCP has no
  notion of a conversation. It has far wider client reach, so it is worth adding once it
  fits.

> **Proactive messages are out of scope.** Neither A2A nor MCP lets a server start a
> message in a conversation. Delivering one is left to a gateway's own delivery endpoint.

## Non-goals

These are deliberate. PRs in these directions are unlikely to be accepted — please open a
discussion first if you think one of them should change.

1. **Not a no-code Agent builder for non-technical users.** The builder persona is
   technical; non-technical members consume what builders ship (via Blueprints).
2. **Not a kitchen-sink automation platform.** If code-driven workflows happen, they stay
   lean orchestration glue (Step Functions-shaped), not a visual mega-tool with hundreds
   of built-in integrations.
3. **No messaging Gateway.** Platypus does not ship an adapter for each chat platform.
   Chat platforms reach Agents over A2A, through gateways that other projects maintain.
4. **MCP stays the canonical path for external tool servers.** The Plugin system extends
   Platypus's own capabilities; it does not replace or duplicate MCP for connecting out.

## How to contribute or propose

Contributions are very welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming
and commit conventions.

For anything beyond a small fix, **open a discussion or comment on the relevant issue
before investing time in a PR**, especially for items in _Later / Exploring_.
Aligning early is much cheaper than reworking a large PR that doesn't fit the direction
above. A rough "we'd like to build X, here's how we'd approach it" goes a long way.
