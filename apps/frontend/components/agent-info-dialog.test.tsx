import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Agent, Provider, Skill, ToolSet } from "@platypus/schemas";
import type { Serialized } from "@/lib/api-write";
import { navigationMock, push, setupUser } from "@/test/test-utils";

vi.mock("next/navigation", () => ({
  ...navigationMock,
  useParams: () => ({ orgId: "org1", workspaceId: "ws1" }),
}));

import { Dialog } from "./ui/dialog";
import { AgentInfoDialog } from "./agent-info-dialog";

function agent(overrides: Partial<Serialized<Agent>> = {}) {
  return {
    id: "agent-1",
    name: "Helper",
    providerId: "provider-1",
    modelId: "gpt-4o",
    ...overrides,
  } as Serialized<Agent>;
}

const providers = [
  { id: "provider-1", name: "OpenAI" },
] as Serialized<Provider>[];
const toolSets = [
  { id: "ts-1", name: "Web Search" },
  { id: "ts-2", name: "Filesystem" },
] as ToolSet[];
const skills = [{ id: "skill-1", name: "Summarise" }] as Serialized<Skill>[];
const agents = [
  { id: "agent-1", name: "Helper" },
  { id: "agent-2", name: "Researcher" },
] as Serialized<Agent>[];

function renderDialog(
  props: Partial<Parameters<typeof AgentInfoDialog>[0]> = {},
) {
  return render(
    <Dialog open>
      <AgentInfoDialog
        agent={agent()}
        agents={agents}
        toolSets={toolSets}
        skills={skills}
        providers={providers}
        {...props}
      />
    </Dialog>,
  );
}

beforeEach(() => push.mockReset());

describe("AgentInfoDialog", () => {
  // The dialog is how a Chat user sees what the Agent will run with.
  it("shows the provider, model, instructions and max steps", () => {
    renderDialog({
      agent: agent({ instructions: "Be terse.", maxSteps: 12 }),
    });

    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("gpt-4o")).toBeInTheDocument();
    expect(screen.getByText("Be terse.")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  // A deleted or unshared Provider, or unset fields, must read as such
  // rather than as a blank box.
  it("falls back when the provider is missing and fields are unset", () => {
    renderDialog({ agent: agent({ providerId: "gone" }) });

    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByText("No instructions set")).toBeInTheDocument();
    expect(screen.getByText("Not set")).toBeInTheDocument();
    expect(screen.queryByText("Input Placeholder")).not.toBeInTheDocument();
  });

  it("shows the input placeholder when the agent sets one", () => {
    renderDialog({ agent: agent({ inputPlaceholder: "Ask me anything" }) });

    expect(screen.getByText("Ask me anything")).toBeInTheDocument();
  });

  // Ids are resolved against what the Workspace can see; an id that no
  // longer resolves is dropped rather than shown raw.
  it("lists the agent's tools, skills and sub-agents by name", () => {
    renderDialog({
      agent: agent({
        toolSetIds: ["ts-1", "ts-missing"],
        skillIds: ["skill-1"],
        subAgentIds: ["agent-2"],
      }),
    });

    expect(screen.getByText("Web Search")).toBeInTheDocument();
    expect(screen.queryByText("Filesystem")).not.toBeInTheDocument();
    expect(screen.queryByText("ts-missing")).not.toBeInTheDocument();
    expect(screen.getByText("Summarise")).toBeInTheDocument();
    expect(screen.getByText("Researcher")).toBeInTheDocument();
  });

  it("hides the tools, skills and sub-agents sections when there are none", () => {
    renderDialog();

    expect(screen.queryByText("Tools")).not.toBeInTheDocument();
    expect(screen.queryByText("Skills")).not.toBeInTheDocument();
    expect(screen.queryByText("Sub-Agents")).not.toBeInTheDocument();
  });

  // Sampling settings sit behind the disclosure; 0 is a real value, not unset.
  it("reveals the sampling settings under Advanced settings", async () => {
    renderDialog({ agent: agent({ temperature: 0, topK: 40 }) });

    expect(screen.queryByText("Temperature")).not.toBeInTheDocument();
    await setupUser().click(
      screen.getByRole("button", { name: "Toggle advanced settings" }),
    );

    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("40")).toBeInTheDocument();
    // Seed, Top-p and both penalties are unset, plus Max Steps above.
    expect(screen.getAllByText("Not set")).toHaveLength(5);
  });

  it("opens the agent's edit page and closes on request", async () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    const user = setupUser();

    await user.click(screen.getByRole("button", { name: "Edit agent" }));
    expect(push).toHaveBeenCalledWith("/org1/workspace/ws1/agents/agent-1");

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
