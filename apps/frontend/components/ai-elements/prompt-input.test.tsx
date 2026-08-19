import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  PromptInput,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputTextarea,
} from "./prompt-input";

beforeEach(() => {
  // jsdom has no matchMedia; PromptInputTextarea subscribes to it via useIsMobile.
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
});

function getFileInput() {
  return screen.getByLabelText("Upload files") as HTMLInputElement;
}

function fireFileChange(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, "files", {
    value: files,
    configurable: true,
  });
  fireEvent.change(input);
}

describe("PromptInput accept filtering", () => {
  it("accepts a file matching an extension pattern and rejects one that doesn't", () => {
    const onError = vi.fn();
    render(
      <PromptInput accept=".pdf" onError={onError} onSubmit={vi.fn()}>
        <PromptInputAttachments className="w-full">
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        <PromptInputBody>
          <PromptInputTextarea />
        </PromptInputBody>
      </PromptInput>,
    );

    const input = getFileInput();
    const txtFile = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireFileChange(input, [txtFile]);

    expect(onError).toHaveBeenCalledWith({
      code: "accept",
      message: "No files match the accepted types.",
    });
    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();

    const pdfFile = new File(["%PDF"], "report.pdf", {
      type: "application/pdf",
    });
    fireFileChange(input, [pdfFile]);

    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });

  it("accepts a file matching an explicit mime type beyond image/*", () => {
    const onError = vi.fn();
    render(
      <PromptInput
        accept="application/json"
        onError={onError}
        onSubmit={vi.fn()}
      >
        <PromptInputAttachments className="w-full">
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        <PromptInputBody>
          <PromptInputTextarea />
        </PromptInputBody>
      </PromptInput>,
    );

    const input = getFileInput();
    const jsonFile = new File(["{}"], "data.json", {
      type: "application/json",
    });
    fireFileChange(input, [jsonFile]);

    expect(onError).not.toHaveBeenCalled();
    expect(screen.getByText("data.json")).toBeInTheDocument();
  });
});

describe("PromptInput attachments", () => {
  it("adds and removes an attachment", () => {
    render(
      <PromptInput onSubmit={vi.fn()}>
        <PromptInputAttachments className="w-full">
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        <PromptInputBody>
          <PromptInputTextarea />
        </PromptInputBody>
      </PromptInput>,
    );

    const input = getFileInput();
    const file = new File(["hi"], "photo.png", { type: "image/png" });
    fireFileChange(input, [file]);

    expect(screen.getByText("photo.png")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove attachment" }));

    expect(screen.queryByText("photo.png")).not.toBeInTheDocument();
  });

  it("enforces maxFiles and maxFileSize", () => {
    const onError = vi.fn();
    render(
      <PromptInput
        maxFiles={1}
        maxFileSize={10}
        onError={onError}
        onSubmit={vi.fn()}
      >
        <PromptInputAttachments className="w-full">
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        <PromptInputBody>
          <PromptInputTextarea />
        </PromptInputBody>
      </PromptInput>,
    );

    const input = getFileInput();
    const tooBig = new File(["x".repeat(20)], "big.txt", {
      type: "text/plain",
    });
    fireFileChange(input, [tooBig]);
    expect(onError).toHaveBeenCalledWith({
      code: "max_file_size",
      message: "All files exceed the maximum size.",
    });

    const small1 = new File(["a"], "a.txt", { type: "text/plain" });
    const small2 = new File(["b"], "b.txt", { type: "text/plain" });
    fireFileChange(input, [small1, small2]);

    expect(onError).toHaveBeenCalledWith({
      code: "max_files",
      message: "Too many files. Some were not added.",
    });
    expect(screen.getByText("a.txt")).toBeInTheDocument();
    expect(screen.queryByText("b.txt")).not.toBeInTheDocument();
  });

  it("adds files dropped anywhere on the document when globalDrop is set", () => {
    render(
      <PromptInput globalDrop onSubmit={vi.fn()}>
        <PromptInputAttachments className="w-full">
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        <PromptInputBody>
          <PromptInputTextarea />
        </PromptInputBody>
      </PromptInput>,
    );

    const file = new File(["hi"], "dropped.png", { type: "image/png" });

    fireEvent.drop(document, {
      dataTransfer: {
        types: ["Files"],
        files: [file],
      },
    });

    expect(screen.getByText("dropped.png")).toBeInTheDocument();
  });
});
