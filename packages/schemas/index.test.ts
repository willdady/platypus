import { describe, it, expect } from "vitest";
import {
  organizationSchema,
  workspaceSchema,
  workspaceCreateSchema,
  agentSchema,
  organizationCreateSchema,
  invitationCreateSchema,
  mcpSchema,
  skillSchema,
  attachmentSchema,
  attachmentCreateSchema,
  sandboxEnvSchema,
  SANDBOX_ENV_MAX_ENTRIES,
  SANDBOX_ENV_MAX_VALUE_BYTES,
  providerSchema,
  providerUpdateSchema,
  providerCreateSchema,
  chatSchema,
} from "./index";

describe("Organization Schema", () => {
  it("should validate a valid organization", () => {
    const validOrg = {
      id: "123",
      name: "Test Org",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = organizationSchema.safeParse(validOrg);
    expect(result.success).toBe(true);
  });

  it("should reject organization with short name", () => {
    const invalidOrg = {
      id: "123",
      name: "AB",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = organizationSchema.safeParse(invalidOrg);
    expect(result.success).toBe(false);
  });

  it("should reject organization with long name", () => {
    const invalidOrg = {
      id: "123",
      name: "A".repeat(31),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = organizationSchema.safeParse(invalidOrg);
    expect(result.success).toBe(false);
  });
});

describe("Organization Create Schema", () => {
  it("should validate create input with only required fields", () => {
    const result = organizationCreateSchema.safeParse({ name: "New Org" });
    expect(result.success).toBe(true);
  });

  it("should reject empty name", () => {
    const result = organizationCreateSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });
});

describe("Attachment Schema", () => {
  it("validates a full attachment", () => {
    const result = attachmentSchema.safeParse({
      id: "att-1",
      workspaceId: "ws-1",
      resourceType: "mcp",
      resourceId: "mcp-1",
      createdAt: new Date(),
    });
    expect(result.success).toBe(true);
  });

  it("validates an agent attachment", () => {
    const result = attachmentSchema.safeParse({
      id: "att-1",
      workspaceId: "ws-1",
      resourceType: "agent",
      resourceId: "agent-1",
      createdAt: new Date(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown resource type", () => {
    const result = attachmentSchema.safeParse({
      id: "att-1",
      workspaceId: "ws-1",
      resourceType: "blueprint",
      resourceId: "bp-1",
      createdAt: new Date(),
    });
    expect(result.success).toBe(false);
  });

  it("create schema accepts resourceType + resourceId", () => {
    const result = attachmentCreateSchema.safeParse({
      resourceType: "provider",
      resourceId: "prov-1",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a skill resource type", () => {
    const result = attachmentCreateSchema.safeParse({
      resourceType: "skill",
      resourceId: "skill-1",
    });
    expect(result.success).toBe(true);
  });

  it("create schema rejects a missing resourceId", () => {
    const result = attachmentCreateSchema.safeParse({ resourceType: "mcp" });
    expect(result.success).toBe(false);
  });
});

describe("MCP Schema", () => {
  const base = {
    id: "mcp-1",
    name: "Test MCP",
    url: "https://mcp.example.com",
    authType: "None" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("accepts a workspace-scoped MCP", () => {
    const result = mcpSchema.safeParse({ ...base, workspaceId: "ws-1" });
    expect(result.success).toBe(true);
  });

  it("accepts an org-scoped MCP", () => {
    const result = mcpSchema.safeParse({ ...base, organizationId: "org-1" });
    expect(result.success).toBe(true);
  });

  it("rejects an MCP scoped to both an organization and a workspace", () => {
    const result = mcpSchema.safeParse({
      ...base,
      organizationId: "org-1",
      workspaceId: "ws-1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an MCP scoped to neither", () => {
    const result = mcpSchema.safeParse(base);
    expect(result.success).toBe(false);
  });
});

describe("Skill Schema", () => {
  const base = {
    id: "skill-1",
    name: "my-skill",
    description: "A description that is at least twenty-four chars long.",
    body: "A skill body that is comfortably longer than the forty-eight character minimum requirement.",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("accepts a workspace-scoped Skill", () => {
    const result = skillSchema.safeParse({ ...base, workspaceId: "ws-1" });
    expect(result.success).toBe(true);
  });

  it("accepts an org-scoped Skill", () => {
    const result = skillSchema.safeParse({ ...base, organizationId: "org-1" });
    expect(result.success).toBe(true);
  });

  it("rejects a Skill scoped to both an organization and a workspace", () => {
    const result = skillSchema.safeParse({
      ...base,
      organizationId: "org-1",
      workspaceId: "ws-1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a Skill scoped to neither", () => {
    const result = skillSchema.safeParse(base);
    expect(result.success).toBe(false);
  });

  it("rejects a non-kebab-case name", () => {
    const result = skillSchema.safeParse({
      ...base,
      workspaceId: "ws-1",
      name: "Not Kebab",
    });
    expect(result.success).toBe(false);
  });
});

describe("Workspace Schema", () => {
  it("should validate a valid workspace", () => {
    const validWorkspace = {
      id: "456",
      organizationId: "123",
      ownerId: "user-1",
      name: "Test Workspace",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = workspaceSchema.safeParse(validWorkspace);
    expect(result.success).toBe(true);
  });
});

describe("Workspace Create Schema", () => {
  // ADR-0008: ownerId is admin-assignable but optional (defaults to caller).
  it("accepts an optional ownerId", () => {
    const result = workspaceCreateSchema.safeParse({
      name: "Test Workspace",
      organizationId: "org-1",
      ownerId: "member-2",
    });
    expect(result.success).toBe(true);
  });

  it("is valid without an ownerId", () => {
    const result = workspaceCreateSchema.safeParse({
      name: "Test Workspace",
      organizationId: "org-1",
    });
    expect(result.success).toBe(true);
  });
});

describe("Invitation Create Schema", () => {
  // ADR-0008: invitation carries an optional Workspace name.
  it("accepts an optional workspaceName", () => {
    const result = invitationCreateSchema.safeParse({
      email: "user@example.com",
      workspaceName: "Contractor Sandbox",
    });
    expect(result.success).toBe(true);
  });

  it("is valid with just an email", () => {
    const result = invitationCreateSchema.safeParse({
      email: "user@example.com",
    });
    expect(result.success).toBe(true);
  });
});

describe("Agent Schema", () => {
  it("should validate a valid agent", () => {
    const validAgent = {
      id: "789",
      workspaceId: "456",
      providerId: "provider-123",
      name: "Test Agent",
      description: "A test agent",
      modelId: "gpt-4",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = agentSchema.safeParse(validAgent);
    expect(result.success).toBe(true);
  });

  it("should allow optional fields", () => {
    const agentWithOptionals = {
      id: "789",
      workspaceId: "456",
      providerId: "provider-123",
      name: "Test Agent",
      description: "A test agent",
      systemPrompt: "You are a helpful assistant",
      modelId: "gpt-4",
      temperature: 0.7,
      maxSteps: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = agentSchema.safeParse(agentWithOptionals);
    expect(result.success).toBe(true);
  });
});

describe("Provider modelMeta (context-compaction §A)", () => {
  const base = {
    id: "prov-1",
    workspaceId: "ws-1",
    name: "My Provider",
    providerType: "OpenAI" as const,
    apiKey: "sk-x",
    modelIds: ["gpt-4o"],
    taskModelId: "gpt-4o",
    memoryExtractionModelId: "gpt-4o",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("is valid with modelMeta omitted (additive, optional)", () => {
    expect(providerSchema.safeParse(base).success).toBe(true);
  });

  it("accepts per-model contextWindow / maxOutputTokens overrides", () => {
    const result = providerSchema.safeParse({
      ...base,
      modelMeta: {
        "gpt-4o": { contextWindow: 128000, maxOutputTokens: 16384 },
        "o1-mini": { contextWindow: 200000 },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-positive contextWindow", () => {
    const result = providerSchema.safeParse({
      ...base,
      modelMeta: { "gpt-4o": { contextWindow: 0 } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer window", () => {
    const result = providerSchema.safeParse({
      ...base,
      modelMeta: { "gpt-4o": { contextWindow: 1.5 } },
    });
    expect(result.success).toBe(false);
  });

  it("carries modelMeta through the update schema", () => {
    const result = providerUpdateSchema.safeParse({
      name: "My Provider",
      providerType: "OpenAI",
      apiKey: "sk-x",
      modelIds: ["gpt-4o"],
      taskModelId: "gpt-4o",
      memoryExtractionModelId: "gpt-4o",
      modelMeta: { "gpt-4o": { contextWindow: 128000 } },
    });
    expect(result.success).toBe(true);
  });
});

describe("Chat compaction state (context-compaction §C)", () => {
  const base = {
    id: "chat-1",
    workspaceId: "ws-1",
    title: "My Chat Title",
    status: "succeeded" as const,
    isPinned: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("is valid with compaction fields omitted (existing rows)", () => {
    expect(chatSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a populated summary + watermark + version", () => {
    const result = chatSchema.safeParse({
      ...base,
      contextSummary: "Summary of earlier turns.",
      summaryWatermark: "msg-42",
      compactionDirty: true,
      version: 3,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an explicitly null summary / watermark", () => {
    const result = chatSchema.safeParse({
      ...base,
      contextSummary: null,
      summaryWatermark: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-integer version", () => {
    const result = chatSchema.safeParse({ ...base, version: 1.5 });
    expect(result.success).toBe(false);
  });
});

describe("Agent compaction config (context-compaction §G)", () => {
  const base = {
    id: "789",
    workspaceId: "456",
    providerId: "provider-123",
    name: "Test Agent",
    description: "A test agent",
    modelId: "gpt-4",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("is valid with no compaction config (defaults applied in code)", () => {
    expect(agentSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a full compaction config", () => {
    const result = agentSchema.safeParse({
      ...base,
      compactionEnabled: true,
      triggerRatio: 0.8,
      targetRatio: 0.5,
      reserveRatio: 0.05,
      keepRecentMessages: 10,
      minPrunableChars: 2000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a ratio above 1", () => {
    const result = agentSchema.safeParse({ ...base, triggerRatio: 1.2 });
    expect(result.success).toBe(false);
  });

  it("rejects a negative keepRecentMessages", () => {
    const result = agentSchema.safeParse({ ...base, keepRecentMessages: -1 });
    expect(result.success).toBe(false);
  });
});

describe("Provider Create Schema", () => {
  const baseProvider = {
    organizationId: "org-123",
    name: "Test Provider",
    providerType: "OpenAI" as const,
    apiKey: "sk-test",
    modelIds: ["gpt-4"],
    taskModelId: "gpt-4",
    memoryExtractionModelId: "gpt-4",
  };

  it("defaults nativeSearchEnabled to true when omitted", () => {
    const result = providerCreateSchema.safeParse(baseProvider);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.nativeSearchEnabled).toBe(true);
    }
  });

  it("preserves nativeSearchEnabled when explicitly set to false", () => {
    const result = providerCreateSchema.safeParse({
      ...baseProvider,
      nativeSearchEnabled: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.nativeSearchEnabled).toBe(false);
    }
  });
});

describe("sandboxEnvSchema", () => {
  it("accepts an empty map", () => {
    expect(sandboxEnvSchema.safeParse({}).success).toBe(true);
  });

  it("accepts valid POSIX keys and string values", () => {
    const ok = sandboxEnvSchema.safeParse({
      OPENAI_API_KEY: "sk-x",
      _LEADING_UNDERSCORE: "ok",
      NODE_ENV: "production",
    });
    expect(ok.success).toBe(true);
  });

  it("rejects keys starting with a digit", () => {
    expect(sandboxEnvSchema.safeParse({ "1FOO": "x" }).success).toBe(false);
  });

  it("rejects keys with hyphens or dots", () => {
    expect(sandboxEnvSchema.safeParse({ "FOO-BAR": "x" }).success).toBe(false);
    expect(sandboxEnvSchema.safeParse({ "foo.bar": "x" }).success).toBe(false);
  });

  it("rejects empty keys", () => {
    expect(sandboxEnvSchema.safeParse({ "": "x" }).success).toBe(false);
  });

  it("rejects values larger than the per-value byte cap", () => {
    const oversize = "a".repeat(SANDBOX_ENV_MAX_VALUE_BYTES + 1);
    expect(sandboxEnvSchema.safeParse({ FOO: oversize }).success).toBe(false);
  });

  it("accepts values at the per-value byte cap", () => {
    const atCap = "a".repeat(SANDBOX_ENV_MAX_VALUE_BYTES);
    expect(sandboxEnvSchema.safeParse({ FOO: atCap }).success).toBe(true);
  });

  it("rejects more than the max entry count", () => {
    const tooMany: Record<string, string> = {};
    for (let i = 0; i <= SANDBOX_ENV_MAX_ENTRIES; i++) tooMany[`K${i}`] = "v";
    expect(sandboxEnvSchema.safeParse(tooMany).success).toBe(false);
  });
});
