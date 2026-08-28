import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { FileUIPart } from "ai";
import type { Provider } from "@platypus/schemas";

/**
 * The edit surface (issue #710). The defect it exists to fix is invisible in a
 * unit test of any one piece: editing resubmitted a bare string, so a message
 * with a file came back without it. So these tests drive the surface the way a
 * user does — open it on a message that carries a file, press Save, and read
 * what it hands back.
 */

// The picker has its own tests; here it stands in for "the surface names what
// it will re-run on", which is the reason the ticket keeps it.
vi.mock("./model-selector-dialog", () => ({
  ModelSelectorDialog: ({ modelId }: { modelId: string }) => (
    <button type="button">{modelId || "Select model"}</button>
  ),
}));

import { MessageEditor } from "./message-editor";

class FakeSpeechRecognition extends EventTarget {
  continuous = false;
  interimResults = false;
  lang = "";
  start = vi.fn(() => this.onstart?.(new Event("start")));
  stop = vi.fn(() => this.onend?.(new Event("end")));
  onstart: ((ev: Event) => void) | null = null;
  onend: ((ev: Event) => void) | null = null;
  onresult: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  emitFinalResult(transcript: string) {
    this.onresult?.({
      resultIndex: 0,
      results: {
        length: 1,
        0: { isFinal: true, length: 1, 0: { transcript, confidence: 1 } },
      },
    });
  }
}

let lastRecognition: FakeSpeechRecognition | null = null;

const registerRecognition = (instance: FakeSpeechRecognition) => {
  lastRecognition = instance;
};

class TrackingSpeechRecognition extends FakeSpeechRecognition {
  constructor() {
    super();
    registerRecognition(this);
  }
}

beforeEach(() => {
  // jsdom has no matchMedia; PromptInputTextarea subscribes to it.
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
  lastRecognition = null;
  window.SpeechRecognition =
    TrackingSpeechRecognition as unknown as Window["SpeechRecognition"];
});

afterEach(() => {
  Reflect.deleteProperty(window, "SpeechRecognition");
  Reflect.deleteProperty(window, "webkitSpeechRecognition");
});

const report: FileUIPart = {
  type: "file",
  url: "https://files.example.com/report.pdf",
  mediaType: "application/pdf",
  filename: "report.pdf",
};

const provider = {
  id: "p1",
  name: "OpenRouter",
  modelIds: [{ id: "m1", passthroughFileTypes: [] }],
} as unknown as Provider;

const renderEditor = (
  overrides: Partial<React.ComponentProps<typeof MessageEditor>> = {},
) => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <MessageEditor
      initialText="What does this say?"
      initialAttachments={[report]}
      agents={[]}
      providers={[provider]}
      agentId=""
      modelId="m1"
      providerId="p1"
      onModelChange={vi.fn()}
      // The seeded PDF reads natively by default, so the compatibility notice
      // stays out of the way of every test that isn't about it.
      passthroughFileTypes={["application/pdf"]}
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { ...view, onSubmit, onCancel };
};

const save = () =>
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

describe("MessageEditor", () => {
  it("opens holding the message's text and its attachments", () => {
    renderEditor();

    expect(screen.getByRole("textbox")).toHaveValue("What does this say?");
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });

  // The regression the ticket exists for.
  it("saves an edited message with its original attachments intact", async () => {
    const { onSubmit } = renderEditor();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "What does this actually say?" },
    });
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toEqual({
      text: "What does this actually say?",
      files: [report],
    });
  });

  it("saves without an attachment the user removed", async () => {
    const { onSubmit } = renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "Remove attachment" }));
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].files).toEqual([]);
  });

  it("attaches a file added while editing", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      blob: async () => new Blob(["hi"], { type: "text/plain" }),
    }) as unknown as typeof global.fetch;
    const { onSubmit } = renderEditor();

    const input = screen.getByLabelText("Upload files") as HTMLInputElement;
    Object.defineProperty(input, "files", {
      value: [new File(["hi"], "extra.txt", { type: "text/plain" })],
      configurable: true,
    });
    fireEvent.change(input);

    expect(screen.getByText("extra.txt")).toBeInTheDocument();

    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].files).toEqual([
      expect.objectContaining({ filename: "report.pdf" }),
      expect.objectContaining({ filename: "extra.txt" }),
    ]);
  });

  it("cancels on Escape without saving", () => {
    const { onSubmit, onCancel } = renderEditor();

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });

    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("cancels from the Cancel action", () => {
    const { onCancel } = renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalled();
  });

  it("saves on Enter", async () => {
    const { onSubmit } = renderEditor();

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  });

  it("keeps Shift+Enter as a newline rather than a save", () => {
    const { onSubmit } = renderEditor();

    fireEvent.keyDown(screen.getByRole("textbox"), {
      key: "Enter",
      shiftKey: true,
    });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  // Anything that shapes the message's parts stays; anything that configures
  // the Chat or the run goes. The picker is the exception the ticket argues
  // for: an edit re-runs on live composer state, so the surface has to name it.
  it("carries the model picker and nothing that configures the Chat", () => {
    renderEditor();

    expect(screen.getByRole("button", { name: "m1" })).toBeInTheDocument();
    for (const gone of ["Settings", "Search", "Agent Information"]) {
      expect(screen.queryByRole("button", { name: gone })).toBeNull();
    }
  });

  // Opening on a message means opening ready to replace it, not ready to
  // append to it.
  it("selects the text it opens on", () => {
    renderEditor();

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe("What does this say?".length);
  });

  // The composer owns the window-level drop (`globalDrop`); a second input
  // claiming it would take the same file a second time.
  it("does not claim a file dropped on the window", () => {
    renderEditor();

    fireEvent.drop(document, {
      dataTransfer: {
        types: ["Files"],
        files: [new File(["hi"], "dropped.png", { type: "image/png" })],
      },
    });

    expect(screen.queryByText("dropped.png")).toBeNull();
  });

  // …but a file dropped ON the edit surface is the edit's, and it must not fall
  // through to the composer's window-level listener.
  it("keeps a file dropped on itself, and stops it bubbling onward", () => {
    const onWindowDrop = vi.fn();
    document.addEventListener("drop", onWindowDrop);
    // Both types read natively, so the compatibility notice stays out of the
    // way — it would otherwise name the dropped file a second time.
    const { container } = renderEditor({
      passthroughFileTypes: ["application/pdf", "image/png"],
    });

    fireEvent.drop(container.querySelector("form")!, {
      dataTransfer: {
        types: ["Files"],
        files: [new File(["hi"], "dropped.png", { type: "image/png" })],
      },
    });

    expect(screen.getByText("dropped.png")).toBeInTheDocument();
    expect(onWindowDrop).not.toHaveBeenCalled();
    document.removeEventListener("drop", onWindowDrop);
  });

  it("writes dictation into the edited message", async () => {
    const { onSubmit } = renderEditor({ initialText: "" });

    fireEvent.click(screen.getByRole("button", { name: "Microphone" }));
    lastRecognition?.emitFinalResult("dictated words");

    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveValue("dictated words"),
    );

    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].text).toBe("dictated words");
  });

  it("warns when the selected model cannot read an attached type", () => {
    renderEditor({ passthroughFileTypes: ["image/png"] });

    expect(screen.getByRole("status")).toHaveTextContent("report.pdf");
  });
});
