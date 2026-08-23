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
A configurable preset that pins a Provider, model, Instructions, generation parameters, Tools, Skills, and Sub-Agents. Selecting an Agent on a Chat turn replaces direct Provider/model selection.

**Sub-Agent**:
An Agent referenced by a parent Agent and exposed to it as a delegate Tool. Invoking it starts a run in its own right — bounded by the same per-step and per-run timeouts the parent turn was started under, and cancelled when the parent is — but never a Chat: nothing about a delegated run is persisted.

**Turn resolution**:
The phase of a **Chat turn** before the model request is sent: the **Tool session** is opened, Skills, Memories and **Contexts** are loaded, **File parts** are resolved to bytes or **Extracted text**, and the **System prompt** is rendered. Ends where the **Drive** begins, so the two are sequential and together are the whole of what a User waits for. Surfaced to Users as "Preparation".
_Avoid_: setup, initialisation, warmup, preflight.

**Drive**:
Running a resolved turn's model loop inside a registered run, through to a terminal status. Takes one of three shapes according to who is waiting on it: an interactive **Chat turn**, a delegated **Sub-Agent**, or a headless **Trigger**. Whichever shape, the drive owns the model invocation and its stop conditions, the succeeded / failed / cancelled decision, and recording that a run was cut short — either at the **Output ceiling** or by the **Step ceiling** stopping a loop the model meant to continue; the entry point that asked for it keeps only the result shape it hands back to its own caller.
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
How full a model's **Context window** was on a single model call — the input-token count the vendor reported for it, inclusive of cached tokens. Read per **Chat turn** as that turn's last call, and within a **Drive** as the step just completed; either way a last value, not a running total, because the **Transcript** is re-sent in full on every call and so occupancy replaces rather than accumulates. Unknown where the Provider reports no token usage, in which case Platypus estimates nothing. Distinct from **Token usage**, which is the count of tokens billed across a turn or run and legitimately is a sum, and from **Projected occupancy**, which looks forward instead of back.
_Avoid_: context size, context usage, tokens used, running total.

**Projected occupancy**:
Where the next model call starts from: the last call's **Context occupancy** plus the output-token count the vendor reported for that same call, since the reply it produced joins the **Transcript** and is re-sent with it. Both figures are the vendor's; an unsent draft is never counted, because tokenising locally is the estimate Platypus refuses. Close to the next call's real input but not identical to it: it reads high on a turn whose reasoning tokens were billed as output and then not re-sent, and low by whatever the next message turns out to be. Shown wherever a reader is about to send — the Chat composer's meter — and used to gate **Tool-result clearing** on a turn's first call, before that turn has reported anything of its own. A retrospective display of a finished run shows plain **Context occupancy** instead, which is why a **Trigger** run's stats and the composer meter legitimately differ.
_Avoid_: estimated occupancy, projected usage, next-turn tokens.

**Transcript**:
The ordered messages of a **Chat**, held as its record and re-sent to the model in full on every **Chat turn** and on every step within one. Distinct from what a single model call receives, which may be narrower — see **Tool-result clearing** — and from the **System prompt**, which is composed per turn rather than accumulated.
_Avoid_: history, conversation, message log, context (which already carries three other meanings).

**Tool-result clearing**:
Replacing the content of an older tool result in what a model call receives, leaving the tool call itself and the stored **Transcript** untouched. Bounds a **Transcript** by retention rather than by summary, so a cleared result is plainly absent to the model instead of silently condensed; Platypus does not summarise a **Transcript** at all. Engages only where a **Context window** was declared, and only for tools whose results are safe to lose.
_Avoid_: pruning, compaction (reserve for summarising, which Platypus does not do), context editing, truncation (that names a per-call bound on a single result or reply).

**Token usage**:
The tokens a **Chat turn** or run was billed for — the vendor's reported input and output counts folded across every model call the turn made. A sum, and legitimately one: each call is billed separately. Distinct from **Context occupancy**, which is a single call's input count and never accumulates — on a long tool-using turn the two differ by roughly an order of magnitude. Counts only: no Provider declares what a model costs per token, so Platypus states no monetary figure anywhere.
_Avoid_: tokens used (ambiguous between this and **Context occupancy** — name which one), cost, spend, context usage.

**Output ceiling**:
The most a `(Provider, model)` pair may produce in a single reply, declared by an Org Admin on the Provider's model entry and surfaced as **Max output tokens**. Unlike the **Context window** it is enforced: it is sent as the output limit on every **Chat turn** and delegated **Sub-Agent** run against that model. The Provider's own one-shot executions — Chat metadata and memory extraction, which run against its pointer-settings — do not carry it. Optional; a model without one is sent no limit at all, leaving the vendor's own default in force, which on Bedrock is far below the model's real capability. Bounds a reply, never the conversation.
_Avoid_: max tokens, token limit, context window (that names the total capacity), output budget.

