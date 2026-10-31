import { vi } from "vitest";
import type { FileUIPart } from "ai";
import type { PlatypusUIMessage, Provider } from "@platypus/schemas";
import type { Serialized } from "@/lib/api-write";
import type { SpeechRecognitionWindow } from "@/hooks/use-speech-to-text";

/**
 * The fixtures and fakes the chat-surface tests share — the composer, the
 * message editor, the slash-command picker, and the speech-to-text hook all
 * need the same Web Speech API that jsdom does not implement, the same
 * Provider to pick a model from, and the same persisted attachments.
 *
 * Only what more than one file needs lives here. A surface whose fixture is
 * deliberately its own shape keeps it local.
 */

/**
 * The Web Speech API jsdom has no implementation of. `start`/`stop` fire the
 * lifecycle events synchronously, the way a real recognition session does
 * once it has the microphone, so a test can drive a whole session without
 * timers.
 */
export class FakeSpeechRecognition extends EventTarget {
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

  emitError(error: string) {
    this.onerror?.({ error });
  }
}

/**
 * Installs the fake on `window` and hands back a reader for the session the
 * component most recently constructed — the handle a test drives results and
 * errors through. Call per test (e.g. in `beforeEach`); the reader resets
 * with it.
 */
export function installSpeechRecognition() {
  let latest: FakeSpeechRecognition | null = null;
  const register = (instance: FakeSpeechRecognition) => {
    latest = instance;
  };
  class TrackingSpeechRecognition extends FakeSpeechRecognition {
    constructor() {
      super();
      register(this);
    }
  }
  (window as SpeechRecognitionWindow).SpeechRecognition =
    TrackingSpeechRecognition;
  return () => latest;
}

/** Undoes `installSpeechRecognition`, both the standard and the webkit name. */
export function uninstallSpeechRecognition() {
  Reflect.deleteProperty(window, "SpeechRecognition");
  Reflect.deleteProperty(window, "webkitSpeechRecognition");
}

/**
 * Sets `window.isSecureContext`. The Web Speech API is gated on it, so the
 * hook reports itself unsupported over plain HTTP.
 */
export function setSecureContext(value: boolean) {
  Object.defineProperty(window, "isSecureContext", {
    value,
    configurable: true,
  });
}

/** The Provider the composer surfaces offer a model from. */
export const composerProvider = {
  id: "provider-1",
  name: "OpenAI",
  modelIds: ["gpt-4o"],
} as unknown as Serialized<Provider>;

/** A persisted PDF attachment, as a stored message carries one. */
export const reportPdf: FileUIPart = {
  type: "file",
  url: "https://files.example.com/report.pdf",
  mediaType: "application/pdf",
  filename: "report.pdf",
};

/** A persisted image attachment, for the cases a PDF cannot cover. */
export const screenshotPng: FileUIPart = {
  type: "file",
  url: "https://files.example.com/shot.png",
  mediaType: "image/png",
  filename: "shot.png",
};

/**
 * One Chat message carrying a single text part. The role follows the id's
 * prefix — `u1` is the User, `a1` the assistant — which keeps a path fixture
 * readable.
 */
export function chatMessage(id: string, text: string): PlatypusUIMessage {
  return {
    id,
    role: id.startsWith("u") ? "user" : "assistant",
    parts: [{ type: "text", text }],
  };
}

/**
 * u1 → a1 → u2 → a2 → u3 → a3, with u2 edited twice: u2b → a2b, and u2c.
 */
export const alternativesTree = [
  { id: "u1", parentId: null },
  { id: "a1", parentId: "u1" },
  { id: "u2", parentId: "a1" },
  { id: "a2", parentId: "u2" },
  { id: "u3", parentId: "a2" },
  { id: "a3", parentId: "u3" },
  { id: "u2b", parentId: "a1" },
  { id: "a2b", parentId: "u2b" },
  { id: "u2c", parentId: "a1" },
];

/** A Chat row whose Active path is `messages`, over `alternativesTree`. */
export function alternativesRow(messages: PlatypusUIMessage[], chatId: string) {
  return {
    id: chatId,
    status: "succeeded",
    providerId: "p1",
    modelId: "m1",
    messages,
    tree: alternativesTree,
  };
}
