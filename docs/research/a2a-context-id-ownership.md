# A2A `contextId` ownership: client-minted or server-minted?

Researched 2026-10-09 against primary sources only: the A2A spec repo, official
SDK source, and framework source. Each source repo was shallow-cloned and is
pinned below to the commit read (short SHAs; GitHub resolves them in permalinks).
Line numbers refer to that commit.

## TL;DR

- **The spec changed sides.** Through v0.3.0, `Task.contextId` was documented as
  "server-generated", and nothing was said about client-provided values.
  v1.0.0-rc said agents **MUST accept and preserve** client-provided
  `contextId`s. v1.0.0 (2026-03-12) and v1.0.1 relaxed that to **MAY accept**.
  If an agent cannot accept one, it **MUST reject the request with an error and
  MUST NOT generate a new `contextId`**. Clients **SHOULD NOT** send a
  client-generated `contextId` unless they know how the server handles it
  (§3.4.1, PR #1588).
- **Every official SDK server accepts and adopts an unknown client-supplied
  `contextId`.** This covers Python, JS, Java, Go, .NET and Rust. None of them
  looks the value up, and each mints a UUID only when the field is absent. The
  TSC wrote on #1581: "SDK precedent is that contextId can be provided by the
  client."
- **Most clients don't mint one.** The SDK helpers, ADK (by default), CrewAI,
  Strands, Semantic Kernel, Microsoft Agent Framework and a2a-inspector all send
  the first message without a `contextId` and adopt the server's. **Clients that
  mint:** Hermes Agent (`ctx-<16 hex>`), the a2a-samples CLI and routing hosts
  (`uuid4`), Agent Stack (platform-allocated id or `uuid4` in its example CLI),
  and ADK with the opt-in `forward_session_id_as_context_id`.
- **Every framework server read here accepts an unknown client `contextId`.**
  None rejects one. Platypus is the only server found that rejects it, which v1.0
  permits.
- **Recommendation:** accept an unknown client `contextId` on a message with no
  `taskId`. Bind it to a new Chat namespaced to the calling A2A token, and echo it
  back verbatim. Validate its length and charset, and reject a bad value with an
  error, never a substitute id. Agent Stack's per-user claim table and Microsoft
  Agent Framework's `IsolationKeyScopedTaskStore` are the prior art for scoping.

## Platypus today

Pinned at `dc968fca`.

`startTurn` in `apps/backend/src/services/a2a-task.ts` handles a `message.contextId`
with no `taskId` like this:

- It selects a Chat where `chat.id = contextId` **and** `workspaceId`, `agentId`
  and `a2aTokenId` match the calling endpoint and token. This is the
  token-scoping amendment (#1293) in `docs/adr/0032-…`.
- If no such Chat exists, it throws
  `new TaskNotFoundError("Context not found")`, imported from
  `@a2a-js/sdk/errors` (`~1.3.0`). On the wire that is JSON-RPC
  **`-32001` TASK_NOT_FOUND** with message `Context not found`.
- A message with no `contextId` gets a Chat id of
  `a2aChatId(token.id, message.messageId)`, a UUIDv5 over `[tokenId, messageId]`.
  This makes concurrent retries race for one Chat. The Chat's id is then
  returned as the `contextId`. `chat.id` is a global `text` primary key
  (`apps/backend/src/db/schema.ts`, table `chat`).

As a result, a client that mints its own `contextId` on the first message, as
Hermes does, is refused with -32001. The spec allows this (§3.4.1: "MUST reject
the request with an error"). Note, though, that the spec's `TaskNotFoundError`
is defined for task ids ("The specified task ID does not correspond to an
existing or accessible task", §3.3.2). The spec has no context-not-found error.

## Tally

"Client mints" means the client puts a `contextId` on the **first** message of a
conversation. "Server on unknown id" means the server's behaviour when a message
carries a `contextId` it has never seen and no `taskId`.

| Project (pinned)                                | Client mints on first message?                                              | Server on unknown client `contextId`                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **A2A spec v0.2.x–v0.3.0**                      | Not expected ("server-generated")                                           | Unspecified                                                                            |
| **A2A spec v1.0.0-rc**                          | Allowed                                                                     | **MUST** accept and preserve                                                           |
| **A2A spec v1.0.0 / v1.0.1**                    | **SHOULD NOT** unless it knows the server's handling                        | **MAY** accept; if not, **MUST** error and **MUST NOT** substitute                     |
| a2a-python `494a8ece0ad9`                       | No                                                                          | Accept & adopt                                                                         |
| a2a-js `ca14b824bc07`                           | No                                                                          | Accept & adopt                                                                         |
| a2a-java `fc2e96e53a8d`                         | No                                                                          | Accept & adopt                                                                         |
| a2a-go `3e1aa7fa3801`                           | No                                                                          | Accept & adopt                                                                         |
| a2a-dotnet `cf4d504e3bcb`                       | No (optional param, default `null`)                                         | Accept & adopt (+ `ClientProvidedContextId` flag)                                      |
| a2a-rs `9329673e7467`                           | Not checked                                                                 | Accept & adopt                                                                         |
| Google ADK Python `d8dc29948c68`                | No by default; opt-in `forward_session_id_as_context_id`                    | Accept: creates session with that id, scoped to the authenticated user                 |
| Google ADK JS `22f3bf99b5ec`                    | Not checked                                                                 | Accept: get-or-create session keyed only on `contextId`                                |
| Google ADK Java `7d1144283811`                  | No (reuses prior id from event metadata)                                    | Accepted by a2a-java; ADK creates a session with a _generated_ id (see note)           |
| LangGraph Platform (`langgraph-api` 0.15.4)     | n/a (server)                                                                | Accept: `runs.create(thread_id=contextId, if_not_exists="create")`                     |
| CrewAI `bb235ef17259`                           | No (adopts response's id)                                                   | Accept (via a2a-python)                                                                |
| FastA2A / Pydantic AI `d94dc2fa644c`            | No                                                                          | Accept & adopt (empty history)                                                         |
| AWS Strands `b340edbbfee0`                      | No (never sets `context_id`)                                                | Accept; documented as "not an authentication boundary"                                 |
| MS Agent Framework `2d9cc3f8ae46`               | No unless the caller supplies one                                           | Accept (`GetOrCreateSessionAsync`); optional per-isolation-key namespacing             |
| MS Semantic Kernel `cc8a15fa356f`               | No (never sets `ContextId`)                                                 | Not verified                                                                           |
| BeeAI Agent Stack `79c786049d39`                | **Yes**: UI pre-creates a platform Context; example CLI mints `uuid4().hex` | Accept & **claim for the calling user**; another user's id gets `ForbiddenUpdateError` |
| **Hermes Agent** (Nous Research) `4f9b741a3a02` | **Yes**: `"ctx-" + uuid4().hex[:16]`                                        | Accept; session key excludes peer identity                                             |
| a2a-samples `6603ba3f2c31`                      | **Yes** (CLI host, routing hosts: `uuid4`)                                  | Sample JS agents accept                                                                |
| a2a-inspector `8aa064639af1`                    | No (starts `null`, adopts the server's)                                     | n/a                                                                                    |
| Microsoft AutoGen                               | No A2A implementation found                                                 | n/a                                                                                    |
| **Platypus** `dc968fca`                         | n/a (server)                                                                | **Reject**: `-32001` "Context not found"                                               |

Counts:

- **Clients:** 4 mint on the first message (Hermes, a2a-samples hosts, Agent
  Stack, ADK opt-in). 7 leave the first message without a `contextId` (the SDK
  helpers, ADK default, CrewAI, Strands, SK, MS AF, inspector).
- **Servers:** 0 reject among the SDKs and frameworks, 1 rejects (Platypus), and
  every other server checked accepts.

## 1. The A2A specification

### v0.2.x and v0.3.0: "server-generated"

- JSON schema `Task.contextId`, v0.2.0: "server-generated id for contextual
  alignment across interactions" ([a2a.json#L1619](https://github.com/a2aproject/A2A/blob/v0.2.0/specification/json/a2a.json#L1619)).
  v0.2.6 is the same text, capitalised.
- JSON schema `Task.contextId`, v0.3.0: "A server-generated identifier for
  maintaining context across multiple related tasks or interactions."
  ([a2a.json#L2224](https://github.com/a2aproject/A2A/blob/v0.3.0/specification/json/a2a.json#L2224)).
  `Message.contextId` is optional: "The context identifier for this message,
  used to group related interactions."
- v0.2.0 spec field table: "`contextId` | `string` | Yes | Server generated ID
  for contextual alignment across interactions"
  ([specification.md#L414](https://github.com/a2aproject/A2A/blob/v0.2.0/docs/specification.md#L414)).
- "Life of a task", v0.3.0: "For the first message, the agent responds with a
  server-generated `contextId`. … Subsequent client messages can include the same
  `contextId` to continue the interaction"
  ([life-of-a-task.md#L14](https://github.com/a2aproject/A2A/blob/v0.3.0/docs/topics/life-of-a-task.md#L14)).
- Neither version says anything normative about a client-provided `contextId` the
  server has never seen.

### v1.0.0-rc (2026-01-29): MUST accept

> - Agents **MUST** generate a new `contextId` when processing a `Message` that does not include a `contextId` field
> - Agents **MUST** accept and preserve client-provided `contextId` values if validations pass (i.e., it doesn't conflict with provided `taskId`)

([specification.md#L605-L607 @ v1.0.0-rc](https://github.com/a2aproject/A2A/blob/v1.0.0-rc/docs/specification.md#L605-L607)).
The proto then still said `Task.context_id` was "Created by the A2A server" and
`REQUIRED`.

### v1.0.0 (2026-03-12) and v1.0.1 (2026-05-28): MAY accept, else MUST error

§3.4.1 "Context Identifier Semantics", verbatim from v1.0.1
([specification.md#L584-L602](https://github.com/a2aproject/A2A/blob/v1.0.1/docs/specification.md#L584-L602)):

> **Generation and Assignment:**
>
> - Agents **MAY** generate a new `contextId` when processing a `Message` that does not include a `contextId` field
> - If an agent generates a new `contextId`, it **MUST** be included in the response (either `Task` or `Message`)
> - Agents **MAY** accept and preserve client-provided `contextId` values
> - If an agent cannot accept a client-provided `contextId`, it **MUST** reject the request with an error and **MUST NOT** generate a new `contextId` for the response
> - Clients **SHOULD NOT** provide a client-generated `contextId` to a server unless they understand how the server will process that `contextId`
> - Server-generated `contextId` values **SHOULD** be treated as opaque identifiers by clients
>
> **Grouping and Scope:** …
>
> - Agents **MAY** implement context expiration or cleanup policies and **SHOULD** document any such policies

The rest of the relevant v1.0.1 text:

- **§3.4.3:** "Agents **MUST** infer `contextId` from the task if only `taskId`
  is provided" and "Agents **MUST** reject messages containing mismatching
  `contextId` and `taskId`".
- **Proto, v1.0.1:** `Task.context_id` is no longer `REQUIRED` and has no
  "created by the server" wording
  ([a2a.proto#L166-L173](https://github.com/a2aproject/A2A/blob/v1.0.1/specification/a2a.proto#L166-L173)).
  `Message` says: "For client messages, both fields are optional, with the
  caveat that if both are provided, they have to match"
  ([a2a.proto#L254-L264](https://github.com/a2aproject/A2A/blob/v1.0.1/specification/a2a.proto#L254-L264)).
- **"Life of a task", v1.0.1:** still describes the server-first flow: "When a
  client sends a message for the first time, the agent responds with a new
  `contextId`"
  ([life-of-a-task.md#L22](https://github.com/a2aproject/A2A/blob/v1.0.1/docs/topics/life-of-a-task.md#L22)).
- **§13.1, Data Access and Authorization Scoping:** "Implementations **MUST**
  scope results to the caller's authorized access boundaries … Even when
  `contextId` or other filter parameters are not specified".
- **§3.1.1 SendMessage errors:** the list is `ContentTypeNotSupportedError`,
  `UnsupportedOperationError` and `TaskNotFoundError`. There is no
  context-specific error code. CrewAI's `CONTEXT_NOT_FOUND = -32016`
  (`lib/crewai/src/crewai/a2a/errors.py#L91`) is not in the spec.

### Issues and PRs

- **[#1406](https://github.com/a2aproject/A2A/issues/1406)** "Clarify Task ID
  Client Generation Semantics" quoted the then-current spec: "Agents **MUST**
  accept and preserve client-provided `contextId` values if validations pass".
  It proposed "Context IDs: Client-provided values are accepted and preserved;
  Task IDs: Client-provided values MUST reference an existing task".
- **[#1581](https://github.com/a2aproject/A2A/issues/1581)** "Context ID Client
  Side Generation / Optional Semantics" (closed). TSC comment (darrelmiller,
  2026-03-03): "SDK precedent is that contextId can be provided by the client.
  The spec previously did not allow this, but unless we can find a very strong
  reason for disallowing a client provided contextId, then we should change the
  spec to allow client provided contextId." A community comment on the same issue
  raises "Context forgery" and "Context confusion" (collisions) as the risks.
- **[#1586](https://github.com/a2aproject/A2A/pull/1586)** (closed, not merged)
  proposed "Agents MUST accept and preserve client-provided contextId values if
  validations pass".
- **[#1588](https://github.com/a2aproject/A2A/pull/1588)** (merged 2026-03-05,
  `dec790aa0639`) produced the current wording. PR body: "server can choose to
  reject, client's should know how to fallback accordingly … if server cannot
  accept client side context id it MUST respond with an error … servers may not
  accept a client side context id for a number of reasons: clashes, validation
  errors, not supporting context ids".
- **[#1992](https://github.com/a2aproject/A2A/issues/1992)** (open epic,
  multi-turn gaps) lists "`contextId` and `taskId` semantics, assignment, and
  mismatch handling" as _already addressed_ in §3.4.

## 2. Official SDKs

All six servers coalesce: explicit or message `contextId`, else a fresh UUID.
None checks that the id exists. A `contextId` that conflicts with a stored Task
named by `taskId` is rejected.

- **a2a-python** (`494a8ece0ad9`)
  - `RequestContext.__init__` /
    `_check_or_generate_context_id` generate an id only
    `if not self._context_id and not self._params.message.context_id`
    ([context.py#L74-L80](https://github.com/a2aproject/a2a-python/blob/494a8ece0ad9/src/a2a/server/agent_execution/context.py#L74-L80),
    [#L180-L192](https://github.com/a2aproject/a2a-python/blob/494a8ece0ad9/src/a2a/server/agent_execution/context.py#L180-L192)).
  - `DefaultRequestHandlerV2._setup_active_task` checks the stored Task only when
    a `task_id` is present. It then passes `original_context_id` straight to the
    builder and `get_or_create(..., create_task_if_missing=True)`
    ([default_request_handler_v2.py#L341-L388](https://github.com/a2aproject/a2a-python/blob/494a8ece0ad9/src/a2a/server/request_handlers/default_request_handler_v2.py#L341-L388)).
  - Side note: the SQL `DatabaseTaskStore` model declares
    `context_id: Mapped[str] = mapped_column(String(36))`
    ([models.py#L54](https://github.com/a2aproject/a2a-python/blob/494a8ece0ad9/src/a2a/server/models.py#L54)).
    A client id longer than 36 characters would hit that column limit there.
  - Client: `new_text_message(..., context_id=None)` in `helpers/proto_helpers.py`.
    No auto-generation was found under `src/a2a/client`.
- **a2a-js** (`ca14b824bc07`): `DefaultRequestHandler._createRequestContext`:
  `const contextId = incomingMessage.contextId || task?.contextId || crypto.randomUUID();`
  ([default_request_handler.ts#L258](https://github.com/a2aproject/a2a-js/blob/ca14b824bc07/src/server/request_handler/default_request_handler.ts#L258)).
  A mismatch with a stored task gives `RequestMalformedError` (#L229-L237). The
  client never generates one; `src/client` only forwards it.
- **a2a-java** (`fc2e96e53a8d`): `RequestContext.Builder.build()` uses the
  "coalesce pattern: builder → message → generate"
  ([RequestContext.java#L407-L430](https://github.com/a2aproject/a2a-java/blob/fc2e96e53a8d/server-common/src/main/java/org/a2aproject/sdk/server/agentexecution/RequestContext.java#L407-L430)).
  `Message.Builder` auto-generates only `messageId`.
- **a2a-go** (`3e1aa7fa3801`): `factory.createNewExecutionContext`:
  `contextID := msg.ContextID; if contextID == "" { contextID = a2a.NewContextID() }`
  ([agentexec.go#L299-L311](https://github.com/a2aproject/a2a-go/blob/3e1aa7fa3801/a2asrv/agentexec.go#L299-L311)).
  `a2aclient` never calls `NewContextID`.
- **a2a-dotnet** (`cf4d504e3bcb`): `A2AServer.ResolveContextAsync`:
  `ContextId = contextId ?? Guid.NewGuid().ToString("N"), ClientProvidedContextId = contextId is not null`
  ([A2AServer.cs#L613-L645](https://github.com/a2aproject/a2a-dotnet/blob/cf4d504e3bcb/src/A2A/Server/A2AServer.cs#L613-L645)).
  The flag lets agents "decide whether to reuse an existing conversation or
  start a new one"
  ([RequestContext.cs#L20-L28](https://github.com/a2aproject/a2a-dotnet/blob/cf4d504e3bcb/src/A2A/Server/RequestContext.cs#L20-L28)).
  The client helper `SendMessageAsync(text, role, string? contextId = null)`
  does not generate one (`src/A2A/Client/A2AClientExtensions.cs`).
- **a2a-rs** (`9329673e7467`): `prepare_task_for_execution`. With no stored
  task, it uses `req.message.context_id.clone().unwrap_or_else(new_context_id)`
  ([handler.rs#L717-L737](https://github.com/a2aproject/a2a-rs/blob/9329673e7467/a2a-server/src/handler.rs#L717-L737)).
  The client side was not checked.

## 3. Frameworks, clients and servers

### Google ADK

**Python** (`d8dc29948c68`)

- _Server:_ `convert_a2a_request_to_agent_run_request` sets
  `session_id=request.context_id`
  ([request_converter.py#L132-L135](https://github.com/google/adk-python/blob/d8dc29948c68/src/google/adk/a2a/converters/request_converter.py#L132-L135)).
  `_resolve_session` creates the session with that id if it is missing
  ([a2a_agent_executor_impl.py#L279-L304](https://github.com/google/adk-python/blob/d8dc29948c68/src/google/adk/a2a/executor/a2a_agent_executor_impl.py#L279-L304)).
- _Scoping:_ `_get_user_id` uses the **authenticated** principal's name, falling
  back to `A2A_USER_{context_id}` for unauthenticated calls. Its docstring:
  "taken only from a principal the A2A server authenticated"
  ([#L70-L85](https://github.com/google/adk-python/blob/d8dc29948c68/src/google/adk/a2a/converters/request_converter.py#L70-L85)).
  The same `contextId` from two authenticated users therefore maps to two
  sessions.
- _Client_ (`RemoteA2aAgent`): `context_id` comes from the previous remote
  response stored in session-event metadata. Otherwise it is `None` unless
  `forward_session_id_as_context_id` is set (default `False`: "Whether to forward
  the local session ID as context_id when no context_id is present")
  ([_remote_a2a_agent.py#L1837-L1851](https://github.com/google/adk-python/blob/d8dc29948c68/src/google/adk/a2a/agent/_remote_a2a_agent.py#L1837-L1851),
  [config.py#L141-L142](https://github.com/google/adk-python/blob/d8dc29948c68/src/google/adk/a2a/agent/config.py#L141-L142)).

**JS** (`22f3bf99b5ec`)

- _Server:_ `userId = A2A_USER_${ctx.contextId}` and `sessionId = ctx.contextId`,
  then `getAdkSession` gets or creates the session
  ([agent_executor.ts#L101-L110](https://github.com/google/adk-js/blob/22f3bf99b5ec/core/src/a2a/agent_executor.ts#L101-L110),
  [#L284-L304](https://github.com/google/adk-js/blob/22f3bf99b5ec/core/src/a2a/agent_executor.ts#L284-L304)).
  There is no principal scoping: anyone holding the id reaches the session.

**Java** (`7d1144283811`)

- _Server:_ `prepareSession` calls
  `getSession(appName, "A2A_USER_"+contextId, contextId)`. If that is empty it
  calls `createSession(appName, userId)` **without** a session id
  ([AgentExecutor.java#L291-L321](https://github.com/google/adk-java/blob/7d1144283811/a2a/src/main/java/com/google/adk/a2a/executor/AgentExecutor.java#L291-L321)).
- _Unverified:_ from reading alone, a client-minted `contextId` seems to get a
  fresh session each turn rather than resuming, because the created session's id
  is not the `contextId`. This was not run.

### LangGraph Platform (`langgraph-api` 0.15.4 wheel from PyPI, `langgraph_api/api/a2a.py`)

- `handle_message_send`: `context_id = requested_context_id or str(uuid.uuid4())`.
  It then calls
  `client.runs.create(thread_id=context_id, …, if_not_exists="create")`
  (around lines 2188–2303; the same happens in `handle_message_stream` around
  lines 3434–3588).
- So an unknown id creates a thread. Whether LangGraph requires thread ids to be
  UUIDs, which would make a non-UUID id like Hermes's `ctx-…` fail, was **not
  verified**. The error mapper does have a "Thread '…' not found. Please create
  the thread first" branch.
- The open-source `langgraph` / `langchain` repos were not searched (GitHub
  code-search rate limit).

### CrewAI (`bb235ef17259`)

- _Client:_ `_prepare_delegation_context` takes
  `context_id=task_config.get("context_id")` (default `None`)
  ([wrapper.py#L1056](https://github.com/crewAIInc/crewAI/blob/bb235ef17259/lib/crewai/src/crewai/a2a/wrapper.py#L1056)).
  It adopts `latest_message.context_id` from responses (#L1315-L1316).
- _Server:_ built on a2a-python's `RequestContext` (`a2a/utils/task.py`), so it
  accepts and adopts.
- `ContextNotFoundError` is defined in `errors.py#L404-L414` but nothing in
  `lib/` raises it.

### Pydantic AI / FastA2A (`d94dc2fa644c`)

- `TaskManager.send_message` / `stream_message` use
  `context_id = message.get('context_id', str(uuid.uuid4()))`
  ([task_manager.py#L128-L136](https://github.com/pydantic/fasta2a/blob/d94dc2fa644c/fasta2a/task_manager.py#L128-L136)).
- `InMemoryStorage.load_context` returns `None` for an unknown id, so the run
  starts with empty history (`storage.py#L129-L131`).
- The client does not generate one.

### AWS Strands Agents (`b340edbbfee0`)

- _Server:_ keyed per `context_id`. The docstring warns: "Contexts are keyed on
  the client-supplied `context_id`, which is not an authentication boundary. A
  caller that knows another caller's `context_id` can attach to that
  conversation. Multi-tenant deployments must enforce authenticated identity at
  the transport/gateway layer." Contexts are capped at `max_contexts` with LRU
  eviction
  ([executor.py#L152-L160](https://github.com/strands-agents/sdk-python/blob/b340edbbfee0/strands-py/src/strands/multiagent/a2a/executor.py#L152-L160)).
- _Client:_ `A2AAgent._send_message` builds the message through
  `convert_input_to_message` and never sets `context_id`
  ([a2a_agent.py#L254-L273](https://github.com/strands-agents/sdk-python/blob/b340edbbfee0/strands-py/src/strands/agent/a2a_agent.py#L254-L273)).

### Microsoft Agent Framework (`2d9cc3f8ae46`) and Semantic Kernel (`cc8a15fa356f`)

**Agent Framework**

- _Server:_ `HandleNewMessageAsync` uses
  `var contextId = context.ContextId ?? Guid.NewGuid().ToString("N")` followed
  by `GetOrCreateSessionAsync(contextId)`
  ([A2AAgentHandler.cs#L124-L127](https://github.com/microsoft/agent-framework/blob/2d9cc3f8ae46/dotnet/src/Microsoft.Agents.AI.Hosting.A2A/A2AAgentHandler.cs#L124-L127)).
- _Optional scoping:_ `IsolationKeyScopedTaskStore` prefixes both task keys and
  the stored `ContextId` with an isolation key "(e.g., user, tenant, or composite
  key) … preventing cross-tenant task access". It strips the prefix before
  returning, "so callers only ever observe bare identifiers"
  ([IsolationKeyScopedTaskStore.cs#L11-L26](https://github.com/microsoft/agent-framework/blob/2d9cc3f8ae46/dotnet/src/Microsoft.Agents.AI.Hosting.A2A/IsolationKeyScopedTaskStore.cs#L11-L26)).
- _Client:_ `A2AAgent` sends `typedSession.ContextId`, which is null on a new
  session. It is filled from the response (`session.ContextId ??= contextId`),
  and a mismatch with a later response throws. A caller can explicitly resume
  with `CreateSessionAsync(contextId)`
  ([A2AAgent.cs#L76-L92](https://github.com/microsoft/agent-framework/blob/2d9cc3f8ae46/dotnet/src/Microsoft.Agents.AI.A2A/A2AAgent.cs#L76-L92),
  [#L357-L379](https://github.com/microsoft/agent-framework/blob/2d9cc3f8ae46/dotnet/src/Microsoft.Agents.AI.A2A/A2AAgent.cs#L357-L379)).

**Semantic Kernel**

- _Client:_ `A2AAgent` builds `MessageSendParams` with only
  `MessageId`, `Role` and `Parts`. It never sends a `ContextId`
  ([A2AAgent.cs#L168-L175](https://github.com/microsoft/semantic-kernel/blob/cc8a15fa356f/dotnet/src/Agents/A2A/A2AAgent.cs#L168-L175)).
  `A2AAgentThread` mints a local thread id that is not sent.
- _Server:_ `A2AHostAgent` was not verified.

### BeeAI / Agent Stack (`79c786049d39`; last commit 2026-04-03)

- _Server (A2A proxy):_ `on_message_send` sets
  `params.message.context_id = params.message.context_id or str(uuid.uuid4())`.
  It then calls `_check_and_record_request`
  ([a2a.py#L218-L266](https://github.com/i-am-bee/agentstack/blob/79c786049d39/apps/agentstack-server/src/agentstack_server/service_layer/services/a2a.py#L218-L266)).
- _Ownership claim:_ `track_request_ids_ownership` does
  `INSERT … ON CONFLICT (context_id) DO NOTHING` together with
  `UPDATE … WHERE context_id = :context_id AND created_by = :user_id`. A new id
  is claimed by the caller; an id owned by another user raises
  `ForbiddenUpdateError(entity="a2a_request_context")`
  ([requests.py#L59-L149](https://github.com/i-am-bee/agentstack/blob/79c786049d39/apps/agentstack-server/src/agentstack_server/infrastructure/persistence/repositories/requests.py#L59-L149)).
  This is the closest prior art to a per-principal namespace with
  first-writer-wins.
- _Client:_ the UI first creates a platform Context
  (`useEnsurePlatformContext` → `createContext`, `/api/v1/contexts`) and uses its
  id as the A2A `contextId`. The SDK example CLI mints
  `context_id = context_id or uuid.uuid4().hex`
  ([cli.py#L35](https://github.com/i-am-bee/agentstack/blob/79c786049d39/apps/agentstack-sdk-py/examples/cli.py#L35)).

### Hermes Agent: Nous Research `NousResearch/hermes-agent` (`4f9b741a3a02`), `plugins/platforms/a2a/`

- _Client:_ `_send_task` sets `ctx = context_id or protocol.new_context_id()`
  ([tools.py#L105](https://github.com/NousResearch/hermes-agent/blob/4f9b741a3a02/plugins/platforms/a2a/tools.py#L105)).
  `new_context_id()` returns `"ctx-" + uuid.uuid4().hex[:16]`
  ([protocol.py#L126-L127](https://github.com/NousResearch/hermes-agent/blob/4f9b741a3a02/plugins/platforms/a2a/protocol.py#L126-L127)).
- _Why it mints:_ it writes the outbound message to the local transcript
  `persist_message(ctx, …)` **before** the server replies, so it needs a key up
  front. It then uses `reply_ctx = payload.get("contextId", ctx)`, so it would
  tolerate a different id coming back
  ([tools.py#L95-L128](https://github.com/NousResearch/hermes-agent/blob/4f9b741a3a02/plugins/platforms/a2a/tools.py#L95-L128)).
  A server error ends the call, so it fails against Platypus today.
- _Server:_ `_prepare_task` uses
  `extract_context_id(params) or protocol.new_context_id()`
  ([adapter.py#L532-L537](https://github.com/NousResearch/hermes-agent/blob/4f9b741a3a02/plugins/platforms/a2a/adapter.py#L532-L537)).
  The id is sanitised by `_safe_context_slug`, which keeps
  `[A-Za-z0-9_.-]` and caps it at 96 characters, "Sanitize attacker-provided
  context ids" (#L130-L133).
- _Scoping:_ the forwarded session key is `(profile, slug, safe_ctx)` and does
  not include the peer (#L578-L585).

### a2a-samples (`6603ba3f2c31`) and a2a-inspector (`8aa064639af1`)

- **Samples, client-minting:** the CLI host does
  `context_id = session if session > 0 else uuid4().hex`
  ([hosts/cli/**main**.py#L106](https://github.com/a2aproject/a2a-samples/blob/6603ba3f2c31/samples/python/hosts/cli/__main__.py#L106)).
  The routing hosts (`a2a_multiagent_host`, `weather_and_airbnb_planner`,
  `content_creation`, `airbnb_planner_multiagent`, `azureaifoundry_sdk`) mint
  `str(uuid.uuid4())` when the session has no `context_id`
  ([a2a_multiagent_host/routing_agent.py#L250-L253](https://github.com/a2aproject/a2a-samples/blob/6603ba3f2c31/samples/python/hosts/a2a_multiagent_host/routing_agent.py#L250-L253)).
- **Samples, accepting:** the JS sample agents use
  `userMessage.contextId || existingTask?.contextId || uuidv4()`
  (`samples/js/src/agents/coder/index.ts#L52`).
- **Inspector:** `let contextId: string | null = null`, set from the server's
  `event.contextId`
  ([script.ts#L235](https://github.com/a2aproject/a2a-inspector/blob/8aa064639af1/frontend/src/script.ts#L235),
  [#L1127-L1128](https://github.com/a2aproject/a2a-inspector/blob/8aa064639af1/frontend/src/script.ts#L1127-L1128)).

### Microsoft AutoGen

GitHub code search for "A2A" in `microsoft/autogen` returned only the README and
unrelated files. No A2A implementation was found.

## Not verified

- a2a-rs client and ADK JS client behaviour.
- Semantic Kernel's server-side `contextId` handling.
- ADK Java's session-resume behaviour at runtime.
- LangGraph's thread-id format constraints.
- The open-source LangChain/LangGraph repos (code-search rate limit).
- None of the projects was executed; all behaviour is read from source.

## Recommendation for Platypus

### What to change

Accept an unknown client-supplied `contextId` instead of refusing it. Every SDK
and framework read here accepts one. The client tools that most need it (Hermes,
the official samples, Agent Stack) mint ids, and the spec explicitly allows
acceptance. Platypus's current refusal is compliant but does not interoperate
with these clients.

The suggested shape, which would amend ADR-0032's "`contextId` is a Chat id":

1. **Unknown id, no `taskId`:** create a new Chat bound to the endpoint's Agent
   and the calling token, exactly as for a message with no `contextId`.
2. **Echo the client's string verbatim** as the `contextId` of every Task,
   Message and event. v1.0 says an agent that cannot use the id must error and
   "MUST NOT generate a new `contextId`". A substitute id is non-compliant, even
   though Hermes would tolerate one.
3. **Don't use the client string as `chat.id`.** `chat.id` is a global primary
   key, so a raw client value would collide across tokens and tenants. Instead,
   store it as an alias column, e.g. `chat.a2aContextId`, with a unique index on
   `(a2aTokenId, a2aContextId)`. Derive the Chat id deterministically as
   `uuidv5([tokenId, "context", contextId])`. This mirrors `a2aChatId`, so two
   concurrent first messages on different instances race for one Chat and the
   existing claim/`startingTurns` logic still holds.
4. **Resolve a `contextId` in this order, both scoped to the caller's token:**
   1. `chat.id = contextId` (a server-minted context), then
   2. `a2aContextId = contextId`.

   Apply the same mapping wherever `contextId` is read. This includes the
   `ListTasks` filter, which today compares `a2aTask.chatId` to
   `params.contextId`.

5. **Validate first, and reject with an error rather than substituting.**
   Suggested rule: 1–128 characters, printable ASCII, `[A-Za-z0-9._:-]`.
   - On failure, throw `RequestMalformedError` (InvalidParams), as Platypus does
     for other bad params.
   - This also covers the a2a-python `String(36)` situation: a cap stops oversized
     ids reaching storage.
   - Hermes's `ctx-<16 hex>` and UUIDs both pass.

### Security considerations

- **Hijack or collision across callers.** The namespace is the A2A token, which
  is already Platypus's principal (#1293 amendment). Two tokens using the same
  string get two different Chats, and nobody can attach to another token's or
  the Owner's Chat.
  - The prior art agrees: Agent Stack claims ids per user and returns Forbidden
    for others; MS Agent Framework namespaces by isolation key; ADK Python keys
    sessions by the authenticated user.
  - The counter-examples are ADK JS, Strands, Hermes, and the bare SDKs, which
    key on the id alone. Strands documents this as a known hole.
- **Guessing.** With token scoping, knowing or guessing an id gives nothing.
  Ids stay non-secret, consistent with the ADR's "a Chat id is no secret".
  Don't add an enumeration oracle: keep returning the same outcome for "exists
  under another token" and "never existed".
- **Changed failure mode.** A client resending a stale server-minted id would
  silently get a new empty Chat instead of -32001. Examples are a Chat that was
  deleted, or one from another token.
  - Option A: accept this, and document a cleanup policy as §3.4.1 asks.
  - Option B: keep -32001 for values in Platypus's own UUIDv5 namespace that
    resolve to nothing for this token, and treat everything else as a
    client-minted alias. Option B keeps strictness for ids Platypus issued.
    Choose deliberately.
- **Resource use.** Client-minted ids let a caller open unlimited Chats. That is
  already true without a `contextId`, and the existing run-slot and follower caps
  still apply.
- **Memory.** New Chats are endpoint/token Chats, not Owner Chats, so the
  Owner-memory leak that #1293 closed stays closed.
- **Docs.** `apps/docs/content/building-with-platypus/a2a-endpoints.mdx`
  describes `SendMessage` without a `contextId`. It should gain the
  client-supplied case and the validation rule in the same PR as the code.
