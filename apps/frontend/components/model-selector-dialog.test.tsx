import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { Provider } from "@platypus/schemas";
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

const dialog = (providers: Provider[]) => (
  <ModelSelectorDialog
    agents={[]}
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
