import { describe, it, expect, vi, beforeEach } from "vitest";
import { useRef, useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Provider } from "@platypus/schemas";
import { Composer } from "./composer";

/**
 * Issue #749: closing the model picker used to move focus twice — Radix
 * returned it to the trigger button, then a 250ms timer moved it on to the
 * textarea. On mobile the intermediate stop on a button dismissed the
 * on-screen keyboard, and the timer reopened it about half a second later.
 *
 * jsdom has no virtual keyboard, so what these tests pin is the mechanism
 * underneath it: focus ends on the textarea, and it gets there in one move
 * without passing through the trigger. Confirming the keyboard itself needs a
 * physical device.
 */

const provider = {
  id: "provider-1",
  name: "OpenAI",
  modelIds: ["gpt-4o"],
} as unknown as Provider;

const renderComposer = () => {
  const onModelChange = vi.fn();

  const Harness = () => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [value, setValue] = useState("");
    const [modelId, setModelId] = useState("");

    return (
      <Composer
        onSubmit={vi.fn()}
        passthroughFileTypes={[]}
        modelSelection={{
          agents: [],
          providers: [provider],
          agentId: "",
          modelId,
          providerId: modelId ? provider.id : "",
          onModelChange: (v) => {
            onModelChange(v);
            setModelId("gpt-4o");
          },
        }}
        textarea={{
          ref: textareaRef,
          value,
          onChange: (e) => setValue(e.target.value),
          placeholder: "Ask anything",
        }}
        onTranscriptionChange={vi.fn()}
        submit={<button type="submit">Send</button>}
      />
    );
  };

  render(<Harness />);

  return {
    onModelChange,
    textarea: screen.getByPlaceholderText("Ask anything"),
    trigger: screen.getByText("Select model").closest("button")!,
  };
};

const openPicker = (trigger: HTMLElement) => {
  fireEvent.click(trigger);
  return screen.getByText("gpt-4o");
};

/** Records every element that takes focus from this point on, in order. */
const recordFocus = () => {
  const targets: EventTarget[] = [];
  document.addEventListener("focusin", (e) => targets.push(e.target!));
  return targets;
};

beforeEach(() => {
  // jsdom has no matchMedia; PromptInputTextarea subscribes to it.
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
  // cmdk scrolls the active item into view and observes its list.
  Element.prototype.scrollIntoView = vi.fn();
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

describe("Composer model picker focus", () => {
  it("returns focus to the textarea when a model is selected", async () => {
    const { textarea, trigger, onModelChange } = renderComposer();

    fireEvent.click(openPicker(trigger));

    expect(onModelChange).toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });

  it("returns focus to the textarea when the picker is dismissed without a selection", async () => {
    const { textarea, trigger, onModelChange } = renderComposer();

    openPicker(trigger);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    expect(onModelChange).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });

  it("does not pass focus through the trigger button on the way back", async () => {
    const { textarea, trigger } = renderComposer();

    const item = openPicker(trigger);
    // Only the close is under test; opening the picker legitimately moves
    // focus into it.
    const focused = recordFocus();
    fireEvent.click(item);
    await waitFor(() => expect(document.activeElement).toBe(textarea));

    // One move, straight to the textarea. Landing on the trigger first is the
    // regression: on mobile it drops the keyboard before the textarea reopens it.
    expect(focused).toEqual([textarea]);
    expect(focused).not.toContain(trigger);
  });
});
