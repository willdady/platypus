---
status: accepted
---

# Agents are reachable over A2A, and Platypus ships no messaging Gateway

Platypus will not build the messaging Gateway that ADR-0015 decided on. Instead, an Owner can make an Agent reachable over A2A (A2A 1.0) through an **A2A endpoint**. Messaging Surfaces are reached through projects that already maintain Gateways (Hermes Agent, OpenClaw), and other A2A clients (Jira Rovo, other agents) call the Agent the same way. No particular client is assumed. The Gateway was a separate stateful app with an adapter for each Surface. For a project with one maintainer that is a permanent cost, and it duplicates work those projects already do. A2A is the emerging standard for "a client talks to a remote agent", and the integration cost it puts on Platypus is a single protocol, not one per Surface. Platypus runs are **long-running**: a turn can take minutes to hours of tool calls and sandbox work. So the server is designed around asynchronous Tasks, not a reply on a single held request.

## Considered Options

- **Build the Gateway (ADR-0015).** Rejected. It means N Surface adapters, plus identity linking, conversation binding, a second deployable and an outbound event type, all owned by one maintainer, to reproduce what Hermes and OpenClaw already ship and maintain.
- **Expose Agents as an MCP server** (a `chat_with_<agent>` tool, using the MCP 2026-07-28 Tasks extension for long calls). Deferred, not rejected. A2A comes first because, as of 2026-07-28, MCP models one tool call, not a conversation: it has no context id, and protocol sessions were removed. An MCP Task tracks one long call and has nothing equivalent to an A2A context with multiple turns. MCP is still evolving and has far wider client reach than A2A, so an MCP surface is likely later. It would sit on the same endpoint, token and Principal model described below.
- **Keying the endpoint by Agent id** (`/a2a/agents/:agentId`). Rejected. A Shared Agent is attached to many Workspaces, so the Agent id alone does not say whose Workspace, Owner and Sandbox a call reaches. It would also put an internal id in a URL handed to third parties.
- **One endpoint for the Workspace, routed by A2A's `tenant` field.** Rejected. Not every client sends `tenant`, and A2A clients address one agent per URL.
- **Tokens scoped to the Workspace.** Rejected. One token would reach every exposed Agent. A token per endpoint is the narrower grant, as in ADR-0030.
- **Serving the Agent Card only with a valid token.** Rejected. Some clients fetch the card anonymously to discover the agent, and Platypus should not be built around the clients known today. Because the endpoint URL is unguessable, a public card tells nothing to anyone who does not already hold the link.
- **Deriving the card's skills from the Agent's Tool sets and Skills.** Rejected. That publishes internal configuration to callers. Skills the Owner writes on the endpoint can come later, if a client routes requests by skill.
- **Hold the request open until the run finishes** (blocking `SendMessage` as the only mode). Rejected. Runs outlive proxy, load-balancer and client timeouts, and a dropped connection would lose the result even though the run continues server-side.
- **Queueing a message sent while a run is active, or appending it to the running turn.** Deferred. A queue reverses the one-run-per-Chat design and needs machinery the backend does not have. Steering a running turn is #1109's concern. Long runs make the busy rejection hurt more, so this is the first thing to revisit when a client needs it.
- **Narrowing the Agent's tools for A2A runs, or an Org Admin approving each endpoint.** Rejected. An Owner who wants narrower tools makes a narrower Agent. A per-endpoint tool list would duplicate the Agent configuration. The Org gate and the Admin's power to revoke are the Organization's controls.
- **A rate limit per endpoint.** Not built. A reverse proxy can rate-limit an endpoint's path if an Operator needs it.
- **General-purpose API keys.** Rejected again, as in ADR-0030. The grant is "converse with this Agent", not the API.
- **Replacing Inbound Triggers with A2A.** Rejected. An Inbound Trigger is headless, its caller fills declared inputs into an Instruction the Owner wrote, and it carries dedup per record and a breaker. An A2A caller sends free text into a Chat. They serve different callers.
- **Platypus as an A2A client** (remote A2A agents appearing as tools, much like sub-agents). Not rejected, and a separate decision. Nothing here depends on it.
- **Proactive messages to a Surface** (the Agent starts a message in an existing conversation). Out of scope. Neither A2A nor MCP has an operation for a server to start a message in a conversation the client didn't just open. Push notifications only report on a Task the client started. Delivering an unprompted message is the job of a Gateway's own delivery endpoint (Hermes `deliver`, OpenClaw `/hooks/agent`).

## Consequences

