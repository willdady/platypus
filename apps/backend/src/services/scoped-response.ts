import type {
  AgentResponse,
  ResourceScope,
  SkillResponse,
} from "@platypus/schemas";
import type { agent as agentTable, skill as skillTable } from "../db/schema.ts";
import { avatarKeyToUrl } from "../utils/avatar-url.ts";

export const agentResponse = (
  row: typeof agentTable.$inferSelect,
  scope: ResourceScope,
  baseUrl: string,
): AgentResponse => {
  const { avatarKey, ...rest } = row;
  return {
    ...rest,
    avatarUrl: avatarKeyToUrl(avatarKey, baseUrl) ?? undefined,
    scope,
  } as AgentResponse;
};

export const skillResponse = (
  row: typeof skillTable.$inferSelect,
  scope: ResourceScope,
): SkillResponse => ({ ...row, scope }) as SkillResponse;
