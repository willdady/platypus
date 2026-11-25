import { vi } from "vitest";
import type { FileUIPart } from "ai";
import type { PlatypusUIMessage, Provider } from "@platypus/schemas";
import type { Serialized } from "@/lib/api-write";
import type { SpeechRecognitionWindow } from "@/hooks/use-speech-to-text";

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

export function uninstallSpeechRecognition() {
  Reflect.deleteProperty(window, "SpeechRecognition");
  Reflect.deleteProperty(window, "webkitSpeechRecognition");
}

export function setSecureContext(value: boolean) {
  Object.defineProperty(window, "isSecureContext", {
    value,
    configurable: true,
  });
}

export const composerProvider = {
  id: "provider-1",
  name: "OpenAI",
  modelIds: [{ id: "gpt-4o", passthroughFileTypes: [] }],
} as unknown as Serialized<Provider>;

export const reportPdf: FileUIPart = {
  type: "file",
  url: "https://files.example.com/report.pdf",
  mediaType: "application/pdf",
  filename: "report.pdf",
};

export const screenshotPng: FileUIPart = {
  type: "file",
  url: "https://files.example.com/shot.png",
  mediaType: "image/png",
  filename: "shot.png",
};

export function chatMessage(id: string, text: string): PlatypusUIMessage {
  return {
    id,
    role: id.startsWith("u") ? "user" : "assistant",
    parts: [{ type: "text", text }],
  };
}

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
