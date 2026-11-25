import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  installSpeechRecognition,
  uninstallSpeechRecognition,
  setSecureContext,
} from "@/test/chat-test-fixtures";
import { useSpeechToText } from "./use-speech-to-text";

describe("useSpeechToText", () => {
  let recognition: ReturnType<typeof installSpeechRecognition>;

  beforeEach(() => {
    setSecureContext(true);
    recognition = installSpeechRecognition();
  });

  afterEach(uninstallSpeechRecognition);

  it("reports unsupported, and says why on toggle, when no Web Speech API is present", () => {
    uninstallSpeechRecognition();
    const { result } = renderHook(() => useSpeechToText());
    expect(result.current.isSupported).toBe(false);

    act(() => result.current.toggleListening());

    expect(result.current.fault).toEqual({ code: "unsupported" });
  });

  it("reports supported and toggles listening state via start/stop", () => {
    const { result } = renderHook(() => useSpeechToText());
    expect(result.current.isSupported).toBe(true);
    expect(result.current.isListening).toBe(false);

    act(() => result.current.toggleListening());
    expect(result.current.isListening).toBe(true);
    expect(recognition()?.start).toHaveBeenCalledTimes(1);

    act(() => result.current.toggleListening());
    expect(result.current.isListening).toBe(false);
    expect(recognition()?.stop).toHaveBeenCalledTimes(1);
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

    act(() => recognition()?.emitFinalResult("world"));

    expect(textarea.value).toBe("hello world");
    expect(inputHandler).toHaveBeenCalledTimes(1);
    expect(onTranscriptionChange).toHaveBeenCalledWith("hello world");
    expect(result.current.transcript).toBe("hello world");
  });

  it("writes each phrase once when the engine restates the whole utterance", () => {
    const textarea = document.createElement("textarea");
    const textareaRef = { current: textarea };
    const onTranscriptionChange = vi.fn();

    const { result } = renderHook(() =>
      useSpeechToText({ textareaRef, onTranscriptionChange }),
    );

    act(() => result.current.toggleListening());

    const stream = [
      "hello",
      "hello world",
      "hello world",
      "hello world",
      "hello world",
      "hello world how",
      "hello world how are",
      "hello world how are you",
      "hello world how are you",
    ];

    stream.forEach((_, index) => {
      act(() =>
        recognition()?.emitResults(
          stream
            .slice(0, index + 1)
            .map((transcript) => ({ transcript, isFinal: true })),
        ),
      );
    });

    expect(textarea.value).toBe("hello world how are you");
    expect(onTranscriptionChange).toHaveBeenLastCalledWith(
      "hello world how are you",
    );
  });

  it("keeps separate phrases when the results are segments rather than restatements", () => {
    const textarea = document.createElement("textarea");
    const textareaRef = { current: textarea };
    const onTranscriptionChange = vi.fn();

    const { result } = renderHook(() =>
      useSpeechToText({ textareaRef, onTranscriptionChange }),
    );

    act(() => result.current.toggleListening());

    act(() =>
      recognition()?.emitResults([{ transcript: "one", isFinal: true }]),
    );
    expect(textarea.value).toBe("one");

    act(() =>
      recognition()?.emitResults([
        { transcript: "one", isFinal: true },
        { transcript: " two", isFinal: true },
      ]),
    );

    expect(textarea.value).toBe("one two");
    expect(onTranscriptionChange).toHaveBeenLastCalledWith("one two");
  });

  it("keeps the rest of the session when one result restates another", () => {
    const textarea = document.createElement("textarea");
    const textareaRef = { current: textarea };

    const { result } = renderHook(() => useSpeechToText({ textareaRef }));

    act(() => result.current.toggleListening());

    act(() =>
      recognition()?.emitResults([
        { transcript: "yes", isFinal: true },
        { transcript: "yes please", isFinal: true },
        { transcript: "send it", isFinal: true },
      ]),
    );

    expect(textarea.value).toBe("yes please send it");
  });

  it("does not re-append a final result promoted from an interim one", () => {
    const textarea = document.createElement("textarea");
    const textareaRef = { current: textarea };

    const { result } = renderHook(() => useSpeechToText({ textareaRef }));

    act(() => result.current.toggleListening());

    act(() =>
      recognition()?.emitResults([{ transcript: "hello", isFinal: false }]),
    );
    expect(textarea.value).toBe("");

    act(() =>
      recognition()?.emitResults([{ transcript: "hello", isFinal: true }]),
    );
    expect(textarea.value).toBe("hello");

    act(() =>
      recognition()?.emitResults([
        { transcript: "hello", isFinal: true },
        { transcript: "there", isFinal: false },
      ]),
    );
    expect(textarea.value).toBe("hello");
  });

  it("keeps earlier speech when a new session replaces the result list", () => {
    const textarea = document.createElement("textarea");
    const textareaRef = { current: textarea };

    const { result } = renderHook(() => useSpeechToText({ textareaRef }));

    act(() => result.current.toggleListening());
    act(() =>
      recognition()?.emitResults([
        { transcript: "one", isFinal: true },
        { transcript: " two", isFinal: true },
      ]),
    );
    expect(textarea.value).toBe("one two");

    act(() => result.current.toggleListening());
    act(() => result.current.toggleListening());
    act(() =>
      recognition()?.emitResults([{ transcript: "three", isFinal: true }]),
    );

    expect(textarea.value).toBe("one two three");
  });

  it("reports a recognition failure to the caller", () => {
    const { result } = renderHook(() => useSpeechToText());

    act(() => result.current.toggleListening());
    expect(result.current.fault).toBeNull();

    act(() => recognition()?.emitError("not-allowed"));

    expect(result.current.fault).toEqual({ code: "not-allowed" });
    expect(result.current.isListening).toBe(false);
  });

  it("reports a failure again when the same one happens twice", () => {
    const { result } = renderHook(() => useSpeechToText());

    act(() => result.current.toggleListening());
    act(() => recognition()?.emitError("network"));
    const first = result.current.fault;

    act(() => result.current.toggleListening());
    act(() => recognition()?.emitError("network"));

    expect(result.current.fault).toEqual({ code: "network" });
    expect(result.current.fault).not.toBe(first);
  });

  it("calls an unrecognised error code unknown", () => {
    const { result } = renderHook(() => useSpeechToText());

    act(() => result.current.toggleListening());
    act(() => recognition()?.emitError("something-new"));

    expect(result.current.fault).toEqual({ code: "unknown" });
  });

  it.each(["no-speech", "aborted"])("ends quietly on %s", (error) => {
    const { result } = renderHook(() => useSpeechToText());

    act(() => result.current.toggleListening());
    act(() => recognition()?.emitError(error));

    expect(result.current.fault).toBeNull();
    expect(result.current.isListening).toBe(false);
  });

  it("refuses to run outside a secure context and says why", () => {
    setSecureContext(false);

    const { result } = renderHook(() => useSpeechToText());

    expect(result.current.isSupported).toBe(false);
    expect(recognition()).toBeNull();

    act(() => result.current.toggleListening());

    expect(result.current.fault).toEqual({ code: "insecure-context" });
  });

  it("stops recognition on unmount", () => {
    const { unmount } = renderHook(() => useSpeechToText());
    unmount();
    expect(recognition()?.stop).toHaveBeenCalledTimes(1);
  });
});
