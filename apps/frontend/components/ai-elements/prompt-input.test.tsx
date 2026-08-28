import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  PromptInput,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputSubmit,
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

/**
 * Two inputs on one page (issue #710: the composer plus an inline edit
 * surface). The composer claims the window-level drop; the edit surface must
 * still keep a file dropped on itself, and exactly one of them may take it.
 */
describe("PromptInput drop routing with two inputs", () => {
  const named = (label: string, globalDrop: boolean) => (
    <PromptInput globalDrop={globalDrop} multiple onSubmit={vi.fn()}>
      <PromptInputAttachments className="w-full">
        {(attachment) => (
          <PromptInputAttachment
            data={attachment}
            data-testid={`${label}-chip`}
          />
        )}
      </PromptInputAttachments>
      <PromptInputBody>
        <PromptInputTextarea />
      </PromptInputBody>
    </PromptInput>
  );

  const dropOn = (target: Element | Document) =>
    fireEvent.drop(target, {
      dataTransfer: {
        types: ["Files"],
        files: [new File(["hi"], "dropped.png", { type: "image/png" })],
      },
    });

  const chips = (label: string) => screen.queryAllByTestId(`${label}-chip`);

  const renderBoth = () =>
    render(
      <>
        {named("composer", true)}
        {named("editor", false)}
      </>,
    ).container.querySelectorAll("form");

  // The defect: the edit surface's own drop never bound (the ref was resolved
  // by walking up from a span rendered OUTSIDE the form), so the file fell
  // through to the composer's window-level listener — landing in the composer
  // and never in the surface it was dropped on.
  it("gives a file dropped on the inline input to that input alone", () => {
    const forms = renderBoth();

    dropOn(forms[1]);

    expect(chips("editor")).toHaveLength(1);
    expect(chips("composer")).toHaveLength(0);
  });

  it("takes a file dropped on the composer once, not twice", () => {
    const forms = renderBoth();

    dropOn(forms[0]);

    expect(chips("composer")).toHaveLength(1);
    expect(chips("editor")).toHaveLength(0);
  });

  it("leaves a drop on neither input to whichever claimed the window", () => {
    renderBoth();

    dropOn(document);

    expect(chips("composer")).toHaveLength(1);
    expect(chips("editor")).toHaveLength(0);
  });
});

describe("PromptInputAttachment image parts", () => {
  // issue #579: a part can carry an image media type with nothing a client
  // can fetch (e.g. Provider-reference-only). It should render as the plain
  // file card every non-image attachment gets, not a broken <img>.
  it("falls back to a file attachment for an image media type with no URL", () => {
    render(
      <PromptInput onSubmit={vi.fn()}>
        <PromptInputAttachment
          data={{
            id: "1",
            type: "file",
            mediaType: "image/png",
            url: "",
            filename: "photo.png",
          }}
        />
      </PromptInput>,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("photo.png")).toBeInTheDocument();
  });

  it("renders an image media type with a URL as an image", () => {
    render(
      <PromptInput onSubmit={vi.fn()}>
        <PromptInputAttachment
          data={{
            id: "1",
            type: "file",
            mediaType: "image/png",
            url: "https://example.com/photo.png",
            filename: "photo.png",
          }}
        />
      </PromptInput>,
    );

    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      "https://example.com/photo.png",
    );
  });
});

const seededPdf = {
  type: "file" as const,
  url: "https://example.com/report.pdf",
  mediaType: "application/pdf",
  filename: "report.pdf",
};

describe("PromptInput initialAttachments", () => {
  // issue #710: an inline edit surface has to open holding the parts the
  // message already carries. Without a seed the only way in is `add()`, which
  // takes `File[]` — something a persisted `FileUIPart` cannot be turned back
  // into, because its bytes were never in this browser.
  it("opens holding the parts it was seeded with", () => {
    render(
      <PromptInput initialAttachments={[seededPdf]} onSubmit={vi.fn()}>
        <PromptInputAttachments className="w-full">
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        <PromptInputBody>
          <PromptInputTextarea />
        </PromptInputBody>
      </PromptInput>,
    );

    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });

  it("submits a seeded part alongside one added afterwards", async () => {
    // A newly attached file is held as a `blob:` URL and read back through
    // fetch on submit; jsdom serves no blob URLs, so the read is stubbed with
    // the Blob it would have returned.
    global.fetch = vi.fn().mockResolvedValue({
      blob: async () => new Blob(["hi"], { type: "text/plain" }),
    }) as unknown as typeof global.fetch;
    const onSubmit = vi.fn();
    render(
      <PromptInput
        initialAttachments={[seededPdf]}
        multiple
        onSubmit={onSubmit}
      >
        <PromptInputAttachments className="w-full">
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        <PromptInputBody>
          <PromptInputTextarea />
        </PromptInputBody>
        <PromptInputSubmit />
      </PromptInput>,
    );

    fireFileChange(getFileInput(), [
      new File(["hi"], "extra.txt", { type: "text/plain" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].files).toEqual([
      expect.objectContaining({
        url: "https://example.com/report.pdf",
        filename: "report.pdf",
      }),
      expect.objectContaining({ filename: "extra.txt" }),
    ]);
  });

  it("drops a seeded part the user removes", async () => {
    const onSubmit = vi.fn();
    render(
      <PromptInput initialAttachments={[seededPdf]} onSubmit={onSubmit}>
        <PromptInputAttachments className="w-full">
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        <PromptInputBody>
          <PromptInputTextarea />
        </PromptInputBody>
        <PromptInputSubmit />
      </PromptInput>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove attachment" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].files).toEqual([]);
  });

  // The seed is an opening position, not a binding: re-rendering with a
  // different array must not throw away what the user has done since. An edit
  // surface's parent re-renders on every keystroke elsewhere on the page.
  it("keeps the live list when the seed prop changes", () => {
    const view = render(
      <PromptInput initialAttachments={[seededPdf]} onSubmit={vi.fn()}>
        <PromptInputAttachments className="w-full">
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        <PromptInputBody>
          <PromptInputTextarea />
        </PromptInputBody>
      </PromptInput>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove attachment" }));
    view.rerender(
      <PromptInput initialAttachments={[seededPdf]} onSubmit={vi.fn()}>
        <PromptInputAttachments className="w-full">
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        <PromptInputBody>
          <PromptInputTextarea />
        </PromptInputBody>
      </PromptInput>,
    );

    expect(screen.queryByText("report.pdf")).not.toBeInTheDocument();
  });
});

describe("PromptInputTextarea onKeyDown", () => {
  // issue #710: an inline edit surface needs Escape to cancel. Spreading a
  // caller's handler through `props` would replace the built-in one outright,
  // taking Enter-to-submit and Backspace-removes-attachment with it.
  it("runs a caller's handler and still submits on Enter", async () => {
    const onKeyDown = vi.fn();
    const onSubmit = vi.fn();
    render(
      <PromptInput onSubmit={onSubmit}>
        <PromptInputBody>
          <PromptInputTextarea onKeyDown={onKeyDown} />
        </PromptInputBody>
        <PromptInputSubmit />
      </PromptInput>,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onKeyDown).toHaveBeenCalled();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  });

  it("lets a caller claim a key by preventing the default", () => {
    const onSubmit = vi.fn();
    render(
      <PromptInput onSubmit={onSubmit}>
        <PromptInputBody>
          <PromptInputTextarea
            onKeyDown={(e) => {
              if (e.key === "Enter") e.preventDefault();
            }}
          />
        </PromptInputBody>
        <PromptInputSubmit />
      </PromptInput>,
    );

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
