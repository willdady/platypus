import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSpeechToText } from "./use-speech-to-text";

class FakeSpeechRecognition extends EventTarget {
  continuous = false;
  interimResults = false;
  lang = "";
  start = vi.fn(() => {
    this.onstart?.(new Event("start"));
  });
  stop = vi.fn(() => {
    this.onend?.(new Event("end"));
  });
  onstart: ((ev: Event) => void) | null = null;
  onend: ((ev: Event) => void) | null = null;
  onresult: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  emitFinalResult(transcript: string) {
    this.emitResults([{ transcript, isFinal: true }]);
  }

  /**
   * Emits one `onresult` carrying the whole result list, the way Chrome on
   * Android does: every result seen so far in the session, `resultIndex`
   * back at 0.
   */
  emitResults(
    entries: { transcript: string; isFinal: boolean }[],
    resultIndex = 0,
  ) {
    const results: Record<string | number, unknown> = {
      length: entries.length,
    };
    entries.forEach((entry, index) => {
      results[index] = {
        isFinal: entry.isFinal,
        length: 1,
        0: { transcript: entry.transcript, confidence: 1 },
      };
    });
    this.onresult?.({ resultIndex, results });
  }
}

describe("useSpeechToText", () => {
  let lastInstance: FakeSpeechRecognition | null = null;
  const registerInstance = (instance: FakeSpeechRecognition) => {
    lastInstance = instance;
  };

  class TrackingSpeechRecognition extends FakeSpeechRecognition {
    constructor() {
      super();
      registerInstance(this);
    }
  }

  beforeEach(() => {
    lastInstance = null;
    window.SpeechRecognition =
      TrackingSpeechRecognition as unknown as Window["SpeechRecognition"];
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "SpeechRecognition");
    Reflect.deleteProperty(window, "webkitSpeechRecognition");
  });

  it("reports unsupported when no Web Speech API is present", () => {
    Reflect.deleteProperty(window, "SpeechRecognition");
    const { result } = renderHook(() => useSpeechToText());
    expect(result.current.isSupported).toBe(false);
  });

  it("reports supported and toggles listening state via start/stop", () => {
    const { result } = renderHook(() => useSpeechToText());
    expect(result.current.isSupported).toBe(true);
    expect(result.current.isListening).toBe(false);

    act(() => result.current.toggleListening());
    expect(result.current.isListening).toBe(true);
    expect(lastInstance?.start).toHaveBeenCalledTimes(1);

    act(() => result.current.toggleListening());
    expect(result.current.isListening).toBe(false);
    expect(lastInstance?.stop).toHaveBeenCalledTimes(1);
  });

  it("appends a final transcript onto the textarea and dispatches input", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "hello";
    const textareaRef = { current: textarea };
    const onTranscriptionChange = vi.fn();
    const inputHandler = vi.fn();
    textarea.addEventListener("input", inputHandler);

    const { result } = renderHook(() =>
      useSpeechToText({ textareaRef, onTranscriptionChange }),
    );

    act(() => lastInstance?.emitFinalResult("world"));

    expect(textarea.value).toBe("hello world");
    expect(inputHandler).toHaveBeenCalledTimes(1);
    expect(onTranscriptionChange).toHaveBeenCalledWith("hello world");
    expect(result.current.transcript).toBe("hello world");
  });

  it("ignores results already appended when the engine replays them", () => {
    const textarea = document.createElement("textarea");
    const textareaRef = { current: textarea };
    const onTranscriptionChange = vi.fn();

    const { result } = renderHook(() =>
      useSpeechToText({ textareaRef, onTranscriptionChange }),
    );

    act(() => result.current.toggleListening());

    act(() =>
      lastInstance?.emitResults([{ transcript: "one", isFinal: true }]),
    );
    expect(textarea.value).toBe("one");

    // Android re-sends the finalised "one" alongside the new " two".
    act(() =>
      lastInstance?.emitResults([
        { transcript: "one", isFinal: true },
        { transcript: " two", isFinal: true },
      ]),
    );

    expect(textarea.value).toBe("one  two");
    expect(onTranscriptionChange).toHaveBeenLastCalledWith("one  two");
  });

  it("does not re-append a final result promoted from an interim one", () => {
    const textarea = document.createElement("textarea");
    const textareaRef = { current: textarea };

    const { result } = renderHook(() => useSpeechToText({ textareaRef }));

    act(() => result.current.toggleListening());

    act(() =>
      lastInstance?.emitResults([{ transcript: "hello", isFinal: false }]),
    );
    expect(textarea.value).toBe("");

    act(() =>
      lastInstance?.emitResults([{ transcript: "hello", isFinal: true }]),
    );
    expect(textarea.value).toBe("hello");

    act(() =>
      lastInstance?.emitResults([
        { transcript: "hello", isFinal: true },
        { transcript: "there", isFinal: false },
      ]),
    );
    expect(textarea.value).toBe("hello");
  });

  it("starts a fresh count when a new session replaces the result list", () => {
    const textarea = document.createElement("textarea");
    const textareaRef = { current: textarea };

    const { result } = renderHook(() => useSpeechToText({ textareaRef }));

    act(() => result.current.toggleListening());
    act(() =>
      lastInstance?.emitResults([
        { transcript: "one", isFinal: true },
        { transcript: " two", isFinal: true },
      ]),
    );
    expect(textarea.value).toBe("one two");

    // Android drops `continuous` and ends the session after an utterance; the
    // next one starts a result list of its own.
    act(() => result.current.toggleListening());
    act(() => result.current.toggleListening());
    act(() =>
      lastInstance?.emitResults([{ transcript: "three", isFinal: true }]),
    );

    expect(textarea.value).toBe("one two three");
  });

  it("stops recognition on unmount", () => {
    const { unmount } = renderHook(() => useSpeechToText());
    unmount();
    expect(lastInstance?.stop).toHaveBeenCalledTimes(1);
  });
});
