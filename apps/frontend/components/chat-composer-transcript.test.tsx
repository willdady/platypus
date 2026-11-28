import { describe, it, expect, vi } from "vitest";
import { useRef, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "./composer";
import { composerProvider } from "@/test/chat-test-fixtures";

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

function renderControlledComposer() {
  let repaint: () => void = () => {};

  const Harness = () => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [value, setValue] = useState("");
    const [, forceRender] = useState(0);
    repaint = () => forceRender((n) => n + 1);

    return (
      <Composer
        onSubmit={vi.fn()}
        canUploadToSandbox={false}
        passthroughFileTypes={[]}
        modelSelection={{
          agents: [],
          providers: [composerProvider],
          agentId: "",
          modelId: "",
          providerId: "",
          isResolved: true,
          onModelChange: vi.fn(),
        }}
        textarea={{
          ref: textareaRef,
          value,
          onChange: (e) => setValue(e.target.value),
        }}
        onTranscriptionChange={setValue}
        submit={<button type="submit">Send</button>}
      />
    );
  };

  render(<Harness />);

  const textarea = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Message",
  });

  return {
    textarea,
    // why: dictation writes through the accessibility API, so no `input` event fires
    writeOutsideReact: (text: string) => {
      textarea.value = text;
    },
    repaint: () => act(() => repaint()),
  };
}

describe("Composer text written outside React", () => {
  it("keeps a transcript that arrived without an input event", () => {
    const { textarea, writeOutsideReact, repaint } = renderControlledComposer();

    writeOutsideReact("meeting notes");
    repaint();

    expect(textarea.value).toBe("meeting notes");
  });

  it("still clears after a send", () => {
    const { textarea, writeOutsideReact, repaint } = renderControlledComposer();
    writeOutsideReact("meeting notes");
    repaint();

    // why: the owner resets its state once the message is on its way
    act(() => {
      textarea.value = "";
      repaint();
    });
    fireEvent.change(textarea, { target: { value: "" } });

    expect(textarea.value).toBe("");
  });

  it("keeps following typing", () => {
    const { textarea, repaint } = renderControlledComposer();

    fireEvent.change(textarea, { target: { value: "hello" } });
    repaint();
    fireEvent.change(textarea, { target: { value: "hello world" } });
    repaint();

    expect(textarea.value).toBe("hello world");
  });
});
