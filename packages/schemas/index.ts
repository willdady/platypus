import { z } from "zod";

const kebabCaseRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Shared free-text bounds, exported so the forms' `maxLength` attributes read
// the same source as the server rule.
//
// The Organization's identity / context.
export const ORGANIZATION_IDENTITY_CONTEXT_MAX_LENGTH = 4000;
// Every free-text Workspace context field (Workspace, Blueprint, Workspace
// context).
export const CONTEXT_MAX_LENGTH = 1000;

// Organization

export const organizationSchema = z.object({
  id: z.string(),
  name: z.string().min(3).max(30),
  // Free-text organization identity / context, rendered EARLY in the system
  // prompt beside the workspace context as framing — NOT a security control
  // (see the provider `securityGuardrails` field for that). Length-bounded
  // against abuse; nullable so existing orgs are unchanged.
  identityContext: z
    .string()
    .max(ORGANIZATION_IDENTITY_CONTEXT_MAX_LENGTH)
    .nullable()
    .optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Organization = z.infer<typeof organizationSchema>;

export const organizationCreateSchema = organizationSchema.pick({ name: true });

export const organizationUpdateSchema = organizationSchema.pick({
  name: true,
  identityContext: true,
});

// Workspace

// Workspace name length bounds, shared so the invite-time default-name
// generator (ADR-0008) can guarantee a provisioned name stays editable.
export const WORKSPACE_NAME_MIN_LENGTH = 3;
export const WORKSPACE_NAME_MAX_LENGTH = 30;

// Daily memory-summary retention bounds, shared with the Workspace form.
export const WORKSPACE_MAX_DAILY_SUMMARIES_MIN = 7;
export const WORKSPACE_MAX_DAILY_SUMMARIES_MAX = 365;
export const DEFAULT_WORKSPACE_MAX_DAILY_SUMMARIES = 90;

export const workspaceSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  ownerId: z.string(),
  name: z
    .string()
    .min(WORKSPACE_NAME_MIN_LENGTH)
    .max(WORKSPACE_NAME_MAX_LENGTH),
  context: z.string().max(CONTEXT_MAX_LENGTH).nullable().optional(),
  taskModelProviderId: z.string().nullable().optional(),
  memoryExtractionProviderId: z.string().nullable().optional(),
  memoryEmbeddingProviderId: z.string().nullable().optional(),
  maxDailySummaries: z
    .number()
    .int()
    .min(WORKSPACE_MAX_DAILY_SUMMARIES_MIN)
    .max(WORKSPACE_MAX_DAILY_SUMMARIES_MAX)
    .optional(),
  // Per-workspace delegation flags (ADR-0006). Settable only by an org admin
  // (enforced in the workspace route); when true the owner may self-manage the
  // respective resource.
  providerSelfManagement: z.boolean().optional(),
  mcpSelfManagement: z.boolean().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Workspace = z.infer<typeof workspaceSchema>;

export const workspaceCreateSchema = workspaceSchema
  .pick({
    name: true,
    context: true,
  })
  // ownerId is admin-assignable (ADR-0008). When omitted, the create handler
  // defaults the owner to the calling admin.
  .extend({ ownerId: z.string().optional() });

export const workspaceUpdateSchema = workspaceSchema.pick({
  name: true,
  context: true,
  taskModelProviderId: true,
  memoryExtractionProviderId: true,
  memoryEmbeddingProviderId: true,
  maxDailySummaries: true,
  providerSelfManagement: true,
  mcpSelfManagement: true,
});

// Chat

export const chatStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export type ChatStatus = z.infer<typeof chatStatusSchema>;

/**
 * Bounds on the per-chat Max steps setting (`chatSchema.maxSteps`). Exported
 * because the documentation contract test pins the numbers the
 * Operator-facing docs quote to these, and the Chat settings input enforces
 * the same pair.
 */
export const CHAT_MAX_STEPS_MIN = 1;
export const CHAT_MAX_STEPS_MAX = 50;

/**
 * Placeholder title a chat is created with until it is titled. Load-bearing on
 * both sides: the backend only ever generates a title while the row still holds
 * this value (idempotent, first-wins), and the client only polls for a
 * generated title while it sees this value. Keep it here so both trees agree.
 */
export const UNTITLED_CHAT_TITLE = "Untitled";

export const chatSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string().min(3).max(30),
  // The Active path, as `GET /:chatId` returns it (ADR-0026).
  messages: z.any().optional(),
  // Every live message's place in the Chat's tree, oldest first. Returned
  // beside `messages` so a client can tell which messages have Alternatives.
  tree: z
    .array(z.object({ id: z.string(), parentId: z.string().nullable() }))
    .optional(),
  status: chatStatusSchema,
  isPinned: z.boolean(),
  tags: z
    .array(z.string().regex(kebabCaseRegex, "Tags must be kebab-case"))
    .max(5, "A chat can have at most 5 tags")
    .optional(),
  agentId: z.string().optional(),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  instructions: z.string().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
  seed: z.number().optional(),
  presencePenalty: z.number().optional(),
  frequencyPenalty: z.number().optional(),
  // Per-chat step ceiling for Direct (no-Agent) turns (#539). Nullable like
  // its six sampling neighbours rather than shaped like the Agent's own
  // `maxSteps`, so a client that clears a field by sending an explicit null
  // — as the Agent form does — cannot hit #263, where a dropped key leaves
  // the column's previous value standing. A chat turn happens to clear by
  // omission instead and survives it only because every turn rewrites all
  // generation columns; accepting null keeps the seam honest either way.
  // Bounded above because a Direct turn never meets the no-progress detector
  // — this ceiling is its only backstop — while the Agent form's field is
  // deliberately left unbounded by its author.
  maxSteps: z
    .number()
    .int()
    .min(CHAT_MAX_STEPS_MIN)
    .max(CHAT_MAX_STEPS_MAX)
    .nullable()
    .optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Chat = z.infer<typeof chatSchema>;

/**
 * Whether a per-chat Max steps value is one the turn endpoint will accept.
 *
 * Shared so the Chat settings input, the send guard and the request validator
 * all decide from `chatSchema.maxSteps` itself. Restating `int/min/max` in the
 * UI is how the field's inline error and its 400 drift apart. "Unset" (null or
 * undefined) is valid — it means fall back to the Direct default.
 */
export const isValidChatMaxSteps = (
  value: number | null | undefined,
): boolean => chatSchema.shape.maxSteps.safeParse(value).success;

const chatTurnSchema = chatSchema
  .pick({
    id: true,
    workspaceId: true,
    instructions: true,
    temperature: true,
    topP: true,
    topK: true,
    seed: true,
    presencePenalty: true,
    frequencyPenalty: true,
    maxSteps: true,
  })
  .extend({
    agentId: z.string().optional(),
    providerId: z.string().optional(),
    modelId: z.string().optional(),
    search: z.boolean().optional(),
    // The server owns the Transcript (ADR-0026) and rebuilds it from its own
    // rows. A client still sending its own is refused rather than
    // half-honoured.
    messages: z.never().optional(),
  });

/**
 * A Chat turn: a new user message and the id it follows, or the id of a reply
 * to regenerate.
 *
 * The message is a trust boundary — a user message of text and files, with no
 * metadata, which only the server writes. The backend also runs it through the
 * AI SDK's `validateUIMessages`, which knows each part's shape.
 */
export const chatSubmitSchema = z
  .union([
    chatTurnSchema.extend({
      message: z.strictObject({
        id: z.string().min(1),
        role: z.literal("user"),
        parts: z.array(z.looseObject({ type: z.enum(["text", "file"]) })),
      }),
      // Always stated, null for a Chat's first message: the server never
      // guesses what a message follows.
      parentId: z.string().nullable(),
    }),
    chatTurnSchema.extend({
      trigger: z.literal("regenerate-message"),
      messageId: z.string().min(1),
    }),
  ])
  .refine(
    (data) => {
      const hasAgent = Boolean(data.agentId);
      const hasProviderModel = Boolean(data.providerId && data.modelId);
      return hasAgent || hasProviderModel;
    },
    {
      message: "Must provide either agentId or (providerId and modelId)",
      path: ["agentId"],
    },
  );

export const chatUpdateSchema = chatSchema.pick({
  workspaceId: true,
  title: true,
  isPinned: true,
  tags: true,
});

export type ChatSubmitData = z.infer<typeof chatSubmitSchema>;

export const chatListItemSchema = chatSchema.pick({
  id: true,
  title: true,
  status: true,
  isPinned: true,
  tags: true,
  agentId: true,
  providerId: true,
  modelId: true,
  createdAt: true,
  updatedAt: true,
});

export type ChatListItem = z.infer<typeof chatListItemSchema>;

export const chatListSchema = z.object({
  results: z.array(chatListItemSchema),
  totalCount: z.number(),
});

// Agent

/**
 * Default agentic step ceiling for an agent that has no explicit `maxSteps`,
 * and the value the Agent form prefills. Keeps API-created agents sane (a
 * single step never lets a tool-calling agent finish its work) while staying
 * low enough to bound a model that fails to converge.
 *
 * Lives here rather than beside either consumer: both the Chat-turn path and
 * the Sub-Agent delegation path resolve an unset `maxSteps` through it, and
 * homing it in one of them makes the other import a module it has no other
 * reason to load.
 */
export const DEFAULT_AGENT_MAX_STEPS = 15;

/**
 * Default agentic step ceiling for a Direct (no-Agent) Chat turn — a bare
 * Provider+model selection with no `agent` row to declare its own `maxSteps`.
 *
 * Deliberately BELOW `DEFAULT_AGENT_MAX_STEPS`: a Direct chat is a
 * conversation, not a configured workflow, and — unlike an unattended run — it
 * is never guarded by the no-progress detector. The ceiling itself is the only
 * guard here, so do not raise it to match the Agent default. It is the value
 * the per-chat Max steps setting (#539) falls back to when left unset; do not
 * derive that setting's maximum from this constant, whose job is to bound the
 * conversation nobody has tuned.
 *
 * 10 rather than something smaller because the page-reader tool a Web-search
 * backend contributes is meant to be called repeatedly: it slices a long page
 * and tells the model to keep reading with a continuation index. A realistic
 * turn looks like search → read → continuation → continuation → answer — five
 * steps already, so a ceiling of 5 sits right on that boundary and would fail
 * in the same silent way as the bug this constant fixes. 10 leaves headroom
 * above it.
 */
export const DEFAULT_DIRECT_MAX_STEPS = 10;

// The bounds the Agent form's counters and `maxLength` attributes read.
export const AGENT_NAME_MIN_LENGTH = 3;
export const AGENT_NAME_MAX_LENGTH = 30;
export const AGENT_DESCRIPTION_MIN_LENGTH = 1;
export const AGENT_DESCRIPTION_MAX_LENGTH = 128;
export const AGENT_INPUT_PLACEHOLDER_MAX_LENGTH = 100;
export const AGENT_MAX_STEPS_MIN = 1;

// An Agent is scoped to either a Workspace or an Organization (mutually
// exclusive), mirroring the dual-scope shape of `provider`/`mcp`/`skill`.
// Org-scoped Agents are Shared resources managed by Org Admins (ADR-0007);
// the XOR is enforced on `agentSchema` below, while the create routes inject
// the scope and Promote re-scopes a Workspace Agent to the Organization.
export const agentBaseSchema = z.object({
  id: z.string(),
  organizationId: z.string().optional(),
  workspaceId: z.string().optional(),
  providerId: z.string(),
  name: z.string().min(AGENT_NAME_MIN_LENGTH).max(AGENT_NAME_MAX_LENGTH),
  description: z
    .string()
    .min(AGENT_DESCRIPTION_MIN_LENGTH)
    .max(AGENT_DESCRIPTION_MAX_LENGTH),
  instructions: z.string().optional(),
  modelId: z.string(),
  // Bounded because the value reaches `stepCountIs(n)`, whose predicate is
  // `steps.length === n`, evaluated only after a step has completed. A `0` (or
  // any negative, or a fraction the integer column would never match) is
  // therefore never equal to a real step count, so the loop runs unbounded —
  // the opposite of the ceiling the operator asked for. `min(1)` matches the
  // `min="1"` the Agent form already puts on the input.
  maxSteps: z.number().int().min(AGENT_MAX_STEPS_MIN).optional(),
  // Sampling params are nullable so the UI can clear them back to "unset"
  // (null) — without null, JSON.stringify drops the cleared `undefined` key
  // and the column keeps its previous value (#263). null is treated as "unset"
  // at run time, falling back to the provider/model default.
  temperature: z.number().nullable().optional(),
  topP: z.number().nullable().optional(),
  topK: z.number().nullable().optional(),
  seed: z.number().nullable().optional(),
  presencePenalty: z.number().nullable().optional(),
  frequencyPenalty: z.number().nullable().optional(),
  toolSetIds: z.array(z.string()).optional(),
  skillIds: z.array(z.string()).optional(),
  subAgentIds: z.array(z.string()).optional(),
  inputPlaceholder: z
    .string()
    .max(AGENT_INPUT_PLACEHOLDER_MAX_LENGTH)
    .optional(),
  avatarUrl: z.string().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const agentSchema = agentBaseSchema.refine(
  (data) => {
    const hasOrg = Boolean(data.organizationId);
    const hasWorkspace = Boolean(data.workspaceId);
    return (hasOrg || hasWorkspace) && !(hasOrg && hasWorkspace);
  },
  {
    message:
      "Agent must have either organizationId or workspaceId, but not both",
    path: ["organizationId"],
  },
);

export type Agent = z.infer<typeof agentSchema>;

export const agentCreateSchema = agentBaseSchema.pick({
  workspaceId: true,
  providerId: true,
  name: true,
  description: true,
  instructions: true,
  modelId: true,
  maxSteps: true,
  temperature: true,
  topP: true,
  topK: true,
  seed: true,
  presencePenalty: true,
  frequencyPenalty: true,
  toolSetIds: true,
  skillIds: true,
  subAgentIds: true,
  inputPlaceholder: true,
});

export const agentUpdateSchema = agentBaseSchema.pick({
  providerId: true,
  name: true,
  description: true,
  instructions: true,
  modelId: true,
  maxSteps: true,
  temperature: true,
  topP: true,
  topK: true,
  seed: true,
  presencePenalty: true,
  frequencyPenalty: true,
  toolSetIds: true,
  skillIds: true,
  subAgentIds: true,
  inputPlaceholder: true,
});

// Skill

/**
 * A Skill name's shape, as a source fragment rather than a finished pattern:
 * the name is matched whole here, and anchored differently by the Chat input's
 * slash command, which reads it after a leading `/` and greedily — so
 * `/deploy-staging` can never resolve as `/deploy`. One source, so the two
 * cannot drift into disagreeing about what the user typed.
 */
export const SKILL_NAME_SOURCE = "[a-z0-9]+(?:-[a-z0-9]+)*";

// The bounds the Skill form's counters and `maxLength` attributes read, so the
// input and the server rule cannot drift apart.
export const SKILL_NAME_MIN_LENGTH = 5;
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MIN_LENGTH = 24;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
export const SKILL_BODY_MIN_LENGTH = 48;
export const SKILL_BODY_MAX_LENGTH = 50000;
export const SKILL_ARGUMENT_HINT_MAX_LENGTH = 120;

const skillNameRegex = new RegExp(`^${SKILL_NAME_SOURCE}$`);

// A Skill is scoped to either a Workspace or an Organization (mutually
// exclusive), mirroring the dual-scope shape of `provider`/`mcp`. Org-scoped
// Skills are Shared resources managed by Org Admins (ADR-0007). The XOR is
// enforced on `skillSchema` below; the create routes inject the scope.
export const skillBaseSchema = z.object({
  id: z.string(),
  organizationId: z.string().optional(),
  workspaceId: z.string().optional(),
  name: z
    .string()
    .min(SKILL_NAME_MIN_LENGTH)
    .max(SKILL_NAME_MAX_LENGTH)
    .regex(skillNameRegex, "Skill name must be kebab-case"),
  description: z
    .string()
    .min(SKILL_DESCRIPTION_MIN_LENGTH)
    .max(SKILL_DESCRIPTION_MAX_LENGTH),
  body: z.string().min(SKILL_BODY_MIN_LENGTH).max(SKILL_BODY_MAX_LENGTH),
  disableModelInvocation: z.boolean().default(false),
  argumentHint: z
    .string()
    .max(SKILL_ARGUMENT_HINT_MAX_LENGTH)
    .nullable()
    .optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const skillSchema = skillBaseSchema.refine(
  (data) => {
    const hasOrg = Boolean(data.organizationId);
    const hasWorkspace = Boolean(data.workspaceId);
    return (hasOrg || hasWorkspace) && !(hasOrg && hasWorkspace);
  },
  {
    message:
      "Skill must have either organizationId or workspaceId, but not both",
    path: ["organizationId"],
  },
);

export type Skill = z.infer<typeof skillSchema>;

export const skillCreateSchema = skillBaseSchema
  .pick({
    organizationId: true,
    workspaceId: true,
    name: true,
    description: true,
    body: true,
    disableModelInvocation: true,
    argumentHint: true,
  })
  .extend({
    agentIds: z.array(z.string()).optional(),
  });

export const skillUpdateSchema = skillBaseSchema
  .pick({
    name: true,
    description: true,
    body: true,
    argumentHint: true,
  })
  .extend({
    disableModelInvocation: z.boolean().optional(),
    agentIds: z.array(z.string()).optional(),
  });

// Tool

export const toolSchema = z.object({
  id: z.string(),
  description: z.string(),
  category: z.string().optional(),
});

export type Tool = z.infer<typeof toolSchema>;

// Tool Set

export const toolSetSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  description: z.string().optional(),
  tools: z.array(toolSchema),
});

export type ToolSet = z.infer<typeof toolSetSchema>;

// Tool names

/**
 * The ceiling a tool name must satisfy to be callable by a model — the
 * Anthropic/OpenAI tool-name ceiling of 64 characters, tighter than the 128 the
 * MCP specification itself permits, and a stricter character set than that
 * specification's (which also allows `.`).
 *
 * Two producers namespace a tool name under a prefix and are held to this:
 * MCP-sourced tools, under their server's slug (issue #467), and a third-party
 * plugin's Tool-set tools, under its manifest name (issue #664). It is
 * producer-neutral for that reason — {@link namespaceMcpToolName} is one caller,
 * not the owner.
 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * The separator between a namespace and the tool name under it. `__` rather than
 * anything else because it survives {@link TOOL_NAME_PATTERN}, and because
 * `humanizeToolType` in the frontend treats `_` as a word boundary — so
 * `acme__createIssue` renders as "Acme create issue" with no separator left
 * showing.
 */
export const TOOL_NAME_NAMESPACE_SEPARATOR = "__";

/**
 * Namespace a tool name under a prefix.
 *
 * A name that already looks namespaced (`github__pull`) is prefixed anyway,
 * never stripped: stripping would guess at the author's intent, and would
 * reintroduce a collision for a producer exposing both `pull` and `github__pull`.
 */
export const namespaceToolName = (prefix: string, toolName: string): string =>
  `${prefix}${TOOL_NAME_NAMESPACE_SEPARATOR}${toolName}`;

/**
 * How long a third-party plugin's manifest `name` may be (issue #664).
 *
 * The name is the namespace every one of the plugin's Tool-set tool names enters
 * a turn under, so this and {@link MAX_PLUGIN_TOOL_NAME_LENGTH} together bound
 * the composed name below {@link TOOL_NAME_PATTERN}'s 64 — 24 + 2 + 32 = 58,
 * with six characters of slack. Bounding the two halves is why no total-length
 * check is needed anywhere.
 *
 * Read it as a floor, not a quota: a plugin named `linear` leaves 56 characters
 * for a tool name. The cap is what a plugin may *declare*, not what it gets.
 */
export const MAX_PLUGIN_NAME_LENGTH = 24;

/**
 * How long a tool name in a third-party plugin's Tool set may be (issue #664).
 * See {@link MAX_PLUGIN_NAME_LENGTH} for the arithmetic the pair guarantees.
 */
export const MAX_PLUGIN_TOOL_NAME_LENGTH = 32;

// MCP

/**
 * Derive an MCP's tool-namespace slug from its display `name` (issue #467):
 * lowercase, apostrophes dropped outright (so a possessive collapses onto its
 * unpunctuated spelling — "Marys MCP Server" and "Mary's MCP Server" both
 * resolve to `marys_mcp_server`, which is exactly the pre-existing-collision
 * case the turn-time backstop in the Tool session exists for), every
 * remaining run of characters outside `[a-z0-9]` collapsed to a single `_`,
 * and leading/trailing `_` trimmed. Collapsing runs (rather than mapping each
 * disallowed character individually) is what guarantees a slug never contains
 * `__` — the split point a namespaced tool name is decoded on later — since
 * two adjacent underscores can only arise from two adjacent disallowed
 * characters, which collapse to one.
 *
 * Shared by the MCP create/update schemas below, the create/update routes
 * (uniqueness checks), the MCP test-connection route, and the Tool session's
 * merge site, so every caller agrees on exactly what a given name slugifies
 * to. A name of only disallowed characters slugifies to `""`; the create and
 * update schemas reject that, but this function itself does not, so the
 * one-time data backfill can still resolve pre-existing rows with it.
 */
export const slugifyMcpName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/** Namespace a raw MCP-server tool name under its owning MCP's slug. */
export const namespaceMcpToolName = (slug: string, toolName: string): string =>
  namespaceToolName(slug, toolName);

const mcpBearerTokenRefine = {
  validator: (data: { authType: string; bearerToken?: string }) => {
    if (data.authType === "Bearer") {
      return data.bearerToken && data.bearerToken.length > 0;
    }
    return true;
  },
  params: {
    message: "Bearer token is required when auth type is Bearer",
    path: ["bearerToken"],
  },
};

const mcpNameSlugifiesRefine = {
  validator: (data: { name: string }) => slugifyMcpName(data.name).length > 0,
  params: {
    message:
      "Name must contain at least one letter or digit — it becomes this MCP's tool-namespace prefix",
    path: ["name"],
  },
};

const mcpBaseSchema = z.object({
  id: z.string(),
  organizationId: z.string().optional(),
  workspaceId: z.string().optional(),
  name: z.string().min(3).max(30),
  slug: z.string(),
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional(),
  authType: z.enum(["None", "Bearer", "OAuth"]),
  bearerToken: z.string().optional(),
  oauthClientId: z.string().optional(),
  oauthClientSecret: z.string().optional(),
  oauthRequestedScope: z.string().max(1024).optional(),
  oauthAuthorized: z.boolean().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const mcpOauthCallbackSchema = z.object({
  code: z.string(),
  state: z.string(),
});

export const mcpSchema = mcpBaseSchema
  .refine(mcpBearerTokenRefine.validator, mcpBearerTokenRefine.params)
  .refine(
    (data) => {
      const hasOrg = Boolean(data.organizationId);
      const hasWorkspace = Boolean(data.workspaceId);
      return (hasOrg || hasWorkspace) && !(hasOrg && hasWorkspace);
    },
    {
      message:
        "MCP must have either organizationId or workspaceId, but not both",
      path: ["organizationId"],
    },
  );

export type MCP = z.infer<typeof mcpSchema>;

export const mcpCreateSchema = mcpBaseSchema
  .pick({
    organizationId: true,
    workspaceId: true,
    name: true,
    url: true,
    headers: true,
    authType: true,
    bearerToken: true,
    oauthClientId: true,
    oauthClientSecret: true,
    oauthRequestedScope: true,
  })
  .refine(mcpBearerTokenRefine.validator, mcpBearerTokenRefine.params)
  .refine(mcpNameSlugifiesRefine.validator, mcpNameSlugifiesRefine.params);

export const mcpUpdateSchema = mcpBaseSchema
  .pick({
    name: true,
    url: true,
    headers: true,
    authType: true,
    bearerToken: true,
    oauthClientId: true,
    oauthClientSecret: true,
    oauthRequestedScope: true,
  })
  .refine(mcpBearerTokenRefine.validator, mcpBearerTokenRefine.params)
  .refine(mcpNameSlugifiesRefine.validator, mcpNameSlugifiesRefine.params);

export const mcpTestSchema = mcpBaseSchema
  .pick({
    url: true,
    headers: true,
    authType: true,
    bearerToken: true,
  })
  .extend({
    mcpId: z.string().optional(),
    // The form's current Name, so the test can report the namespaced tool
    // names the MCP will actually contribute once saved (issue #467). Falls
    // back to the stored MCP's name (via `mcpId`) when omitted.
    name: z.string().optional(),
  })
  .refine(mcpBearerTokenRefine.validator, mcpBearerTokenRefine.params)
  .refine(
    (data) => {
      if (data.authType === "OAuth") {
        return data.mcpId && data.mcpId.length > 0;
      }
      return true;
    },
    {
      message: "mcpId is required when auth type is OAuth",
      path: ["mcpId"],
    },
  );

// Attachment — the explicit link that surfaces an org-scoped Shared resource
// inside a specific Workspace (ADR-0007 / #154). Polymorphic over resource type.

export const attachmentResourceTypeSchema = z.enum([
  "mcp",
  "provider",
  "skill",
  "agent",
]);
export type AttachmentResourceType = z.infer<
  typeof attachmentResourceTypeSchema
>;

const attachmentBaseSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  resourceType: attachmentResourceTypeSchema,
  resourceId: z.string(),
  createdAt: z.date(),
});

export const attachmentSchema = attachmentBaseSchema;
export type Attachment = z.infer<typeof attachmentSchema>;

export const attachmentCreateSchema = attachmentBaseSchema.pick({
  resourceType: true,
  resourceId: true,
});

// Blueprint — a named, Organization-scoped macro that, applied to a Workspace,
// creates the Attachments for a chosen set of Shared resources in one step
// (ADR-0008). It is a snapshot, not a living binding: applying stamps
// Attachments at that moment; later edits never disturb already-provisioned
// Workspaces. A Blueprint may only list org-scoped (Shared) resources, so its
// items reuse the Attachment resource-type set.

// The bounds the Blueprint form's counters and `maxLength` attributes read.
export const BLUEPRINT_NAME_MIN_LENGTH = 3;
export const BLUEPRINT_NAME_MAX_LENGTH = 100;
export const BLUEPRINT_DESCRIPTION_MAX_LENGTH = 500;

const blueprintItemSchema = z.object({
  resourceType: attachmentResourceTypeSchema,
  resourceId: z.string(),
});
export type BlueprintItem = z.infer<typeof blueprintItemSchema>;

const blueprintBaseSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z
    .string()
    .min(BLUEPRINT_NAME_MIN_LENGTH)
    .max(BLUEPRINT_NAME_MAX_LENGTH),
  description: z
    .string()
    .max(BLUEPRINT_DESCRIPTION_MAX_LENGTH)
    .nullable()
    .optional(),
  // The Shared resources this Blueprint provisions. Deduped/validated by the
  // route; each must be an org-scoped resource in the same organization.
  items: z.array(blueprintItemSchema),
  // Tier 2 pointer-settings (ADR-0008) stamped onto the Workspace on apply.
  // The three provider references must be org-scoped (Shared) — validated by
  // the route. `context` is the default Workspace context text. All optional;
  // a null/omitted slot leaves the Workspace's existing value untouched.
  taskModelProviderId: z.string().nullable().optional(),
  memoryExtractionProviderId: z.string().nullable().optional(),
  memoryEmbeddingProviderId: z.string().nullable().optional(),
  context: z.string().max(CONTEXT_MAX_LENGTH).nullable().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const blueprintSchema = blueprintBaseSchema;
export type Blueprint = z.infer<typeof blueprintSchema>;

export const blueprintCreateSchema = blueprintBaseSchema.pick({
  name: true,
  description: true,
  items: true,
  taskModelProviderId: true,
  memoryExtractionProviderId: true,
  memoryEmbeddingProviderId: true,
  context: true,
});

export const blueprintUpdateSchema = blueprintBaseSchema.pick({
  name: true,
  description: true,
  items: true,
  taskModelProviderId: true,
  memoryExtractionProviderId: true,
  memoryEmbeddingProviderId: true,
  context: true,
});

// Apply a Blueprint to an existing Workspace (admin only, ad-hoc re-apply).
export const blueprintApplySchema = z.object({
  workspaceId: z.string(),
});

// Provider

export const providerApiModeSchema = z.enum(["chat", "responses"]);

// Per-model configuration attached to a provider. Replaces the old free-form
// `modelIds: string[]`; each enabled model now carries its own metadata.
//
// `passthroughFileTypes` lists the media types (wildcards like `image/*`
// allowed) the model ingests NATIVELY. It is a capability ROUTER, not a
// security allow-list: an attached file whose type is absent is converted to
// text where possible (extracted for PDF/DOCX, see issue #342) — it is never
// blocked for safety. Absent / legacy rows fall back to a provider-type default
// at resolve time on the backend. This object is the home for per-model
// metadata generally, which is why `contextWindow` lands here too.
//
// `maxExtractedTextChars` caps how much text a converted document may inject,
// protecting small local contexts; omitted means the shared
// `DEFAULT_MAX_EXTRACTED_TEXT_CHARS` default. It stays a character budget and
// is deliberately NOT derived from `contextWindow`: the derivation needs a
// chars-per-token ratio, which is exactly the estimate ADR-0018 rejects, and it
// would silently change file handling for every Provider that declares a
// window.
//
// `contextWindow` is the vendor's published TOTAL token capacity for this
// model, declared by an Org Admin because nothing can discover it — see
// ADR-0018. Optional always: where it is absent, the Chat's context meter is
// hidden and nothing else changes.
//
// `maxOutputTokens` caps a SINGLE reply, and unlike `contextWindow` it is
// enforced: it becomes the generation call's output ceiling for every turn on
// this model. Omitted means Platypus sends nothing and the provider's own
// default applies — which is fine for the direct Anthropic provider (it carries
// a per-model fallback table) and silently truncating on Amazon Bedrock, whose
// Converse API omits `inferenceConfig.maxTokens` entirely when nothing is
// passed and falls back to a default far below the model's real ceiling (issue
// #454). Deliberately unbounded above: the only meaningful ceiling is the
// model's own, Platypus cannot know it behind a proxy, and a value the model
// won't take is the vendor's to reject.
//
// The universal wildcard (`*/*` or `*`) is an advanced escape hatch: it sends
// EVERY attached file to the model raw. Values are deliberately NOT validated
// as MIME patterns, so declaring a type the endpoint can't actually ingest is
// the operator's responsibility — e.g. `*/*` on an OpenAI chat-completions
// provider will forward a PDF raw and the endpoint will reject the turn. Use it
// only on endpoints that genuinely accept those types natively.
// --- Model aliases (issue #386, ADR-0017) ---
//
// A Model alias is a stable name a Provider gives one of its enabled models, so
// an Agent or Chat can reference the name instead of the concrete vendor id and
// repointing the alias upgrades every reference at once.
//
// The prefix marks REFERENCES, never DEFINITIONS. `modelIds[].alias` holds the
// bare name (`flagship`); `agent.modelId` / `chat.modelId` hold
// `alias:flagship`. Those two fields are the only places a string could mean
// either thing, so they are the only ones that need marking — and the marking
// makes a stored row readable on its own, without cross-referencing the
// Provider. The prefix is never user-visible: an Org Admin types `flagship`.
export const MODEL_ALIAS_PREFIX = "alias:";

/**
 * A model id that has been resolved against a Provider's `modelIds` — never a
 * raw `agent.modelId` / `chat.modelId`, which may hold an alias reference.
 *
 * Nominal on purpose. Every bug this feature keeps producing has one shape:
 * logic answering "did the model change?" or "which entry is this?" by
 * string-comparing a stored reference. The backend resolver is the sole
 * producer, the capability helpers and the provider SDK require it, so passing
 * an unresolved reference into id-keyed code is a compile error rather than
 * something an audit has to keep catching. Storage types stay plain `string`.
 */
export type ConcreteModelId = string & {
  readonly __concreteModelId: unique symbol;
};

/** Whether a stored model reference names an alias rather than a concrete id. */
export const isAliasReference = (reference: string): boolean =>
  reference.startsWith(MODEL_ALIAS_PREFIX);

/** The bare alias name in a reference, or null when it names a concrete id. */
export const aliasNameFromReference = (reference: string): string | null =>
  isAliasReference(reference)
    ? reference.slice(MODEL_ALIAS_PREFIX.length)
    : null;

/** The narrow shape the reference helpers need — satisfied by `ModelConfig`. */
type AliasableModel = { id: string; alias?: string };

/** The reference a picker submits for an entry: its alias if it has one. */
export const modelReferenceFor = (model: AliasableModel): string =>
  model.alias ? `${MODEL_ALIAS_PREFIX}${model.alias}` : model.id;

/** The label an alias-aware picker shows for an entry. */
export const modelLabelFor = (model: AliasableModel): string =>
  model.alias ?? model.id;

/**
 * Resolve a stored reference to the `modelIds` ENTRY it names.
 *
 * Entry-based rather than string-based so that aliasing an already-referenced
 * model doesn't silently break selection: a stored bare `gpt-4` keeps matching
 * the entry now labelled `flagship`, and `alias:flagship` matches the same
 * entry. Alias names compare case-insensitively (the namespace rule below
 * guarantees at most one match); concrete ids compare exactly, because they are
 * case-sensitive vendor strings. An alias reference NEVER falls back to a
 * like-named concrete id — that ambiguity is what the prefix exists to prevent.
 */
export const findModelEntry = <T extends AliasableModel>(
  models: readonly T[],
  reference: string,
): T | undefined => {
  const aliasName = aliasNameFromReference(reference);
  if (aliasName !== null) {
    const folded = aliasName.toLowerCase();
    return models.find((m) => m.alias?.toLowerCase() === folded);
  }
  return models.find((m) => m.id === reference);
};

/**
 * Resolve a stored reference to the concrete model id it names — the SOLE
 * producer of `ConcreteModelId`, shared by the backend and frontend resolvers
 * so the brand has exactly one mint. `undefined` means the reference names
 * nothing this Provider has, which callers must treat as a hard error rather
 * than falling back to another model.
 *
 * Takes already-normalized entries because the two sides normalize differently
 * (the backend also fills provider-type passthrough defaults).
 */
export const resolveModelReference = (
  models: readonly AliasableModel[],
  reference: string,
): ConcreteModelId | undefined => {
  const entry = findModelEntry(models, reference);
  return entry ? (entry.id as ConcreteModelId) : undefined;
};

/** What a de-migration rewrote when an alias stopped existing (see ADR-0017). */
export type AliasRepoint = {
  /** The alias name that no longer exists. */
  alias: string;
  /** The concrete id its references were rewritten to. */
  modelId: string;
  agents: number;
  chats: number;
};

/**
 * A Provider pointer-setting: always a concrete model id, never an alias.
 *
 * Schema-enforced rather than conventional. `handleEmbeddingConfigChange`
 * decides whether to null every stored embedding by string-comparing the
 * incoming `embeddingModelId` against the stored one, and the provider form
 * gates its confirmation dialog on the same comparison — an alias would leave
 * that string byte-identical across a repoint, skipping both the invalidation
 * and the warning and leaving vectors from a superseded embedding model in
 * place. Aliasing these three would save no edits anyway: each is referenced by
 * exactly one row, the Provider that defines the alias. See ADR-0017.
 */
const pointerModelIdSchema = z
  .string()
  // Case-insensitive on purpose, unlike `isAliasReference`. That helper reads
  // the exact storage format; this is a GUARD, so it rejects anything that
  // merely looks like a reference — `Alias:flagship` would otherwise slip
  // through as a bogus concrete id and fail the turn far from the typo.
  .refine((value) => !value.toLowerCase().startsWith(MODEL_ALIAS_PREFIX), {
    message: "Must be a concrete model id, not a Model alias",
  });

/**
 * Bounds on a declared Context window (ADR-0018). The floor rejects the number
 * of *thousands* — a `128` meaning 128k — because an under-declaration by three
 * orders of magnitude is indistinguishable from a deliberate one at read time
 * and would cripple every reading taken against it. The ceiling sits well above
 * today's largest published window without leaving the field unbounded.
 *
 * Exported because the documentation contract test pins the numbers the
 * Operator-facing docs quote to these, and the provider form's preset list has
 * to stay inside them.
 */
export const CONTEXT_WINDOW_MIN = 1_000;
export const CONTEXT_WINDOW_MAX = 10_000_000;

/**
 * Tool-result clearing (ADR-0018 Notes, issue #524).
 *
 * The core tool names whose results are large, disposable, and safe to clear
 * from what a model call receives once Context occupancy crosses the
 * threshold below. Deny by default: a new core tool is NOT clearable until
 * added here explicitly, which is the safe direction and so needs no
 * announcement.
 *
 * Excludes anything that mutates state (`fsWrite`, `fsEdit`, `shellExec`),
 * sub-Agent delegation (its result is the point of the call, not disposable
 * page content), and `loadSkill` (its result is instructions the model is
 * meant to keep following, not data to discard).
 *
 * This is the core half of clearability, not the whole of it: an MCP tool
 * whose server declares `readOnlyHint` is also clearable (ADR-0021, issue
 * #626), resolved separately by the Tool session and combined with this set
 * at the one place both are consulted — `isClearableToolName` in
 * `apps/backend/src/runs/tool-result-clearing.ts`.
 */
export const CLEARABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "web_search",
  "read_url",
  "fetchUrl",
  "fsRead",
  "fsList",
]);

/**
 * The fraction of the declared Context window at which Tool-result clearing
 * engages. Read against the total window, not the total less the Output
 * ceiling — see the ADR-0018 Notes.
 */
export const TOOL_RESULT_CLEARING_THRESHOLD = 0.7;

/** How many of the most recent clearable tool results survive a clearing pass. */
export const TOOL_RESULT_CLEARING_KEEP_RECENT = 4;

/**
 * A Context occupancy reading as it is stored on an assistant message
 * (`ChatMessageMetadata.contextOccupancy`): the input-token count the vendor
 * reported for the last model call of a turn, and that call's output count.
 *
 * Both figures are the vendor's own. Nothing here is estimated, and no reading
 * is ever synthesised where a Provider reported no usage (ADR-0018).
 */
export type ContextOccupancyReading = {
  inputTokens: number;
  outputTokens: number | null;
};

/**
 * The size the NEXT model call starts at, given the last one's reading:
 * everything that call was sent, plus the reply it produced, because a Chat
 * re-sends its Transcript in full and that reply is now part of it.
 *
 * Distinct from Context occupancy itself, which is one call's input count and
 * is what a retrospective display (a Trigger run's stats) should show. This is
 * the forward-looking figure, and the one to show anywhere a reader is about to
 * send — the composer's meter — or anywhere a decision is being made about the
 * call that has not happened yet: Tool-result clearing's gate on a turn's first
 * call.
 *
 * ADR-0018 anticipated this derivation ("makes the next turn's starting size
 * derivable exactly") without naming it; it lives here rather than in either
 * app because both compute it and a silent disagreement between them shows up
 * as a meter contradicting the clearing it is supposed to explain.
 *
 * `null`/absent output means the Provider reported an input count and no output
 * one. The reply's tokens are then unknown, not zero, so this reads low by
 * however many they were — the same conservative direction as an under-declared
 * window, and the only alternative would be estimating them.
 */
export const nextTurnOccupancy = (
  reading: ContextOccupancyReading | null | undefined,
): number | undefined =>
  reading ? reading.inputTokens + (reading.outputTokens ?? 0) : undefined;

export const modelConfigSchema = z.object({
  id: z.string().min(1),
  // The bare alias name. Absent means the model is referenced by its id.
  // Whitespace is trimmed; the remaining name must be non-empty and must not
  // itself look like a reference (no `alias:alias:foo`).
  alias: z
    .string()
    .trim()
    .min(1, "Alias cannot be empty")
    .refine((value) => !value.toLowerCase().startsWith(MODEL_ALIAS_PREFIX), {
      message: `Alias cannot begin with "${MODEL_ALIAS_PREFIX}"`,
    })
    .optional(),
  passthroughFileTypes: z.array(z.string()).default([]),
  maxExtractedTextChars: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  contextWindow: z
    .number()
    .int()
    .min(CONTEXT_WINDOW_MIN)
    .max(CONTEXT_WINDOW_MAX)
    .optional(),
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;

// Provider `modelIds` payload schema. Accepts the new per-model objects and,
// for backward compatibility with clients/rows predating per-model config, a
// bare `string[]`; bare strings coerce to objects with an empty
// `passthroughFileTypes` (defaults are applied on the backend at resolve time).
export const modelIdsSchema = z
  .array(z.union([z.string().min(1), modelConfigSchema]))
  .min(1, "At least one model is required")
  .transform((items) =>
    items.map((item) =>
      typeof item === "string"
        ? { id: item, passthroughFileTypes: [] as string[] }
        : item,
    ),
  )
  // Aliases and concrete ids share one flat namespace per Provider. Because the
  // `alias:` prefix is hidden in the UI, an alias named after a real model id
  // would render a second, identical-looking picker option pointing somewhere
  // else entirely. Compared case-insensitively (the maintainer's call on #386):
  // two options differing only in case read as duplicates to a human.
  //
  // A whole-array invariant, so it cannot live on `modelConfigSchema`, and it
  // sits after the `.transform()` so it sees normalized objects — which also
  // means the provider form and the API validation get it for free.
  //
  // Only alias-vs-alias and alias-vs-id are checked. Duplicate concrete ids
  // stay legal here and are collapsed by `dedupeModelConfigs` on the route, as
  // they were before aliases existed.
  .superRefine((models, ctx) => {
    const idsFolded = new Set(models.map((m) => m.id.toLowerCase()));
    const seenAliases = new Set<string>();
    models.forEach((model, index) => {
      if (!model.alias) return;
      const folded = model.alias.toLowerCase();
      const clashes = seenAliases.has(folded) || idsFolded.has(folded);
      if (!clashes) {
        seenAliases.add(folded);
        return;
      }
      ctx.addIssue({
        code: "custom",
        path: [index, "alias"],
        message: `Alias "${model.alias}" duplicates another model's alias or id`,
      });
    });
  });

// --- Model file-capability helpers (issue #328) ---
//
// Framework-agnostic and dependency-free, so both the backend gate and the
// frontend warning import the SAME logic instead of maintaining mirrored
// copies. Provider-type strings are accepted loosely (`string`) so callers on
// either side can pass their own provider shape.

// Provider types that ingest documents (images + PDF) natively.
const NATIVE_FILE_PROVIDER_TYPES: ReadonlySet<string> = new Set([
  "Anthropic",
  "Google",
  "Bedrock",
]);

/**
 * The passthrough set a model inherits when it declares none. Native-file
 * providers, and OpenAI on the Responses API, take images and PDFs; OpenAI
 * chat-completions endpoints get the images-only floor.
 *
 * OpenRouter (and any future aggregator / unknown type) fronts heterogeneous
 * models whose capabilities vary per model — many are text-only — so a single
 * provider-type floor can't be right. It defaults to accepting nothing
 * natively: an undeclared model then rejects binaries at the gate (a clean 400
 * before persist, never a raw image forwarded to a text model that would fail
 * and brick the chat on replay). Operators opt each vision model in with an
 * explicit `image/*`; text-like files are still inlined regardless. See #328.
 */
export const defaultPassthroughFileTypes = (provider: {
  providerType: string;
  apiMode?: string;
}): string[] => {
  if (NATIVE_FILE_PROVIDER_TYPES.has(provider.providerType)) {
    return ["image/*", "application/pdf"];
  }
  if (provider.providerType === "OpenAI") {
    return provider.apiMode !== "chat"
      ? ["image/*", "application/pdf"]
      : ["image/*"];
  }
  return [];
};

/**
 * Extensions whose bytes are plain text (source, config, data, markup). Used
 * to decide the text-vs-binary split by the file's real nature rather than the
 * unreliable browser-supplied media type. Binary document formats
 * (pdf/docx/xlsx/pptx) are deliberately absent — those are extracted rather
 * than inlined (see `EXTRACTABLE_DOCUMENT_EXTENSIONS`).
 */
export const TEXT_LIKE_EXTENSIONS: ReadonlySet<string> = new Set([
  "txt",
  "text",
  "md",
  "markdown",
  "mdx",
  "rst",
  "log",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "properties",
  "xml",
  "html",
  "htm",
  "svg",
  "css",
  "scss",
  "sass",
  "less",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "scala",
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "cs",
  "php",
  "swift",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "sql",
  "graphql",
  "gql",
  "proto",
  "dockerfile",
  "makefile",
  "gitignore",
  "editorconfig",
  "lua",
  "pl",
  "pm",
  "r",
  "jl",
  "dart",
  "vue",
  "svelte",
  "tf",
  "hcl",
]);

/**
 * The metadata every file-classification decision is made from. Deliberately
 * just the browser-supplied pair — the same shape a `file` message part, an
 * upload, and a stored attachment all reduce to.
 */
export type FileMetadata = { mediaType?: string; filename?: string };

/** A filename's lower-cased extension, or `""` when it has none. */
export const fileExtension = (filename: string | undefined): string => {
  const base = (filename ?? "").split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

/** Whether a filename's extension is a known plain-text/code/config format. */
export const isTextLikeExtension = (filename: string | undefined): boolean =>
  TEXT_LIKE_EXTENSIONS.has(fileExtension(filename));

/**
 * Whether `mediaType` matches any pattern. A pattern may be exact
 * (`application/pdf`), a subtype wildcard ("image slash star"), or the
 * universal wildcard. Case-insensitive; media-type parameters are ignored.
 */
export const mediaTypeMatches = (
  mediaType: string | undefined,
  patterns: string[],
): boolean => {
  if (!mediaType || patterns.length === 0) return false;
  const type = mediaType.split(";")[0].trim().toLowerCase();
  return patterns.some((pattern) => {
    const p = pattern.trim().toLowerCase();
    if (p === "*/*" || p === "*") return true;
    if (p.endsWith("/*")) return type.startsWith(p.slice(0, -1));
    return type === p;
  });
};

/**
 * Binary document formats the backend can convert to text (issue #342). Kept
 * deliberately narrow — one extractor per format, no OCR. PPTX/XLSX may follow.
 * The backend picks its extractor from this same table, so the classification
 * and the extraction can never disagree about what is extractable.
 */
export type ExtractableDocumentFormat = "pdf" | "docx";

const EXTRACTABLE_DOCUMENTS: ReadonlyArray<{
  format: ExtractableDocumentFormat;
  extensions: readonly string[];
  mediaTypes: readonly string[];
}> = [
  { format: "pdf", extensions: ["pdf"], mediaTypes: ["application/pdf"] },
  {
    format: "docx",
    extensions: ["docx"],
    mediaTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
  },
];

/**
 * Which extractable format a file is, or `null` for none. Matches on extension
 * OR declared media type, because either can be the reliable half: the OS may
 * tag a `.pdf` as `application/octet-stream`, and a file arriving from a paste
 * buffer may carry a media type but no name. Extension wins when both are known
 * — it survives the media-type lottery that motivated #328.
 */
export const extractableDocumentFormat = (
  file: FileMetadata,
): ExtractableDocumentFormat | null => {
  const ext = fileExtension(file.filename);
  for (const entry of EXTRACTABLE_DOCUMENTS) {
    if (ext && entry.extensions.includes(ext)) return entry.format;
  }
  for (const entry of EXTRACTABLE_DOCUMENTS) {
    if (mediaTypeMatches(file.mediaType, [...entry.mediaTypes])) {
      return entry.format;
    }
  }
  return null;
};

/**
 * Default cap on the characters a single extracted document may inject. Sized
 * to stay well inside a modest local context (~12k tokens) while still carrying
 * a normal report; operators raise or lower it per model with
 * `maxExtractedTextChars`.
 */
export const DEFAULT_MAX_EXTRACTED_TEXT_CHARS = 50_000;

/**
 * The effective character cap for a declared (or absent) per-model value. One
 * place decides what a missing, zero, or otherwise nonsense value means, so the
 * schema's `.int().positive()` and the runtime can't drift: a cap is a guard
 * rail, and must never resolve to something that drops the whole document.
 */
export const resolveExtractedTextCap = (declared?: number): number =>
  typeof declared === "number" && Number.isFinite(declared) && declared > 0
    ? declared
    : DEFAULT_MAX_EXTRACTED_TEXT_CHARS;

export type FileClassification = "passthrough" | "text" | "extract" | "reject";

/**
 * Classify a file from metadata shared by the frontend and backend. The
 * backend can additionally provide its byte-sniff result when content is
 * available.
 *
 * `extract` is checked after `text` — the two sets never overlap, but the
 * ordering makes the precedence explicit: native ingestion beats extraction,
 * and extraction is only ever the branch a `reject` would otherwise have taken.
 */
export const classifyFile = (
  file: FileMetadata,
  passthroughFileTypes: string[],
  contentLooksBinary = false,
): FileClassification => {
  if (mediaTypeMatches(file.mediaType, passthroughFileTypes)) {
    return "passthrough";
  }
  if (isTextLikeExtension(file.filename) && !contentLooksBinary) {
    return "text";
  }
  if (extractableDocumentFormat(file)) {
    return "extract";
  }
  return "reject";
};

/**
 * The three-valued `searchSource` a Provider row stores (ADR-0014) —
 * replaces the `nativeSearchEnabled` switch + `webBackend` select, which
 * fought over the same slot ("this provider's own tool, a plugin backend, or
 * neither" was two fields answering one question). `"none"` and `"native"`
 * are the two reserved literals; anything else is a Web-search backend
 * Contribution's `backend` discriminator.
 */
export const SEARCH_SOURCE_NONE = "none";
export const SEARCH_SOURCE_NATIVE = "native";

// The bound the Provider form's `maxLength` attribute reads.
export const PROVIDER_SECURITY_GUARDRAILS_MAX_LENGTH = 8000;

const providerBaseSchema = z.object({
  id: z.string(),
  organizationId: z.string().optional(),
  workspaceId: z.string().optional(),
  name: z.string().min(3).max(32),
  providerType: z.enum([
    "OpenAI",
    "OpenRouter",
    "Bedrock",
    "Google",
    "Anthropic",
  ]),
  apiKey: z.string().min(1),
  region: z
    .string()
    .regex(/^[a-z]{2}-[a-z]+-\d+$/, "Invalid AWS region format")
    .optional(),
  baseUrl: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  extraBody: z.record(z.string(), z.unknown()).optional(),
  organization: z.string().optional(),
  project: z.string().optional(),
  apiMode: providerApiModeSchema.default("responses"),
  // Which of "no search" / this provider's own tool / a plugin Web-search
  // backend serves the chat search toggle (ADR-0014). Replaces the old
  // `nativeSearchEnabled` + `webBackend` pair — a switch and
  // a select cannot both gate the same slot without one of them being
  // unreachable-false from the other. `SEARCH_SOURCE_NATIVE` is offered only
  // when `providerHasNativeSearch`; any other non-reserved value is a backend
  // discriminator, not validated against the registry here — the registry is
  // a backend-runtime concern, and a stale id degrades to no search tools
  // plus a warn-log rather than blocking the form.
  //
  // Defaults to `SEARCH_SOURCE_NATIVE` — the old defaults (`nativeSearchEnabled:
  // true`, no `webBackend`) resolved to native whenever the provider was
  // capable, so a brand-new Provider keeps that behaviour.
  //
  // Length-bounded because the value is free text that reaches a log line on
  // every searching turn; 200 is far above a namespaced plugin id
  // (`@scope/name.backend`). `""` normalises to `SEARCH_SOURCE_NONE` so the
  // column holds one representation of "no search", not two.
  searchSource: z
    .string()
    .max(200)
    .default(SEARCH_SOURCE_NATIVE)
    .transform((value) => (value === "" ? SEARCH_SOURCE_NONE : value)),
  // Free-text system-prompt security directives appended LAST (recency) to
  // every run on this provider — including sub-agent runs resolved to this
  // provider. Provider-scoped because guard strength is a property of the model
  // endpoint: weaker self-hosted models warrant more guarding than frontier
  // ones. Append-only and non-suppressible — the escape hatch is to point the
  // agent at a different provider. A prompt-level FLOOR, not a guarantee.
  // Length-bounded against abuse; nullable so existing providers are unchanged.
  securityGuardrails: z
    .string()
    .max(PROVIDER_SECURITY_GUARDRAILS_MAX_LENGTH)
    .nullable()
    .optional(),
  modelIds: modelIdsSchema,
  // The three pointer-settings hold a concrete model id and never an alias —
  // enforced on the FIELD, not in a `providerSchema.refine`, because
  // `providerCreateSchema` / `providerUpdateSchema` are `.pick()`ed off this
  // base and so never see `providerSchema`'s refinements. The API routes
  // validate with those two, which is exactly where the guard has to bite.
  taskModelId: pointerModelIdSchema,
  memoryExtractionModelId: pointerModelIdSchema,
  embeddingModelId: pointerModelIdSchema.nullable().optional(),
  embeddingDimensions: z
    .number()
    .int()
    .min(256)
    .max(4096)
    .nullable()
    .optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const providerSchema = providerBaseSchema
  .refine(
    (data) => {
      if (data.providerType === "Bedrock") {
        return data.region && data.region.length > 0;
      }
      return true;
    },
    {
      message: "Region is required for Bedrock providers",
      path: ["region"],
    },
  )
  .refine(
    (data) => {
      const hasOrg = Boolean(data.organizationId);
      const hasWorkspace = Boolean(data.workspaceId);
      return (hasOrg || hasWorkspace) && !(hasOrg && hasWorkspace);
    },
    {
      message:
        "Provider must have either organizationId or workspaceId, but not both",
      path: ["organizationId"],
    },
  );

export type Provider = z.infer<typeof providerSchema>;

/**
 * Whether a provider can search the web on its own, with no Web-search backend
 * configured — i.e. whether the AI SDK exposes a provider-native `web_search`
 * tool for this provider type and API mode.
 *
 * Lives here, beside `defaultPassthroughFileTypes`, for the same reason: the
 * backend's injection gate and the frontend's toggle visibility must agree, and
 * mirrored copies of a capability table drift. Bedrock has no native search, and
 * OpenAI's lives on the Responses API only — which is why an OpenAI-compatible
 * endpoint on the chat API (vLLM, llama.cpp, LiteLLM) returns false and gains
 * search only through a Web-search backend (ADR-0014).
 *
 * `default` covers unknown provider types conservatively: a type this table has
 * never seen cannot be assumed to carry a native tool.
 */
export const providerHasNativeSearch = (
  provider: Pick<Provider, "providerType" | "apiMode">,
): boolean => {
  switch (provider.providerType) {
    case "Anthropic":
    case "Google":
    case "OpenRouter":
      return true;
    case "OpenAI":
      return provider.apiMode !== "chat";
    default:
      return false;
  }
};

/**
 * Whether a URL supplied by a Web-search backend may be presented — passed to the
 * model in a `web_search` result, and rendered as a clickable Sources pill.
 *
 * The backend's egress guard covers **model-supplied** URLs going *into*
 * `read_url`. This covers **backend-supplied** URLs coming *out* of `web_search`,
 * which nothing else checks: a `javascript:` or `data:` href in a clickable pill
 * is a live hole, and dropping the entry also keeps garbage out of the context
 * window.
 *
 * Shared rather than mirrored for `providerHasNativeSearch`'s reason, with more
 * at stake: core drops an unpresentable result before the model sees it and the
 * frontend re-checks before it reaches the DOM, so the two are belt-and-braces on
 * one rule. Two copies of a security predicate drift, and the frontend's is the
 * copy that decides what becomes an `href`.
 *
 * Scheme only. Length is a separate, caller-owned concern — core bounds a result
 * URL by `MAX_URL_CHARS` before this runs, because the treatment differs (a URL
 * cut to fit is a broken link, so it is dropped, not truncated).
 */
export const isPresentableUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * The `toolMetadata` key that marks a `web_search` / `read_url` Tool as one core
 * built around a Web-search backend's executors (ADR-0014).
 *
 * The tool *name* cannot identify one: provider-native search registers under the
 * same `web_search` key on OpenAI, OpenRouter and Anthropic, so a native call and
 * a plugin call produce message parts of the same type. The AI SDK's
 * `providerExecuted` separates them wherever a provider sets it — Anthropic and
 * OpenAI do, on the first chunk — but that flag belongs to the provider package,
 * and `@openrouter/ai-sdk-provider` never sets it, so a discriminator built on it
 * alone is only as good as each vendor's plumbing.
 *
 * Core owns the Tool it builds, so it marks it: the AI SDK propagates a Tool's
 * `metadata` onto the tool call's `toolMetadata` and from there onto UI message
 * parts, which persist with the message. Nothing a provider executes can carry
 * this key, on any vendor, whether or not that vendor reports itself.
 *
 * Shared here rather than mirrored for `isPresentableUrl`'s reason: the frontend
 * reads what the backend writes, and two copies of the key drift.
 *
 * Also stamped on the web-fetch Tool set's `fetchUrl` (issue #525): that tool is
 * not a Web-search backend, but it is core-built in exactly the same sense — a
 * fixed, model-facing contract with no vendor behind it — and needs the same
 * "core built this, don't guess" signal so its page reads join the Web tool
 * block instead of dumping page content into the Transcript.
 */
export const WEB_BACKEND_TOOL_MARKER = "platypusWebBackend";

/**
 * The `toolMetadata` key holding the outcome of backend-side web-tool
 * normalization (issue #525): one shape for a native provider search, a
 * Web-search backend's search or page read, and the web-fetch Tool set's
 * `fetchUrl` — computed once, server-side (`normalizeWebToolPart` in
 * `apps/backend/src/runs/web-tool-normalize.ts`), and read by the frontend
 * with no vendor knowledge of its own.
 *
 * Absent means "not a recognised web tool" — the part renders on the generic
 * tool renderer. Never inferred from the payload on the frontend; the backend
 * is the only place that decides this.
 */
export const WEB_TOOL_NORMALIZED_KEY = "platypusNormalizedWebTool";

/**
 * A web tool's result, reduced to what every reader needs regardless of which
 * search ran, which page-reader fetched it, or which vendor answered — the
 * uniform presentation issue #525 asks for. Supersedes the frontend's old,
 * search-only `WebSearchSource`-adjacent shape, which could not express a
 * page read at all.
 *
 * `kind` follows what actually happened, not which tool was called: OpenAI's
 * hosted web tool covers a search, an opened page, and an in-page find under
 * one tool name, and only its output says which occurred.
 *
 * `results` is present only for a Web-search backend's search — the one case
 * whose entries may still be lifted into the Sources row (ADR-0014). Native
 * search deliberately omits it: the Provider emits its own citation parts for
 * the pages it actually used, and lifting a native search's full result list
 * as well would fill the row with pages the reply never cited. `resultCount`
 * carries a native search's raw, unfiltered count instead — the entries the
 * vendor returned, not the subset that could become a pill.
 */
export type NormalizedWebToolResult =
  | {
      kind: "search";
      query?: string;
      results?: Array<{ title: string; url: string; snippet?: string }>;
      resultCount?: number;
      answer?: string;
      error?: string;
    }
  | {
      kind: "page";
      url?: string;
      contentType?: string;
      contentLength?: number;
      truncated?: boolean;
      error?: string;
    }
  | {
      kind: "find";
      url?: string;
      pattern?: string;
      error?: string;
    };

/**
 * Tool names a Provider may execute natively for web search, keyed by the part
 * type the AI SDK produces (`tool-<name>`). Read alongside `providerExecuted`,
 * never alone: `google_search` is in this set purely because Google's native
 * search registers under a name the old shape-guessing discriminator never
 * saw, not because the name alone proves anything.
 */
export const WEB_TOOL_KNOWN_NATIVE_SEARCH_NAMES: ReadonlySet<string> = new Set([
  "web_search",
  "google_search",
]);

export const providerCreateSchema = providerBaseSchema.pick({
  organizationId: true,
  workspaceId: true,
  name: true,
  providerType: true,
  apiKey: true,
  region: true,
  baseUrl: true,
  headers: true,
  extraBody: true,
  organization: true,
  project: true,
  apiMode: true,
  searchSource: true,
  securityGuardrails: true,
  modelIds: true,
  taskModelId: true,
  memoryExtractionModelId: true,
  embeddingModelId: true,
  embeddingDimensions: true,
});

// Sandbox

// Workspace-default environment variables merged into every sandbox shell.exec
// call. See docs/adr/0004-sandbox-workspace-default-env-vars.md for rationale,
// threat model, and merge precedence.
export const SANDBOX_ENV_MAX_ENTRIES = 64;
export const SANDBOX_ENV_MAX_VALUE_BYTES = 4 * 1024;
const SANDBOX_ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const sandboxEnvSchema = z
  .record(
    z.string().regex(SANDBOX_ENV_KEY_REGEX, {
      message:
        "env keys must match POSIX env var rules: [A-Za-z_][A-Za-z0-9_]*",
    }),
    z
      .string()
      .refine(
        (v) => Buffer.byteLength(v, "utf8") <= SANDBOX_ENV_MAX_VALUE_BYTES,
        {
          message: `env values must be at most ${SANDBOX_ENV_MAX_VALUE_BYTES} bytes`,
        },
      ),
  )
  .refine((rec) => Object.keys(rec).length <= SANDBOX_ENV_MAX_ENTRIES, {
    message: `at most ${SANDBOX_ENV_MAX_ENTRIES} env entries are allowed`,
  });

const sandboxBaseSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string().min(3).max(30),
  backend: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
  // Two-tier env (ADR-0004 amendment, ADR-0006): adminEnv is org-admin-managed
  // and wins at merge; userEnv is workspace-owner-managed. See the sandbox
  // route for field-level authorization and the admin/user collision check.
  adminEnv: sandboxEnvSchema.optional(),
  userEnv: sandboxEnvSchema.optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const sandboxSchema = sandboxBaseSchema;

export type Sandbox = z.infer<typeof sandboxSchema>;

export const sandboxCreateSchema = sandboxBaseSchema.pick({
  workspaceId: true,
  name: true,
  backend: true,
  config: true,
  credentials: true,
  adminEnv: true,
  userEnv: true,
});

export const sandboxUpdateSchema = sandboxBaseSchema.pick({
  name: true,
  backend: true,
  config: true,
  credentials: true,
  adminEnv: true,
  userEnv: true,
});

// Invitation

export const invitationStatusSchema = z.enum([
  "pending",
  "accepted",
  "declined",
  "expired",
]);

export const invitationSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  organizationId: z.string(),
  invitedBy: z.string(),
  status: invitationStatusSchema,
  // Optional name for the Workspace provisioned when this invitation is
  // accepted (ADR-0008). When null/omitted the accept handler defaults it to
  // "<member name>'s Workspace".
  workspaceName: z
    .string()
    .min(WORKSPACE_NAME_MIN_LENGTH)
    .max(WORKSPACE_NAME_MAX_LENGTH)
    .nullable()
    .optional(),
  // The ordered set of Blueprints applied to the provisioned Workspace on
  // accept (ADR-0009). Stored in the invitation_blueprint junction; surfaced
  // here in `position` order on reads.
  blueprintIds: z.array(z.string()).optional(),
  // Redemption token minted with the invitation (ADR-0019, #549). Nullable
  // only at the column level for pre-existing rows a backfill migration
  // hasn't reached yet; every invitation created through the API has one.
  token: z.string().nullable().optional(),
  expiresAt: z.date(),
  createdAt: z.date(),
});

export type Invitation = z.infer<typeof invitationSchema>;

export const invitationCreateSchema = invitationSchema.pick({
  email: true,
  workspaceName: true,
  blueprintIds: true,
});

export const invitationListItemSchema = invitationSchema.extend({
  organizationName: z.string().optional(),
  invitedByName: z.string().optional(),
});

export type InvitationListItem = z.infer<typeof invitationListItemSchema>;

// Response of the unauthenticated invitation-link resolution endpoint
// (#549, ADR-0019): only what a bare "choose a password" form needs to
// look legitimate rather than like a phishing page. Never the inviter,
// the Blueprint set, or the Workspace name.
export const invitationLinkResolutionSchema = z.object({
  email: z.string().email(),
  organizationName: z.string(),
});

export type InvitationLinkResolution = z.infer<
  typeof invitationLinkResolutionSchema
>;

// Body of the unauthenticated invitation-link registration endpoint
// (#549, ADR-0019). The email is deliberately absent: it comes only from
// the token server-side, matching the frontend's non-editable email field.
export const invitationRedemptionRegisterSchema = z.object({
  name: z.string().min(1),
  password: z.string().min(8),
});

export type InvitationRedemptionRegister = z.infer<
  typeof invitationRedemptionRegisterSchema
>;

// Response of the invitation-link redemption and accept endpoints (#549,
// ADR-0019): where the accept landed the new member, so the client can send
// them straight to the Workspace it just provisioned.
export const invitationAcceptResultSchema = z.object({
  message: z.string(),
  organizationId: z.string(),
  workspaceId: z.string(),
});

export type InvitationAcceptResult = z.infer<
  typeof invitationAcceptResultSchema
>;

// Response of the unauthenticated sign-up availability endpoint (#550,
// ADR-0019): whether public sign-up is open, or an Invitation link is the only
// way to an account. The one thing the frontend reads to decide whether to
// offer Sign up.
export const signUpAvailabilitySchema = z.object({
  open: z.boolean(),
});

export type SignUpAvailability = z.infer<typeof signUpAvailabilitySchema>;

export const providerUpdateSchema = providerBaseSchema.pick({
  name: true,
  providerType: true,
  apiKey: true,
  region: true,
  baseUrl: true,
  headers: true,
  extraBody: true,
  organization: true,
  project: true,
  apiMode: true,
  searchSource: true,
  securityGuardrails: true,
  modelIds: true,
  taskModelId: true,
  memoryExtractionModelId: true,
  embeddingModelId: true,
  embeddingDimensions: true,
});

export type ProviderUpdateData = z.infer<typeof providerUpdateSchema>;

// Organization Member

export const organizationMemberSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  role: z.enum(["admin", "member"]),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const organizationMemberUpdateSchema = organizationMemberSchema.pick({
  role: true,
});

export const organizationMemberWithUserSchema = organizationMemberSchema.extend(
  {
    user: z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      image: z.string().nullable().optional(),
    }),
  },
);

// Combined Org Member for List

export const orgMemberListItemSchema = organizationMemberWithUserSchema.extend({
  isSuperAdmin: z.boolean(),
});

export type OrgMemberListItem = z.infer<typeof orgMemberListItemSchema>;

export const orgMemberListSchema = z.object({
  results: z.array(orgMemberListItemSchema),
});

// Context

export const contextSchema = z.object({
  id: z.string(),
  userId: z.string(),
  workspaceId: z.string().nullable().optional(),
  content: z.string().min(0).max(1000),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Context = z.infer<typeof contextSchema>;

export const contextCreateSchema = contextSchema.pick({
  workspaceId: true,
  content: true,
});

export const contextUpdateSchema = contextSchema.pick({
  content: true,
});

// Memory Daily Summary

export const memoryDailySummarySchema = z.object({
  id: z.string(),
  userId: z.string(),
  workspaceId: z.string(),
  summaryDate: z.string(), // YYYY-MM-DD
  summary: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// Webhook Event (defined here so trigger schemas can reference it). Each
// event's payload is declared beside the name in `webhookEventDataSchemas` at
// the foot of this file, where the Card and Notification pieces it builds on
// are already in scope.

export const webhookEventSchema = z.enum([
  "notification.created",
  "notification.updated",
  "notification.read",
  "notification.dismissed",
  "card.created",
  "card.updated",
  "card.moved",
  "card.deleted",
]);

export type WebhookEvent = z.infer<typeof webhookEventSchema>;

// Trigger

export const triggerTypeSchema = z.enum(["cron", "event"]);

export type TriggerType = z.infer<typeof triggerTypeSchema>;

export const cronTriggerConfigSchema = z.object({
  cronExpression: z.string().min(1),
  timezone: z.string().default("UTC"),
  isOneOff: z.boolean().default(false),
});

export type CronTriggerConfig = z.infer<typeof cronTriggerConfigSchema>;

export const eventTriggerFiltersSchema = z.object({
  boardId: z.string().optional(),
  columnId: z.string().optional(),
  changedFields: z.array(z.string()).optional(),
});

export const eventTriggerConfigSchema = z.object({
  events: z.array(webhookEventSchema).min(1),
  filters: eventTriggerFiltersSchema.optional(),
});

export type EventTriggerConfig = z.infer<typeof eventTriggerConfigSchema>;

// The bounds the Trigger form's `maxLength` / `min` / `max` attributes read.
export const TRIGGER_NAME_MIN_LENGTH = 1;
export const TRIGGER_NAME_MAX_LENGTH = 100;
export const TRIGGER_DESCRIPTION_MAX_LENGTH = 500;
export const TRIGGER_INSTRUCTION_MAX_LENGTH = 10000;
export const TRIGGER_MAX_RUNS_TO_KEEP_MIN = 1;
export const TRIGGER_MAX_RUNS_TO_KEEP_MAX = 1000;

export const triggerSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  type: triggerTypeSchema,
  name: z.string().min(TRIGGER_NAME_MIN_LENGTH).max(TRIGGER_NAME_MAX_LENGTH),
  description: z
    .string()
    .max(TRIGGER_DESCRIPTION_MAX_LENGTH)
    .nullable()
    .optional(),
  instruction: z.string().min(1).max(TRIGGER_INSTRUCTION_MAX_LENGTH),
  enabled: z.boolean().default(true),
  maxRunsToKeep: z
    .number()
    .int()
    .min(TRIGGER_MAX_RUNS_TO_KEEP_MIN)
    .max(TRIGGER_MAX_RUNS_TO_KEEP_MAX)
    .default(50),
  search: z.boolean().default(false),
  // Whether a firing composes the `<memories>` block. Off by default: a
  // headless run should not have a system prompt that drifts with the
  // Workspace User's unrelated interactive-chat activity.
  includeMemories: z.boolean().default(false),
  config: z.union([cronTriggerConfigSchema, eventTriggerConfigSchema]),
  lastRunAt: z.date().nullable().optional(),
  nextRunAt: z.date().nullable().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Trigger = z.infer<typeof triggerSchema>;

export const triggerCreateSchema = triggerSchema.pick({
  workspaceId: true,
  agentId: true,
  type: true,
  name: true,
  description: true,
  instruction: true,
  enabled: true,
  maxRunsToKeep: true,
  search: true,
  includeMemories: true,
  config: true,
});

export const triggerUpdateSchema = triggerSchema
  .pick({
    name: true,
    description: true,
    instruction: true,
    enabled: true,
    maxRunsToKeep: true,
    agentId: true,
    search: true,
    includeMemories: true,
    type: true,
    config: true,
  })
  .partial();

// Trigger Run

export const triggerRunStatusSchema = z.enum([
  "pending",
  "running",
  "success",
  "failed",
  "cancelled",
  "suppressed",
]);

export type TriggerRunStatus = z.infer<typeof triggerRunStatusSchema>;

/**
 * How each run status is written wherever a User reads one — the row badge and
 * the page's status filter. Keyed by the status type, so a status added to the
 * domain fails the typecheck rather than rendering raw.
 *
 * `suppressed` is not a run that failed: it is a firing the run-rate breaker
 * dropped before it started, so the Trigger did not run against that record at
 * all (see the Operator reference on Triggers). Nor is `cancelled`: someone
 * stopped the run, nothing faulted, so it carries no error message (#647).
 */
export const TRIGGER_RUN_STATUS_LABELS: Record<TriggerRunStatus, string> = {
  pending: "Pending",
  running: "Running",
  success: "Success",
  failed: "Failed",
  cancelled: "Cancelled",
  suppressed: "Suppressed",
};

/**
 * A Provider's cached-input breakdown of an input-token figure (issue #734):
 * how many of the input tokens were READ from cache, and how many the model
 * calls caused to be WRITTEN. A breakdown of the figure, never subtracted from
 * it.
 *
 * Both keys optional following the rule `contextOccupancy` sets below: a
 * Provider that reports nothing persists no key, because `0` reads as a
 * measurement rather than "unknown".
 *
 * The single declaration of the pair — spread into `triggerRunStatsSchema` and
 * inferred as `CachedInputTokens`, so the schema and the type cannot drift
 * apart (issue #745).
 */
export const cachedInputTokensShape = {
  /**
   * Cached input tokens READ across the model calls, summed the same way the
   * input figure beside it is. A breakdown of that figure, which already
   * includes cached tokens — never subtracted.
   */
  cacheReadTokens: z.number().int().nonnegative().optional(),
  /**
   * Cached input tokens the model calls caused to be WRITTEN, summed as above.
   * Only present where the Provider reports a write count — OpenAI and Google
   * cache implicitly and report none.
   */
  cacheWriteTokens: z.number().int().nonnegative().optional(),
};

export type CachedInputTokens = z.infer<
  z.ZodObject<typeof cachedInputTokensShape>
>;

export const triggerRunStatsSchema = z.object({
  steps: z.number(),
  toolCalls: z.array(z.object({ name: z.string(), count: z.number() })),
  // Cross-step SUMS, and billing figures: every step's usage folded together.
  // They are rendered on the trigger runs page and deliberately keep that
  // meaning — occupancy gets its own field below rather than reinterpreting a
  // number an Operator already reads (ADR-0018).
  inputTokens: z.number(),
  outputTokens: z.number(),
  ...cachedInputTokensShape,
  /**
   * How full the model's context got: the input tokens reported for the FINAL
   * step of the run, which is the whole conversation as last sent. A last
   * value, never a sum. Absent where the Provider reported no usage — occupancy
   * is then unknown and nothing is estimated.
   */
  contextOccupancy: z.number().int().nonnegative().optional(),
  /**
   * Set only when the run stopped because it hit the model's output ceiling.
   * Absent rather than `false` so an untruncated run stores nothing, matching
   * the equivalent marker on a Chat message.
   */
  truncatedByTokenLimit: z.literal(true).optional(),
  /**
   * Set only when the run's model loop was stopped because it reached its step
   * ceiling with the model still asking to continue. Absent rather than `false`,
   * the same way the output-ceiling marker above is, and never set for a run the
   * no-progress detector halted — that stop is reported as a failure with its
   * own message.
   */
  stoppedAtStepLimit: z.literal(true).optional(),
});

export type TriggerRunStats = z.infer<typeof triggerRunStatsSchema>;

export const triggerRunSchema = z.object({
  id: z.string(),
  triggerId: z.string(),
  status: triggerRunStatusSchema,
  eventType: z.string().nullable().optional(),
  eventData: z.any().nullable().optional(),
  startedAt: z.date(),
  completedAt: z.date().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  stats: triggerRunStatsSchema.nullable().optional(),
  createdAt: z.date(),
});

export const triggerRunListSchema = z.object({
  results: z.array(triggerRunSchema),
});

/**
 * A run as the workspace-wide Trigger runs list returns it: the run plus the
 * name of the Trigger it belongs to. The list mixes runs from every Trigger, so
 * a row that only carried `triggerId` could not name its own Trigger; the
 * listing endpoint already joins the trigger table to scope the query, so the
 * name comes back with it rather than being resolved a second time client-side.
 */
export const triggerRunWithTriggerSchema = triggerRunSchema.extend({
  triggerName: z.string(),
});

export type TriggerRunWithTrigger = z.infer<typeof triggerRunWithTriggerSchema>;

export const triggerRunWithTriggerListSchema = z.object({
  results: z.array(triggerRunWithTriggerSchema),
});

export type TriggerRunWithTriggerList = z.infer<
  typeof triggerRunWithTriggerListSchema
>;

// Run events (#647, ADR-0023)

/**
 * What kind of thing a **Run event** records. Shape only: a tool call, a
 * stretch of reasoning, a stretch of generated text, or a delegation to a
 * Sub-Agent (whose own events nest beneath it). There is deliberately no
 * `step` — the SDK exposes only a step-finish hook, so a step event could not
 * exist when its children are emitted — and no `failed`: failure is a status.
 */
export const runEventTypeSchema = z.enum([
  "tool-call",
  "reasoning",
  "text",
  "delegate",
]);

export type RunEventType = z.infer<typeof runEventTypeSchema>;

/**
 * How a Run event stands. `running` while open; one of the three terminal
 * values once it ended, or once the run it belongs to ended without it.
 */
export const runEventStatusSchema = z.enum([
  "running",
  "completed",
  "error",
  "cancelled",
]);

export type RunEventStatus = z.infer<typeof runEventStatusSchema>;

/**
 * The most of an error string a Run event keeps, in bytes. The one content a
 * Run event carries at all (ADR-0023); anything longer is stored as a preview
 * that says so, never silently shortened.
 */
export const RUN_EVENT_ERROR_MAX_BYTES = 1024;

/**
 * A failed event's error, capped. `truncated` is explicit — and `originalBytes`
 * is kept — so a reader can tell a short error from a clipped one. The preview
 * is cut on a character boundary, never inside a UTF-8 codepoint.
 */
export const runEventErrorSchema = z.object({
  message: z.string(),
  truncated: z.boolean(),
  originalBytes: z.number().int().nonnegative(),
});

export type RunEventError = z.infer<typeof runEventErrorSchema>;

/**
 * A durable, timestamped record of one thing that happened during a Trigger
 * run — see **Run event** in `CONTEXT.md`. Carries what it was, when it
 * started, how long it took and how it ended; never what it said (ADR-0023).
 *
 * `startedAt` is an absolute wall-clock instant in epoch milliseconds, so it
 * lines up with backend logs and a delegate's events need no rebasing;
 * `durationMs` comes from a monotonic clock and is absent while the event is
 * still open. `parentEventId` is null for an event of the root run and the id
 * of the `delegate` event for an event of that delegate's run. `seq` is the
 * run's monotonic insertion order, kept for incremental polling; display order
 * is by `startedAt`.
 */
export const runEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  parentEventId: z.string().nullable(),
  seq: z.number().int().nonnegative(),
  type: runEventTypeSchema,
  toolName: z.string().nullable().optional(),
  startedAt: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  status: runEventStatusSchema,
  error: runEventErrorSchema.nullable().optional(),
  /**
   * Set when the run hit its event ceiling while this event was open, so
   * children it would have had were dropped. Marked on the node — not only on
   * the run — so a delegate whose children were dropped does not render as a
   * delegate that did nothing.
   */
  childrenTruncated: z.boolean().optional(),
});

export type RunEvent = z.infer<typeof runEventSchema>;

/**
 * A run as its detail page reads it: the list row's shape plus the two fields
 * the list never selects — the final assistant text, and whether the run's
 * timeline was cut at the event ceiling.
 */
export const triggerRunDetailSchema = triggerRunWithTriggerSchema.extend({
  finalText: z.string().nullable().optional(),
  eventsTruncated: z.boolean(),
});

export type TriggerRunDetail = z.infer<typeof triggerRunDetailSchema>;

/**
 * The run detail endpoint's response. `events` is the **Run timeline** —
 * ordered by `seq` on the wire; the renderer orders by start time — and may be
 * a partial page when the caller asked only for events past a sequence number.
 */
export const triggerRunDetailResponseSchema = z.object({
  run: triggerRunDetailSchema,
  events: z.array(runEventSchema),
});

export type TriggerRunDetailResponse = z.infer<
  typeof triggerRunDetailResponseSchema
>;

// Notification

export const notificationSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  title: z.string().nullable().optional(),
  body: z.string().min(1).max(2000),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Notification = z.infer<typeof notificationSchema>;

export const notificationListItemSchema = notificationSchema.extend({
  agentName: z.string(),
  agentAvatarUrl: z.string().optional(),
  isRead: z.boolean(),
});

export type NotificationListItem = z.infer<typeof notificationListItemSchema>;

// Kanban Label Colors

export const KANBAN_LABEL_COLORS = [
  { name: "Red", value: "#ef4444" },
  { name: "Orange", value: "#f97316" },
  { name: "Amber", value: "#f59e0b" },
  { name: "Green", value: "#22c55e" },
  { name: "Teal", value: "#14b8a6" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Indigo", value: "#6366f1" },
  { name: "Purple", value: "#a855f7" },
  { name: "Pink", value: "#ec4899" },
  { name: "Gray", value: "#6b7280" },
] as const;

// Kanban Label

export const kanbanLabelSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(50),
  color: z.enum(
    KANBAN_LABEL_COLORS.map((c) => c.value) as [string, ...string[]],
  ),
});

export type KanbanLabel = z.infer<typeof kanbanLabelSchema>;

// Kanban Board

export const kanbanBoardSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  labels: z.array(kanbanLabelSchema).default([]),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type KanbanBoard = z.infer<typeof kanbanBoardSchema>;

export const kanbanBoardCreateSchema = kanbanBoardSchema.pick({
  name: true,
  description: true,
  labels: true,
});

// `labels` is optional on update (rather than defaulting to `[]`) so an update
// that only touches the name or description leaves the board's labels — and the
// cards referencing them — alone.
export const kanbanBoardUpdateSchema = kanbanBoardSchema
  .pick({
    name: true,
    description: true,
  })
  .extend({
    labels: z.array(kanbanLabelSchema).optional(),
  });

// Kanban Column

export const kanbanColumnSchema = z.object({
  id: z.string(),
  boardId: z.string(),
  name: z.string().min(1).max(100),
  position: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type KanbanColumn = z.infer<typeof kanbanColumnSchema>;

export const kanbanColumnCreateSchema = kanbanColumnSchema.pick({
  name: true,
});

export const kanbanColumnUpdateSchema = kanbanColumnSchema.pick({
  name: true,
});

export const kanbanColumnReorderSchema = z.object({
  columnIds: z.array(z.string()).min(1),
});

// Kanban Card Priority

export const kanbanCardPrioritySchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "urgent",
]);

export type KanbanCardPriority = z.infer<typeof kanbanCardPrioritySchema>;

export const KANBAN_CARD_PRIORITIES = [
  { value: "none" as const, label: "None", color: null },
  { value: "low" as const, label: "Low", color: "#3b82f6" },
  { value: "medium" as const, label: "Medium", color: "#f59e0b" },
  { value: "high" as const, label: "High", color: "#f97316" },
  { value: "urgent" as const, label: "Urgent", color: "#ef4444" },
] as const;

// Kanban Card Assignee

export const kanbanCardAssigneeSchema = z.object({
  type: z.enum(["user", "agent"]),
  id: z.string(),
});

export type KanbanCardAssignee = z.infer<typeof kanbanCardAssigneeSchema>;

export const kanbanResolvedAssigneeSchema = z.object({
  type: z.enum(["user", "agent"]),
  id: z.string(),
  name: z.string(),
  image: z.string().nullable().optional(),
});

export type KanbanResolvedAssignee = z.infer<
  typeof kanbanResolvedAssigneeSchema
>;

// Kanban Card

export const kanbanCardSchema = z.object({
  id: z.string(),
  columnId: z.string(),
  title: z.string().min(1).max(200),
  body: z.string().nullable().optional(),
  labelIds: z.array(z.string()).default([]),
  assignees: z.array(kanbanCardAssigneeSchema).max(1).default([]),
  dueDate: z.string().nullable().optional(),
  priority: kanbanCardPrioritySchema.default("none"),
  position: z.number(),
  createdByUserId: z.string().nullable().optional(),
  createdByAgentId: z.string().nullable().optional(),
  lastEditedByUserId: z.string().nullable().optional(),
  lastEditedByAgentId: z.string().nullable().optional(),
  createdByName: z.string().nullable().optional(),
  lastEditedByName: z.string().nullable().optional(),
  resolvedAssignees: z.array(kanbanResolvedAssigneeSchema).optional(),
  commentCount: z.number().int().default(0),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type KanbanCard = z.infer<typeof kanbanCardSchema>;

export const kanbanCardCreateSchema = kanbanCardSchema.pick({
  title: true,
  body: true,
  labelIds: true,
  assignees: true,
  dueDate: true,
  priority: true,
});

export const kanbanCardUpdateSchema = kanbanCardSchema
  .pick({
    title: true,
    body: true,
    labelIds: true,
    assignees: true,
    dueDate: true,
    priority: true,
  })
  .partial();

export const kanbanCardMoveSchema = z.object({
  columnId: z.string(),
  afterCardId: z.string().nullable(),
  /**
   * The column the card was in when the caller last read it. When given, the
   * move applies only while the card is still there, so a caller working from
   * a stale view cannot overwrite a move made in the meantime.
   */
  expectedColumnId: z.string().optional(),
});

// Kanban Card Comment

export const kanbanCardCommentSchema = z.object({
  id: z.string(),
  cardId: z.string(),
  body: z.string().min(1),
  createdByUserId: z.string().nullable().optional(),
  createdByAgentId: z.string().nullable().optional(),
  createdByName: z.string().nullable().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const kanbanCardCommentCreateSchema = kanbanCardCommentSchema.pick({
  body: true,
});

export const kanbanCardCommentUpdateSchema = kanbanCardCommentSchema
  .pick({ body: true })
  .partial();

export type KanbanCardComment = z.infer<typeof kanbanCardCommentSchema>;

// Kanban Card history

/**
 * The most recent entries a Card's history keeps. Older entries are dropped,
 * never archived: a Card history is working context for whoever acts on the
 * Card next, not an audit trail (ADR-0024). Deliberately a constant rather
 * than an Operator setting — the cap is what keeps the concept honest.
 */
export const KANBAN_CARD_HISTORY_LIMIT = 50;

/**
 * A Label or Column as it stood when the entry was written. The id keeps the
 * entry joinable while the referent exists; the name is what makes it readable
 * after a rename or a deletion — and for a history the snapshot is the more
 * correct of the two, since a Column renamed last month did not have its
 * current name when the Card entered it.
 */
export const kanbanCardHistoryRefSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export type KanbanCardHistoryRef = z.infer<typeof kanbanCardHistoryRefSchema>;

/**
 * One field's movement within a single write. `body` is the deliberate
 * exception and carries no values at all: it is unbounded Markdown, and
 * storing it twice per edit is the capture ADR-0024 refuses. A body edit is
 * legible ("who touched it, when") but not recoverable.
 */
export const kanbanCardHistoryChangeSchema = z.discriminatedUnion("field", [
  z.object({
    field: z.literal("title"),
    before: z.string().nullable(),
    after: z.string().nullable(),
  }),
  z.object({ field: z.literal("body") }),
  z.object({
    field: z.literal("priority"),
    before: kanbanCardPrioritySchema,
    after: kanbanCardPrioritySchema,
  }),
  z.object({
    field: z.literal("dueDate"),
    before: z.string().nullable(),
    after: z.string().nullable(),
  }),
  z.object({
    field: z.literal("assignees"),
    before: z.array(kanbanCardAssigneeSchema),
    after: z.array(kanbanCardAssigneeSchema),
  }),
  z.object({
    field: z.literal("labelIds"),
    before: z.array(kanbanCardHistoryRefSchema),
    after: z.array(kanbanCardHistoryRefSchema),
  }),
  z.object({
    field: z.literal("columnId"),
    before: kanbanCardHistoryRefSchema.nullable(),
    after: kanbanCardHistoryRefSchema,
  }),
]);

export type KanbanCardHistoryChange = z.infer<
  typeof kanbanCardHistoryChangeSchema
>;

/**
 * One write addressed to a Card, as its history remembers it. A `created`
 * entry carries the single `columnId` change that brought the Card into
 * existence; an `updated` entry carries every field that actually moved.
 */
export const kanbanCardHistoryEntrySchema = z.object({
  id: z.string(),
  cardId: z.string(),
  kind: z.enum(["created", "updated"]),
  changes: z.array(kanbanCardHistoryChangeSchema).default([]),
  actorUserId: z.string().nullable().optional(),
  actorAgentId: z.string().nullable().optional(),
  actorName: z.string().nullable().optional(),
  createdAt: z.date(),
});

// Kanban Board State (nested response)

export const kanbanBoardStateSchema = z.object({
  board: kanbanBoardSchema,
  columns: z.array(
    kanbanColumnSchema.extend({
      cards: z.array(kanbanCardSchema),
    }),
  ),
});

export type KanbanBoardState = z.infer<typeof kanbanBoardStateSchema>;

// Webhook

export const webhookSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string().min(1).max(100),
  url: z
    .string()
    .url()
    .refine((url) => url.startsWith("https://"), {
      message: "Webhook URL must use HTTPS",
    }),
  signingSecret: z.string(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  enabled: z.boolean(),
  events: z.array(webhookEventSchema).min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Webhook = z.infer<typeof webhookSchema>;

export const webhookCreateSchema = z.object({
  name: z.string().min(1).max(100),
  url: z
    .string()
    .url()
    .refine((url) => url.startsWith("https://"), {
      message: "Webhook URL must use HTTPS",
    }),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  enabled: z.boolean().optional(),
  events: z.array(webhookEventSchema).min(1).optional(),
});

export const webhookUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  url: z
    .string()
    .url()
    .refine((url) => url.startsWith("https://"), {
      message: "Webhook URL must use HTTPS",
    })
    .optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  enabled: z.boolean().optional(),
  events: z.array(webhookEventSchema).min(1).optional(),
});

// Dashboard

export const rglLayoutItemSchema = z.object({
  i: z.string(),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
});

export type RglLayoutItem = z.infer<typeof rglLayoutItemSchema>;

// Widget types, their data contracts and the schemas derived from them live in
// their own module — the registry is the single source for what Widget types
// exist. Re-exported here so `@platypus/schemas` stays one import specifier.
export * from "./widget-registry.ts";

export const dashboardSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().max(500).nullable().optional(),
  desktopLayout: z.array(rglLayoutItemSchema),
  mobileLayout: z.array(rglLayoutItemSchema),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Dashboard = z.infer<typeof dashboardSchema>;

export const dashboardCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(500).nullable().optional(),
});

export const dashboardUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).nullable().optional(),
  desktopLayout: z.array(rglLayoutItemSchema).optional(),
  mobileLayout: z.array(rglLayoutItemSchema).optional(),
});

// --- Webhook event payloads --------------------------------------------------

/**
 * What each **Webhook event** carries as its `data`.
 *
 * The name and the payload are one value ({@link WebhookEventPayload}), so a
 * producer cannot pair `card.deleted` with a Notification's shape and the
 * dispatcher does not have to guess where the entity id is (#811, #840).
 *
 * Declared here rather than beside {@link webhookEventSchema} only because the
 * Card and Notification pieces these build on are defined further down the
 * file. The enum points here.
 *
 * The record-carrying events spread the stored row whole, so their schemas are
 * loose: a row that gains a column keeps parsing, and what an external
 * subscriber receives on the wire is unchanged. These describe the value handed
 * to `dispatchEvent`, not the delivered body — a delivery is that value
 * JSON-encoded, so a `z.date()` here reaches a subscriber as an ISO string. What is pinned is the part the
 * dispatcher, the Trigger filters and the docs all read — the entity id, the
 * Board and Column, and `card.updated`'s `changedFields`.
 *
 * The Card record is spelled out rather than derived from
 * {@link kanbanCardSchema}, which describes the Card an API response carries:
 * the row a dispatch spreads holds `dueDate` and the timestamps as `Date`s, and
 * none of the read-side fields the board view joins on (`createdByName`,
 * `resolvedAssignees`, `commentCount`).
 */
const webhookCardRecordShape = {
  id: z.string(),
  boardId: z.string(),
  columnId: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  labelIds: z.array(z.string()),
  assignees: z.array(kanbanCardAssigneeSchema),
  dueDate: z.date().nullable(),
  priority: kanbanCardPrioritySchema,
  position: z.number(),
  createdByUserId: z.string().nullable(),
  createdByAgentId: z.string().nullable(),
  lastEditedByUserId: z.string().nullable(),
  lastEditedByAgentId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
};

const webhookNotificationRecordShape = {
  id: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  title: z.string().nullable(),
  body: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
};

/**
 * Every event's payload, keyed by event name. The `satisfies` is the whole
 * enforcement: an event added to {@link webhookEventSchema} without a payload
 * here fails to compile, and a payload for an event that does not exist fails
 * the same way.
 */
export const webhookEventDataSchemas = {
  "notification.created": z.looseObject(webhookNotificationRecordShape),
  "notification.updated": z.looseObject(webhookNotificationRecordShape),
  /**
   * Two legitimate shapes: marking one Notification read names it, while
   * "mark all as read" names the set it covered in a single event rather than
   * one event per Notification.
   */
  "notification.read": z.union([
    z.object({ notificationId: z.string(), userId: z.string() }),
    z.object({
      notificationIds: z.array(z.string()),
      userId: z.string(),
      bulk: z.literal(true),
    }),
  ]),
  /** The id and nothing else — a dismissal has nobody to attribute it to. */
  "notification.dismissed": z.object({ notificationId: z.string() }),
  "card.created": z.looseObject(webhookCardRecordShape),
  "card.updated": z.looseObject({
    ...webhookCardRecordShape,
    changedFields: z.array(z.string()),
  }),
  "card.moved": z.looseObject({
    ...webhookCardRecordShape,
    previousColumnId: z.string(),
  }),
  "card.deleted": z.object({
    cardId: z.string(),
    boardId: z.string(),
    columnId: z.string(),
  }),
} satisfies Record<WebhookEvent, z.ZodType>;

/** The `data` the named event carries. */
export type WebhookEventData<E extends WebhookEvent = WebhookEvent> = z.infer<
  (typeof webhookEventDataSchemas)[E]
>;

/** An event and its payload — the value `dispatchEvent` takes. */
export type WebhookEventPayload = {
  [E in WebhookEvent]: { event: E; data: WebhookEventData<E> };
}[WebhookEvent];

/**
 * What an event names: one entity, or a set of them. The debounce bucket and
 * the run-rate breaker both key off this, so an event naming a set says so in
 * its type rather than by failing a chain of probes for keys it never had
 * (#811).
 */
export type WebhookEventEntity =
  { kind: "entity"; id: string } | { kind: "set" };

/** The entity an event names. The one place that knows where the id lives. */
export const webhookEventEntity = (
  payload: WebhookEventPayload,
): WebhookEventEntity => {
  switch (payload.event) {
    case "notification.created":
    case "notification.updated":
    case "card.created":
    case "card.updated":
    case "card.moved":
      return { kind: "entity", id: payload.data.id };
    case "notification.dismissed":
      return { kind: "entity", id: payload.data.notificationId };
    case "notification.read":
      // `bulk` is the flag the two shapes are told apart by — the same one the
      // Webhooks page tells an integrator to branch on.
      return "bulk" in payload.data
        ? { kind: "set" }
        : { kind: "entity", id: payload.data.notificationId };
    case "card.deleted":
      return { kind: "entity", id: payload.data.cardId };
  }
};

/**
 * The value-diff an event reports, where it reports one. Only `card.updated`
 * declares `changedFields`; every other event answers `undefined` rather than
 * each reader deciding for itself what carries a diff.
 */
export const webhookEventChangedFields = (
  payload: WebhookEventPayload,
): string[] | undefined =>
  payload.event === "card.updated" ? payload.data.changedFields : undefined;

/** The Board and Column an event names, where it names them. */
export const webhookEventScope = (
  payload: WebhookEventPayload,
): { boardId?: string; columnId?: string } => {
  switch (payload.event) {
    case "card.created":
    case "card.updated":
    case "card.moved":
    case "card.deleted":
      return { boardId: payload.data.boardId, columnId: payload.data.columnId };
    default:
      return {};
  }
};
