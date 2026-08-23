---
name: platypus-tools
description: Platypus tools and tool sets — writing a tool, contributing a tool set from a plugin, scoping tools to a workspace, sharing a tool across sets, chat icons, and custom tool UI. Always load this skill when the user mentions tools or tool sets.
---

# Platypus Tools

Two things make a tool reachable by an Agent: the **tool** itself, and the
**contribution** that grants it. A tool nobody contributes is dead code.

## 1. Write the tool

An AI SDK `tool()` with three parts — `description` (how the model decides to
call it), `inputSchema` (a Zod object, every field `.describe()`d), and
`execute` (sync or async, returning a structured object).

```typescript
export const convertTemperature = tool({
  description:
    "Convert temperature between Fahrenheit, Celsius, and Kelvin. Specify the value and the units to convert from and to.",
  inputSchema: z.object({
    value: z.number().describe("The temperature value to convert"),
    from: z.enum(["fahrenheit", "celsius", "kelvin"]).describe("Convert from"),
    to: z.enum(["fahrenheit", "celsius", "kelvin"]).describe("Convert to"),
  }),
  execute: ({ value, from, to }) => ({ result, unit: to }),
});
```

Note the shape: enums over a tool per unit pair. Widen a tool's parameters
before you multiply tools — every extra name is another choice the model can
get wrong.

Return `{ error: "..." }` from a caught failure rather than throwing; the model
reads the result and can recover.

Tool implementations live in the backend's `tools` directory, one file per
subject area, tests co-located beside them.

## 2. Contribute the tool set

**Tool sets are plugin contributions.** Do not reach for `registerToolSet` —
it is core-internal, and its one remaining caller is the Sandbox set, which is
a Sandbox-backend extension point rather than a native tool set.

Add yours to the `contributes.toolSets` array of a `PlatypusPlugin`. Core
plugins live under the backend's `plugins` directory, split by cohesion: pure
utilities in one, the domain tool sets in another.

```typescript
export const plugin: PlatypusPlugin = {
  name: "@platypus/tools-basic",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  contributes: {
    toolSets: [
      {
        id: "time",
        name: "Time",
        category: "Utilities",
        description: "Tools for getting current time and converting timezones",
        tools: { getCurrentTime, convertTimezone },
      },
    ],
  },
};
```

- **id** — kebab-case, and a *stable identifier*: Agents persist granted ids,
  so renaming a shipped id silently strips the set from every Agent holding it.
  Core ids stay unprefixed.
- **category** — groups the set in the Agent form. Take an existing category
  unless the set genuinely sits outside all of them.

Done when the set appears in the Agent form under its category and its tools
run in a chat.

### Adding a new plugin

A capability earns its own plugin when an Operator would plausibly want to
**deny it in isolation** — that is why egress and infra are separate plugins
while utilities share one. Cohesion, not subject matter, is the test.

A new plugin needs an entry in the built-in loader map, which *is* the core
allowlist — membership there is what makes a plugin core. Then decide its
gating: the always-on list for essentials no Operator would deny, otherwise it
waits behind the plugins env var. A name in both is rejected fail-loud, since
listing an always-on plugin as an enable switch is a misconfiguration.

## 3. Give it a chat icon

Unmapped tools fall back to a wrench. The icon resolver checks three maps in
order, so pick the rung that fits:

1. **Per-tool overrides** — checked first. For a set whose tools are visually
   distinct, or tools belonging to no set at all. Keep it sparse.
2. **Tool name → set id** — every tool needs an entry here unless it has an
   override. A tool in several sets maps to whichever fits best; the icon is
   correct regardless of which set supplied it at runtime.
3. **Set id → Lucide icon** — one per set, matching the workspace home page.

Done when every tool name your contribution exports resolves to something
other than the wrench.

## Scoping tools to a workspace

Set `tools` to a factory instead of an object and it resolves per chat turn
against a `ToolSetContext` — workspace, agent, org, user, and frontend URL:

```typescript
tools: ({ workspaceId, agentId, orgId, frontendUrl }) =>
  createKanbanTools(workspaceId, agentId, orgId, frontendUrl),
```

Keep the factory in the tool's own file, returning `Record<string, Tool>`.

The context also carries `registerCloser` for anything needing teardown at end
of turn. **Call it guarded — `ctx.registerCloser?.(close)`.** It is optional
on purpose and must stay so: a manifest declares only a major api version, so
a plugin cannot ask for a core new enough to have it, and an unguarded call on
older core throws out of your factory and costs the turn *every* tool in the
set.

## Sharing one tool across sets

Extract it into a standalone exported factory returning a single `Tool`. The
owning set calls that factory internally; other sets import and call it too.

Use the **same key name** in every set. Tools **claim** names into one map as
each set resolves, so identical keys collapse to one entry — a deliberate
dedup, not a collision. Differing keys give the Agent the same tool twice
under two names.

When two *different* tools claim one name the later claim wins and the shadowed
one is logged with both owners, so check the logs before assuming a tool is
missing. Turn precedence runs session tools, then search, then sub-agent tools
— each layer beating the one before it.

## Custom chat UI

Tools render their input and output as JSON by default. For a bespoke card —
interactive elements, images, structured results, or progress during execution
— read [`CUSTOM-UI.md`](CUSTOM-UI.md), which carries the renderer contract and
the double-render trap.

## When a tool doesn't appear

Tool resolution is **strict at boot, forgiving at runtime**: a duplicate set id
throws on startup, but at turn time an unresolvable id, a factory that throws,
or an unreachable MCP server each costs only its own tools, logging a warning.
A chat turn is not where you discover a plugin is broken — so a silently
toolless Agent is a log question, not a UI question.

Work down the chain: is the set in a plugin's `contributes.toolSets`; is a new
plugin in the loader map and either always-on or named in the env var; does the
Agent actually hold the set's id; does the backend log a resolution warning for
this turn.

## Resources

- ADR-0013 (plugin contributions), ADR-0014 (web-search backends)
- [AI SDK tool calling](https://sdk.vercel.ai/docs/ai-sdk-core/tools-and-tool-calling), [Zod](https://zod.dev)