- **An A2A endpoint** makes one Agent reachable from one Workspace, at `/a2a/:endpointId` with its Agent Card beside it. The endpoint id is minted for the endpoint and unguessable, not the Agent id. An Agent can have several endpoints, so the Owner can give clients that need different settings their own, or retire one client's URL without touching the others. Shared Agents are supported. The path lives outside `/organizations/...` so an Operator can expose `/a2a/*` alone, as with `/hooks/*` (ADR-0030). JSON-RPC binding only. gRPC and HTTP+JSON are deferred until a client needs them.
- **The Owner manages endpoints on a Workspace-level "A2A endpoints" screen**, like Triggers and Webhooks, not on the Agent's settings, where Shared Agents are locked against Workspace edits. Only the Owner creates, edits or deletes an endpoint, and only in the UI.
- **Each endpoint has a public name and description**, set by the Owner and defaulting to the Agent's own. The Agent's description is written for the Owner and for other Agents, which read it when delegating, so it is not necessarily fit for outside callers.
- **Agent Card.** The public card carries the endpoint's name and description, the auth scheme (HTTP bearer) and the A2A features the endpoint supports. It also carries one skill, built from the same name and description and tagged `chat`, since A2A 1.0 requires a non-empty `skills` array; the authenticated extended card is the same card. OAuth is deferred until a client needs it.
- **Tokens belong to an endpoint, one per client.** Revoking one leaves the others working, and logs and Chats show which client acted. Token handling copies ADR-0030:
  - shown once and stored as a hash;
  - expiry of 30, 90, 180 or 365 days, default 90;
  - the Owner is notified 30 and 7 days before expiry, and on first use after expiry;
  - created and regenerated only in the UI, and never readable by an Agent's tools or present in a model's context.
- **An Organization gate for A2A, off by default**, separate from the Inbound Trigger gate and with the same shape (off, all Workspaces, or selected Workspaces). It is separate because the grants differ: an A2A caller sends free text, while an Inbound Trigger caller only fills declared inputs. It is checked on every call.
- **Org Admins see and revoke, not edit**, through an Organization-wide list like the Inbound Trigger one. The Owner is notified when an Admin revokes.
- **What callers see when an endpoint is not live.** The card and every call return `404` when the endpoint is unknown, disabled or deleted, when the gate excludes its Workspace, or when the Workspace's Owner is no longer a member of the Organization. That last case is the same rule and the same check that stop Triggers firing (GHSA-h9jr-rxwg-pgx3). On a live endpoint, a call with a missing or bad token gets `401`, as A2A clients expect. The live card has already confirmed the endpoint exists, so the `401` reveals nothing new.
- **`contextId` is a Chat id.** A message without one creates a Chat bound to the Agent, and the new Chat's id is returned as the `contextId`. A message with one appends to that Chat's active leaf, through the same submit path as the web UI (ADR-0026). The Chat is an ordinary Chat in the Owner's Chat list, labelled with the token's name. The Owner can read it and continue it in the UI. A client's next message then follows the Owner's turns, and a run the Owner started counts as the context's active run.
- **The client's `messageId` becomes the user message's id.** A retry with the same `messageId` hits ADR-0026's duplicate-id check and is answered with the existing Task, so retrying after a timeout never starts a second run.
- **A Task is a row of its own** with a uuid id, referencing the Chat, the turn's assistant message, the token, and any push configuration. A message id alone cannot be the Task id, since message ids are only unique within a Chat. Task state comes from the run: `submitted` → `working` → `completed` / `failed` / `canceled`. `input-required` and `auth-required` are unused, because no run can pause for a human. Task rows live as long as their Chat. Deleting the Chat deletes them, and `GetTask` returns `404` once the endpoint is gone.
- **Long-running first.** `SendMessage` always returns the Task once the run has started, never the finished result. A client asking to block gets the finished Task only if the run ends within a short server-side cap; otherwise it gets the Task still `working`. Clients then follow the run in one of three ways:
  - `GetTask`, polling. It is read from the database, so any backend instance answers.
  - `SendStreamingMessage` / `SubscribeToTask`, over SSE. Every stream on a Task, on any instance, gets the same events, the reply's pieces included (see the #1308 amendment).
  - **Push notifications** (`TaskPushNotificationConfig`). When the Task ends (`completed`, `failed` or `canceled`), the backend POSTs it to the URL the client registered, with the credentials the client supplied. Nothing is pushed for intermediate states: a run of hours would mean many deliveries for little value, and a client that wants progress can stream. Delivery reuses the Webhook transport, including its SSRF guard and retries. Unlike a Webhook's, a push URL comes from an outside caller, so private networks are refused unless the Operator sets `A2A_PUSH_ALLOW_PRIVATE_NETWORKS`; the URL is checked at delivery only, so registration is no DNS oracle. Each config delivers once, a Task at most five times, and stored credentials are never read back.
