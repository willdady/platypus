import { createIdGenerator } from "ai";
import { SKILL_NAME_SOURCE } from "@platypus/schemas";
import { db } from "../index.ts";
import { LOAD_SKILL_TOOL_NAME } from "../tools/turn-tool-names.ts";
import type { PlatypusUIMessage } from "../types.ts";
import { resolveScoped } from "./scoped-resource.ts";
import { resolveAssignedSkillByName } from "./skill-resolution.ts";

/**
 * A user-invoked Skill, named from the chat input.
 *
 * The wire format is the text itself: `/blog-post about otters` arrives as an
 * ordinary text part, token included, and the token is what the transcript
 * shows. Nothing structured rides alongside it — a `data-command` part was
 * specified and dropped, because the text answers everything it would have
 * (issue #649): it survives the edit composer, it renders without a part
 * renderer of its own, and a command with no trailing prose is still a
 * non-empty text part rather than a `content: []` the providers reject.
 *
 * Deriving the name from the text at submit time is also what makes a desync
 * impossible: Tab-complete `/deploy`, type `-staging`, and a name captured when
 * the picker was used would disagree with what was sent.
 *
 * Anchored at position 0, so "one command per message" falls out of the grammar
 * rather than needing a rule. Greedy, so `/deploy-staging` never resolves as
 * `/deploy`.
 *
 * Built from the Skill-name shape `@platypus/schemas` already enforces on save,
 * so a name this accepts is a name a Skill can actually have. A second copy of
 * the character class here is how the parser and the validator drift.
 */
export const SLASH_COMMAND_PATTERN = new RegExp(`^/(${SKILL_NAME_SOURCE})`);

/**
 * The command the latest user message opens with, or `null` if it opens with
 * anything else.
 *
 * Read off the FIRST text part: a message may lead with attachments, and the
 * prose part is the one the user typed. A trailing assistant message means the
 * turn is a continuation rather than a fresh submission, so there is no new
 * command to read.
 */
export const slashCommandOf = (
  messages: PlatypusUIMessage[],
): string | null => {
  const latest = messages.at(-1);
  if (latest?.role !== "user") return null;
  const firstText = latest.parts.find((part) => part.type === "text");
  if (!firstText) return null;
  return SLASH_COMMAND_PATTERN.exec(firstText.text)?.[1] ?? null;
};

/**
 * The data-access surface the seeding depends on. Production wires this to
 * Drizzle (`drizzleSlashCommandQueries`); tests pass an in-memory
 * implementation. Named after the lookups, not the query shapes — the same
 * seam `ChatTurnQueries` uses.
 */
export type SlashCommandQueries = {
  /**
   * The Skill ids assigned to this Agent, or `null` where the Agent does not
   * resolve in this Workspace (ADR-0007).
   */
  getAgentSkillIds(
    agentId: string,
    orgId: string,
    workspaceId: string,
  ): Promise<string[] | null>;
  /**
   * The assigned Skill of this name, or `null` for a name that resolves to
   * nothing this Agent holds. `disableModelInvocation` is not consulted: it
   * gates the model's catalogue, and this caller is the user (#713).
   */
  resolveAssignedSkill(
    name: string,
    ctx: { orgId: string; workspaceId: string },
    permittedSkillIds: string[],
  ): Promise<{ name: string; body: string } | null>;
};

const drizzleSlashCommandQueries: SlashCommandQueries = {
  async getAgentSkillIds(agentId, orgId, workspaceId) {
    const found = await resolveScoped(db, "agent", agentId, {
      orgId,
      workspaceId,
    });
    return found?.row.skillIds ?? null;
  },

  async resolveAssignedSkill(name, ctx, permittedSkillIds) {
    const resolution = await resolveAssignedSkillByName(
      db,
      name,
      ctx,
      permittedSkillIds,
    );
    return resolution.kind === "resolved"
      ? { name: resolution.row.name, body: resolution.row.body }
      : null;
  },
};

const generateMessageId = createIdGenerator({ prefix: "msg", size: 16 });
const generateToolCallId = createIdGenerator({ prefix: "call", size: 24 });

/**
 * The seeded pair: a `loadSkill` call and its result, as a trailing assistant
 * message.
 *
 * The body must never read as something the user said. ADR-0020 already
 * rejected appending a block to the user's message — the model may attribute it
 * to them, and it is forgeable where a tool result is not — and a per-turn
 * system-prompt fragment would invalidate the stable prefix for the whole Chat.
 * A tool result is what the provenance actually is.
 *
 * *Trailing* assistant specifically: the SDK treats a trailing assistant
 * message as a continuation and reuses its id, so the model's reply lands in
 * this same message. One transcript bubble with a `loadSkill` card above the
 * answer — what a model-initiated call looks like. A standalone assistant
 * message would render as two.
 */
const loadSkillSeedMessage = (skill: {
  name: string;
  body: string;
}): PlatypusUIMessage => ({
  id: generateMessageId(),
  role: "assistant",
  parts: [
    {
      type: `tool-${LOAD_SKILL_TOOL_NAME}`,
      toolCallId: generateToolCallId(),
      state: "output-available",
      input: { name: skill.name },
      output: { name: skill.name, body: skill.body },
    },
  ],
});

/**
 * Resolves the slash command the latest user message opens with and appends the
 * seeded `loadSkill` pair, or returns the messages untouched.
 *
 * Untouched covers every way a command can fail to resolve — no Agent selected,
 * an Agent with no Skills, a typo, a Skill since deleted, a Skill assigned to
 * some other Agent. The message then sends as the ordinary text it already is,
 * which is the whole reason the token stays in the text.
 *
 * The caller appends this to the messages that reach `RunInput`, so the pair is
 * PERSISTED rather than re-seeded per turn. The argument is fidelity: seeding
 * only for the latest user message means a command in an earlier turn would
 * lose its Skill on every turn after, and the replayed conversation would stop
 * being the conversation that happened.
 */
export const seedUserInvokedSkill = async (
  args: {
    messages: PlatypusUIMessage[];
    orgId: string;
    workspaceId: string;
    /** Absent on a Direct (no-Agent) turn, which advertises no Skills. */
    agentId?: string;
  },
  queries: SlashCommandQueries = drizzleSlashCommandQueries,
): Promise<PlatypusUIMessage[]> => {
  const { messages, orgId, workspaceId, agentId } = args;
  if (!agentId) return messages;

  const name = slashCommandOf(messages);
  if (!name) return messages;

  const skillIds = await queries.getAgentSkillIds(agentId, orgId, workspaceId);
  if (!skillIds || skillIds.length === 0) return messages;

  const skill = await queries.resolveAssignedSkill(
    name,
    { orgId, workspaceId },
    skillIds,
  );
  if (!skill) return messages;

  return [...messages, loadSkillSeedMessage(skill)];
};
