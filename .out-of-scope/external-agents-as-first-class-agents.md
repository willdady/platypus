# External Agents as First-Class Agents

Platypus does **not** make a remote A2A agent a first-class, selectable agent:
a stored entity listed in the agent picker, the command menu and the Sub-Agent
picker beside native Agents, carrying an "external" badge and an avatar set by
a Workspace Owner or Org Admin.

This rejects that _shape_ of the A2A client, not the client itself. Letting a
Platypus Agent discover and message remote A2A agents is wanted, and is
tracked as a Tool set in #1357.

## Why this is out of scope

A Tool set is how an Agent already reaches anything outside the instance
(Web search, MCP servers), and the outbound questions — untrusted output, Tool
gates, audit — are already answered for Tools. A first-class external agent
instead adds a permanent new concept that every agent-facing surface has to
reason about:

- a new entity, or an origin marker on the Agent row, that agent lists,
  Sub-Agent resolution and the permission model all have to handle;
- ownership and who may add one (Workspace Owner, Org Admin, or both);
- a badge, an avatar source and its override, in every picker;
- Sub-Agent rules (step budget, timeout, truncation, activity events) for a
  run Platypus does not execute.

The benefit that only this shape buys is a remote agent in the same pickers as
a native one. Nobody has needed that yet, and a Tool set can still give the
model a Sub-Agent-style hand-off, so the remote catalogue stays out of the
parent's context — #1357's open question 4.

## If this is ever reconsidered

The signal would be people needing to choose a remote agent _directly_ — as a
Chat's agent, or in the Sub-Agent picker — where calling it through a Tool
falls short. Delete this file only if that need is real.

## Prior requests

- #1358 — "feat: external agents over A2A as first-class, selectable agents"
