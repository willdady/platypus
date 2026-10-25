import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { Agent, Provider } from "@platypus/schemas";
import { ModelSelectorDialog } from "./model-selector-dialog";
import type { Serialized } from "@/lib/api-write";

function countingProvider() {
  let reads = 0;
  const provider = {
    id: "p1",
    name: "Test",
    get modelIds() {
      reads += 1;
      return [{ id: "gpt-4o", passthroughFileTypes: [] }];
    },
  } as unknown as Serialized<Provider>;
  return { provider, reads: () => reads };
}

function dialog(
  providers: Serialized<Provider>[],
  agents: Serialized<Agent>[] = [],
) {
  return (
    <ModelSelectorDialog
      agents={agents}
      providers={providers}
      agentId=""
      modelId=""
      providerId=""
      isResolved
      isOpen
      onOpenChange={vi.fn()}
      onModelChange={vi.fn()}
    />
  );
}

describe("ModelSelectorDialog model options", () => {
  // Issue #869: the picker re-normalised every provider's model list on each
  // render. The options are a pure function of the provider list, so they are
  // computed once per provider-list identity.
  it("normalises each provider's models once across re-renders", () => {
    const { provider, reads } = countingProvider();
    const providers = [provider];
    const view = render(dialog(providers));
    expect(reads()).toBe(1);

    view.rerender(dialog(providers));

    expect(reads()).toBe(1);
  });
});

describe("ModelSelectorDialog agent groups", () => {
  const agent = (id: string, name: string, isPinned: boolean) =>
    ({ id, name, isPinned }) as unknown as Serialized<Agent>;

  const namesIn = (group: string) =>
    within(screen.getByRole("group", { name: group }))
      .getAllByRole("option")
      .map((option) => option.textContent);

  it("shows pinned agents in a Pinned group above the Agents group", () => {
    render(
      dialog(
        [],
        [
          agent("a1", "Triage", false),
          agent("a2", "Writer", true),
          agent("a3", "Coder", false),
        ],
      ),
    );

    expect(namesIn("Pinned")).toEqual(["Writer"]);
    expect(namesIn("Agents")).toEqual(["Triage", "Coder"]);
    const [first, second] = screen
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-labelledby"));
    expect(
      [first, second].map((id) => document.getElementById(id!)?.textContent),
    ).toEqual(["Pinned", "Agents"]);
  });

  it("shows only the Agents group when nothing is pinned", () => {
    render(dialog([], [agent("a1", "Triage", false)]));

    expect(
      screen.queryByRole("group", { name: "Pinned" }),
    ).not.toBeInTheDocument();
    expect(namesIn("Agents")).toEqual(["Triage"]);
  });
});

describe("ModelSelectorDialog trigger label", () => {
  const provider = (id: string, name: string, models: string[]) =>
    ({
      id,
      name,
      modelIds: models.map((model) => ({
        id: model,
        passthroughFileTypes: [],
      })),
    }) as unknown as Serialized<Provider>;

  const triggerFor = (
    providers: Serialized<Provider>[],
    providerId: string,
    agents: Serialized<Agent>[] = [],
  ) =>
    render(
      <ModelSelectorDialog
        agents={agents}
        providers={providers}
        agentId={agents[0]?.id ?? ""}
        modelId="glm-flash"
        providerId={providerId}
        isResolved
        isOpen={false}
        onOpenChange={vi.fn()}
        onModelChange={vi.fn()}
      />,
    );

  // Issue #1651: a label two Providers offer reads the same either way, so
  // the trigger names the Provider.
  it("names the Provider when another Provider offers the same label", () => {
    triggerFor(
      [
        provider("p1", "OpenRouter", ["glm-flash"]),
        provider("p2", "OpenRouter (Completions API)", ["glm-flash", "x"]),
      ],
      "p2",
    );

    expect(screen.getByRole("button")).toHaveTextContent(
      /^glm-flash · OpenRouter \(Completions API\)$/,
    );
  });

  it("shows the label alone when no other Provider offers it", () => {
    triggerFor(
      [
        provider("p1", "OpenRouter", ["glm-flash"]),
        provider("p2", "Other", ["x"]),
      ],
      "p1",
    );

    expect(screen.getByRole("button")).toHaveTextContent(/^glm-flash$/);
  });

  it("shows only the Agent's name when an Agent is selected", () => {
    triggerFor(
      [
        provider("p1", "OpenRouter", ["glm-flash"]),
        provider("p2", "OpenRouter (Completions API)", ["glm-flash"]),
      ],
      "p2",
      [{ id: "a1", name: "Writer" } as unknown as Serialized<Agent>],
    );

    expect(screen.getByRole("button")).toHaveTextContent(/^Writer$/);
  });
});
