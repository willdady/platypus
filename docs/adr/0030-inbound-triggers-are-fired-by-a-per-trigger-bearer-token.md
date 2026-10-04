---
status: accepted
---

# Inbound Triggers are fired by a per-Trigger bearer token on a separately exposable path

An external system (an issue tracker, a CI pipeline, an automation tool) can start an Agent run by calling an **Inbound Trigger**: a third Trigger type beside Cron and Event, fired by `POST /hooks/triggers/:triggerId` with `Authorization: Bearer <token>`. This is the backend's first ingress that is not a browser session, and it is deliberately narrow. The credential is one token per Trigger that grants exactly "run this Agent with this Instruction", never access to the API. The run acts as the Workspace Owner like every Trigger run, so the token is only as safe as the Agent's tools are narrow. The path lives outside `/organizations/...` so an Operator can expose `/hooks/*` alone through a proxy or tunnel, which is how a deployment on a private network takes calls at all. The call is asynchronous: a `202` hands back a run id, and the outcome lands in run history like any other Trigger run. Originates from [#1114](https://github.com/willdady/platypus/issues/1114).

## Considered Options

- **An external event source for Event Triggers.** External callers would publish named events into the Workspace's Webhook-event stream. Rejected: the stream is one enumerated set with two consumers, and opening it would hand untrusted payloads to every outbound Webhook subscriber and to the debounce, which would fold calls about different records into one run.
- **Riding the messaging Gateway (ADR-0015).** The Gateway drives interactive Chat turns as linked Users. An Inbound Trigger is headless and unattended, the shape of a Trigger run, not a Chat.
- **General-purpose API keys.** A key that reaches the whole API is a much larger grant than "fire this one Trigger", and nobody needs it for this. Not designed out, but not this decision.
- **HMAC signatures instead of, or as well as, a bearer token.** HMAC also proves the body was not altered and resists replay, but the caller must compute a signature, which most "send a web request" tools cannot. Bearer over TLS is enough for callers that can set a header. Deferred, together with raw bodies (below).
- **A token in the query string.** Works with every sender, and leaks into proxy and access logs. Rejected outright.
- **Accepting a raw JSON body when no inputs are declared.** Serves senders with a fixed payload shape. Deferred: those senders mostly cannot set a bearer header either and sign with HMAC instead, so raw bodies are only useful once HMAC exists, and they arrive together. The injection risk is not the reason; it is the same as for declared inputs.
- **Templating inputs into the Instruction (`{{issueKey}}`).** Adds escaping rules and a second route by which caller text reaches the prompt. The Instruction refers to inputs by name instead.
- **A per-Workspace flag, as ADR-0006's delegation flags are.** Rejected for the gate's shape: an Organization that trusts all its Workspaces would have to flip every one, and new Workspaces would start blocked. An exclusion list under "all" was rejected too, since "all but these" is not "all".
- **An Org Admin lock on a single Trigger.** Would stop an Owner from regenerating a token an Admin revoked. Rejected: revoke already stops the damage at once, the breaker and dedup cap a runaway loop, and an Owner who ignores an Admin is a conversation, not a platform feature.
- **A persisted log of inbound calls with its own UI.** Rejected in favour of one structured log line per call, which the Operator's log tooling already collects and retains for as long as their compliance needs, without a new table holding caller data.
- **Separate breaker settings for Inbound Triggers.** Rejected as a knob with no job: a record can have only one run active at a time (dedup), so for long runs the rate per record is already bounded by run length, and the existing breaker settings bound short loops.

## Consequences

- **The token is shown once and stored as a hash**, unlike the Webhook signing secret, which stays readable because HMAC needs it. Regenerating invalidates the old token immediately. Every token expires: the Owner picks 30, 90, 180 or 365 days, default 90. The Owner is notified 30 and 7 days before expiry (a reminder that would fall before the token was created is skipped) and the first time an expired token is used. Each of those is recorded on the Trigger, not inferred from the Notification, which the Owner may delete. Regenerating clears them.
- **Only the Owner creates Inbound Triggers, and only in the UI.** The Agent's Trigger tools cannot create one, change a Trigger's type to inbound, or regenerate a token, and never return one: a live credential must not enter a model's context or a Chat transcript.
- **The body is declared string inputs.** `{ "inputs": { … } }`. The Trigger declares each input's name, whether it is required, and a description. A call with a missing required input, an undeclared input, or a value that is not a string is rejected with `400`; nothing is truncated or coerced. The Agent sees the inputs, with their descriptions, in a labelled block above the Instruction. No file attachments.
- **An Organization gate, off by default.** An Org Admin sets it to off, all Workspaces, or selected Workspaces. It is checked on every call, not only when a Trigger is created. Turning it off, or deselecting a Workspace, makes that Workspace's Inbound Triggers unreachable without deleting them or their tokens.
- **Rejections do not reveal what exists.** An unknown Trigger, a wrong or expired token, a disabled Trigger, a gate that excludes the Workspace, and a non-inbound Trigger all return the same `404`. Only a caller holding a valid token learns anything more specific.
- **Every inbound run is under the breaker.** The Owner may mark one required input as identifying the record (e.g. an issue key); the existing run-rate breaker then counts per value of it. With none marked, it counts the whole Trigger. The existing `TRIGGER_BREAKER_*` settings apply unchanged. Marking a record key is the expected setup.
- **One active run per record.** For a Trigger with a record key, a call for a record that already has a pending or running run returns that run as `202 { runId, deduplicated: true }`; the call's inputs are dropped and it does not count toward the breaker. `deduplicated` is always present, so a later queue can change what happens without changing the response.
- **The run row exists before the `202`.** It is written as `pending` at acceptance so the returned id is real. `GET /hooks/triggers/:triggerId/runs/:runId`, with the same token, returns status, timestamps and error, never output. It is short-term polling: once Max Runs to Keep prunes the run it is `404`, and no time-based retention floor is added.
- **Load and size are bounded by Operator settings.** A server-wide cap on concurrently active inbound runs answers excess calls with `429` and `Retry-After`, writing no run row. A body cap, default 64 KB, answers with `413` and is the only size limit. There is no debounce, and per-IP rate limiting is the proxy's job.
- **The call log is a documented format.** Every inbound call, whatever its outcome (accepted, deduplicated, suppressed, rejected with its reason, rate-limited), writes one structured line at `info` with stable fields: Organization, Workspace and Trigger ids where known, outcome, reason, run id, `deduplicated`, and the record key value. Never other input values. This is the first log output Platypus promises not to break, and the docs list it. It correlates with run history by run id; call outcomes and run statuses stay separate vocabularies because they describe different things. An Operator running above `info` will not see these lines.
- **Org Admins can see and revoke, not edit.** An Organization-wide list shows each Inbound Trigger's Workspace, Owner, created, expiry status, last used and last rejected, never the token. Revoking a token is the one action an Admin takes inside another person's Workspace, and the Owner is notified. Last used and last rejected are written at most once a minute per Trigger, so a flood of bad calls cannot become a flood of writes.

## Amendment — three points settled while building it (#1114)

The implementing PR settled three points the decision above left open or stated
too broadly. Each narrows a claim; none reverses one.

**The concurrency cap counts runs, so it is asked last.** The issue's build
contract ordered the checks cap, then dedup, then the breaker, which answers
`429` to calls that would start no run. Instead the cap is asked only by a call
that would start one: dedup first, then the breaker, then the cap, all under the
record's lock.

- A call for a record that already has an active run gets
  `202 { runId, deduplicated: true }` however busy the server is. A `429` would
  make the caller wait and retry for an answer it already had, and the retry
  would get the same dedup answer anyway.
- A call the breaker stops gets its `suppressed` row and its `202`. A `429`
  there would hide the trip from run history, the one place an Owner sees it,
  and make the breaker's verdict depend on unrelated load.
- A `429` still writes no run row. It is now exactly the call that would have
  started an Agent.

The cap exists to bound load, meaning Agents running at once. Neither of those
calls adds any, so turning them away bought nothing and cost the caller its
answer.

**"Server-wide" means per backend instance.** The count of active inbound runs
is held by the process that accepted the calls, because an inbound run executes
in that process, so its own count is what bounds its own load. With several
instances, a deployment admits up to the number of instances times the setting.
A cluster-wide count would need a shared counter whose slots leak when a process
dies mid-run, and so a recovery sweep of their own, all for a bound the Operator
already gets by dividing the setting by the number of instances. The body cap
applies per request, so this changes nothing for it. The backend configuration
reference says so.

**The Agent's Trigger tools cannot delete an Inbound Trigger either.** The rule
above names create, changing a Trigger's type to inbound, and regenerating a
token. Editing one, including disabling it, was already refused. Deletion was
left open. The tools now refuse it too, so the Agent-side rule is whole: create,
edit, delete, type changes and regenerating are the Owner's, in the UI. The
reason is the one that makes the token worth protecting. An inbound run's
context carries caller-supplied text, so a prompt injection that talks the Agent
into deleting its own Trigger stops the integration, and the caller, answered
with the uniform `404`, cannot tell why. Deleting is also harder to undo than
the edit already refused: the Owner has to recreate the Trigger and give the
caller a new id and token.

## Amendment — the gate lives on the Inbound Triggers screen and saves with the switches (#1114)

Testing the integration end to end moved the Organization gate. The decision
above still holds: the gate is the Organization's, it is checked on every call,
and **Selected workspaces** defers to each Workspace's switch. What changed is
where an Org Admin sets it and how it is saved.

**The gate is set on the Organization's Inbound Triggers screen, not on
General.** That screen already listed every Inbound Trigger and was where an
Admin revoked a token, but it had to send them to General to decide which
Workspaces take calls at all. Who may be called, what can be called, and
stopping a token now sit on one screen. General goes back to the Organization's
name and identity text.

**Under Selected workspaces, the screen lists every Workspace with its switch,
and one save writes the gate and all the switches together.** The endpoint is
`PUT /organizations/:orgId/inbound-triggers/access`, Org Admin only, with
`{ gate, allowedWorkspaceIds? }`. With the list, every Workspace in the
Organization is set on for the ids listed and off for the rest, in the same
transaction as the gate. Without it, the switches are left as they are. An id
outside the Organization refuses the whole save before anything is written.

- Saved apart, switching from **All workspaces** to **Selected workspaces**
  refused calls for every Workspace whose switch was still off. Every switch
  starts off, and nothing switched one on while the gate was **All**, so in
  practice that was every Workspace. The docs had to warn the Admin to visit
  each Workspace's settings first. Saving both at once removes the gap, so the
  warning is gone.
- The screen also names any Workspace that holds Inbound Triggers but would be
  switched off, before the save, so a cut-off is a choice and not a surprise.
- The Organization update no longer accepts the gate. That update is a full
  write that requires the name, so a gate control saving through it on another
  screen would have to resend a name it read earlier and could undo a rename.
  The gate now has one writer.

**The Workspace's own switch stays in its settings.** It is the same flag, so
two screens can write it. Both are Org Admin only, and the last write wins,
which is the same rule as any other setting edited from two tabs. The Workspace
screen is where an Admin already manages that Workspace's other delegation
flags, so removing it there would only add a detour.

## Amendment — a `413` does not stamp last rejected (#1114)

Review found that a call with no token could move a Trigger's last rejected
time. The decision above still holds: last rejected is how an Owner or Org
Admin sees that something is calling with a bad or stale token, and it is
written at most once a minute. What changed is which rejections write it.

**A body past the cap is answered `413` and logged, but does not stamp last
rejected.** The body cap is checked before the token, so a `413` says nothing
about the token: it is the same answer with a valid token, a wrong one, or
none. Stamping it let anyone who knew a Trigger's id move that Trigger's last
rejected time without presenting a token at all, so the time an Owner reads as
"something called with a bad token" no longer meant that. A missing, wrong or
expired token still stamps, because that call was refused for its token, which
is what the time reports.

- Stamping only when the bearer token matches was the alternative. It would
  hash the token on a path built to answer before reading it, for a case
  where a legitimate caller already learns why from the `413` itself.
- The `413` still writes its call-log line with reason `body_too_large`, so
  an Operator sees the call. Every other rejection stamps as before.

## Amended by ADR-0032

ADR-0015's Gateway was never built and is superseded by
[ADR-0032](0032-agents-are-reachable-over-a2a-not-a-platypus-messaging-gateway.md).
The considered option "Riding the messaging Gateway" therefore refers to
something that will not exist. Interactive Chats with an external caller now go
through the A2A server instead. The reasoning still holds: an Inbound Trigger is
headless and unattended, and the caller fills in declared inputs, not a prompt.
A2A does not replace Inbound Triggers.
