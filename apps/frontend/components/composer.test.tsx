import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useRef, useState } from "react";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { Composer } from "./composer";
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
} from "@/lib/chat-test-fixtures";
import {
  installMatchMediaStub,
  installResizeObserverStub,
} from "@/lib/test-utils";

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

/**
 * Issue #749: switching models dropped the Android on-screen keyboard and
 * brought it back a moment later. Chrome shows the keyboard while an editable
 * element has focus, so anything that parks focus elsewhere in between is a
 * flap, and the picker did it twice.
 *
 * The first pass fixed the tail: Radix returned focus to the trigger button on
 * close and a 250ms timer then moved it to the textarea, so the picker now
 * takes over the close and focuses the textarea itself. That alone was not
 * enough — a press inside the picker focuses the nearest focusable ancestor
 * first, which is the trigger button on the way in and cmdk's scrolling list on
 * the way out, and the list held focus for the dialog's whole exit animation.
 * The picker suppresses the browser's focus-on-press for both.
 *
 * jsdom has no virtual keyboard and does not move focus on a press, so it
 * cannot show either symptom. These tests pin what the fix rests on instead:
 * the press is default-prevented, focus lands on the textarea in a single move,
 * and neither opening nor selecting broke. The focus timeline it produces in a
 * real browser was measured under mobile emulation; the keyboard itself needs a
 * physical device.
 */

/** The session the composer most recently constructed. */
let recognition: ReturnType<typeof installSpeechRecognition>;

const renderComposer = ({
  canUploadToSandbox = false,
  onSubmit = vi.fn(),
}: {
  canUploadToSandbox?: boolean;
  onSubmit?: (message: PromptInputMessage) => void;
} = {}) => {
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
          placeholder: "Ask anything",
        }}
        onTranscriptionChange={vi.fn()}
        submit={<button type="submit">Send</button>}
      />
    );
  };

  render(<Harness />);

  return {
    onModelChange,
    textarea: screen.getByPlaceholderText("Ask anything"),
    trigger: screen.getByText("Select model").closest("button")!,
    mic: screen.getByRole("button", { name: "Microphone" }),
  };
};

const openPicker = (trigger: HTMLElement) => {
  fireEvent.click(trigger);
  return screen.getByText("gpt-4o");
};

/** Records every element that takes focus from this point on, in order. */
const recordFocus = () => {
  const targets: EventTarget[] = [];
  document.addEventListener("focusin", (e) => targets.push(e.target!));
  return targets;
};

beforeEach(() => {
  vi.clearAllMocks();
  installMatchMediaStub();
  installResizeObserverStub();
  // cmdk scrolls the active item into view.
  Element.prototype.scrollIntoView = () => {};
  setSecureContext(true);
  recognition = installSpeechRecognition();
});

afterEach(uninstallSpeechRecognition);

describe("Composer model picker focus", () => {
  it("returns focus to the textarea when a model is selected", async () => {
    const { textarea, trigger, onModelChange } = renderComposer();

    fireEvent.click(openPicker(trigger));

    expect(onModelChange).toHaveBeenCalledWith("provider:provider-1:gpt-4o");
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });

  it("returns focus to the textarea when the picker is dismissed without a selection", async () => {
    const { textarea, trigger, onModelChange } = renderComposer();

    openPicker(trigger);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    expect(onModelChange).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });

  it("does not pass focus through the trigger button on the way back", async () => {
    const { textarea, trigger } = renderComposer();

    const item = openPicker(trigger);
    // Only the close is under test; opening the picker legitimately moves
    // focus into it.
    const focused = recordFocus();
    fireEvent.click(item);
    await waitFor(() => expect(document.activeElement).toBe(textarea));

    // One move, straight to the textarea. Landing on the trigger first is the
    // regression: on mobile it drops the keyboard before the textarea reopens it.
    expect(focused).toEqual([textarea]);
    expect(focused).not.toContain(trigger);
  });

  // A press that is default-prevented never moves focus, so the textarea keeps
  // it while the picker opens and the search box keeps it while the picker
  // closes. `fireEvent` returns false for exactly that.
  it("does not let a press on the trigger take focus off the composer", () => {
    const { trigger } = renderComposer();

    expect(fireEvent.mouseDown(trigger)).toBe(false);
  });

  it("does not let a press on a model take focus off the search box", () => {
    const { trigger } = renderComposer();
    const item = openPicker(trigger).closest("[cmdk-item]")!;

    expect(fireEvent.mouseDown(item)).toBe(false);
  });

  it("still opens and switches model when the picker is pressed, not just clicked", async () => {
    const { textarea, trigger, onModelChange } = renderComposer();

    // Selection runs off `click`, which a prevented `mousedown` does not stop —
    // press both the trigger and the model the way a real tap does.
    fireEvent.mouseDown(trigger);
    fireEvent.mouseUp(trigger);
    fireEvent.click(trigger);

    const item = screen.getByText("gpt-4o");
    fireEvent.mouseDown(item);
    fireEvent.mouseUp(item);
    fireEvent.click(item);

    expect(onModelChange).toHaveBeenCalledWith("provider:provider-1:gpt-4o");
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });
});

