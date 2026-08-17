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

**File part**:
A file a User attached to a message in a Chat, carried alongside the message's text and persisted as a storage reference. On every Chat turn each File part is resolved to bytes and routed by the target model's declared capability.
_Avoid_: attachment (an **Attachment** is the Shared-resource reference), upload.

**Passthrough file type**:
A media type the target `(Provider, model)` pair ingests **natively**, declared per model. A capability router, not a security allow-list: a File part outside the set is converted to text where possible, never blocked for safety.

**Extracted text**:
The plain text pulled out of a binary document (PDF, DOCX) that the target model can't ingest natively, injected in place of the File part and annotated as extracted so the loss is visible. Lossy — layout, tables and images don't survive. Distinct from an inlined text file, whose bytes are already text and are sent verbatim.
_Avoid_: parsed text, converted file, OCR (Platypus does not OCR).

**Agent**:
A configurable preset that pins a Provider, model, Instructions, generation parameters, Tools, Skills, and sub-Agents. Selecting an Agent on a Chat turn replaces direct Provider/model selection.

**Sub-Agent**:
An Agent referenced by a parent Agent and exposed to it as a delegate Tool. Invoking it starts a run in its own right — bounded by the same per-step and per-run timeouts the parent turn was started under, and cancelled when the parent is — but never a Chat: nothing about a delegated run is persisted.

**Drive**:
Running a resolved turn's model loop inside a registered run, through to a terminal status. Takes one of three shapes according to who is waiting on it: an interactive **Chat turn**, a delegated **Sub-Agent**, or a headless Trigger. Whichever shape, the drive owns the model invocation and its stop conditions, the succeeded / failed / cancelled decision, and recording an **Output ceiling** cutoff; the entry point that asked for it keeps only the result shape it hands back to its own caller.
_Avoid_: driver, run executor, generation loop.

**Instructions**:
The free-text behaviour brief a User writes on an Agent — or on a Chat with no Agent. One input to the System prompt rather than the whole of it: it renders as the first fragment and cannot suppress the Platypus-owned fragments that follow.
_Avoid_: system prompt (that names the composed artefact), prompt, persona.

**System prompt**:
The single string Platypus composes per Chat turn and sends to the model, assembled from an ordered set of fragments that Platypus owns. Instructions render first and the Provider's security guardrails last; the fragments in between carry Organization, Workspace, User and Agent state. A User authors only the Instructions fragment and cannot suppress the others (ADR-0016). `FRAGMENTS` in `apps/backend/src/system-prompt.ts` is the authority on the order; `apps/docs/content/concepts/system-prompt.mdx` documents it for Users. A Sub-Agent invocation is the exception — it receives only Instructions plus guardrails.
_Avoid_: prompt, preamble, prompt template.

**Provider**:
A configured connection to an AI vendor (OpenAI, OpenRouter, Bedrock, Anthropic, Google, …). Carries credentials, base URL, the enabled `modelIds`, and a `taskModelId` for one-shot tasks. Lives at either Organization or Workspace scope.

**Model alias**:
A stable name a Provider assigns to one of its enabled models, which an Agent or Chat may select in place of a concrete model id. Repointing the alias at a different model upgrades every Agent and Chat using it at once. Provider-scoped: an alias never spans Providers, and the Provider's own pointer-settings (`taskModelId`, `memoryExtractionModelId`, `embeddingModelId`) always name a concrete model, never an alias.
_Avoid_: model alias name, model shortcut.

**Context window**:
The total token capacity of a `(Provider, model)` pair, declared by an Org Admin on the Provider's model entry. Asserted, never discovered: no vendor exposes it through the model API and no standard exists, so Platypus cannot query it — and a model reached through a proxy may not have the capacity its name implies. Optional; a model without one runs normally, but its **Context occupancy** cannot be judged against anything. Unrelated to **Context** (User Context) despite the shared word.
_Avoid_: context size, token limit, max tokens (that names an output cap).

