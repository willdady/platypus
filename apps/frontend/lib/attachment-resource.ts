import type { AttachmentResourceType } from "@platypus/schemas";

export const ATTACHMENT_RESOURCE_LABELS: Record<
  AttachmentResourceType,
  string
> = {
  mcp: "MCP server",
  provider: "provider",
  skill: "skill",
  agent: "agent",
};
