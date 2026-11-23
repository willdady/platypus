import { createIdGenerator } from "ai";
import { SKILL_NAME_SOURCE, type SkillLoadResult } from "@platypus/schemas";
import { db } from "../index.ts";
import { LOAD_SKILL_TOOL_NAME } from "../tools/turn-tool-names.ts";
import { SANDBOX_TOOLSET_ID } from "../tools/index.ts";
import type { PlatypusUIMessage } from "../types.ts";
import { resolveScoped } from "./scoped-resource.ts";
import { resolveAssignedSkillByName } from "./skill-resolution.ts";
import { skillLoadResult } from "./skill-sandbox.ts";

export const SLASH_COMMAND_PATTERN = new RegExp(`^/(${SKILL_NAME_SOURCE})`);

export const slashCommandOf = (
  messages: PlatypusUIMessage[],
): string | null => {
  const latest = messages.at(-1);
  if (latest?.role !== "user") return null;
  const firstText = latest.parts.find((part) => part.type === "text");
  if (!firstText) return null;
  return SLASH_COMMAND_PATTERN.exec(firstText.text)?.[1] ?? null;
};

export type SlashCommandQueries = {
  getAgentAssignments(
    agentId: string,
    orgId: string,
    workspaceId: string,
  ): Promise<{ skillIds: string[]; toolSetIds: string[] } | null>;
  resolveAssignedSkill(
    name: string,
    ctx: { orgId: string; workspaceId: string },
    permittedSkillIds: string[],
    hasSandboxToolSet: boolean,
  ): Promise<SkillLoadResult | null>;
};

const drizzleSlashCommandQueries: SlashCommandQueries = {
  async getAgentAssignments(agentId, orgId, workspaceId) {
    const found = await resolveScoped(db, "agent", agentId, {
      orgId,
      workspaceId,
    });
    if (!found) return null;
    return {
      skillIds: found.row.skillIds,
      toolSetIds: found.row.toolSetIds,
    };
  },

  async resolveAssignedSkill(name, ctx, permittedSkillIds, hasSandboxToolSet) {
    const resolution = await resolveAssignedSkillByName(
      db,
      name,
      ctx,
      permittedSkillIds,
    );
    return resolution.kind === "resolved"
      ? skillLoadResult(db, resolution.row, {
          workspaceId: ctx.workspaceId,
          hasSandboxToolSet,
        })
      : null;
  },
};

const generateMessageId = createIdGenerator({ prefix: "msg", size: 16 });
const generateToolCallId = createIdGenerator({ prefix: "call", size: 24 });

const loadSkillSeedMessage = (skill: SkillLoadResult): PlatypusUIMessage => ({
  id: generateMessageId(),
  role: "assistant",
  parts: [
    {
      type: `tool-${LOAD_SKILL_TOOL_NAME}`,
      toolCallId: generateToolCallId(),
      state: "output-available",
      input: { name: skill.name },
      output: skill,
    },
  ],
});

export const seedUserInvokedSkill = async (
  args: {
    messages: PlatypusUIMessage[];
    orgId: string;
    workspaceId: string;
    agentId?: string;
  },
  queries: SlashCommandQueries = drizzleSlashCommandQueries,
): Promise<PlatypusUIMessage[]> => {
  const { messages, orgId, workspaceId, agentId } = args;
  if (!agentId) return messages;

  const name = slashCommandOf(messages);
  if (!name) return messages;

  const agent = await queries.getAgentAssignments(agentId, orgId, workspaceId);
  if (!agent || agent.skillIds.length === 0) return messages;

  const skill = await queries.resolveAssignedSkill(
    name,
    { orgId, workspaceId },
    agent.skillIds,
    agent.toolSetIds.includes(SANDBOX_TOOLSET_ID),
  );
  if (!skill) return messages;

  return [...messages, loadSkillSeedMessage(skill)];
};
