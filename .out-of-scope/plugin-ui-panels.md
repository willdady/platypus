# Plugin UI Panels / Human-Facing Plugin Surfaces

Platypus plugins do **not** contribute anything a human sees in the UI — no
iframe-embedded panels, no external dashboards, no native React injection, no
per-plugin viewer surfaces at any scope (org or workspace). Human-facing UI is a
**deliberate, permanent non-goal of the plugin system**.

This rejects the _plugin extension-point mechanism_, not the underlying need to
surface an embedded external view. That need has an in-model home — see
**Preferred alternative** below.

## Why a plugin extension point is out of scope

The plugin system (ADR-0013) exists to let Operators extend Platypus's **own
capabilities** without maintaining a fork. Its extension points are, by design,
**backend, model-facing, and core-owned**:

- **Sandbox backends** — execution environments
- **Tool sets** — capabilities an agent invokes
- a **messaging gateway** — planned as a third

The extension-point set is intentionally **fixed** — "The set is fixed — Plugins
cannot define new ones" (CONTEXT.md). A plugin fills a core-owned slot; it does
not open a new _category_ of slot, and human-facing rendering is a category core
deliberately never opened. ADR-0013 draws the boundary the other way too:
plugins run **in-process with no isolation**, on the premise that everything a
plugin contributes is vetted backend code. A generic iframe viewer framing
external origins, plus a per-user signed-identity token path, is a different
trust and product shape than "run vetted backend code," and it is not what the
plugin trust model was designed around. ADR-0013 already records UI injection and
an in-app surface as out of scope; the proposal asks to reverse exactly that
posture, and the answer is that it stays a non-goal.

The extension surface is `PluginContributions` (`packages/plugin-sdk/index.ts`),
today exactly two keys — `toolSets?` and `sandboxBackends?`. Both ship _code that
core drives_, never _a view core frames_.

## Preferred alternative: an iframe widget on the existing dashboards feature

Platypus already has a first-class, workspace-scoped **dashboards** feature —
`widgetTypeSchema` (`packages/schemas/index.ts`) with a `widgetDataSchema`
discriminated union, backend routes in `apps/backend/src/routes/dashboard.ts`,
and a component/icon registry in `apps/frontend/components/widgets/`. It ships
metric, text, image, weather, and line/pie/bar chart widgets. What it lacks is an
**iframe widget type**.

The motivating use cases in the request (a vLLM/LiteLLM token-usage view, a
cost/quota board, a view over a code-driven pipeline) are dashboard content, not
a new plugin capability. Adding an `iframe` widget — another entry in the widget
enum + discriminated union, a component, and route support — covers the embed
need **within the existing, in-model surface**: workspace-scoped, role-gated by
the dashboard's existing access, no new plugin extension point, and no new plugin
trust boundary. That is a small, additive enhancement to a feature that already
exists, and it is the sanctioned path for embedding an external view.

## If the plugin-extension-point framing is ever reconsidered

The blocker is directional, not technical — the proposed plugin design maps
cleanly onto the existing `contributes`/factory pattern and would be a small,
append-only API change. Reconsidering means first deciding that human-facing,
core-framed _plugin_ surfaces belong in Platypus at all, then amending ADR-0013
to open a UI extension point (and settling the iframe sandboxing /
signed-identity security model). Until that directional decision changes, this
stays out of scope. Note that the dashboards iframe-widget alternative does **not**
require reopening this — it is a separate, in-scope piece of work. Delete this
file only if the _plugin extension-point_ decision itself is revisited.

## Prior requests

- #327 — "Feature: UI-panel extension point for plugins (embed org- and workspace-scoped external dashboards)"
