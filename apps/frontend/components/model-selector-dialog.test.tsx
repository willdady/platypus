import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { Agent, Provider } from "@platypus/schemas";
import { ModelSelectorDialog } from "./model-selector-dialog";
import { installResizeObserverStub } from "@/lib/test-utils";

const countingProvider = () => {
  let reads = 0;
  const provider = {
    id: "p1",
    name: "Test",
    get modelIds() {
      reads += 1;
      return [{ id: "gpt-4o", passthroughFileTypes: [] }];
    },
  } as unknown as Provider;
  return { provider, reads: () => reads };
};

const dialog = (providers: Provider[], agents: Agent[] = []) => (
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

beforeEach(() => {
  // cmdk scrolls the active item into view and observes its list.
  Element.prototype.scrollIntoView = () => {};
  installResizeObserverStub();
});

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
    ({ id, name, isPinned }) as unknown as Agent;

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

    expect(screen.queryByRole("group", { name: "Pinned" })).toBeNull();
    expect(namesIn("Agents")).toEqual(["Triage"]);
  });
});
