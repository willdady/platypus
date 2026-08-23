import { describe, it, expect } from "vitest";
import {
  organizationSchema,
  organizationUpdateSchema,
  workspaceSchema,
  workspaceCreateSchema,
  agentSchema,
  organizationCreateSchema,
  invitationCreateSchema,
  mcpSchema,
  skillSchema,
  attachmentSchema,
  nextTurnOccupancy,
  attachmentCreateSchema,
  chatSubmitSchema,
  isValidChatMaxSteps,
  sandboxEnvSchema,
  SANDBOX_ENV_MAX_ENTRIES,
  SANDBOX_ENV_MAX_VALUE_BYTES,
  providerCreateSchema,
  providerUpdateSchema,
  providerHasNativeSearch,
  SEARCH_SOURCE_NONE,
  SEARCH_SOURCE_NATIVE,
  isPresentableUrl,
  type Provider,
  classifyFile,
  extractableDocumentFormat,
  resolveExtractedTextCap,
  DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
  CONTEXT_WINDOW_MIN,
  CONTEXT_WINDOW_MAX,
  MODEL_ALIAS_PREFIX,
  isAliasReference,
  aliasNameFromReference,
  modelReferenceFor,
  modelLabelFor,
  findModelEntry,
  triggerRunStatsSchema,
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
      instructions: "You are a helpful assistant",
      modelId: "gpt-4",
      temperature: 0.7,
      maxSteps: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = agentSchema.safeParse(agentWithOptionals);
    expect(result.success).toBe(true);
  });

  // A maxSteps below 1 reaches `stepCountIs(n)`, which compares `n` against a
  // step count that is never less than 1 — so it silently removes the ceiling
  // instead of tightening it. Reject it here rather than at the run.
  it.each([0, -1, 2.5])("should reject a maxSteps of %s", (maxSteps) => {
    const result = agentSchema.safeParse({
      id: "789",
      workspaceId: "456",
      providerId: "provider-123",
      name: "Test Agent",
      description: "A test agent",
      modelId: "gpt-4",
      maxSteps,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.success).toBe(false);
  });
});

describe("Chat Submit Schema", () => {
  const baseSubmit = {
    id: "chat-1",
    workspaceId: "ws-1",
    messages: [],
    providerId: "p1",
    modelId: "gpt-4",
  };

  it("should accept a maxSteps override on the turn", () => {
    const result = chatSubmitSchema.safeParse({ ...baseSubmit, maxSteps: 25 });
    expect(result.success).toBe(true);
  });

  // Issue #263 class of bug, guarded at the schema: a client that clears a
  // field by sending an explicit `null` — rather than dropping the key, which
  // silently keeps the column's previous value — is accepted here, and null
  // means "unset".
  it("should accept a null maxSteps as cleared", () => {
    const result = chatSubmitSchema.safeParse({
      ...baseSubmit,
      maxSteps: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxSteps).toBeNull();
    }
  });

  // A Direct turn has no no-progress detector, so this ceiling is its only
  // backstop — bounded deliberately (unlike the Agent's unbounded field), and
  // integer because it reaches `stepCountIs(n)`, where a fraction or a value
  // below 1 can never equal a real step count.
  it.each([0, -1, 2.5, 51])(
    "should reject a chat maxSteps of %s",
    (maxSteps) => {
      const result = chatSubmitSchema.safeParse({ ...baseSubmit, maxSteps });
      expect(result.success).toBe(false);
    },
  );
});