- **`CancelTask` cancels the run** on whichever instance holds it. That depends on #1237 (cross-instance run lock and cancel), which is a hard prerequisite, as are the busy check and `GetTask` consistency.
- **One run per context.** A message to a context whose run is still active is rejected with an A2A error carrying the active Task's id. The caller can follow that Task and send again when it ends. Queueing and steering are deferred (see Considered Options).
- **A new Principal kind, `a2a`**: `{ kind: "a2a", endpointId, tokenId, name, onBehalfOfUserId }`. The run acts as the Workspace Owner, as Trigger runs do, because the Owner issued the token. The Principal still records which client started it, for logs and attribution. The run is not interactive. A2A carries no end-user identity: when a Gateway relays a Telegram user, Platypus sees only that Gateway's token.
- **The Agent knows it is on A2A.** The turn's System prompt says the conversation arrives over A2A from the token's name, and that the caller may not be the Owner. It names the token, never the endpoint URL.
- **No limit on which Agents can be exposed.** As with Inbound Triggers, a token is only as safe as the Agent's tools are narrow, and the endpoint screen and the docs say so.
- **Memory settings belong to the endpoint, and both default to off.** `includeMemories` mirrors the Trigger setting (the run's System prompt gets the Workspace's Memories block). `extractMemories` decides whether the endpoint's Chats feed memory extraction, including any turns the Owner adds to them in the UI. Both are off by default because the caller isn't necessarily the Owner: a group-chat stranger reached through a Gateway shouldn't read the Owner's memories or write into them.
- **Load is bounded by an Operator setting**: a server-wide cap on active A2A runs. Excess calls get `429` with `Retry-After`, and no Chat or Task is written.
- **Every call writes one structured log line** at `info`, in a documented and stable format, as the Inbound Trigger call log does. It records Organization, Workspace, endpoint, token, method, outcome, reason, Task and Chat, never message content.
- **Parts.** Inbound: text and data parts. Data parts are rendered as labelled JSON, like Inbound Trigger inputs. Outbound: the final assistant text as a Task artifact. File parts in either direction are deferred until a client needs them. Inbound would reuse the composer upload path (ADR-0028), and outbound would offer sandbox downloads as signed URLs.
- **Deleting an endpoint, its Agent, or a Shared Agent's Attachment** deletes the endpoint and its tokens. Its Chats stay, as Chats do when their Agent is deleted.
- **Supersedes ADR-0015** in full. ADR-0030's reference to the Gateway as the interactive path is replaced by this ADR. GLOSSARY.md's Gateway vocabulary and the ROADMAP Messaging Gateway section are withdrawn with it.

## Amendment — only an expired token stamps last rejected (#1243)

A2A tokens follow ADR-0030's lifecycle, with one difference in which
rejections stamp last rejected. An Inbound Trigger has one token, so any call
refused for its token (missing, wrong or expired) can stamp that Trigger. An
A2A endpoint has one token per client, and last rejected is kept per token. A
missing or wrong token matches no token, so there is nothing to stamp.

**Only a call with an expired token stamps last rejected**, on the token it
presented. A missing or wrong token is still answered `401`.

- Stamping the endpoint instead was the alternative. It would add a column
  that answers "someone without a valid token called", which says nothing
  about any one client. The `401` and the call log already tell that caller
  and the Operator.

## Amendment — the A2A run cap is per backend instance (#1274)

