import { describe, it, expect } from "vitest";
import {
  organizationSchema,
  workspaceSchema,
  workspaceCreateSchema,
  agentSchema,
  organizationCreateSchema,
  invitationCreateSchema,
  mcpSchema,
  sandboxEnvSchema,
  SANDBOX_ENV_MAX_ENTRIES,
  SANDBOX_ENV_MAX_VALUE_BYTES,
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