describe("isValidChatMaxSteps", () => {
  // The predicate the Chat settings input and the send guard both decide from,
  // so an inline error and a 400 can never disagree about the bound.
  it.each([1, 10, 50])("accepts %s", (value) => {
    expect(isValidChatMaxSteps(value)).toBe(true);
  });

  it.each([0, -1, 2.5, 51])("rejects %s", (value) => {
    expect(isValidChatMaxSteps(value)).toBe(false);
  });

  // Unset is not an error — it means fall back to the Direct default.
  it.each([null, undefined])("treats %s as valid", (value) => {
    expect(isValidChatMaxSteps(value)).toBe(true);
  });

  it("agrees with the request schema it is derived from", () => {
    const base = {
      id: "chat-1",
      workspaceId: "ws-1",
      messages: [],
      providerId: "p1",
      modelId: "gpt-4",
    };
    for (const value of [0, 1, 50, 51]) {
      expect(isValidChatMaxSteps(value)).toBe(
        chatSubmitSchema.safeParse({ ...base, maxSteps: value }).success,
      );
    }
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

  it("defaults searchSource to native when omitted", () => {
    const result = providerCreateSchema.safeParse(baseProvider);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.searchSource).toBe(SEARCH_SOURCE_NATIVE);
    }
  });

  it("preserves searchSource when explicitly set to none", () => {
    const result = providerCreateSchema.safeParse({
      ...baseProvider,
      searchSource: SEARCH_SOURCE_NONE,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.searchSource).toBe(SEARCH_SOURCE_NONE);
    }
  });

  it("accepts securityGuardrails when omitted or null", () => {
    expect(providerCreateSchema.safeParse(baseProvider).success).toBe(true);
    expect(
      providerCreateSchema.safeParse({
        ...baseProvider,
        securityGuardrails: null,
      }).success,
    ).toBe(true);
  });

  it("accepts securityGuardrails up to 8000 chars and rejects beyond", () => {
    expect(
      providerCreateSchema.safeParse({
        ...baseProvider,
        securityGuardrails: "a".repeat(8000),
      }).success,
    ).toBe(true);
    expect(
      providerCreateSchema.safeParse({
        ...baseProvider,
        securityGuardrails: "a".repeat(8001),
      }).success,
    ).toBe(false);
  });

  it("round-trips a backend id through searchSource on create and update", () => {
    // Free text, deliberately unvalidated against the plugin registry — the
    // valid set is whichever plugins the deployment loaded (ADR-0014).
    const created = providerCreateSchema.safeParse({
      ...baseProvider,
      searchSource: "acme.searx",
    });
    expect(created.success).toBe(true);
    if (created.success) {
      expect(created.data.searchSource).toBe("acme.searx");
    }

    const cleared = providerUpdateSchema.safeParse({
      ...baseProvider,
      searchSource: SEARCH_SOURCE_NONE,
    });
    expect(cleared.success).toBe(true);
    if (cleared.success) {
      expect(cleared.data.searchSource).toBe(SEARCH_SOURCE_NONE);
    }
  });

  it("normalises an empty searchSource to none and bounds its length", () => {
    // A form select's "None" option, or a pre-collapse row written by hand,
    // could still submit `""`. Normalised rather than rejected, so the column
    // holds one representation of "no search" and choosing None is not a 400.
    const empty = providerUpdateSchema.safeParse({
      ...baseProvider,
      searchSource: "",
    });
    expect(empty.success).toBe(true);
    if (empty.success) {
      expect(empty.data.searchSource).toBe(SEARCH_SOURCE_NONE);
    }

    // Bounded because the value is free text that reaches a log line on every
    // searching turn; 200 is far above a namespaced plugin id.
    expect(
      providerCreateSchema.safeParse({
        ...baseProvider,
        searchSource: "x".repeat(200),
      }).success,
    ).toBe(true);
    expect(
      providerCreateSchema.safeParse({
        ...baseProvider,
        searchSource: "x".repeat(201),
      }).success,
    ).toBe(false);
  });

  // The pre-collapse `nativeSearchEnabled` / `webBackend` pair is gone from the
  // request shape entirely, not aliased onto `searchSource`: the Provider API is
  // reachable only with a session cookie, so its one writer is the Provider form
  // shipped alongside it, and that always sends `searchSource`.
  it("ignores the pre-collapse search fields rather than mapping them", () => {
    const result = providerCreateSchema.safeParse({
      ...baseProvider,
      nativeSearchEnabled: false,
      webBackend: "acme.searx",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.searchSource).toBe(SEARCH_SOURCE_NATIVE);
      expect(result.data).not.toHaveProperty("nativeSearchEnabled");
      expect(result.data).not.toHaveProperty("webBackend");
    }
  });
});

