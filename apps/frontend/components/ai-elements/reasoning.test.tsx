import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import {
  AUTO_CLOSE_DELAY,
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "./reasoning";

const renderReasoning = (props: Partial<ComponentProps<typeof Reasoning>>) => {
  const ui = (p: Partial<ComponentProps<typeof Reasoning>>) => (
    <Reasoning {...p}>
      <ReasoningTrigger />
      <ReasoningContent>Weighing the options</ReasoningContent>
    </Reasoning>
  );
  const view = render(ui(props));
  return {
    rerender: (next: Partial<ComponentProps<typeof Reasoning>>) =>
      view.rerender(ui(next)),
  };
};

const trigger = () => screen.getByRole("button");
const reasoningText = () => screen.queryByText("Weighing the options");

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Reasoning", () => {
  it("is open and reads as thinking while streaming", () => {
    renderReasoning({ isStreaming: true });

    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(trigger()).toHaveTextContent("Thinking...");
    expect(reasoningText()).toBeInTheDocument();
  });

  it("stays open for as long as streaming lasts", () => {
    renderReasoning({ isStreaming: true });

    advance(AUTO_CLOSE_DELAY * 10);

    expect(reasoningText()).toBeInTheDocument();
  });

  // Partial seconds round up, so a short think never reads as zero.
  it("records how many seconds it thought for once streaming ends", () => {
    const { rerender } = renderReasoning({ isStreaming: true });

    advance(2500);
    rerender({ isStreaming: false });

    expect(
      screen.getByRole("button", { name: /Thought for 3 seconds/ }),
    ).toBeInTheDocument();
  });

  it("closes itself a moment after streaming ends", () => {
    const { rerender } = renderReasoning({ isStreaming: true });
    rerender({ isStreaming: false });

    advance(AUTO_CLOSE_DELAY - 1);
    expect(reasoningText()).toBeInTheDocument();

    advance(1);
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(reasoningText()).toBeNull();
  });

  // The auto-close happens once; after that the reader is in charge.
  it("stays open when the reader reopens it after it closed itself", () => {
    const { rerender } = renderReasoning({ isStreaming: true });
    rerender({ isStreaming: false });
    advance(AUTO_CLOSE_DELAY);

    fireEvent.click(trigger());
    advance(AUTO_CLOSE_DELAY * 10);

    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(reasoningText()).toBeInTheDocument();
  });

  // How the chat renders it: closed, and left alone in both directions.
  it("neither opens nor closes on its own when it starts closed", () => {
    const { rerender } = renderReasoning({
      isStreaming: true,
      defaultOpen: false,
    });
    expect(reasoningText()).toBeNull();

    rerender({ isStreaming: false, defaultOpen: false });
    fireEvent.click(trigger());
    advance(AUTO_CLOSE_DELAY * 10);

    expect(reasoningText()).toBeInTheDocument();
  });
});