**Context occupancy**:
How full a model's **Context window** was on the most recent Chat turn — the input-token count the vendor reported for the last model call of that turn, inclusive of cached tokens. A last value, not a running total: the conversation is re-sent in full on every Chat turn, so occupancy replaces rather than accumulates. Unknown where the Provider reports no token usage, in which case Platypus estimates nothing. Distinct from token **usage**, which is the count of tokens billed across a turn or run and legitimately is a sum.
_Avoid_: context size, context usage, tokens used, running total.

**Output ceiling**:
The most a `(Provider, model)` pair may produce in a single reply, declared by an Org Admin on the Provider's model entry and surfaced as **Max output tokens**. Unlike the **Context window** it is enforced: it is sent as the output limit on every **Chat turn** and delegated **Sub-Agent** run against that model. The Provider's own one-shot executions — Chat metadata and memory extraction, which run against its pointer-settings — do not carry it. Optional; a model without one is sent no limit at all, leaving the vendor's own default in force, which on Bedrock is far below the model's real capability. Bounds a reply, never the conversation.
_Avoid_: max tokens, token limit, context window (that names the total capacity), output budget.

**Tool set**:
A named bundle of Tools an Agent can be granted. Either contributed by a Plugin (registered in code) or backed by an MCP server.

**Tool session**:
One Agent's Tool sets, resolved for one Chat turn, together with the connections opened to serve them. Sessions nest: a Sub-Agent's session is opened on its first delegation and closes with the parent's, so a turn has exactly one thing to dispose however many tool sources it reached. A Tool set that cannot serve the turn — a factory that throws, an unreachable MCP — costs its own Tools and no more.
_Avoid_: tool context (that is the scope handed to a Tool set factory), tool loader.

**MCP**:
A Model Context Protocol server registered at Workspace scope, or — as a Shared resource — at Organization scope. Resolves to a Tool set at Chat-turn time.

**Skill**:
A named capability with a description, attached to an Agent. Surfaced to the model so it can request the skill's instructions on demand via the `loadSkill` Tool. Lives at Workspace scope, or — as a Shared resource — at Organization scope.

**Sandbox**:
A configured, isolated execution environment registered in a Workspace, providing shell and filesystem tools that operate inside it. Resolves to a Tool set at Chat-turn time. The Sandbox interface is an Extension point: different backends (local container, remote VM, hosted sandbox-as-a-service, …) are contributed by Plugins. A Sandbox also carries workspace-default environment variables that are merged into every shell execution without transiting the model.

**Plugin**:
A distributable bundle — one package, one version, one config namespace, one enable/disable switch — that the Operator installs at deploy time to extend Platypus without maintaining a fork. Runs in-process (no isolation); the trust boundary is the deployment, not an in-app install step. A Plugin makes one or more Contributions to Extension points, possibly across several points sharing one config namespace (e.g. a Sandbox backend and a Tool set on one credential block). Core Plugins ship pre-bundled; third-party Plugins are installed alongside them and loaded identically. Not hot-loaded; not a marketplace.
_Avoid_: extension (reserve for Extension point), add-on, module.

**Extension point**:
A typed slot, defined and owned by core, that a Plugin fills. The set is fixed — Plugins cannot define new ones, though core may add points (each is a purely additive, minor API bump). The Extension points are Sandbox backends, Tool sets and Web-search backends (ADR-0014); the first two shipped with the Plugin system, the third followed it. The messaging **Gateway adapter** is deliberately _not_ a backend Extension point — it lives in the separate **Gateway** app behind its own adapter seam (ADR-0015).
_Avoid_: hook, slot.

**Contribution**:
A single filling of one Extension point by one Plugin — one Sandbox backend, one Tool set, or one Web-search backend. Each Contribution has a globally unique id: a core Plugin's ids stand alone; a third-party Plugin's ids are qualified by the Plugin name. A Plugin may make several Contributions.
_Avoid_: registration, extension.

**Plugin config**:
Deployment-wide configuration and credentials for a Plugin, set by the Operator at deploy time and shared across all of that Plugin's Contributions and all tenants. Distinct from per-Workspace resource settings (e.g. a Sandbox's per-Workspace config and credentials), which remain Org-Admin- and Workspace-Owner-governed.