**Step ceiling**:
The most model calls one turn's loop may make before it is stopped, counting every round trip a tool call costs rather than the size of any one reply. Set as an Agent's **Max steps**, defaulted where none is given; a **Chat turn** with no Agent runs under its own resolved value. Enforced as a stop condition, not an error: the loop simply ends, and the run is recorded as succeeded because it did the work it was allowed to do. Where it stopped a loop the model meant to continue, that is recorded and told to whoever reads the output — the same way an **Output ceiling** cutoff is. Distinct from the **Output ceiling**: this one bounds the loop, that one bounds a single reply, and a "cut short" notice names which of the two it means.
_Avoid_: max steps (that names the Agent field, not the concept), iteration cap, loop limit. "Step limit" is the User-facing wording — it is what the notices say and what the docs call it — and the code names the stop after it (`stoppedAtStepLimit`), mirroring the **Output ceiling**'s own `truncatedByTokenLimit`; prefer this term when writing about the mechanism.

**Unavailable capability**:
Something a **Chat turn** was asked to run with and **Turn resolution** could not supply, where the turn proceeds without it rather than failing. Web search is the case that exists: the User turns it on, the Provider names a search backend that is no longer installed or that fails to start, and the reply is written with no search at all. The model is never told — telling it would have it explain an outage it cannot see — so the turn is reported to the User instead, as a notice under the reply. Reported on the outcome, not the cause: whatever the reason no tools were served, the User is told the same thing, and the Operator's log carries the specific fault. A capability the turn never asked for is not one of these, and neither is a Tool the model called and got an error back from.
_Avoid_: degraded capability, disabled capability, failed tool.

**Tool set**:
A named bundle of Tools an Agent can be granted. Either contributed by a Plugin (registered in code) or backed by an MCP server.

**Tool session**:
One Agent's Tool sets, resolved for one Chat turn, together with the connections opened to serve them. Sessions nest: a Sub-Agent's session is opened on its first delegation and closes with the parent's, so a turn has exactly one thing to dispose however many tool sources it reached. A Tool set or Web-search backend that opens something with a lifetime registers its own close into that same one thing. A Tool set that cannot serve the turn — a factory that throws, an unreachable MCP — costs its own Tools and no more.
_Avoid_: tool context (that is the scope handed to a Tool set factory), tool loader.

**MCP**:
A Model Context Protocol server registered at Workspace scope, or — as a Shared resource — at Organization scope. Resolves to a Tool set at Chat-turn time.

**Skill**:
A named capability with a description, attached to an Agent. Surfaced to the model so it can request the skill's instructions on demand via the `loadSkill` Tool. Lives at Workspace scope, or — as a Shared resource — at Organization scope.

**Sandbox**:
A configured, isolated execution environment registered in a Workspace, providing shell and filesystem tools that operate inside it. Resolves to a Tool set at Chat-turn time. The Sandbox interface is an Extension point: different backends (local container, remote VM, hosted sandbox-as-a-service, …) are contributed by Plugins. A Sandbox also carries workspace-default environment variables that are merged into every shell execution without transiting the model.

**Board**:
A Kanban board scoped to a Workspace: ordered **Columns**, **Cards**, and Board-level colour-coded Labels. A shared working surface — Users and Agents read and update the same Board, Agents through the Kanban Tool set. Board activity is the source of the `card.*` **Webhook events**. Deleting a Label removes it from every Card using it; everything else on the Card survives.
_Avoid_: kanban (that names the Tool set), task list, project.

**Column**:
A named stage on a **Board**; a **Card** sits in exactly one Column at a time, ordered by position within it. Crossing Columns is what `card.moved` means — a reorder within one Column fires only `card.updated`.
_Avoid_: lane, swimlane, list, stage.

**Card**:
The unit of work on a **Board**: title, Markdown body, Labels, due date, priority (none/low/medium/high/urgent), a single Assignee, and threaded Comments. Every write records who made it — a User _or_ an Agent — and an Assignee may be either. An Agent is held to the same rules as a person: only Labels the Board actually has, only Assignees who can work in the Workspace.
_Avoid_: ticket, issue, item, task.

**Dashboard**:
A Workspace-scoped grid of **Widgets** with separate desktop and mobile layouts, auto-refreshing in view mode. Deliberately split by ownership: Users own the layout and the widget set; an Agent updates Widget data only.
_Avoid_: report, page, view.

