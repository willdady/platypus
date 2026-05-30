# Platypus

Shared vocabulary for the Platypus codebase. Use these terms exactly when discussing the domain — don't drift into synonyms.

## Language

**Organization**:
The top-level tenant. Owns Workspaces, organization-scoped Providers, and member roles.

**Workspace**:
A scoped environment inside an Organization that contains Chats, Agents, MCPs, Skills, and workspace-scoped Providers. Owned by exactly one User within the Organization; not shared between Users.

**Chat**:
A persisted conversation in a Workspace. Composed of a sequence of messages and the configuration used to produce the assistant's replies.

**Chat turn**:
A single round of running the model: given the prior messages and a Workspace + Agent (or Provider + model) selection, produce the assistant's next streamed response. Distinct from one-shot Provider executions like metadata generation.
_Avoid_: chat request, chat invocation, chat run.

**Agent**:
A configurable preset that pins a Provider, model, system prompt, generation parameters, Tools, Skills, and sub-Agents. Selecting an Agent on a Chat turn replaces direct Provider/model selection.

**Sub-Agent**:
An Agent referenced by a parent Agent and exposed to it as a delegate Tool.

**Provider**:
A configured connection to an AI vendor (OpenAI, OpenRouter, Bedrock, Anthropic, Google, …). Carries credentials, base URL, the enabled `modelIds`, and a `taskModelId` for one-shot tasks. Lives at either Organization or Workspace scope.

**Tool set**:
A named bundle of Tools an Agent can be granted. Either statically registered in code or backed by an MCP server.

**MCP**:
A Model Context Protocol server registered in a Workspace. Resolves to a Tool set at Chat-turn time.

**Skill**:
A named capability with a description, attached to an Agent. Surfaced to the model so it can request the skill's instructions on demand via the `loadSkill` Tool.

**Sandbox**:
A configured, isolated execution environment registered in a Workspace, providing shell and filesystem tools that operate inside it. Resolves to a Tool set at Chat-turn time. The Sandbox interface is pluggable so different backends (local container, remote VM, hosted sandbox-as-a-service, …) can be contributed. A Sandbox also carries workspace-default environment variables that are merged into every shell execution without transiting the model.

**Memory**:
A persisted summary of prior activity, retrieved per-User per-Workspace and rendered into the system prompt when the Agent's Tool sets include the memory tool set.

**Context** (User Context):
Free-text notes a User attaches at global or per-Workspace scope, rendered into the system prompt.

**Operator**:
The actor who controls a Platypus deployment — process environment, compose files, and infrastructure. Equivalent to the platform super-admin (`user.role = "admin"`), who bypasses all in-app authorization. Declares deployment-time allowlists (e.g. the eligible Docker Sandbox networks) that bound what an Org Admin can configure in-app.
_Avoid_: sysadmin, root, host owner.

**Org Admin**:
A User with the `admin` role in an Organization. Configures credential- and reach-bearing resources (Providers, Sandboxes, MCPs) and may grant a Workspace Owner self-management of some of them.
_Avoid_: organization owner.

**Workspace Owner**:
The single User who owns a Workspace. Always manages composition (Agents, Skills, Chats); manages credential- and reach-bearing resources only where an Org Admin has delegated it.
_Avoid_: workspace user, member.

## Relationships

- An **Organization** has many **Workspaces**.
- A **Workspace** has many **Chats**, **Agents**, **MCPs**, and **Skills**, and zero-or-one **Sandbox**.
- A **Chat** is produced by a sequence of **Chat turns**.
- A **Chat turn** uses either an **Agent** or a direct **Provider** + model selection.
- An **Agent** references one **Provider**, zero-or-more **Tool sets** (static or **MCP**-backed), zero-or-more **Skills**, and zero-or-more **Sub-Agents**.
- A **Provider** belongs to either an **Organization** (shared) or a **Workspace** (private).
- Authority over configuration runs **Operator** → **Org Admin** → **Workspace Owner**; each tier is bounded by the tier above it.

## Example dialogue

> **Dev:** "When the user sends a message with an **Agent** selected, what runs?"
> **Domain expert:** "A **Chat turn**. The turn resolves the **Agent**'s **Provider** and model, loads its **Tool sets**, **Skills**, and **Sub-Agents**, renders the system prompt with any **Memories** and **Contexts**, and streams the model's reply."
> **Dev:** "And generating a title for an existing **Chat**?"
> **Domain expert:** "That's not a **Chat turn** — it's a one-shot **Provider** execution against the **Provider**'s `taskModelId`."