**Memory**:
A persisted summary of prior activity, retrieved per-User per-Workspace and rendered into the system prompt on **every** Chat turn once the Workspace has a memory-extraction Provider set — not gated on the Agent's Tool sets. The `memory` Tool set is a separate, additive thing: it grants `memorySearch` / `memoryGet` for reaching beyond the summaries already in the prompt.

**Context** (User Context):
Free-text notes a User attaches at global or per-Workspace scope, rendered into the system prompt. Nothing to do with the model's **Context window** — the word carries both meanings and they are never interchangeable.

**Operator**:
The actor who controls a Platypus deployment — process environment, compose files, and infrastructure. Equivalent to the platform super-admin (`user.role = "admin"`), who bypasses all in-app authorization. Installs and enables Plugins and sets their deploy-time Plugin config, and declares deployment-time allowlists (e.g. the eligible Docker Sandbox networks) that bound what an Org Admin can configure in-app.
_Avoid_: sysadmin, root, host owner.

**Org Admin**:
A User with the `admin` role in an Organization. Configures credential- and reach-bearing resources (Providers, Sandboxes, MCPs) and may grant a Workspace Owner self-management of some of them.
_Avoid_: organization owner.

**Workspace Owner**:
The single User who owns a Workspace. Always manages composition (Agents, Skills, Chats); manages credential- and reach-bearing resources only where an Org Admin has delegated it.
_Avoid_: workspace user, member.

**Scoped resource**:
An Agent, Skill, MCP, or Provider whose row lives at exactly one scope — a Workspace _or_ the Organization, mutually exclusive (the dual-scope shape). Resolved relative to a Workspace it yields a `(row, scope)` pair: Workspace-scoped rows are visible directly; Organization-scoped rows are visible only where an **Attachment** exists, and are locked against Workspace-surface mutation. The **Shared resource** is the Organization-scoped case of a Scoped resource.
_Avoid_: dual-scope entity, polymorphic resource.

**Shared resource**:
An Agent, Skill, MCP, or Provider defined once at Organization scope and _referenced_ (not copied) by Workspaces. A single source of truth: edited only by Org Admins, surfaced as locked to Workspace Owners. A Shared resource may only reference other Shared resources — sharing is always explicit and per-resource, never implicit or cascading.
_Avoid_: org agent, global agent.

**Attachment**:
The explicit reference that makes a Shared resource appear inside a Workspace. A Shared resource shows up in a Workspace's lists only where attached; an Org Admin manages every Shared resource regardless of Attachment via the Organization surface.

**Promote**:
The Org-Admin action that re-scopes a Workspace-private resource to Organization scope, turning it into a Shared resource and auto-attaching its origin Workspace. The resource becomes Org-Admin-governed.

**Blueprint**:
A named, Organization-scoped macro that, applied to a Workspace, both creates the Attachments for a chosen set of Shared resources (Tier 1) and sets the Workspace's pointer-settings — task/memory Providers and a default Context (Tier 2) — in one step. Run once at provisioning (or re-run on demand), never a live link. A Tier 2 Provider must also be one the Blueprint attaches. Editing a Blueprint affects only later applications; already-provisioned Workspaces are unchanged. The primary tool for provisioning a ready-to-use Workspace during onboarding.
_Avoid_: template, policy, group.

**Gateway** (Messaging gateway):
A decoupled, stateful app — deployed alongside the frontend and backend — that bridges external chat Surfaces to Platypus, relaying messages both ways. Holds the long-lived per-Surface connections and hosts Gateway adapters; the backend itself stays messaging-agnostic. Platypus, not the Gateway, is the identity authority.
_Avoid_: bot, bridge, connector.

