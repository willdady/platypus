import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Chat } from "@platypus/schemas";
import { useChatSettings } from "./use-chat-settings";

const chat = (over: Partial<Chat> = {}): Chat =>
  ({
    id: "chat-1",
    instructions: "Be brief.",
    temperature: 0.5,
    ...over,
  }) as unknown as Chat;

describe("useChatSettings", () => {
  it("seeds the form from the chat row", () => {
    const { result } = renderHook(() => useChatSettings(chat(), ""));

    expect(result.current.settings.instructions).toBe("Be brief.");
    expect(result.current.settings.temperature).toBe(0.5);
  });

  // Issue #869: the settings dialog lost unsaved edits while a run streamed.
  // The chat row is polled during a run and SWR hands back a fresh object each
  // flush; re-syncing on the object discarded whatever the user had typed.
  it("keeps unsaved edits when a poll flush replaces the row", () => {
    const { result, rerender } = renderHook(
      ({ data }: { data: Chat }) => useChatSettings(data, ""),
      { initialProps: { data: chat() } },
    );

    act(() => result.current.setInstructions("Edited while the run streamed"));

    rerender({ data: chat({ temperature: 0.7 }) });

    expect(result.current.settings.instructions).toBe(
      "Edited while the run streamed",
    );
    expect(result.current.settings.temperature).toBe(0.5);
  });

  it("re-syncs when the chat identity changes", () => {
    const { result, rerender } = renderHook(
      ({ data }: { data: Chat }) => useChatSettings(data, ""),
      { initialProps: { data: chat() } },
    );

    act(() => result.current.setInstructions("Edited"));

    rerender({ data: chat({ id: "chat-2", instructions: "Another chat." }) });

    expect(result.current.settings.instructions).toBe("Another chat.");
  });
});
