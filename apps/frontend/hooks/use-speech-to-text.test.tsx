import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  installSpeechRecognition,
  uninstallSpeechRecognition,
  setSecureContext,
} from "@/lib/chat-test-fixtures";
import { useSpeechToText } from "./use-speech-to-text";

describe("useSpeechToText", () => {
  /** The session the hook most recently constructed. */
  let recognition: ReturnType<typeof installSpeechRecognition>;

  beforeEach(() => {
    setSecureContext(true);
    recognition = installSpeechRecognition();
  });

  afterEach(uninstallSpeechRecognition);

  it("reports unsupported when no Web Speech API is present", () => {
    uninstallSpeechRecognition();
    const { result } = renderHook(() => useSpeechToText());
    expect(result.current.isSupported).toBe(false);
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

    // The stream Chrome for Android produces for "hello world" then "how are
    // you": one more `isFinal` entry per partial update, each carrying the
    // whole utterance so far. Concatenating the list writes every word again
    // for every entry it appears in (issue #752).
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

    // The engine re-sends the finalised "one" alongside the new " two".
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

    // "yes" opening "yes please" reads as a restatement, so that phrase is
    // spoken once. Judging each entry against its neighbour keeps the mistake
    // to the pair - the unrelated segment after it still lands.
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

    // Android drops `continuous` and ends the session after an utterance; the
    // next one starts a result list of its own.
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
    // No recognition object is built at all, so nothing can be started.
    expect(recognition()).toBeNull();

    act(() => result.current.toggleListening());

    expect(result.current.fault).toEqual({ code: "insecure-context" });
  });

  it("says why when the browser has no Web Speech API", () => {
    Reflect.deleteProperty(window, "SpeechRecognition");

    const { result } = renderHook(() => useSpeechToText());

    act(() => result.current.toggleListening());

    expect(result.current.fault).toEqual({ code: "unsupported" });
  });

  it("stops recognition on unmount", () => {
    const { unmount } = renderHook(() => useSpeechToText());
    unmount();
    expect(recognition()?.stop).toHaveBeenCalledTimes(1);
  });
});
