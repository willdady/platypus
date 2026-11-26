import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useRef, useState } from "react";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { Composer, type ModelPickerConfig } from "./composer";
import {
  PromptInputSpeechButton,
  type PromptInputMessage,
} from "./ai-elements/prompt-input";
import { toast } from "sonner";
import {
  composerProvider,
  installSpeechRecognition,
  uninstallSpeechRecognition,
  setSecureContext,
} from "@/test/chat-test-fixtures";

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

let recognition: ReturnType<typeof installSpeechRecognition>;

function renderComposer({
  canUploadToSandbox = false,
  onSubmit = vi.fn<(message: PromptInputMessage) => void>(),
  placeholder = "Ask anything",
}: {
  canUploadToSandbox?: boolean;
  onSubmit?: (message: PromptInputMessage) => void;
  placeholder?: string;
} = {}) {
  const onModelChange = vi.fn();

  const Harness = () => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [value, setValue] = useState("");
    const [modelId, setModelId] = useState("");

    return (
      <Composer
        onSubmit={onSubmit}
        canUploadToSandbox={canUploadToSandbox}
        passthroughFileTypes={[]}
        modelSelection={{
          agents: [],
          providers: [composerProvider],
          agentId: "",
          modelId,
          providerId: modelId ? composerProvider.id : "",
          isResolved: true,
          onModelChange: (v) => {
            onModelChange(v);
            setModelId("gpt-4o");
          },
        }}
        textarea={{
          ref: textareaRef,
          value,
          onChange: (e) => setValue(e.target.value),
          placeholder,
        }}
        onTranscriptionChange={vi.fn()}
        submit={<button type="submit">Send</button>}
      />
    );
  };

  render(<Harness />);

  return {
    onModelChange,
    textarea: screen.getByRole("textbox", { name: "Message" }),
    trigger: screen.getByRole("button", { name: "Select model" }),
    mic: screen.getByRole("button", { name: "Microphone" }),
  };
}

function openPicker(trigger: HTMLElement) {
  fireEvent.click(trigger);
  return screen.getByRole("option", { name: "gpt-4o" });
}

function recordFocus() {
  const targets: EventTarget[] = [];
  document.addEventListener("focusin", (e) => targets.push(e.target!));
  return targets;
}

beforeEach(() => {
  setSecureContext(true);
  recognition = installSpeechRecognition();
});

afterEach(uninstallSpeechRecognition);

describe("Composer textarea name", () => {
  it("is named Message whatever the placeholder says", () => {
    renderComposer({ placeholder: "Run in progress…" });

    expect(
      screen.getByRole("textbox", { name: "Message" }),
    ).toBeInTheDocument();
  });
});

describe("Composer model picker focus", () => {
  it("returns focus to the textarea when a model is selected", async () => {
    const { textarea, trigger, onModelChange } = renderComposer();

    fireEvent.click(openPicker(trigger));

    expect(onModelChange).toHaveBeenCalledWith("provider:provider-1:gpt-4o");
    await waitFor(() => expect(textarea).toHaveFocus());
  });

  it("returns focus to the textarea when the picker is dismissed without a selection", async () => {
    const { textarea, trigger, onModelChange } = renderComposer();

    openPicker(trigger);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });

    expect(onModelChange).not.toHaveBeenCalled();
    await waitFor(() => expect(textarea).toHaveFocus());
  });

  it("does not pass focus through the trigger button on the way back", async () => {
    const { textarea, trigger } = renderComposer();

    const item = openPicker(trigger);
    const focused = recordFocus();
    fireEvent.click(item);
    await waitFor(() => expect(textarea).toHaveFocus());

    expect(focused).toEqual([textarea]);
    expect(focused).not.toContain(trigger);
  });

  // why: fireEvent returns false when the press was default-prevented
  it("does not let a press on the trigger take focus off the composer", () => {
    const { trigger } = renderComposer();

    expect(fireEvent.mouseDown(trigger)).toBe(false);
  });

  it("does not let a press on a model take focus off the search box", () => {
    const { trigger } = renderComposer();
    const item = openPicker(trigger);

    expect(fireEvent.mouseDown(item)).toBe(false);
  });

  it("still opens and switches model when the picker is pressed, not just clicked", async () => {
    const { textarea, trigger, onModelChange } = renderComposer();

    fireEvent.mouseDown(trigger);
    fireEvent.mouseUp(trigger);
    fireEvent.click(trigger);

    const item = screen.getByText("gpt-4o");
    fireEvent.mouseDown(item);
    fireEvent.mouseUp(item);
    fireEvent.click(item);

    expect(onModelChange).toHaveBeenCalledWith("provider:provider-1:gpt-4o");
    await waitFor(() => expect(textarea).toHaveFocus());
  });
});

