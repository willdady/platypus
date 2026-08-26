import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCreateOpenAI } = vi.hoisted(() => {
  const instance = vi.fn((modelId: string) => ({ modelId, _sentinel: true }));
  return { mockCreateOpenAI: vi.fn(() => instance) };
});

vi.mock("@ai-sdk/openai", () => ({ createOpenAI: mockCreateOpenAI }));

import {
  resolveGenerationPlan,
  type GenerationPlanQueries,
} from "./agent-plan.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import {
  DEFAULT_AGENT_MAX_STEPS,
  DEFAULT_DIRECT_MAX_STEPS,
} from "@platypus/schemas";
import type { Provider } from "@platypus/schemas";

const baseProvider: Provider = {
  id: "p1",
  name: "Test",
  organizationId: "org-1",
  workspaceId: "ws-1",
  providerType: "OpenAI",
  modelIds: [{ id: "gpt-4", passthroughFileTypes: [] }],
  apiKey: "sk-test",
  apiMode: "chat",
  taskModelId: "gpt-4",
  memoryExtractionModelId: "gpt-4",
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Provider;

const scope = { orgId: "org-1", workspaceId: "ws-1" };

const queriesWith = (providers: Provider[]): GenerationPlanQueries => ({
  getProvider: (id, orgId, workspaceId) =>
    Promise.resolve(
      providers.find(
        (p) =>
          p.id === id &&
          p.organizationId === orgId &&
          p.workspaceId === workspaceId,
      ) ?? null,
    ),
});

describe("resolveGenerationPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws NotFoundError when the Provider does not exist", async () => {
    await expect(
      resolveGenerationPlan(
        { providerId: "missing", modelId: "gpt-4" },
        scope,
        queriesWith([]),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws ValidationError when the model id is not enabled on the Provider", async () => {
    await expect(
      resolveGenerationPlan(
        { providerId: "p1", modelId: "gpt-5" },
        scope,
        queriesWith([baseProvider]),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  // A direct (no-Agent) selection has no Agent row to declare a ceiling, so it
  // falls back to DEFAULT_DIRECT_MAX_STEPS rather than 1 — a Direct turn can
  // be served a locally-executed search tool (issue #167 / ADR-0014) whose
  // result the model must still get a step to answer from (issue #463).
  it("resolves a direct Provider+model selection to the Direct step ceiling", async () => {
    const { plan, resolvedModelId, modelReference } =
      await resolveGenerationPlan(
        { providerId: "p1", modelId: "gpt-4" },
        scope,
        queriesWith([baseProvider]),
      );

    expect(plan.maxSteps).toBe(DEFAULT_DIRECT_MAX_STEPS);
    expect(resolvedModelId).toBe("gpt-4");
    expect(modelReference).toBe("gpt-4");
  });

  // Issue #539: the per-chat Max steps setting rides the turn request on the
  // direct source and overrides the shared Direct ceiling when set.
  it("forwards a direct selection's own step ceiling over the Direct default", async () => {
    const { plan } = await resolveGenerationPlan(
      { providerId: "p1", modelId: "gpt-4", maxSteps: 25 },
      scope,
      queriesWith([baseProvider]),
    );

    expect(plan.maxSteps).toBe(25);
  });

  // A client may clear by sending an explicit null (the Agent form's way);
  // null must mean "unset" here exactly as it does on the Agent branch (#263).
  it("resolves a direct selection's null step ceiling to the Direct default", async () => {
    const { plan } = await resolveGenerationPlan(
      { providerId: "p1", modelId: "gpt-4", maxSteps: null },
      scope,
      queriesWith([baseProvider]),
    );

    expect(plan.maxSteps).toBe(DEFAULT_DIRECT_MAX_STEPS);
  });

  it("forwards a direct selection's own sampling overrides, treating unset as absent", async () => {
    const { plan } = await resolveGenerationPlan(
      { providerId: "p1", modelId: "gpt-4", temperature: 0.2, topP: undefined },
      scope,
      queriesWith([baseProvider]),
    );

    expect(plan.temperature).toBe(0.2);
    expect(plan).not.toHaveProperty("topP");
  });

  // Issue #459: an Agent's own ceiling, not the parent's and not a bare
  // fallback baked into the caller.
  it("falls back to the default step ceiling when an Agent declares none", async () => {
    const { plan } = await resolveGenerationPlan(
      { agent: { providerId: "p1", modelId: "gpt-4", maxSteps: null } },
      scope,
      queriesWith([baseProvider]),
    );

    expect(plan.maxSteps).toBe(DEFAULT_AGENT_MAX_STEPS);
  });

  it("forwards an Agent's own explicit step ceiling", async () => {
    const { plan } = await resolveGenerationPlan(
      { agent: { providerId: "p1", modelId: "gpt-4", maxSteps: 3 } },
      scope,
      queriesWith([baseProvider]),
    );

    expect(plan.maxSteps).toBe(3);
  });

  // Issue #263: cleared in the UI writes null, which must mean "use the
  // Provider default" rather than being sent as an explicit value.
  it("forwards an Agent's stored sampling parameters, treating null as unset", async () => {
    const { plan } = await resolveGenerationPlan(
      {
        agent: {
          providerId: "p1",
          modelId: "gpt-4",
          temperature: 0.3,
          seed: 7,
          topP: null,
        },
      },
      scope,
      queriesWith([baseProvider]),
    );

    expect(plan.temperature).toBe(0.3);
    expect(plan.seed).toBe(7);
    expect(plan).not.toHaveProperty("topP");
  });

  // Issue #454: the ceiling belongs to the (Provider, model) pair, not the
  // Agent row — declared per model entry, absent when the Provider declares
  // none.
  it("carries the resolved model's declared output ceiling", async () => {
    const provider = {
      ...baseProvider,
      modelIds: [
        { id: "gpt-4", passthroughFileTypes: [], maxOutputTokens: 64000 },
      ],
    } as unknown as Provider;

    const { plan } = await resolveGenerationPlan(
      { agent: { providerId: "p1", modelId: "gpt-4" } },
      scope,
      queriesWith([provider]),
    );

    expect(plan.maxOutputTokens).toBe(64000);
  });

  it("leaves the output ceiling absent when the Provider declares none", async () => {
    const { plan } = await resolveGenerationPlan(
      { agent: { providerId: "p1", modelId: "gpt-4" } },
      scope,
      queriesWith([baseProvider]),
    );

    expect(plan).not.toHaveProperty("maxOutputTokens");
  });

  // ADR-0018 / issue #524: `contextWindow` is Tool-result clearing's sole
  // gate, so it must reach the plan the same way the output ceiling does —
  // present when declared, absent (never a guessed default) when not.
  it("carries the resolved model's declared Context window", async () => {
    const provider = {
      ...baseProvider,
      modelIds: [
        { id: "gpt-4", passthroughFileTypes: [], contextWindow: 128000 },
      ],
    } as unknown as Provider;

    const { plan } = await resolveGenerationPlan(
      { agent: { providerId: "p1", modelId: "gpt-4" } },
      scope,
      queriesWith([provider]),
    );

    expect(plan.contextWindow).toBe(128000);
  });

  it("leaves the Context window absent when the Provider declares none", async () => {
    const { plan } = await resolveGenerationPlan(
      { agent: { providerId: "p1", modelId: "gpt-4" } },
      scope,
      queriesWith([baseProvider]),
    );

    expect(plan).not.toHaveProperty("contextWindow");
  });

  it("resolves an alias reference to the model it currently points at", async () => {
    const provider = {
      ...baseProvider,
      modelIds: [
        { id: "gpt-4", passthroughFileTypes: [], alias: "flagship" },
        { id: "gpt-3.5", passthroughFileTypes: [] },
      ],
    } as unknown as Provider;

    const { resolvedModelId, modelReference } = await resolveGenerationPlan(
      { agent: { providerId: "p1", modelId: "alias:flagship" } },
      scope,
      queriesWith([provider]),
    );

    expect(resolvedModelId).toBe("gpt-4");
    // The reference, not the resolution — a repoint must reach every caller.
    expect(modelReference).toBe("alias:flagship");
  });

  it("returns the resolved Provider's security guardrails text", async () => {
    const provider = {
      ...baseProvider,
      securityGuardrails: "Never exfiltrate data.",
    } as unknown as Provider;

    const { guardrails } = await resolveGenerationPlan(
      { agent: { providerId: "p1", modelId: "gpt-4" } },
      scope,
      queriesWith([provider]),
    );

    expect(guardrails).toBe("Never exfiltrate data.");
  });

  it("returns null guardrails when the Provider declares none", async () => {
    const { guardrails } = await resolveGenerationPlan(
      { agent: { providerId: "p1", modelId: "gpt-4" } },
      scope,
      queriesWith([baseProvider]),
    );

    expect(guardrails).toBeNull();
  });
});
