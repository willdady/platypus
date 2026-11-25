import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Provider } from "@platypus/schemas";

// why: the picker is stubbed — its own tests cover it; this proves the surface names it
vi.mock("./model-selector-dialog", () => ({
  ModelSelectorDialog: ({ modelId }: { modelId: string }) => (
    <button type="button">{modelId || "Select model"}</button>
  ),
}));

import { MessageEditor } from "./message-editor";
import {
  reportPdf,
  installSpeechRecognition,
  uninstallSpeechRecognition,
} from "@/test/chat-test-fixtures";
import type { Serialized } from "@/lib/api-write";

let recognition: ReturnType<typeof installSpeechRecognition>;

beforeEach(() => {
  recognition = installSpeechRecognition();
});

afterEach(() => {
  uninstallSpeechRecognition();
});

const provider = {
  id: "p1",
  name: "OpenRouter",
  modelIds: [{ id: "m1", passthroughFileTypes: [] }],
} as unknown as Serialized<Provider>;

function renderEditor(
  overrides: Partial<React.ComponentProps<typeof MessageEditor>> = {},
) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <MessageEditor
      initialText="What does this say?"
      initialAttachments={[reportPdf]}
      modelSelection={{
        agents: [],
        providers: [provider],
        agentId: "",
        modelId: "m1",
        providerId: "p1",
        isResolved: true,
        onModelChange: vi.fn(),
      }}
      passthroughFileTypes={["application/pdf"]}
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { ...view, onSubmit, onCancel };
}

function save() {
  return fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

describe("MessageEditor", () => {
  it("opens holding the message's text and its attachments", () => {
    renderEditor();

    expect(screen.getByRole("textbox")).toHaveValue("What does this say?");
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });

  it("saves an edited message with its original attachments intact", async () => {
    const { onSubmit } = renderEditor();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "What does this actually say?" },
    });
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toEqual({
      text: "What does this actually say?",
      files: [reportPdf],
      sandboxFiles: [],
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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        blob: async () => new Blob(["hi"], { type: "text/plain" }),
      }),
    );
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

  it("carries the model picker and nothing that configures the Chat", () => {
    renderEditor();

    expect(screen.getByRole("button", { name: "m1" })).toBeInTheDocument();
    for (const gone of ["Settings", "Search", "Agent info"]) {
      expect(
        screen.queryByRole("button", { name: gone }),
      ).not.toBeInTheDocument();
    }
  });

  it("selects the text it opens on", () => {
    renderEditor();

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe("What does this say?".length);
  });

  it("does not claim a file dropped on the window", () => {
    renderEditor();

    fireEvent.drop(document, {
      dataTransfer: {
        types: ["Files"],
        files: [new File(["hi"], "dropped.png", { type: "image/png" })],
      },
    });

    expect(screen.queryByText("dropped.png")).not.toBeInTheDocument();
  });

  it("keeps a file dropped on itself, and stops it bubbling onward", () => {
    const onWindowDrop = vi.fn();
    document.addEventListener("drop", onWindowDrop);
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
    recognition()?.emitFinalResult("dictated words");

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
