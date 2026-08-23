import { z } from "zod";

const kebabCaseRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Organization

export const organizationSchema = z.object({
  id: z.string(),
  name: z.string().min(3).max(30),
  // Free-text organization identity / context, rendered EARLY in the system
  // prompt beside the workspace context as framing — NOT a security control
  // (see the provider `securityGuardrails` field for that). Length-bounded
  // against abuse; nullable so existing orgs are unchanged.
  identityContext: z.string().max(4000).nullable().optional(),
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

export const workspaceSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  ownerId: z.string(),
  name: z
    .string()
    .min(WORKSPACE_NAME_MIN_LENGTH)
    .max(WORKSPACE_NAME_MAX_LENGTH),
  context: z.string().max(1000).nullable().optional(),
  taskModelProviderId: z.string().nullable().optional(),
  memoryExtractionProviderId: z.string().nullable().optional(),
  memoryEmbeddingProviderId: z.string().nullable().optional(),
  maxDailySummaries: z.number().int().min(7).max(365).optional(),
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
    organizationId: true,
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
  messages: z.any().optional(),
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
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Chat = z.infer<typeof chatSchema>;

export const chatSubmitSchema = chatSchema
  .pick({
    id: true,
    workspaceId: true,
    messages: true,
    instructions: true,
    temperature: true,
    topP: true,
    topK: true,
    seed: true,
    presencePenalty: true,
    frequencyPenalty: true,
  })
  .extend({
    agentId: z.string().optional(),
    providerId: z.string().optional(),
    modelId: z.string().optional(),
    search: z.boolean().optional(),
  })
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

export type ChatUpdateData = z.infer<typeof chatUpdateSchema>;

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

export type ChatList = z.infer<typeof chatListSchema>;

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
 * conversation, not a configured workflow, it has no step-limit control in
 * the UI, and — unlike an unattended run — it is never guarded by the
 * no-progress detector. The ceiling itself is the only guard here, so do not
 * raise it to match the Agent default.
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
  name: z.string().min(3).max(30),
  description: z.string().min(1).max(128),
  instructions: z.string().optional(),
  modelId: z.string(),
  // Bounded because the value reaches `stepCountIs(n)`, whose predicate is
  // `steps.length === n`, evaluated only after a step has completed. A `0` (or
  // any negative, or a fraction the integer column would never match) is
  // therefore never equal to a real step count, so the loop runs unbounded —
  // the opposite of the ceiling the operator asked for. `min(1)` matches the
  // `min="1"` the Agent form already puts on the input.
  maxSteps: z.number().int().min(1).optional(),
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
  inputPlaceholder: z.string().max(100).optional(),
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

const skillNameRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
    .min(5)
    .max(64)
    .regex(skillNameRegex, "Skill name must be kebab-case"),
  description: z.string().min(24).max(1024),
  body: z.string().min(48).max(50000),
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
  })
  .extend({
    agentIds: z.array(z.string()).optional(),
  });