**Widget**:
A typed tile on a **Dashboard** — metric, text/markdown, image, weather, or chart. An Agent may bring a Widget's data current but can never change its type, placement, size, or presence; updating requires matching the declared type, so a chart cannot be overwritten into a metric.
_Avoid_: tile, panel, component.

**Trigger**:
A saved automation that runs an Agent unattended against a fixed Instruction — no Chat, nobody watching. One of two shapes: a **Cron Trigger**, firing on a schedule evaluated in the Trigger's own timezone, or an **Event Trigger**, firing when a subscribed **Webhook event** occurs in the Workspace, debounced so a burst coalesces into one run. The event's payload arrives above the Instruction, so the Instruction can point at it. An Agent's own writes never fire that Agent's own Event Trigger.
_Avoid_: automation, job, scheduler, webhook (that delivers events out; it runs nothing).

**Trigger run**:
One execution of a **Trigger** — the headless shape of a **Drive**. Recorded separately from any Chat under its own status vocabulary (`pending` / `running` / `success` / `failed` — not the chat-run words), with its own stats and retention bounded by Max Runs to Keep. Bounded by the same **Output ceiling** and **Step ceiling** as any Drive, plus the unattended-only no-progress stop: repeating the same tool call and getting the same result several times in a row ends the run as _failed_, naming the tool — distinct from a step-limit stop, which still ends _success_.
_Avoid_: trigger execution, scheduled run (ambiguous between the Trigger shapes).

