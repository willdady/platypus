import type { AttachmentResourceType } from "@platypus/schemas";

/**
 * What an Attachment's resource type is called in prose. One home, so the
 * attach picker and the Manage attachments dialog can't drift.
 */
export const ATTACHMENT_RESOURCE_LABELS: Record<
  AttachmentResourceType,
  string
> = {
  mcp: "MCP server",
  provider: "provider",
  skill: "skill",
  agent: "agent",
};
