import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import type {
  Agent,
  Blueprint,
  Provider,
  Skill,
  Trigger,
} from "@platypus/schemas";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
} from "@/test/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { AgentsList } from "./agents-list";
import { BlueprintsList } from "./blueprints-list";
import { ProvidersList } from "./providers-list";
import { SkillsList } from "./skills-list";
import { TriggerList } from "./trigger-list";

const blueprint = {
  id: "b1",
  name: "Starter",
  items: [],
} as unknown as Blueprint;
const provider = {
  id: "p1",
  name: "Local OpenAI",
  providerType: "OpenAI",
  scope: "workspace",
} as unknown as Provider;
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

function failedRefresh(rows: unknown[]) {
  return { error: new Error("500"), data: { results: rows } };
}

const organization = { "/organizations/org1": { data: { id: "org1" } } };

beforeEach(resetListHarness);

describe("a list keeps its chrome when a refresh fails with rows held", () => {
  it("keeps the Providers footer", async () => {
    mockScopedSWR(
      { "/providers": failedRefresh([provider]) },
      { strict: true },
    );

    await renderList(<ProvidersList orgId="org1" workspaceId="ws1" />);

    expect(screen.getByText("Local OpenAI")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Add/ })).toBeInTheDocument();
  });

  it("keeps the Blueprints footer", async () => {
    mockScopedSWR(
      { "/blueprints": failedRefresh([blueprint]) },
      { strict: true },
    );

    await renderList(<BlueprintsList orgId="org1" />);

    expect(screen.getByText("Starter")).toBeInTheDocument();
    expect(screen.getByText(/Create blueprint/)).toBeInTheDocument();
  });

  it("keeps the Agents footer", async () => {
    mockScopedSWR(
      {
        "/agents": failedRefresh([agent]),
        "/providers": [],
        "/tools": [],
        "/skills": [],
      },
      { strict: true },
    );

    await renderList(<AgentsList orgId="org1" workspaceId="ws1" />);

    expect(screen.getByText("Triage")).toBeInTheDocument();
    expect(screen.getByText(/Create agent/)).toBeInTheDocument();
  });

  it("keeps the Skills toolbar", async () => {
    mockScopedSWR(
      { "/skills": failedRefresh([skill]), "/agents": [], ...organization },
      { strict: true },
    );

    await renderList(<SkillsList orgId="org1" workspaceId="ws1" />);

    expect(screen.getByText("Triage skill")).toBeInTheDocument();
    expect(screen.getByLabelText("Search skills")).toBeInTheDocument();
  });

  it("keeps the Organization Skills footer", async () => {
    mockScopedSWR(
      {
        "/skills": failedRefresh([skill]),
        "/agents": [],
        "/attachments?": [],
        ...organization,
      },
      { strict: true },
    );

    await renderList(<SkillsList orgId="org1" />);

    expect(screen.getByText("Triage skill")).toBeInTheDocument();
    expect(screen.getByText(/Create skill/)).toBeInTheDocument();
  });

  it("keeps the Triggers toolbar", async () => {
    mockScopedSWR(
      { "/triggers": failedRefresh([trigger]), "/agents": [] },
      { strict: true },
    );

    await renderList(<TriggerList orgId="org1" workspaceId="ws1" />);

    expect(screen.getByText("Nightly triage")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter by type")).toBeInTheDocument();
  });
});