describe("Composer dictation", () => {
  it("starts recognition when the mic is clicked", () => {
    const { mic } = renderComposer();

    fireEvent.click(mic);

    expect(recognition()?.start).toHaveBeenCalled();
  });

  it("stops recognition when the mic is clicked again", () => {
    const { mic } = renderComposer();

    fireEvent.click(mic);
    fireEvent.click(mic);

    expect(recognition()?.stop).toHaveBeenCalled();
  });

  it("still runs an onClick supplied by a wrapping trigger", () => {
    const onClick = vi.fn();
    render(
      <PromptInputSpeechButton aria-label="Microphone" onClick={onClick} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Microphone" }));

    expect(onClick).toHaveBeenCalled();
    expect(recognition()?.start).toHaveBeenCalled();
  });
});

describe("Composer dictation failures", () => {
  it("says why voice input cannot run outside a secure context", () => {
    // why: a LAN http origin has the API on window, but no browser grants a mic
    setSecureContext(false);

    const { mic } = renderComposer();
    fireEvent.click(mic);

    expect(recognition()).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(
      "Voice input needs a secure connection. Open this page over HTTPS or on localhost.",
    );
  });

  it("tells the user when the microphone is blocked", () => {
    const { mic } = renderComposer();
    fireEvent.click(mic);

    act(() => recognition()?.onerror?.({ error: "not-allowed" }));

    expect(toast.error).toHaveBeenCalledWith(
      "Microphone access is blocked. Allow the microphone for this site in your browser settings.",
    );
  });

  it("says nothing when the microphone simply heard nothing", () => {
    const { mic } = renderComposer();
    fireEvent.click(mic);

    act(() => recognition()?.onerror?.({ error: "no-speech" }));

    expect(toast.error).not.toHaveBeenCalled();
  });

  it("keeps the mic pressable where dictation is unavailable, so it can explain", () => {
    Reflect.deleteProperty(window, "SpeechRecognition");

    const { mic } = renderComposer();

    // why: a disabled button takes no pointer events, so its tooltip can't explain
    expect(mic).toBeEnabled();

    fireEvent.click(mic);

    expect(toast.error).toHaveBeenCalledWith(
      "Voice input isn't supported in this browser.",
    );
  });
});

describe("Composer model picker — unsettled selection", () => {
  const renderPicker = (isResolved: boolean) => {
    const textareaRef = { current: null };
    render(
      <Composer
        onSubmit={vi.fn()}
        passthroughFileTypes={[]}
        modelSelection={{
          agents: [],
          providers: [composerProvider],
          agentId: "",
          modelId: "",
          providerId: "",
          isResolved,
          onModelChange: vi.fn(),
        }}
        textarea={{
          ref: textareaRef,
          value: "",
          onChange: vi.fn(),
          placeholder: "Ask anything",
        }}
        onTranscriptionChange={vi.fn()}
        submit={<button type="submit">Send</button>}
      />,
    );
  };

  it("shows no selection label until the selection resolves", () => {
    renderPicker(false);

    expect(screen.queryByText("Select model")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Loading selection")).toBeInTheDocument();
  });

  it("labels the trigger once the selection has resolved", () => {
    renderPicker(true);

    expect(screen.getByText("Select model")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Loading selection"),
    ).not.toBeInTheDocument();
  });
});

describe("Composer model picker — substituted selection", () => {
  const renderWith = (substitution?: ModelPickerConfig["substitution"]) => {
    render(
      <Composer
        onSubmit={vi.fn()}
        passthroughFileTypes={[]}
        modelSelection={{
          agents: [],
          providers: [composerProvider],
          agentId: "",
          modelId: "gpt-4o",
          providerId: composerProvider.id,
          isResolved: true,
          substitution,
          onModelChange: vi.fn(),
        }}
        textarea={{
          ref: { current: null },
          value: "",
          onChange: vi.fn(),
          placeholder: "Ask anything",
        }}
        onTranscriptionChange={vi.fn()}
        submit={<button type="submit">Send</button>}
      />,
    );
  };

  it("says the chat's own Agent is gone and a different model is in use", () => {
    renderWith({ missing: "agent", source: "chat" });

    expect(screen.getByRole("status")).toHaveTextContent(
      "This chat's Agent is no longer available, so it's using a different model.",
    );
  });

  it("says the last-used model is gone for a new chat", () => {
    renderWith({ missing: "model", source: "lastUsed" });

    expect(screen.getByRole("status")).toHaveTextContent(
      "The model you last used is no longer available, so this chat is using a different one.",
    );
  });

  it("says nothing when the selection is the one asked for", () => {
    renderWith(undefined);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("Composer Sandbox uploads", () => {
  const openMenu = () => {
    const plus = screen.getByRole("button", { name: "Add attachments" });
    fireEvent.keyDown(plus, { key: "Enter" });
  };

  const pickForSandbox = (file: File) =>
    fireEvent.change(screen.getByLabelText("Upload files to Sandbox"), {
      target: { files: [file] },
    });

  const csv = () => new File(["a,b"], "data.csv", { type: "text/csv" });

  it("offers Upload to Sandbox when the Chat can upload", () => {
    renderComposer({ canUploadToSandbox: true });
    openMenu();

    expect(
      screen.getByRole("menuitem", { name: /Upload to Sandbox/ }),
    ).toBeInTheDocument();
  });

  it("hides Upload to Sandbox when it cannot", () => {
    renderComposer();
    openMenu();

    expect(
      screen.getByRole("menuitem", { name: /Add photos or files/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /Upload to Sandbox/ }),
    ).not.toBeInTheDocument();
  });

  it("shows a picked file as a Sandbox chip with no preview", () => {
    renderComposer({ canUploadToSandbox: true });

    pickForSandbox(new File(["x"], "photo.png", { type: "image/png" }));

    expect(screen.getByText("photo.png")).toBeInTheDocument();
    expect(screen.getByText("Sandbox")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("refuses a file over the transfer bound when it is picked", () => {
    renderComposer({ canUploadToSandbox: true });
    const big = csv();
    Object.defineProperty(big, "size", { value: 25 * 1024 * 1024 + 1 });

    pickForSandbox(big);

    expect(toast.error).toHaveBeenCalled();
    expect(screen.queryByText("data.csv")).not.toBeInTheDocument();
  });

  it("locks the Agent picker while a Sandbox chip is held", () => {
    renderComposer({ canUploadToSandbox: true });

    pickForSandbox(csv());

    const picker = () => screen.getByRole("button", { name: "Select model" });
    expect(picker()).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Sandbox upload" }),
    );
    expect(picker()).toBeEnabled();
  });

  it("does not lock the picker for a File part alone", () => {
    const { trigger } = renderComposer({ canUploadToSandbox: true });

    fireEvent.change(screen.getByLabelText("Upload files"), {
      target: { files: [csv()] },
    });

    expect(screen.getByText("data.csv")).toBeInTheDocument();
    expect(trigger).toBeEnabled();
  });

  it("keeps the typed text when the Send fails", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("upload failed"));
    const { textarea } = renderComposer({ canUploadToSandbox: true, onSubmit });

    fireEvent.change(textarea, { target: { value: "Summarise it" } });
    pickForSandbox(csv());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(textarea).toHaveValue("Summarise it");
    expect(screen.getByText("data.csv")).toBeInTheDocument();
  });

  it("submits the Sandbox files beside the File parts", async () => {
    const onSubmit = vi.fn();
    renderComposer({ canUploadToSandbox: true, onSubmit });
    const file = csv();

    pickForSandbox(file);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      files: [],
      sandboxFiles: [file],
    });
  });
});
