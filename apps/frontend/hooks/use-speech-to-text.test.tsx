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
    this.onresult?.({
      resultIndex: 0,
      results: {
        length: 1,
        0: {
          isFinal: true,
          length: 1,
          0: { transcript, confidence: 1 },
        },
      },
    });
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

  it("stops recognition on unmount", () => {
    const { unmount } = renderHook(() => useSpeechToText());
    unmount();
    expect(lastInstance?.stop).toHaveBeenCalledTimes(1);
  });
});
