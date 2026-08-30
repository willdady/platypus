import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useRef, useState } from "react";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import type { Provider } from "@platypus/schemas";
import { Composer } from "./composer";
import { PromptInputSpeechButton } from "./ai-elements/prompt-input";
import { toast } from "sonner";

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

const provider = {
  id: "provider-1",
  name: "OpenAI",
  modelIds: ["gpt-4o"],
} as unknown as Provider;

const renderComposer = () => {
  const onModelChange = vi.fn();

  const Harness = () => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [value, setValue] = useState("");
    const [modelId, setModelId] = useState("");

    return (
      <Composer
        onSubmit={vi.fn()}
        passthroughFileTypes={[]}
        modelSelection={{
          agents: [],
          providers: [provider],
          agentId: "",
          modelId,
          providerId: modelId ? provider.id : "",
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

const setSecureContext = (value: boolean) => {
  Object.defineProperty(window, "isSecureContext", {
    value,
    configurable: true,
  });
};

/** Records every element that takes focus from this point on, in order. */
const recordFocus = () => {
  const targets: EventTarget[] = [];
  document.addEventListener("focusin", (e) => targets.push(e.target!));
  return targets;
};

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no matchMedia; PromptInputTextarea subscribes to it.
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
  // cmdk scrolls the active item into view and observes its list.
  Element.prototype.scrollIntoView = vi.fn();
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  lastRecognition = null;
  setSecureContext(true);
  window.SpeechRecognition =
    TrackingSpeechRecognition as unknown as Window["SpeechRecognition"];
});

afterEach(() => {
  Reflect.deleteProperty(window, "SpeechRecognition");
});

describe("Composer model picker focus", () => {
  it("returns focus to the textarea when a model is selected", async () => {
    const { textarea, trigger, onModelChange } = renderComposer();

    fireEvent.click(openPicker(trigger));

    expect(onModelChange).toHaveBeenCalled();
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

    expect(onModelChange).toHaveBeenCalled();
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

    expect(lastRecognition?.start).toHaveBeenCalled();
  });

  it("stops recognition when the mic is clicked again", () => {
    const { mic } = renderComposer();

    fireEvent.click(mic);
    fireEvent.click(mic);

    expect(lastRecognition?.stop).toHaveBeenCalled();
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
    expect(lastRecognition?.start).toHaveBeenCalled();
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

    expect(lastRecognition).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(
      "Voice input needs a secure connection. Open this page over HTTPS or on localhost.",
    );
  });

  it("tells the user when the microphone is blocked", () => {
    const { mic } = renderComposer();
    fireEvent.click(mic);

    act(() => lastRecognition?.onerror?.({ error: "not-allowed" }));

    expect(toast.error).toHaveBeenCalledWith(
      "Microphone access is blocked. Allow the microphone for this site in your browser settings.",
    );
  });

  it("says nothing when the microphone simply heard nothing", () => {
    const { mic } = renderComposer();
    fireEvent.click(mic);

    act(() => lastRecognition?.onerror?.({ error: "no-speech" }));

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
