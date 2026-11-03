---
status: accepted
---

# A Tool gate decides whether a tool call runs, and fails closed

> **In the code.** The point is `toolGates` on the Plugin manifest, registered
> through the shared contribution pipeline like the other three
> (`toolGatePoint` in `plugins/extension-points.ts`). `tool-gates/index.ts`
> holds the registry and `toolGateOptions`, which `buildModelInvocation` spreads
> into every Drive's `streamText` call as `toolApproval` — and leaves out
> entirely when no gate is enabled. Each Tool session builds the gate's view of
> its calls (`ToolSession.gateScope`: Tool set ids, the MCP hint in all three
> states, and `attended`, true only for an interactive top-level session); a
> Sub-Agent's run carries its own nested session's. A denial reaches the model
> as the SDK's `execution-denied` tool result with the gate's reason, the Chat
> part as `output-denied` with the reason on its approval, and the Run timeline
> as a cancelled tool-call event carrying the reason; the no-progress detector
> counts a repeated denial like a repeated result. The reference gate is the
> built-in `@platypus/decision-gate`, which calls `experimental_decide` (the
> SDK's current name for `experimental_evaluate`).

Platypus adds a fourth Extension point (ADR-0013), the **Tool gate**. A gate sees a tool call before it executes and returns a **Verdict**: `allow`, `ask` or `deny`, with an optional reason. A gate only gates. It never changes a call's arguments or its result. The motivating case is fast decision models (Jev and equivalents) asked "is this tool call destructive?", but a gate can equally be a plain rule list, and core cannot tell the two apart: it sees only the Verdict.

This makes the authority decision that ADR-0021 refused to take from a read-only hint, and from a weaker signal. A hint is unverified; a decision model is probabilistic. A false "read" under ADR-0021 costs a cleared Tool result, which is recoverable. A false `allow` here is an unguarded write, which is not. So the rule is that **anything a gate cannot vouch for is not allowed**:

- **A gate that throws or exceeds its timeout returns `ask`.** It never returns `allow`. Each gate declares its own timeout, capped by a core maximum.
- **Several gates combine to the most restrictive Verdict.** `deny` beats `ask`, and `ask` beats `allow`. Gates run in parallel.
- **`ask` reaches a human only in a top-level Chat turn.** In a Trigger run, an A2A call or any Sub-Agent run, `ask` is `deny`. A Sub-Agent runs inside its parent's tool call, so it has no way to stop and ask, even when the parent is an attended Chat. A gate is told whether the run is attended, but core enforces the conversion, so a gate cannot forget it.
- **`ask` is `deny` everywhere until the approval round-trip ships.** Asking in a Chat needs the turn to stop, the User's answer to arrive as a new request the server verifies against its own message tree (ADR-0026), and the existing assistant message to continue. That is a separate piece of work. The Verdict carries `ask` from the start so no gate changes when it lands.
- **`deny` is final.** A User cannot click past it. `ask` is the gate's way of saying "a human may decide", and `deny` is its way of saying "no one may".

A denied call returns a tool error to the model, carrying a structured refusal with the gate's reason, and the run continues. The model can adapt or explain itself; a run that ends on the first deny cannot. The denial is shown on the Chat's tool card and recorded on the Run timeline (ADR-0023). Allows are not recorded.

A gate applies **deployment-wide**. An enabled gate Plugin runs on every locally-executed tool call in every Organization, including MCP tools. Tools the Provider executes itself (such as native web search) never reach the backend and cannot be gated. That gap is accepted and documented, not worked around. Coverage is one seam, the shared model invocation all three Drives build (`driveChat`, `driveDelegate`, `driveOnce`), using the AI SDK's `toolApproval` hook. It is not a wrapper on each tool map. The existing wrappers differ by Drive, and a gate a Drive can miss is no gate.

A gate sees the tool name, its description, the arguments, the Tool set id, the Agent, Workspace and Organization ids, whether the run is attended, and the tool's read-only hint in ADR-0021's three states. It sees no credentials and no message history.

Core ships one gate as a built-in Plugin that is off by default: a **decision-model gate**. It asks a decision model one yes/no question about the call through the AI SDK's `experimental_evaluate`, and maps the probability to a Verdict using two thresholds from its config. The Plugin's config names the model and holds its credentials, the same way web-fetch's do (as #1091 recorded).

## Considered Options

- **A Block every User can override.** Rejected. A Verdict of `allow | block` where every block prompts the User makes every block an `ask`. A rule an Operator enforces ("never drop a table") becomes one click for a Workspace Owner. The gate chooses between `ask` and `deny` instead.
- **Extending the Tool set contribution** with a vetting hook. Rejected. That couples gating to whoever contributed the tool, so a third party's tools are vetted by that same third party. A separate point lets an Operator gate tools from every source, MCP included.
- **Attaching gates per Agent**, as Tool sets are. Rejected as the first scope. The Workspace Owner a safety gate protects against is the same person who could detach it from their own Agent. Gates attached per Organization by an Org Admin are a likely next step. A gate attached per Agent could only tighten the result, never loosen it.
- **Decision models as a Provider model type**, with a slot on the Workspace that gates read through core. Deferred, not rejected. The Operator sets the reference gate's thresholds, and confidence from one model means nothing for another, so a Workspace Owner choosing the model would quietly recalibrate a gate they do not own. A Workspace with no model set leaves only bad options: every call becomes `ask`, or setting nothing bypasses the gate. Bedrock, OpenRouter and OpenAI-compatible Providers cannot serve an evaluation model at all, and the API is still `experimental_`. Keeping it inside one Plugin keeps it out of core's schema and database. Reconsider when a second caller needs a decision model.
- **Core thresholds on a confidence score.** Rejected. Core understands only Verdicts, so a gate built on a rule list and one built on a model are the same to it, and scores never become a core contract.
- **Failing open on timeout**, so a slow judge does not stall work. Rejected. A gate that times out under load would then let through exactly the calls it exists to stop.

## Consequences

- **A gate that never answers blocks everything.** That is the intended direction. An Operator who enables a gate accepts that its outage is a tool outage.
- **Latency on every tool call.** Every enabled gate adds a call to each local tool call. Verdicts are not cached, even for identical calls within a run. An unattended run that retries the same denied call gets the same refusal back each time, so the no-progress detector halts it the way it halts any repeated call with the same result. There is no special handling for gates.
- **Unattended runs feel the gate hardest.** With `ask` read as `deny`, a Trigger or A2A run cannot get a cautious verdict past a human. That is the case a gate exists for.
- **Before tool call is the only stage.** Rewriting or redacting a result, observing whole runs, and changing what the model is sent are separate stages, each with a different contract. A gate is not middleware and is not the place for them.

## Notes: the approval round-trip (2026-10-25)

Added when `ask` began reaching a User (issue #1256). It replaces the "`ask` is
`deny` everywhere until the approval round-trip ships" bullet above, which no
longer holds; the rest of the Decision is unchanged.

- **In an attended run `ask` stops the turn.** Core returns the SDK's
  `user-approval` with the gate's reason. The SDK runs the step's allowed calls,
  denies its denied ones and ends the loop after that step; the run succeeds and
  the reply is stored holding its `approval-requested` parts. There is no Chat
  status for a reply that waits. Unattended runs (Trigger, A2A, Sub-Agent, and a
  plan with no gate scope) keep `ask` as `deny`. A gate that fails is still
  `ask`, so in a Chat the User may approve a call its gate could not vet.
- **The answer is a turn the server verifies against its own rows** (ADR-0026).
  `respond-to-approvals` names the Chat's Active leaf and answers exactly the
  approvals it waits on; the server writes each answer onto its stored part and
  continues the reply under its own id, with a fresh Step ceiling and turn
  deadline. The client sends only whether each call may run, never an approval
  object, so `experimental_toolApprovalSecret` is not used.
- **An approved call is not re-vetted.** The SDK hands every approved call to
  the hook again before running it; core finds the User's approval for that
  call id in the Transcript and returns `approved` without asking any gate. A
  gate cannot revise its Verdict on resume.
- **Moving on denies.** A new message under a reply still waiting denies each
  unanswered call with a reason saying the User sent a new message instead, so
  the model sees a refusal rather than the call vanishing from later turns. A
  regenerate leaves the waiting reply as an Alternative, and the same denial
  applies if that Alternative is ever continued.

## Notes: the after-call result stage (2026-11-03)

Added with issue #1255. It replaces the "Before tool call is the only stage"
consequence above, which no longer holds; the rest of the Decision is unchanged.

- **A gate may also declare `evaluateResult`.** It is asked about every locally
  executed tool's result before the model sees it: in a Chat turn, a Trigger run,
  an A2A call, a Sub-Agent run, and for the delegation tool's own result in the
  parent. It sees the same `ToolGateCall` the before-call stage sees, plus the
  result as the model would receive it after result normalisation. No
  credentials, no message history.
- **A result is gated, never rewritten.** The answer is a Result Verdict:
  `allow` or `deny`, with an optional reason. There is no `ask`, because a result
  the tool already produced has nothing a person could approve. Core never
  redacts, rewrites or annotates a value.
- **The result stage fails closed.** A gate that throws, outruns the same
  `timeoutMs` as its before-call stage, or returns anything that is not a Result
  Verdict counts as `deny`. Several result-evaluating gates run in parallel; any
  `deny` wins, and the first denying gate in registration order supplies the
  reason.
- **A denied result is withheld entirely.** It is never persisted, streamed to
  the Chat, or recorded on the Run timeline. What is persisted is an ordinary
  tool error carrying the reason, in the same shape as a tool that threw. The
  model is told the tool **ran** and its result was withheld by the named gate;
  a write tool's side effects have already happened, and the wording must not
  imply otherwise. The Chat tool card shows its existing error state, and the
  Run timeline closes the tool event as it does for any tool error. No new part
  state or UI.
- **The seam is the shared model invocation, as a wrapper on `execute`.** Every
  Drive builds its model call through `buildModelInvocation`, so the result
  stage is applied there and no Drive can miss it. A deployment with no
  result-evaluating gate sends exactly the tools it always did. Provider-executed
  tools remain ungated: they have no `execute` to wrap, which is the same gap the
  before-call stage already accepts.
- **A tool's error is vetted as its result.** A tool that throws reaches the
  model as a tool error carrying its message, and that message can carry content
  the tool fetched: a failed Sub-Agent's partial output, an MCP server's error
  text. Result gates are asked about the message as the result; a denial
  replaces the error with the gate's reason. A streaming tool that throws
  releases its last activity yield first, because no yield is its result then.
- **Tool-result clearing is unaffected.** A withheld result is an ordinary tool
  error part, so clearing treats it like any other failed call.
- **The reference gate's result stage is opt-in.** `@platypus/decision-gate`
  asks its decision model whether the result contains instructions directed at
  the assistant rather than data, and denies above a new optional
  `resultDenyThreshold`. Without that field it performs no result evaluation and
  its before-call stage is unchanged. A contribution's shape is fixed, not read
  from config, so the plugin declares `evaluateResult` either way: with it
  enabled but no threshold, core still wraps each tool and a streaming tool's
  last yield waits one tick for an `allow`. Accepted rather than making
  contributions depend on config. A long result is asked about in overlapping
  parts, and the most suspicious part decides, so no instruction goes unscreened
  by sitting past the first part.