The decision above calls the load bound "a server-wide cap on active A2A runs".
That still holds within one backend instance. What this narrows is the word
"server-wide", the same way [ADR-0030's #1114 amendment](0030-inbound-triggers-are-fired-by-a-per-trigger-bearer-token.md) narrowed it for the Inbound Trigger cap.

**"Server-wide" means per backend instance.** The count of active A2A runs is
held by the process that started them, because an A2A run executes in that
process, so its own count is what bounds its own load. With several instances,
a deployment admits up to the number of instances times the setting. A
cluster-wide count would need a shared counter whose slots leak when a process
dies mid-run, and so a recovery sweep of its own, all for a bound the Operator
already gets by dividing the setting by the number of instances. The backend
configuration reference says so.

- This does not contradict A2A working whichever instance a call lands on.
  `GetTask`, `CancelTask` and the busy check reach any instance's runs; only
  the admission count is local.

## Amendment — `ListTasks` lists the calling token's Tasks (#1281)

The decision above lists the methods an endpoint answers and leaves out
`ListTasks`, which A2A 1.0 defines and its TCK requires.

**`ListTasks` is supported, and lists only the Tasks the calling token
started** on its endpoint. That is narrower than `GetTask`, `CancelTask` and
push configs, which reach any of the endpoint's Tasks by id. A Task's id is a
random UUID that only the client that started it is told, so it works as that
client's key to the Task. A list scoped to the endpoint would hand every token
the others' ids, and with them their replies, undoing "tokens belong to an
endpoint, one per client". A Task whose token was deleted has no token, so it
is listed to no one.

- Listing by endpoint, to match `GetTask`, was the alternative. It is the
  literal reading of "Tasks the caller may see", but nothing a client needs
  is in another client's Tasks.
- A Task's status timestamp is when its end was recorded, or when it was made
  while it runs. The list is ordered by it, newest first.

## Amendment — a token reaches only the Chats and Tasks it started (#1293)

The decision above scopes `contextId` to the endpoint's Agent and every Task
method to the endpoint, and the `ListTasks` amendment calls `GetTask`,
`CancelTask` and push configs deliberately wider than the list. Both are
replaced: **a token reaches only the Chats and Tasks it started.**

- **`contextId`** names a Chat only when that Chat's token is the caller's.
  The Owner's UI Chats, another token's Chats and Chats started through
  another endpoint for the same Agent are unreachable. Chat ids are in UI
  URLs, screenshots and the call log, so they are not secrets. Appending to
  an Owner UI Chat also wrote the caller's text into the Owner's Memories,
  since a Chat with no endpoint reads as the Owner's own, and appending to
  another endpoint's Chat got around that endpoint's memory settings.
- **`GetTask`, `CancelTask`, `SubscribeToTask`, a message naming a `taskId`
  and the four push-config methods** reach only the caller token's Tasks. One
  token could otherwise cancel another's run, or read the push credentials it
  registered.
- **Every reach outside that answers as an unknown id does**
  (`TaskNotFoundError`), so a caller learns nothing about what it can't reach.
- **"One run per context" no longer mints a Task for an Owner's turn.** A
  token's Chat busy with a turn the Owner started in the UI answers busy with
  no `taskId`. A busy answer names a Task only when the caller's token started
  the running turn. The Owner continuing a client's Chat in the UI, and a
  client's next message following those turns, is unchanged.
- **A deleted token's Chats and Tasks are reachable by no one** over A2A. Its
  calls are already `401`, and no other token reaches them.

## Amendment — every stream on a Task gets the same events (#1308)

The decision above streamed reply deltas only on the connection that started
the run; a `SubscribeToTask` follower, or a retried `SendStreamingMessage`,
got status changes and then the whole artifact at the end, and every follower
polled the database once a second. A2A 1.0 §3.5.2 says events "MUST be
broadcast to all active streams for that task" in the same order. **Every
stream on a Task now gets the same events, including the reply's pieces.**

- **The instance running a Task's run is its one producer.** It reads the
  run's own stream, whether or not the call that started it is streaming, and
  publishes numbered events: a change of status, each piece of the reply, and
  the end. Streams on that instance get them in-process.
- **Other instances get them through Postgres `NOTIFY`**, on the LISTEN
  connection the cross-instance cancel already held (#1237), now shared by
  both. Each event carries its piece of the reply, split to fit `NOTIFY`'s
  8000-byte payload, with its character offset into the reply. That is the
  simplest design that gives every follower the same ordered events: no
  delta store, no migration, and no instance reads another's memory. An
  in-memory ring on the producer with a database fallback, or the reply's text
  read from the database at an offset, were the alternatives. The first needs
  a second store for the instances that can't reach the ring; the second
  trails the run by the partial-write interval and so cannot give followers
  the pieces the starter got.
- **Each instance keeps the reply so far of every Task it hears of**, so a
  stream joining mid-reply is sent it as one artifact first, then the pieces
  after it. A2A runs are capped per instance, so this is small.
- **A lost notification leaves a gap in the numbers.** A stream on the
  instance that missed it sends no more pieces; the end still comes with the
  whole artifact. Status and the end come from the database too: a follower
  with no producer on its instance reads its Task every 15 seconds while it
  hears nothing, which also covers a producer lost with its instance.
- **A blocking `SendMessage` on the instance that started the run** waits on
  the run's events until it ends or the deadline passes, then reads the Task
  once. It does not poll.
- **The 30-second cap on a blocking `SendMessage` stays**, a deliberate
  deviation from §3.2.2, which waits for the Task to end. Runs last minutes to
  hours, and proxies, load balancers and clients time out an idle request
  long before that. Past the cap the client gets the Task still running and
  follows it as the decision above describes.

## Amendment — a call with no `A2A-Version` is served as 1.0

A2A 1.0 §3.6.2 reads a request with no `A2A-Version` header as version 0.3.
**Platypus serves it as 1.0**, the only version its card declares. A2A is new
in Platypus and no 0.3 client was ever served, so there is nothing to stay
compatible with, and refusing a request without the header would shut out
every client that never sends it. A header naming another version is refused,
as the spec says.