**Webhook**:
An outbound subscription that delivers Workspace **Webhook events** to an external HTTPS URL — fire-and-forget, never blocking the action that produced the event. Each delivery carries an envelope (event name, timestamp, org and workspace ids, the event's `data`) and is signed with the Webhook's signing secret (HMAC-SHA256 over the raw body); failures retry three times (1s/2s/4s backoff), then the delivery is given up. Consumes the same event stream as an **Event Trigger** but sends it out rather than running an Agent.
_Avoid_: callback, integration, outgoing hook.

**Webhook event**:
One of the enumerated Workspace occurrences a **Webhook** subscribes to and an **Event Trigger** fires on — `card.*` and `notification.*`, one shared stream with two consumers. Payload shape varies per event: some carry the full record, others only the IDs of what changed, and a few carry both shapes (`notification.read` has a singular and a bulk form).
_Avoid_: domain event, platform event; "notification" (reserved for the Notification itself).

**Notification**:
A short message an Agent posts to a Workspace's feed — the reply an unattended run leaves when there was no Chat anyone was watching. In-app only: nothing is emailed or pushed, and in-app Notifications never route to a messaging **Surface**. Read-state tracked per User; an Agent can edit and dismiss only the Notifications it posted itself. Posting one is granted per-Agent through the Notifications Tool set.
_Avoid_: alert, push, mention, message (that names a Chat's unit).

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

**Invitation**:
An Organization's record of the decision that one named person may hold an account and join it, carrying an optional Workspace name and an ordered set of Blueprints. Redeemable exactly once, before it expires; redemption or acceptance joins the person to the Organization and provisions their Workspace.
_Avoid_: invite request, membership request, allowlist entry.

**Invitation link**:
The single-use URL that redeems an Invitation, bearing a token minted with it. Held by whoever the Invitation's sender passes it to — the link, not the address on the Invitation, is what binds a redemption to it.
_Avoid_: magic link, signup link, activation link.

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
- A **Workspace** has many **Chats**, **Agents**, **MCPs**, **Skills**, **Boards**, **Dashboards**, **Triggers**, **Webhooks**, and **Notifications**, and zero-or-one **Sandbox**.
- A **Chat** is produced by a sequence of **Chat turns**.
- A **Chat turn** runs in two sequential phases: **Turn resolution** assembles what the turn needs, then the **Drive** runs the model loop. A slow turn is slow in one phase or the other, and they are attributed separately.
- A **Chat turn** uses either an **Agent** or a direct **Provider** + model selection.
- A **Chat turn** renders one **System prompt**, whose first fragment is the **Instructions** of the selected **Agent** — or of the **Chat** itself, where no Agent is selected.
- An **Agent** references one **Provider**, zero-or-more **Tool sets** (static or **MCP**-backed), zero-or-more **Skills**, and zero-or-more **Sub-Agents**.
- A **Provider** belongs to either an **Organization** (shared) or a **Workspace** (private).
- Each model a **Provider** exposes may declare a **Context window**. A **Chat turn** against that model yields a **Context occupancy**, measured from the tokens the vendor reports and meaningful only where a **Context window** was declared.
- A **Chat turn** also yields a **Token usage**, folded across its model calls. Both come from the same vendor-reported figures and neither substitutes for the other: occupancy answers how full the window got, usage answers how much the turn was billed.
- A **Chat turn**'s **Context occupancy** and its reply's tokens together give the next turn's **Projected occupancy**, which is what a reader is shown before they send.
- A **Chat turn** sends its **Transcript** in full. **Tool-result clearing** narrows what an individual model call receives without altering the stored **Transcript**, so what a User reads and what the model was given can legitimately differ; it is driven by **Projected occupancy** on a turn's first call and by **Context occupancy** on every call after, and therefore engages only where a **Context window** was declared.
- Each model a **Provider** exposes may also declare an **Output ceiling**, which a **Chat turn** — or a **Sub-Agent** run — against that model is generated under. Independent of the **Context window**: one bounds the reply and is enforced, the other describes the whole capacity and is not.
- Every **Chat turn**, **Sub-Agent** run and **Trigger** run also drives under a **Step ceiling**, which bounds the loop rather than any one reply. Both ceilings can cut a turn short, and each records which one did, so the notice a reader sees names the limit that applied.
- A **Board** owns its ordered **Columns**; a **Card** lives in exactly one **Column** at a time. Moving a Card between Columns is what `card.moved` names — a reorder within one Column fires only `card.updated`.
- A **Board** write and a **Notification** post emit **Webhook events**. The stream has two consumers: an **Event Trigger** runs an Agent inside Platypus in response, a **Webhook** delivers the event to an external URL — and neither consumer affects the other.
- A **Trigger** is the headless shape of a **Drive**: its Agent runs unattended as a **Trigger run**, and a **Notification** is the reply it leaves behind when there was no Chat anyone was watching.
- A **Chat turn** may also record an **Unavailable capability** — something it was asked to run with that **Turn resolution** could not supply. Like the **Output ceiling** cutoff it is a per-turn outcome told to the User under the reply, and unlike it, it is known before the model is ever called.
- An **Agent**, **Skill**, **MCP**, or **Provider** is a **Scoped resource**: its row carries either an `organizationId` or a `workspaceId`, never both. Resolved relative to a **Workspace**, an Organization-scoped one is a **Shared resource**, visible only through an **Attachment**; a Sandbox-backed **Tool set** instead rebinds to the invoking **Workspace**'s **Sandbox** at Chat-turn time.
- A **Blueprint** names a set of **Shared resources** and, applied to a **Workspace**, creates their **Attachments** in one step.
- **Workspaces** are created only by **Org Admins** — directly, or auto-provisioned for a member when they accept an invitation. An invitation carries an ordered set of zero-or-more **Blueprints**; on accept they are applied to the new Workspace in order (Attachments union; later Blueprints win on any single-valued pointer-setting). Members do not create their own Workspaces.
- An **Invitation** is redeemed through its **Invitation link**, which creates the account and joins the Organization in one act; a person who already holds an account instead accepts the Invitation in-app. Where the Operator requires invitations, redemption is the only way an account comes into existence — admission is the **Operator**'s to constrain, never an **Org Admin**'s to widen.
- Authority over configuration runs **Operator** → **Org Admin** → **Workspace Owner**; each tier is bounded by the tier above it.
- A **Gateway** hosts many **Gateway adapters**, one per **Surface**. A message on a **Surface** carries a **Sender** and arrives at a **Conversation locus**.
- A **Sender** resolves to a **User** through an **Identity link** (authorizes); a **Conversation locus** resolves to a **Chat** through a **Conversation binding** (routes). The two are separate because in a shared room "who spoke" and "where it happened" diverge; a direct message collapses them 1:1.
- An inbound Surface message drives a **Chat turn** as the linked **User**; the reply streams back over the inbound call. Agent-initiated (proactive) output appends a message to the bound **Chat** and is delivered to its **Conversation locus** — distinct from in-app notifications, which never route to a **Surface**.

## Example dialogue

> **Dev:** "When the user sends a message with an **Agent** selected, what runs?"
> **Domain expert:** "A **Chat turn**. The turn resolves the **Agent**'s **Provider** and model, loads its **Tool sets**, **Skills**, and **Sub-Agents**, renders the system prompt with any **Memories** and **Contexts**, and streams the model's reply."
> **Dev:** "And generating a title for an existing **Chat**?"
> **Domain expert:** "That's not a **Chat turn** — it's a one-shot **Provider** execution against the **Provider**'s `taskModelId`."