export const skillUpdateSchema = skillBaseSchema
  .pick({
    name: true,
    description: true,
    body: true,
  })
  .extend({
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

// MCP

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

const mcpBaseSchema = z.object({
  id: z.string(),
  organizationId: z.string().optional(),
  workspaceId: z.string().optional(),
  name: z.string().min(3).max(30),
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
  .refine(mcpBearerTokenRefine.validator, mcpBearerTokenRefine.params);

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
  .refine(mcpBearerTokenRefine.validator, mcpBearerTokenRefine.params);

export const mcpTestSchema = mcpBaseSchema
  .pick({
    url: true,
    headers: true,
    authType: true,
    bearerToken: true,
  })
  .extend({
    mcpId: z.string().optional(),
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
export type AttachmentCreateData = z.infer<typeof attachmentCreateSchema>;

// Blueprint — a named, Organization-scoped macro that, applied to a Workspace,
// creates the Attachments for a chosen set of Shared resources in one step
// (ADR-0008). It is a snapshot, not a living binding: applying stamps
// Attachments at that moment; later edits never disturb already-provisioned
// Workspaces. A Blueprint may only list org-scoped (Shared) resources, so its
// items reuse the Attachment resource-type set.

const blueprintItemSchema = z.object({
  resourceType: attachmentResourceTypeSchema,
  resourceId: z.string(),
});
export type BlueprintItem = z.infer<typeof blueprintItemSchema>;

const blueprintBaseSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string().min(3).max(100),
  description: z.string().max(500).nullable().optional(),
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
  context: z.string().max(1000).nullable().optional(),
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
export type BlueprintCreateData = z.infer<typeof blueprintCreateSchema>;

export const blueprintUpdateSchema = blueprintBaseSchema.pick({
  name: true,
  description: true,
  items: true,
  taskModelProviderId: true,
  memoryExtractionProviderId: true,
  memoryEmbeddingProviderId: true,
  context: true,
});
export type BlueprintUpdateData = z.infer<typeof blueprintUpdateSchema>;

// Apply a Blueprint to an existing Workspace (admin only, ad-hoc re-apply).
export const blueprintApplySchema = z.object({
  workspaceId: z.string(),
});
export type BlueprintApplyData = z.infer<typeof blueprintApplySchema>;

// Provider

export const providerApiModeSchema = z.enum(["chat", "responses"]);

export type ProviderApiMode = z.infer<typeof providerApiModeSchema>;

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
 * meant to keep following, not data to discard). MCP and third-party plugin
 * tools are out of scope until read-only hints are surfaced (#626).
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
  securityGuardrails: z.string().max(8000).nullable().optional(),
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
 */
export const WEB_BACKEND_TOOL_MARKER = "platypusWebBackend";

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

export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

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

export type OrganizationMember = z.infer<typeof organizationMemberSchema>;

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

export type OrganizationMemberWithUser = z.infer<
  typeof organizationMemberWithUserSchema
>;

// Combined Org Member for List

export const orgMemberListItemSchema = organizationMemberWithUserSchema.extend({
  isSuperAdmin: z.boolean(),
});

export type OrgMemberListItem = z.infer<typeof orgMemberListItemSchema>;

export const orgMemberListSchema = z.object({
  results: z.array(orgMemberListItemSchema),
});

export type OrgMemberList = z.infer<typeof orgMemberListSchema>;

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

export type MemoryDailySummary = z.infer<typeof memoryDailySummarySchema>;

// Webhook Event (defined here so trigger schemas can reference it)

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

export type EventTriggerFilters = z.infer<typeof eventTriggerFiltersSchema>;

export const eventTriggerConfigSchema = z.object({
  events: z.array(webhookEventSchema).min(1),
  filters: eventTriggerFiltersSchema.optional(),
});

export type EventTriggerConfig = z.infer<typeof eventTriggerConfigSchema>;

export const triggerSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  type: triggerTypeSchema,
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  instruction: z.string().min(1).max(10000),
  enabled: z.boolean().default(true),
  maxRunsToKeep: z.number().int().min(1).max(1000).default(50),
  search: z.boolean().default(false),
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
]);

export type TriggerRunStatus = z.infer<typeof triggerRunStatusSchema>;

export const triggerRunStatsSchema = z.object({
  steps: z.number(),
  toolCalls: z.array(z.object({ name: z.string(), count: z.number() })),
  // Cross-step SUMS, and billing figures: every step's usage folded together.
  // They are rendered on the trigger runs page and deliberately keep that
  // meaning — occupancy gets its own field below rather than reinterpreting a
  // number an Operator already reads (ADR-0018).
  inputTokens: z.number(),
  outputTokens: z.number(),
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

export type TriggerRun = z.infer<typeof triggerRunSchema>;

export const triggerRunListSchema = z.object({
  results: z.array(triggerRunSchema),
});

export type TriggerRunList = z.infer<typeof triggerRunListSchema>;

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

export const notificationCreateSchema = notificationSchema.pick({
  title: true,
  body: true,
});

export const notificationUpdateSchema = notificationSchema
  .pick({
    title: true,
    body: true,
  })
  .partial();

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

export const widgetTypeSchema = z.enum([
  "metric",
  "text",
  "image",
  "weather",
  "line-chart",
  "pie-chart",
  "bar-chart",
]);

export type WidgetType = z.infer<typeof widgetTypeSchema>;

export const metricWidgetDataSchema = z.object({
  value: z.number(),
  label: z.string(),
  unit: z.string().optional(),
  change: z.string().optional(),
});

export type MetricWidgetData = z.infer<typeof metricWidgetDataSchema>;

export const textWidgetDataSchema = z.object({
  content: z.string(),
});

export type TextWidgetData = z.infer<typeof textWidgetDataSchema>;

export const imageWidgetDataSchema = z.object({
  url: z.string(),
});

export type ImageWidgetData = z.infer<typeof imageWidgetDataSchema>;

export const weatherConditionSchema = z.enum([
  "clear-day",
  "clear-night",
  "partly-cloudy-day",
  "partly-cloudy-night",
  "cloudy",
  "rain",
  "sleet",
  "snow",
  "wind",
  "fog",
  "thunderstorm",
]);

export type WeatherCondition = z.infer<typeof weatherConditionSchema>;

export const weatherWidgetDataSchema = z.object({
  location: z.string(),
  date: z.string(),
  condition: weatherConditionSchema,
  description: z.string().max(100),
  temperatureC: z.number(),
  highC: z.number(),
  lowC: z.number(),
  unit: z.enum(["C", "F"]),
});

export type WeatherWidgetData = z.infer<typeof weatherWidgetDataSchema>;

export const lineChartSeriesSchema = z.object({
  label: z.string().describe("Series name shown in the legend"),
  values: z
    .array(z.number().nullable())
    .describe("One value per category; null renders as a gap in the line"),
});

export const lineChartWidgetDataSchema = z.object({
  yAxisLabel: z
    .string()
    .optional()
    .describe('Optional Y-axis label, e.g. "Revenue ($)"'),
  categories: z
    .array(z.string())
    .describe("X-axis category labels, one per data point"),
  series: z
    .array(lineChartSeriesSchema)
    .min(1)
    .describe("One or more data series; each becomes a line on the chart"),
});

export type LineChartWidgetData = z.infer<typeof lineChartWidgetDataSchema>;

export const pieChartSegmentSchema = z.object({
  label: z.string().describe("Segment name shown in the legend and tooltip"),
  value: z.number().describe("Absolute numeric value for this segment"),
});

export const pieChartWidgetDataSchema = z.object({
  centerLabel: z
    .string()
    .max(20)
    .optional()
    .describe(
      'Large text displayed in the donut hole, e.g. "$12,400" (max 20 chars)',
    ),
  centerSubLabel: z
    .string()
    .max(30)
    .optional()
    .describe('Smaller text below centerLabel, e.g. "Total" (max 30 chars)'),
  segments: z
    .array(pieChartSegmentSchema)
    .min(1)
    .describe("One or more segments making up the donut chart"),
});

export type PieChartWidgetData = z.infer<typeof pieChartWidgetDataSchema>;

export const barChartSeriesSchema = z.object({
  label: z.string().describe("Series name shown in the legend"),
  values: z
    .array(z.number().nullable())
    .describe("One value per category; null renders as a gap in the chart"),
});

export const barChartWidgetDataSchema = z.object({
  yAxisLabel: z
    .string()
    .optional()
    .describe('Optional Y-axis label, e.g. "Revenue ($)"'),
  categories: z
    .array(z.string())
    .describe("X-axis category labels, one per group of bars"),
  series: z
    .array(barChartSeriesSchema)
    .min(1)
    .describe("One or more data series; each becomes a set of bars"),
});

export type BarChartWidgetData = z.infer<typeof barChartWidgetDataSchema>;

export const widgetDataSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("metric"), data: metricWidgetDataSchema }),
  z.object({ type: z.literal("text"), data: textWidgetDataSchema }),
  z.object({ type: z.literal("image"), data: imageWidgetDataSchema }),
  z.object({ type: z.literal("weather"), data: weatherWidgetDataSchema }),
  z.object({ type: z.literal("line-chart"), data: lineChartWidgetDataSchema }),
  z.object({ type: z.literal("pie-chart"), data: pieChartWidgetDataSchema }),
  z.object({ type: z.literal("bar-chart"), data: barChartWidgetDataSchema }),
]);

export const widgetSchema = z.object({
  id: z.string(),
  dashboardId: z.string(),
  type: widgetTypeSchema,
  title: z.string(),
  data: z
    .union([
      metricWidgetDataSchema,
      textWidgetDataSchema,
      imageWidgetDataSchema,
      weatherWidgetDataSchema,
      lineChartWidgetDataSchema,
      pieChartWidgetDataSchema,
      barChartWidgetDataSchema,
    ])
    .nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Widget = z.infer<typeof widgetSchema>;

export const widgetCreateSchema = z.object({
  type: widgetTypeSchema,
  title: z.string().min(1).max(200),
});

export const widgetUpdateDataSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("metric"),
    title: z.string().min(1).max(200).optional(),
    data: metricWidgetDataSchema,
  }),
  z.object({
    type: z.literal("text"),
    title: z.string().min(1).max(200).optional(),
    data: textWidgetDataSchema,
  }),
  z.object({
    type: z.literal("image"),
    title: z.string().min(1).max(200).optional(),
    data: imageWidgetDataSchema,
  }),
  z.object({
    type: z.literal("weather"),
    title: z.string().min(1).max(200).optional(),
    data: weatherWidgetDataSchema,
  }),
  z.object({
    type: z.literal("line-chart"),
    title: z.string().min(1).max(200).optional(),
    data: lineChartWidgetDataSchema,
  }),
  z.object({
    type: z.literal("pie-chart"),
    title: z.string().min(1).max(200).optional(),
    data: pieChartWidgetDataSchema,
  }),
  z.object({
    type: z.literal("bar-chart"),
    title: z.string().min(1).max(200).optional(),
    data: barChartWidgetDataSchema,
  }),
]);

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
