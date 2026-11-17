import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import type { Agent, Blueprint, Skill, Trigger } from "@platypus/schemas";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
} from "@/test/list-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { AgentsList } from "./agents-list";
import { BlueprintsList } from "./blueprints-list";
import { SkillsList } from "./skills-list";
import { TriggerList } from "./trigger-list";

// --- Fixtures ----------------------------------------------------------------

const blueprint = { id: "b1", name: "Starter", items: [] } as unknown as Blueprint;
const agent = {
  id: "a1",
  name: "Triage",
  toolSetIds: [],
  skillIds: [],
  subAgentIds: [],
} as unknown as Agent;
const skill = { id: "s1", name: "Triage skill" } as unknown as Skill;
const trigger = {
  id: "t1",
  name: "Nightly triage",
  triggerType: "event",
  config: { events: [] },
} as unknown as Trigger;

/**
 * A failed revalidation, with the rows it already returned still held — the
 * state a list reaches when a background refresh fails after a successful
 * first load.
 */
const failedRefresh = { error: new Error("500"), data: { results: [] } };
function held(read: unknown[], fix: typeof failedRefresh) {
  return { ...fix, data: { results: read } };
}

beforeEach(resetListHarness);

// --- Tests -------------------------------------------------------------------

describe("a list keeps its chrome when a refresh fails with rows held", () => {
  it("keeps the Blueprints footer", async () => {
    mockScopedSWR(
      { "/blueprints": held([blueprint], failedRefresh) },
    );

    await renderList(<BlueprintsList orgId="org1" />);

    expect(screen.getByText("Starter")).toBeInTheDocument();
    expect(screen.getByText(/Create blueprint/)).toBeInTheDocument();
  });

  it("keeps the Agents footer", async () => {
    mockScopedSWR(
      {
        "/agents": held([agent], failedRefresh),
        "/providers": [],
        "/tools": [],
      },
    );

    await renderList(<AgentsList orgId="org1" workspaceId="ws1" />);

    expect(screen.getByText("Triage")).toBeInTheDocument();
    expect(screen.getByText(/Create agent/)).toBeInTheDocument();
  });

  it("keeps the Skills toolbar", async () => {
    mockScopedSWR(
      { "/skills": held([skill], failedRefresh), "/agents": [] },
    );

    await renderList(<SkillsList orgId="org1" workspaceId="ws1" />);

    expect(screen.getByText("Triage skill")).toBeInTheDocument();
    expect(screen.getByLabelText("Search skills")).toBeInTheDocument();
  });

  it("keeps the Triggers toolbar", async () => {
    mockScopedSWR(
      { "/triggers": held([trigger], failedRefresh), "/agents": [] },
    );

    await renderList(<TriggerList orgId="org1" workspaceId="ws1" />);

    expect(screen.getByText("Nightly triage")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter by type")).toBeInTheDocument();
  });
});