describe("providerHasNativeSearch", () => {
  // The whole capability table, both API modes, because the backend's injection
  // gate and the frontend's toggle visibility both hang off this one function.
  const cases: Array<
    [Provider["providerType"], "chat" | "responses", boolean]
  > = [
    ["Anthropic", "chat", true],
    ["Anthropic", "responses", true],
    ["Google", "chat", true],
    ["Google", "responses", true],
    ["OpenRouter", "chat", true],
    ["OpenRouter", "responses", true],
    // OpenAI's native search lives on the Responses API only, so an
    // OpenAI-compatible chat endpoint (vLLM, llama.cpp) has none.
    ["OpenAI", "chat", false],
    ["OpenAI", "responses", true],
    ["Bedrock", "chat", false],
    ["Bedrock", "responses", false],
  ];

  it.each(cases)("%s on the %s API → %s", (providerType, apiMode, expected) => {
    expect(providerHasNativeSearch({ providerType, apiMode })).toBe(expected);
  });

  it("treats an unknown provider type as having no native search", () => {
    expect(
      providerHasNativeSearch({
        providerType: "Fictional" as Provider["providerType"],
        apiMode: "responses",
      }),
    ).toBe(false);
  });
});

describe("isPresentableUrl", () => {
  // Both consumers are downstream of this: the backend drops an unpresentable
  // `web_search` result before the model sees it, and the frontend re-checks
  // before the URL becomes an `href`. The rejection cases are the point.
  it("accepts http and https only", () => {
    expect(isPresentableUrl("http://example.com/")).toBe(true);
    expect(isPresentableUrl("https://example.com/")).toBe(true);
  });

  it("rejects other schemes, non-URLs, and non-strings", () => {
    expect(isPresentableUrl("javascript:alert(1)")).toBe(false);
    expect(isPresentableUrl("data:text/html,<script>alert(1)</script>")).toBe(
      false,
    );
    expect(isPresentableUrl("file:///etc/passwd")).toBe(false);
    expect(isPresentableUrl("not a url")).toBe(false);
    expect(isPresentableUrl("")).toBe(false);
    expect(isPresentableUrl(undefined)).toBe(false);
    expect(isPresentableUrl(null)).toBe(false);
    expect(isPresentableUrl(42)).toBe(false);
  });

  // Case-insensitive by way of `new URL`, which normalises the scheme — so
  // `JavaScript:` is not a bypass.
  it("is not fooled by scheme casing", () => {
    expect(isPresentableUrl("HTTPS://example.com/")).toBe(true);
    expect(isPresentableUrl("JavaScript:alert(1)")).toBe(false);
  });
});

