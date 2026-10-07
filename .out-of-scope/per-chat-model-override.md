# Per-Chat Model Override on a Selected Agent

Platypus does **not** let a Chat choose which model runs when that Chat has an
Agent selected. Selecting an Agent resolves the Provider, the model, the
Instructions, the generation parameters and the step ceiling from the Agent row
and from nowhere else. There is no "use this Agent, but on a stronger model"
control, and the Chat's own generation columns stay inert for as long as an
Agent is selected.

This rejects the **override**, not the observation underneath it. Wanting the
same capabilities on a cheaper or stronger model is a reasonable thing to want;
the answer in Platypus is a second Agent, and that is the intended shape.

## Why it is out of scope

### The rule it breaks is load-bearing, not descriptive

`GLOSSARY.md` defines an Agent as "a configurable preset that pins a Provider,
model, Instructions, generation parameters, Tools, Skills, and Sub-Agents.
Selecting an Agent on a Chat turn replaces direct Provider/model selection."

The word doing the work is **replaces**. An Agent is not a set of defaults that
a Chat may amend; it is the whole of what a turn resolves against. That is a
deliberate decision rather than an accident of the current implementation, and
it is what makes an Agent legible: a person reading an Agent row knows what a
turn using it will do, without also having to read the Chat.

The proposal for an override argues that model choice is a "quality tier"
rather than a capability, so moving it does not disturb "an Agent grants
capability, and a bare model is bare". That is true as far as it goes, and it
is not the objection. The objection is that an Agent stops fully determining a
turn — and once that is conceded for one field, the boundary between the fields
a Chat may amend and the fields it may not becomes a judgement call defended
case by case, rather than one rule anybody can state.

### The enforcement is already wholesale, across seven fields

This is not a rule that exists only in prose. The Chat row already carries
`instructions`, `temperature`, `topP`, `topK`, `seed`, `presencePenalty` and
`frequencyPenalty`, and every one of them is ignored the moment an Agent is
selected — a single line decides it:

```ts
// apps/backend/src/runs/agent-plan.ts
const samplingSource: SamplingSource =
  "agent" in source ? source.agent : source;
```

The same fork resolves `providerId`, `modelId` and `maxSteps`, and the per-chat
step ceiling added in #539 is deliberately scoped to Direct turns for the same
reason. The Chat schema then makes the two paths mutually exclusive by
validation — a Chat carries `agentId`, **or** it carries `providerId` and
`modelId`, never both.

So an override for the model alone would not be an extension of an existing
pattern. It would be the first exception to a rule currently enforced without
exception, and it would leave the six sampling columns beside it inert for no
reason a User could infer. The larger version — let the Chat's columns override
the Agent's generally — is a much bigger change to what an Agent means, and
sweeps in `instructions`, which is far closer to capability than model choice
is.

### The problem it was offered to solve is not established

The case for the override is that welding the model to the Agent is what makes
Agent rosters grow: to run the same capabilities on a different tier you must
clone the Agent, so a Workspace accumulates variations of itself. The mechanism
is real — there is genuinely no other way to do it — but the claim that this is
what produces a crowded roster in practice rests on a single reporter's
Workspace. A crowded roster is answered first by the Workspace boundary, as
recorded in
[`capability-discovery-for-ad-hoc-chats.md`](./capability-discovery-for-ad-hoc-chats.md).

If the clone-per-tier pattern turns up repeatedly, across Workspaces that are
not one person's, this is worth reopening — the mechanism is not in dispute,
only how much of the observed growth it explains.

## Prior requests

- #581 — "Direction wanted: separate \"which model runs\" from \"what it can
  reach\", and make a large catalogue affordable" (step 6 of six; steps 4 and 5
  are recorded in
  [`capability-discovery-for-ad-hoc-chats.md`](./capability-discovery-for-ad-hoc-chats.md))