**Surface**:
An external chat platform Platypus can be reached through — Telegram, Slack, Discord, and others.
_Avoid_: channel (a Surface's own rooms are "channels"), platform.

**Gateway adapter**:
The first-party, in-repo module that integrates one Surface with the Gateway, implementing a uniform capability contract (auth, inbound, outbound, streaming, threading, pairing). Contributed through the Gateway's own adapter seam — not the backend Plugin system.
_Avoid_: channel adapter, connector, driver.

**Sender**:
The identity of whoever sent a message on a Surface (e.g. a Telegram user, a Slack team+user, a Discord user). Resolved to a User through an Identity link — this is what authorizes a relayed message.
_Avoid_: from, author.

**Conversation locus**:
The addressable place on a Surface where one conversation lives and where replies are posted — a direct message, or a thread/room. Resolved to a Chat through a Conversation binding — this is what routes messages.
_Avoid_: conversation, channel, thread.

**Identity link**:
The record binding a Sender to a User. Created only through a User-authenticated linking flow (a Platypus-minted, single-use, short-lived code the User relays to the Surface); the Gateway can relay but never mint one. Authorizes; does not route.

**Conversation binding**:
The record binding a Conversation locus to a Chat (which carries the Workspace + Agent). On a single-stream Surface (e.g. a Telegram DM) it is the single rolling Chat, rebound by `/new`; on a thread-capable Surface each thread is its own binding and Chat. Routes; does not authorize.

## Relationships

- An **Organization** has many **Workspaces**.
- A **Workspace** has many **Chats**, **Agents**, **MCPs**, and **Skills**, and zero-or-one **Sandbox**.
- A **Chat** is produced by a sequence of **Chat turns**.
- A **Chat turn** uses either an **Agent** or a direct **Provider** + model selection.
- A **Chat turn** renders one **System prompt**, whose first fragment is the **Instructions** of the selected **Agent** — or of the **Chat** itself, where no Agent is selected.
- An **Agent** references one **Provider**, zero-or-more **Tool sets** (static or **MCP**-backed), zero-or-more **Skills**, and zero-or-more **Sub-Agents**.
- A **Provider** belongs to either an **Organization** (shared) or a **Workspace** (private).
- Each model a **Provider** exposes may declare a **Context window**. A **Chat turn** against that model yields a **Context occupancy**, measured from the tokens the vendor reports and meaningful only where a **Context window** was declared.
- Each model a **Provider** exposes may also declare an **Output ceiling**, which a **Chat turn** — or a **Sub-Agent** run — against that model is generated under. Independent of the **Context window**: one bounds the reply and is enforced, the other describes the whole capacity and is not.
- An **Agent**, **Skill**, **MCP**, or **Provider** is a **Scoped resource**: its row carries either an `organizationId` or a `workspaceId`, never both. Resolved relative to a **Workspace**, an Organization-scoped one is a **Shared resource**, visible only through an **Attachment**; a Sandbox-backed **Tool set** instead rebinds to the invoking **Workspace**'s **Sandbox** at Chat-turn time.
- A **Blueprint** names a set of **Shared resources** and, applied to a **Workspace**, creates their **Attachments** in one step.
- **Workspaces** are created only by **Org Admins** — directly, or auto-provisioned for a member when they accept an invitation. An invitation carries an ordered set of zero-or-more **Blueprints**; on accept they are applied to the new Workspace in order (Attachments union; later Blueprints win on any single-valued pointer-setting). Members do not create their own Workspaces.
- Authority over configuration runs **Operator** → **Org Admin** → **Workspace Owner**; each tier is bounded by the tier above it.
- A **Gateway** hosts many **Gateway adapters**, one per **Surface**. A message on a **Surface** carries a **Sender** and arrives at a **Conversation locus**.
- A **Sender** resolves to a **User** through an **Identity link** (authorizes); a **Conversation locus** resolves to a **Chat** through a **Conversation binding** (routes). The two are separate because in a shared room "who spoke" and "where it happened" diverge; a direct message collapses them 1:1.
- An inbound Surface message drives a **Chat turn** as the linked **User**; the reply streams back over the inbound call. Agent-initiated (proactive) output appends a message to the bound **Chat** and is delivered to its **Conversation locus** — distinct from in-app notifications, which never route to a **Surface**.

## Example dialogue

> **Dev:** "When the user sends a message with an **Agent** selected, what runs?"
> **Domain expert:** "A **Chat turn**. The turn resolves the **Agent**'s **Provider** and model, loads its **Tool sets**, **Skills**, and **Sub-Agents**, renders the system prompt with any **Memories** and **Contexts**, and streams the model's reply."
> **Dev:** "And generating a title for an existing **Chat**?"
> **Domain expert:** "That's not a **Chat turn** — it's a one-shot **Provider** execution against the **Provider**'s `taskModelId`."