describe("Provider modelIds (per-model config)", () => {
  const base = {
    organizationId: "org-123",
    name: "Test Provider",
    providerType: "OpenAI" as const,
    apiKey: "sk-test",
    taskModelId: "gpt-4",
    memoryExtractionModelId: "gpt-4",
  };

  it("coerces a legacy string[] to per-model objects with empty passthrough", () => {
    const result = providerCreateSchema.safeParse({
      ...base,
      modelIds: ["gpt-4", "gpt-4o"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modelIds).toEqual([
        { id: "gpt-4", passthroughFileTypes: [] },
        { id: "gpt-4o", passthroughFileTypes: [] },
      ]);
    }
  });

  it("accepts per-model objects and defaults passthroughFileTypes to []", () => {
    const result = providerCreateSchema.safeParse({
      ...base,
      modelIds: [
        { id: "gpt-4o" },
        { id: "qwen-vl", passthroughFileTypes: ["image/*"] },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modelIds).toEqual([
        { id: "gpt-4o", passthroughFileTypes: [] },
        { id: "qwen-vl", passthroughFileTypes: ["image/*"] },
      ]);
    }
  });

  it("requires at least one model", () => {
    expect(
      providerCreateSchema.safeParse({ ...base, modelIds: [] }).success,
    ).toBe(false);
  });

  it("accepts a per-model maxExtractedTextChars override", () => {
    const result = providerCreateSchema.safeParse({
      ...base,
      modelIds: [{ id: "qwen", maxExtractedTextChars: 20000 }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modelIds[0].maxExtractedTextChars).toBe(20000);
    }
  });

  it("leaves maxExtractedTextChars undefined when not declared", () => {
    const result = providerCreateSchema.safeParse({
      ...base,
      modelIds: [{ id: "qwen" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modelIds[0].maxExtractedTextChars).toBeUndefined();
    }
  });

  it("rejects a non-positive or fractional maxExtractedTextChars", () => {
    for (const value of [0, -1, 1.5]) {
      expect(
        providerCreateSchema.safeParse({
          ...base,
          modelIds: [{ id: "qwen", maxExtractedTextChars: value }],
        }).success,
      ).toBe(false);
    }
  });

  it("accepts a per-model maxOutputTokens override", () => {
    const result = providerCreateSchema.safeParse({
      ...base,
      modelIds: [{ id: "qwen", maxOutputTokens: 64000 }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modelIds[0].maxOutputTokens).toBe(64000);
    }
  });

  // Optional on BOTH paths for the same reason the window is: a Provider saved
  // untouched through the update schema must not become a 400.
  it.each([
    ["create", providerCreateSchema],
    ["update", providerUpdateSchema],
  ])(
    "leaves maxOutputTokens undefined on %s when not declared",
    (_, schema) => {
      const result = schema.safeParse({ ...base, modelIds: [{ id: "qwen" }] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.modelIds).toHaveLength(1);
        expect(result.data.modelIds![0].maxOutputTokens).toBeUndefined();
      }
    },
  );

  it("rejects a non-positive or fractional maxOutputTokens", () => {
    for (const value of [0, -1, 1.5]) {
      expect(
        providerCreateSchema.safeParse({
          ...base,
          modelIds: [{ id: "qwen", maxOutputTokens: value }],
        }).success,
        `maxOutputTokens ${value} should be rejected`,
      ).toBe(false);
    }
  });

  // No upper bound, unlike the Context window: the ceiling that matters is the
  // model's own, Platypus cannot know it, and a value above it is the vendor's
  // to reject.
  it("accepts a maxOutputTokens far above any published ceiling", () => {
    expect(
      providerCreateSchema.safeParse({
        ...base,
        modelIds: [{ id: "qwen", maxOutputTokens: 10_000_000 }],
      }).success,
    ).toBe(true);
  });

  it("survives the legacy string[] coercion as undefined", () => {
    const result = providerCreateSchema.safeParse({
      ...base,
      modelIds: ["gpt-4"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modelIds[0].maxOutputTokens).toBeUndefined();
    }
  });

  it("accepts a declared contextWindow", () => {
    const result = providerCreateSchema.safeParse({
      ...base,
      modelIds: [{ id: "qwen", contextWindow: 128000 }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modelIds[0].contextWindow).toBe(128000);
    }
  });

  // Optional on BOTH paths, and deliberately so: a Provider configured before
  // the field existed is edited through the update schema, and a
  // create-vs-update divergence would make saving it untouched a 400.
  it.each([
    ["create", providerCreateSchema],
    ["update", providerUpdateSchema],
  ])("leaves contextWindow undefined on %s when not declared", (_, schema) => {
    const result = schema.safeParse({ ...base, modelIds: [{ id: "qwen" }] });
    expect(result.success).toBe(true);
    if (result.success) {
      // Asserted, not optional-chained: a schema that dropped `modelIds`
      // entirely would satisfy an `undefined` expectation vacuously.
      expect(result.data.modelIds).toHaveLength(1);
      expect(result.data.modelIds![0].contextWindow).toBeUndefined();
    }
  });

  it("rejects a contextWindow that is zero, negative, fractional or out of bounds", () => {
    // 128 is the case the floor exists for: an Org Admin typing the number of
    // thousands. Silently accepting it would cripple every reading taken
    // against it rather than fail where the mistake was made.
    for (const value of [0, -1, 1.5, 128, 999, 10_000_001]) {
      expect(
        providerCreateSchema.safeParse({
          ...base,
          modelIds: [{ id: "qwen", contextWindow: value }],
        }).success,
        `contextWindow ${value} should be rejected`,
      ).toBe(false);
    }
  });

  it("accepts the exact bounds", () => {
    for (const value of [CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX]) {
      expect(
        providerCreateSchema.safeParse({
          ...base,
          modelIds: [{ id: "qwen", contextWindow: value }],
        }).success,
        `contextWindow ${value} should be accepted`,
      ).toBe(true);
    }
  });

  it("keeps the alias namespace rule unaffected by a declared contextWindow", () => {
    // The window rides on the same entry as the alias (ADR-0017), so a repoint
    // moves it — but it is not part of what makes two entries clash.
    const aliased = providerCreateSchema.safeParse({
      ...base,
      modelIds: [{ id: "qwen", alias: "flagship", contextWindow: 200000 }],
    });
    expect(aliased.success).toBe(true);
    if (aliased.success) {
      expect(aliased.data.modelIds[0]).toMatchObject({
        alias: "flagship",
        contextWindow: 200000,
      });
    }

    expect(
      providerCreateSchema.safeParse({
        ...base,
        modelIds: [
          { id: "qwen", alias: "flagship", contextWindow: 200000 },
          { id: "qwen-2", alias: "FLAGSHIP", contextWindow: 8000 },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("Organization identityContext", () => {
  it("accepts an organization when identityContext is omitted or null", () => {
    const base = {
      id: "org-1",
      name: "Acme Org",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(organizationSchema.safeParse(base).success).toBe(true);
    expect(
      organizationSchema.safeParse({ ...base, identityContext: null }).success,
    ).toBe(true);
  });

  it("rejects identityContext beyond 4000 chars on the update schema", () => {
    expect(
      organizationUpdateSchema.safeParse({
        name: "Acme Org",
        identityContext: "a".repeat(4000),
      }).success,
    ).toBe(true);
    expect(
      organizationUpdateSchema.safeParse({
        name: "Acme Org",
        identityContext: "a".repeat(4001),
      }).success,
    ).toBe(false);
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

describe("classifyFile", () => {
  const passthroughFileTypes = ["image/*"];

  it("prioritizes native passthrough media types", () => {
    expect(
      classifyFile(
        { mediaType: "image/png", filename: "image.png" },
        passthroughFileTypes,
        true,
      ),
    ).toBe("passthrough");
  });

  it("classifies text-like files when content is not binary", () => {
    expect(
      classifyFile(
        { mediaType: "application/octet-stream", filename: "notes.md" },
        passthroughFileTypes,
      ),
    ).toBe("text");
  });

  it("rejects binary content even when the extension is text-like", () => {
    expect(
      classifyFile(
        { mediaType: "application/octet-stream", filename: "notes.md" },
        passthroughFileTypes,
        true,
      ),
    ).toBe("reject");
  });

  it("marks a non-native PDF for extraction", () => {
    expect(
      classifyFile(
        { mediaType: "application/pdf", filename: "report.pdf" },
        passthroughFileTypes,
      ),
    ).toBe("extract");
  });

  it("marks a non-native DOCX for extraction", () => {
    expect(
      classifyFile(
        {
          mediaType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          filename: "spec.docx",
        },
        passthroughFileTypes,
      ),
    ).toBe("extract");
  });

  it("still rejects binary types nothing can extract", () => {
    expect(
      classifyFile(
        { mediaType: "application/zip", filename: "bundle.zip" },
        passthroughFileTypes,
      ),
    ).toBe("reject");
    expect(
      classifyFile(
        { mediaType: "application/octet-stream", filename: "blob.bin" },
        passthroughFileTypes,
      ),
    ).toBe("reject");
  });

  it("prefers native passthrough over extraction", () => {
    expect(
      classifyFile({ mediaType: "application/pdf", filename: "report.pdf" }, [
        "application/pdf",
      ]),
    ).toBe("passthrough");
  });
});

describe("extractableDocumentFormat", () => {
  it("recognizes PDF and DOCX by extension regardless of case", () => {
    expect(extractableDocumentFormat({ filename: "report.PDF" })).toBe("pdf");
    expect(extractableDocumentFormat({ filename: "spec.docx" })).toBe("docx");
  });

  it("recognizes PDF and DOCX by media type when the filename is missing", () => {
    expect(extractableDocumentFormat({ mediaType: "application/pdf" })).toBe(
      "pdf",
    );
    expect(
      extractableDocumentFormat({
        mediaType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).toBe("docx");
  });

  it("prefers the extension over a mismatched media type", () => {
    expect(
      extractableDocumentFormat({
        mediaType: "application/octet-stream",
        filename: "spec.docx",
      }),
    ).toBe("docx");
  });

  it("does not claim formats Phase 2 cannot extract", () => {
    for (const filename of ["sheet.xlsx", "slides.pptx", "legacy.doc"]) {
      expect(extractableDocumentFormat({ filename })).toBeNull();
    }
    expect(extractableDocumentFormat({})).toBeNull();
  });
});

describe("resolveExtractedTextCap", () => {
  it("keeps a positive declared cap", () => {
    expect(resolveExtractedTextCap(8000)).toBe(8000);
  });

  it("falls back to the default for a missing or nonsense cap", () => {
    for (const value of [
      undefined,
      0,
      -5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(resolveExtractedTextCap(value)).toBe(
        DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
      );
    }
  });
});

describe("Model aliases (modelIds)", () => {
  const base = {
    organizationId: "org-123",
    name: "Test Provider",
    providerType: "OpenAI" as const,
    apiKey: "sk-test",
    taskModelId: "gpt-4",
    memoryExtractionModelId: "gpt-4",
  };

  const parseModels = (modelIds: unknown) =>
    providerCreateSchema.safeParse({ ...base, modelIds });

  it("accepts an alias on an entry and trims surrounding whitespace", () => {
    const result = parseModels([{ id: "gpt-4", alias: "  flagship  " }]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modelIds[0].alias).toBe("flagship");
    }
  });

  it("leaves alias undefined when not declared", () => {
    const result = parseModels([{ id: "gpt-4" }]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modelIds[0].alias).toBeUndefined();
    }
  });

  it("rejects an empty or whitespace-only alias", () => {
    for (const alias of ["", "   ", "\t"]) {
      expect(parseModels([{ id: "gpt-4", alias }]).success).toBe(false);
    }
  });

  it("rejects an alias that itself begins with the alias prefix", () => {
    for (const alias of ["alias:flagship", "ALIAS:flagship"]) {
      expect(parseModels([{ id: "gpt-4", alias }]).success).toBe(false);
    }
  });

  it("accepts distinct aliases across entries", () => {
    expect(
      parseModels([
        { id: "gpt-4", alias: "flagship" },
        { id: "gpt-4o-mini", alias: "fast" },
      ]).success,
    ).toBe(true);
  });

  it("rejects two aliases differing only in case", () => {
    const result = parseModels([
      { id: "gpt-4", alias: "Fast" },
      { id: "gpt-4o-mini", alias: "fast" },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects an alias duplicating another entry's concrete id, case-insensitively", () => {
    expect(
      parseModels([{ id: "gpt-4" }, { id: "gpt-4o-mini", alias: "GPT-4" }])
        .success,
    ).toBe(false);
  });

  it("rejects an alias duplicating its own entry's concrete id", () => {
    expect(parseModels([{ id: "gpt-4", alias: "gpt-4" }]).success).toBe(false);
  });

  it("still coerces a legacy string[] with no aliases", () => {
    const result = parseModels(["gpt-4", "gpt-4o"]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modelIds).toEqual([
        { id: "gpt-4", passthroughFileTypes: [] },
        { id: "gpt-4o", passthroughFileTypes: [] },
      ]);
    }
  });
});

describe("Provider pointer-settings reject alias references", () => {
  const base = {
    organizationId: "org-123",
    name: "Test Provider",
    providerType: "OpenAI" as const,
    apiKey: "sk-test",
    modelIds: [{ id: "gpt-4", alias: "flagship" }],
    taskModelId: "gpt-4",
    memoryExtractionModelId: "gpt-4",
  };

  it("accepts concrete ids in all three pointer-settings", () => {
    expect(
      providerCreateSchema.safeParse({ ...base, embeddingModelId: "embed-3" })
        .success,
    ).toBe(true);
  });

  for (const field of [
    "taskModelId",
    "memoryExtractionModelId",
    "embeddingModelId",
  ] as const) {
    it(`rejects an alias reference in ${field} on create`, () => {
      expect(
        providerCreateSchema.safeParse({
          ...base,
          [field]: `${MODEL_ALIAS_PREFIX}flagship`,
        }).success,
      ).toBe(false);
    });

    it(`rejects an alias reference in ${field} on update`, () => {
      expect(
        providerUpdateSchema.safeParse({
          [field]: `${MODEL_ALIAS_PREFIX}flagship`,
        }).success,
      ).toBe(false);
    });
  }

  it("rejects a differently-cased alias prefix too — the guard is not the parser", () => {
    expect(
      providerCreateSchema.safeParse({ ...base, taskModelId: "Alias:flagship" })
        .success,
    ).toBe(false);
  });

  it("still accepts a null or absent embeddingModelId", () => {
    expect(
      providerCreateSchema.safeParse({ ...base, embeddingModelId: null })
        .success,
    ).toBe(true);
    expect(providerCreateSchema.safeParse(base).success).toBe(true);
  });
});

describe("Model reference helpers", () => {
  const models = [
    { id: "gpt-4", passthroughFileTypes: [], alias: "flagship" },
    { id: "gpt-4o-mini", passthroughFileTypes: [] },
  ];

  it("marks only alias references", () => {
    expect(isAliasReference("alias:flagship")).toBe(true);
    expect(isAliasReference("gpt-4")).toBe(false);
  });

  it("reads the bare name out of a reference", () => {
    expect(aliasNameFromReference("alias:flagship")).toBe("flagship");
    expect(aliasNameFromReference("gpt-4")).toBeNull();
  });

  it("submits an alias reference for an aliased entry and the id otherwise", () => {
    expect(modelReferenceFor(models[0])).toBe("alias:flagship");
    expect(modelReferenceFor(models[1])).toBe("gpt-4o-mini");
  });

  it("labels an aliased entry with its alias and the id otherwise", () => {
    expect(modelLabelFor(models[0])).toBe("flagship");
    expect(modelLabelFor(models[1])).toBe("gpt-4o-mini");
  });

  it("resolves a bare id to its entry even once that entry is aliased", () => {
    expect(findModelEntry(models, "gpt-4")).toBe(models[0]);
  });

  it("resolves an alias reference to its entry, ignoring case", () => {
    expect(findModelEntry(models, "alias:flagship")).toBe(models[0]);
    expect(findModelEntry(models, "alias:FLAGSHIP")).toBe(models[0]);
  });

  it("matches concrete ids case-sensitively, as vendor strings", () => {
    expect(findModelEntry(models, "GPT-4")).toBeUndefined();
  });

  it("returns undefined for a reference matching no entry", () => {
    expect(findModelEntry(models, "alias:ghost")).toBeUndefined();
    expect(findModelEntry(models, "ghost")).toBeUndefined();
  });

  it("never resolves an alias reference to a like-named concrete id", () => {
    expect(findModelEntry(models, "alias:gpt-4")).toBeUndefined();
  });
});

describe("triggerRunStatsSchema", () => {
  const base = {
    steps: 3,
    toolCalls: [{ name: "search", count: 2 }],
    inputTokens: 900,
    outputTokens: 120,
  };

  it("accepts a run that recorded Context occupancy", () => {
    const result = triggerRunStatsSchema.safeParse({
      ...base,
      contextOccupancy: 42_000,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.contextOccupancy).toBe(42_000);
  });

  it("leaves occupancy undefined for a Provider that reported no usage", () => {
    const result = triggerRunStatsSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.contextOccupancy).toBeUndefined();
  });

  it("keeps the cross-step token sums meaning what they meant", () => {
    // Occupancy is a separate field precisely so these two keep their billing
    // meaning — a reader of the trigger runs page must not find the same name
    // holding a different quantity (ADR-0018).
    const result = triggerRunStatsSchema.safeParse({
      ...base,
      contextOccupancy: 42_000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.inputTokens).toBe(900);
      expect(result.data.outputTokens).toBe(120);
    }
  });

  it("rejects a negative or fractional occupancy", () => {
    for (const contextOccupancy of [-1, 1.5]) {
      expect(
        triggerRunStatsSchema.safeParse({ ...base, contextOccupancy }).success,
      ).toBe(false);
    }
  });
});

describe("nextTurnOccupancy", () => {
  it("adds the reply to what the last call was sent", () => {
    // The forward-looking figure the composer's meter shows: 222 input on the
    // last call plus the 118-token reply it produced, because the Transcript is
    // re-sent in full and that reply is now part of it (ADR-0018).
    expect(nextTurnOccupancy({ inputTokens: 222, outputTokens: 118 })).toBe(
      340,
    );
  });

  it("reads low rather than estimating when the output count is unknown", () => {
    // A Provider that reported an input count and no output one leaves the
    // reply's size unknown, not zero. Under-reading is the safe direction and
    // the only alternative is the estimate ADR-0018 rejected.
    expect(nextTurnOccupancy({ inputTokens: 222, outputTokens: null })).toBe(
      222,
    );
  });

  it("is unknown where the reading is", () => {
    // Absent and `null` say the same thing — no reading — and both must stay
    // undefined so the meter hides rather than showing a confident 0.
    expect(nextTurnOccupancy(null)).toBeUndefined();
    expect(nextTurnOccupancy(undefined)).toBeUndefined();
  });
});