/**
 * Issue #752: the mic button wrote its own `onClick` before spreading caller
 * props, so the `onClick` that Radix's TooltipTrigger injects through `asChild`
 * replaced it. The tap closed the tooltip and did nothing else, so dictation
 * never started - on any platform, not just the Android one it was reported on.
 *
 * These drive the composer as a user meets it, mic inside its tooltip trigger,
 * because that wrapper is the whole defect. Asserting on a transcript alone
 * cannot catch it: recognition is constructed on mount, so a test that emits a
 * result directly on it passes whether or not the click ever landed.
 */
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

    // Both run: the wrapper keeps its behaviour - a tooltip still closes on
    // tap - and the button keeps its own.
    expect(onClick).toHaveBeenCalled();
    expect(recognition()?.start).toHaveBeenCalled();
  });
});

/**
 * Issue #768: a recognition failure only reached `console.error`. On a phone
 * there is no console short of `chrome://inspect` over USB, so permission
 * denial, an unavailable speech service and a tap that never landed all
 * presented the same way - as nothing happening.
 */
describe("Composer dictation failures", () => {
  it("says why voice input cannot run outside a secure context", () => {
    // A LAN address over plain http: the constructor is still on `window`, so
    // the API looks available, but no browser grants a microphone here.
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

    // A disabled button takes no pointer events, so its tooltip never opens
    // and the reason never reaches anyone.
    expect(mic).not.toBeDisabled();

    fireEvent.click(mic);

    expect(toast.error).toHaveBeenCalledWith(
      "Voice input isn't supported in this browser.",
    );
  });
});

/**
 * Issue #799: the picker used to paint "Select model" — which reads as "you
 * have nothing selected" — for as long as the restore ladder took to produce a
 * result, then swap to the Agent the reader had selected in the previous chat.
 * While the selection is unsettled the trigger says nothing at all.
 */
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

    expect(screen.queryByText("Select model")).toBeNull();
    expect(screen.getByLabelText("Loading selection")).toBeInTheDocument();
  });

  it("labels the trigger once the selection has resolved", () => {
    renderPicker(true);

    expect(screen.getByText("Select model")).toBeInTheDocument();
    expect(screen.queryByLabelText("Loading selection")).toBeNull();
  });
});

describe("Composer Sandbox uploads", () => {
  const openMenu = () => {
    const plus = screen
      .getAllByRole("button")
      .find((b) => b.getAttribute("aria-haspopup") === "menu")!;
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

    expect(screen.getByRole("menuitem", { name: /Add photos or files/ }));
    expect(
      screen.queryByRole("menuitem", { name: /Upload to Sandbox/ }),
    ).toBeNull();
  });

  it("shows a picked file as a Sandbox chip with no preview", () => {
    renderComposer({ canUploadToSandbox: true });

    pickForSandbox(new File(["x"], "photo.png", { type: "image/png" }));

    expect(screen.getByText("photo.png")).toBeInTheDocument();
    expect(screen.getByText("Sandbox")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("refuses a file over the transfer bound when it is picked", () => {
    renderComposer({ canUploadToSandbox: true });
    const big = csv();
    Object.defineProperty(big, "size", { value: 25 * 1024 * 1024 + 1 });

    pickForSandbox(big);

    expect(toast.error).toHaveBeenCalled();
    expect(screen.queryByText("data.csv")).toBeNull();
  });

  it("locks the Agent picker while a Sandbox chip is held", () => {
    renderComposer({ canUploadToSandbox: true });

    pickForSandbox(csv());

    const picker = () => screen.getByText("Select model").closest("button");
    expect(picker()).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Sandbox upload" }),
    );
    expect(picker()).not.toBeDisabled();
  });

  it("does not lock the picker for a File part alone", () => {
    const { trigger } = renderComposer({ canUploadToSandbox: true });

    fireEvent.change(screen.getByLabelText("Upload files"), {
      target: { files: [csv()] },
    });

    expect(screen.getByText("data.csv")).toBeInTheDocument();
    expect(trigger).not.toBeDisabled();
  });

  // The owner clears the text once a Send succeeds; a failed one must leave
  // it where it was.
  it("keeps the typed text when the Send fails", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("upload failed"));
    const { textarea } = renderComposer({ canUploadToSandbox: true, onSubmit });

    fireEvent.change(textarea, { target: { value: "Summarise it" } });
    pickForSandbox(csv());
    fireEvent.submit(textarea.closest("form")!);

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(textarea).toHaveValue("Summarise it");
    expect(screen.getByText("data.csv")).toBeInTheDocument();
  });

  it("submits the Sandbox files beside the File parts", async () => {
    const onSubmit = vi.fn();
    const { textarea } = renderComposer({ canUploadToSandbox: true, onSubmit });
    const file = csv();

    pickForSandbox(file);
    fireEvent.submit(textarea.closest("form")!);

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      files: [],
      sandboxFiles: [file],
    });
  });
});
