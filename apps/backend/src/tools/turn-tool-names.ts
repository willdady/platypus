/**
 * The tool names core assigns to a Chat turn *after* the Tool session has
 * claimed its own (`services/chat-execution.ts`): the Web-search pair, the
 * Sub-Agent delegate dispatcher, and the Skill loader.
 *
 * Each of those stages lands by plain assignment, and the precedence is
 * deliberate — search wins over a Tool set that happens to share a name, and a
 * delegate wins over search. What was not deliberate is the silence: a Tool set
 * contributing one of these four names lost it on every turn with nothing said
 * (issue #664). A third-party Tool set can no longer produce one of them,
 * because its tool names are namespaced under its manifest name; a *core* Tool
 * set still could, so `composeToolSet` refuses one that statically declares one
 * of these.
 *
 * Declared here rather than in the four modules that build the tools, because
 * that boot check needs the whole set and this module has no imports —
 * `DELEGATE_TOOL_NAME` lived in `sub-agent.ts`, and reaching it from
 * `tools/index.ts` would have dragged the run lifecycle in behind it.
 */

/** The Web-search backend's search tool (ADR-0014). */
export const WEB_SEARCH_TOOL_NAME = "web_search";

/** The Web-search backend's page-reading tool (ADR-0014). */
export const READ_URL_TOOL_NAME = "read_url";

/**
 * The single dispatcher a turn offers when its Agent has Sub-Agents. It replaced
 * the per-Sub-Agent `delegateTo<Name>` tools, so the name a Plugin can collide
 * with is this bare one.
 */
export const DELEGATE_TOOL_NAME = "delegate";

/** The tool a turn offers when its Agent has Skills. */
export const LOAD_SKILL_TOOL_NAME = "loadSkill";

/**
 * Every name above, in the order the turn assigns them. Core Tool sets keep
 * bare tool names, so this is the list a core Tool set may not statically
 * declare into.
 */
export const RESERVED_TURN_TOOL_NAMES: readonly string[] = [
  WEB_SEARCH_TOOL_NAME,
  READ_URL_TOOL_NAME,
  DELEGATE_TOOL_NAME,
  LOAD_SKILL_TOOL_NAME,
];
