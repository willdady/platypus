import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { FileUIPart } from "ai";
import { toast } from "sonner";
import {
  PromptInput,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputProps,
} from "./prompt-input";

function getFileInput() {
  return screen.getByLabelText("Upload files") as HTMLInputElement;
}

function getSandboxFileInput() {
  return screen.getByLabelText("Upload files to Sandbox") as HTMLInputElement;
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

  it("adds every file offered, with no size or count cap", () => {
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
    const a = new File(["a"], "a.txt", { type: "text/plain" });
    const b = new File(["x".repeat(1024)], "b.txt", { type: "text/plain" });
    fireFileChange(input, [a, b]);

    expect(screen.getByText("a.txt")).toBeInTheDocument();
    expect(screen.getByText("b.txt")).toBeInTheDocument();
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

describe("PromptInput drop routing with two inputs", () => {
  const named = (label: string, globalDrop: boolean) => (
    <PromptInput globalDrop={globalDrop} onSubmit={vi.fn()}>
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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        blob: async () => new Blob(["hi"], { type: "text/plain" }),
      }),
    );
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

  describe("Backspace", () => {
    const renderComposer = () =>
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

    const attachFile = (name: string) =>
      fireFileChange(getFileInput(), [
        new File(["x"], name, { type: "text/plain" }),
      ]);

    const attachSandboxFile = (name: string) =>
      fireFileChange(getSandboxFileInput(), [
        new File(["x"], name, { type: "text/plain" }),
      ]);

    const backspace = () =>
      fireEvent.keyDown(screen.getByRole("textbox"), {
        key: "Backspace",
      });

    it("removes a Sandbox upload before a file attachment", () => {
      renderComposer();
      attachFile("photo.txt");
      attachSandboxFile("sandbox.txt");

      backspace();

      expect(screen.queryByText("sandbox.txt")).not.toBeInTheDocument();
      expect(screen.getByText("photo.txt")).toBeInTheDocument();

      backspace();

      expect(screen.queryByText("photo.txt")).not.toBeInTheDocument();
    });

    it("removes the Sandbox upload even when a file was attached after it", () => {
      renderComposer();
      attachSandboxFile("sandbox.txt");
      attachFile("photo.txt");

      backspace();

      expect(screen.queryByText("sandbox.txt")).not.toBeInTheDocument();
      expect(screen.getByText("photo.txt")).toBeInTheDocument();
    });

    it("removes the last Sandbox upload when only Sandbox uploads are attached", () => {
      renderComposer();
      attachSandboxFile("first.txt");
      attachSandboxFile("second.txt");

      backspace();

      expect(screen.queryByText("second.txt")).not.toBeInTheDocument();
      expect(screen.getByText("first.txt")).toBeInTheDocument();
    });

    it("removes the last file attachment when only file attachments are attached", () => {
      renderComposer();
      attachFile("first.txt");
      attachFile("second.txt");

      backspace();

      expect(screen.queryByText("second.txt")).not.toBeInTheDocument();
      expect(screen.getByText("first.txt")).toBeInTheDocument();
    });

    it("removes no chip when the textarea is not empty", () => {
      renderComposer();
      attachFile("photo.txt");
      const textarea = screen.getByRole("textbox");
      fireEvent.change(textarea, { target: { value: "hello" } });

      const notPrevented = backspace();

      expect(notPrevented).toBe(true);
      expect(screen.getByText("photo.txt")).toBeInTheDocument();
    });

    it("does nothing when there are no chips", () => {
      renderComposer();

      const notPrevented = backspace();

      expect(notPrevented).toBe(true);
    });
  });
});

describe("PromptInput blob-URL lifecycle", () => {
  const originals = {
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };
  let nextBlobId = 0;

  beforeEach(() => {
    nextBlobId = 0;
    URL.createObjectURL = vi.fn(
      () => `blob:test-${++nextBlobId}`,
    ) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  });

  afterEach(() => {
    URL.createObjectURL = originals.createObjectURL;
    URL.revokeObjectURL = originals.revokeObjectURL;
  });

  const fileA = () => new File(["a"], "a.txt", { type: "text/plain" });
  const fileB = () => new File(["b"], "b.txt", { type: "text/plain" });

  const renderInput = (
    onSubmit: (message: { text: string; files: FileUIPart[] }) => void,
    onError?: (err: { code: string; message: string }) => void,
  ) =>
    render(
      <PromptInput onError={onError} onSubmit={onSubmit}>
        <PromptInputAttachments className="w-full">
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        <PromptInputBody>
          <PromptInputTextarea />
        </PromptInputBody>
        <PromptInputSubmit />
      </PromptInput>,
    );

  it("keeps the first attachment's URL alive when a second is added", () => {
    renderInput(vi.fn());
    const input = getFileInput();

    fireFileChange(input, [fileA()]);
    fireFileChange(input, [fileB()]);

    expect(screen.getByText("a.txt")).toBeInTheDocument();
    expect(screen.getByText("b.txt")).toBeInTheDocument();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("submits the remaining attachment after one of two is removed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        blob: async () => new Blob(["b"], { type: "text/plain" }),
      }),
    );
    const onSubmit = vi.fn();
    renderInput(onSubmit);

    fireFileChange(getFileInput(), [fileA(), fileB()]);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Remove attachment" })[0],
    );

    expect(screen.queryByText("a.txt")).not.toBeInTheDocument();
    expect(screen.getByText("b.txt")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].files).toEqual([
      expect.objectContaining({ filename: "b.txt" }),
    ]);
  });

  it("revokes a removed attachment's URL, and only that one", () => {
    renderInput(vi.fn());

    fireFileChange(getFileInput(), [fileA(), fileB()]);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Remove attachment" })[0],
    );

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-1");
  });

  it("revokes every live attachment URL on unmount", () => {
    const view = renderInput(vi.fn());

    fireFileChange(getFileInput(), [fileA(), fileB()]);
    view.unmount();

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-1");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-2");
  });

  it("reports a failed conversion instead of silently blocking submit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("blob URL revoked")),
    );
    const onError = vi.fn();
    const onSubmit = vi.fn();
    renderInput(onSubmit, onError);

    fireFileChange(getFileInput(), [fileA()]);
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith({
        code: "conversion",
        message: "Couldn't read an attachment. Remove it and try again.",
      }),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("falls back to a toast when a failed conversion has no onError handler", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("blob URL revoked")),
    );
    renderInput(vi.fn());

    fireFileChange(getFileInput(), [fileA()]);
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't read an attachment. Remove it and try again.",
      ),
    );
  });
});

describe("PromptInput submit failure", () => {
  const seeded = {
    type: "file" as const,
    url: "https://example.com/report.pdf",
    mediaType: "application/pdf",
    filename: "report.pdf",
  };

  const failure = {
    code: "submit" as const,
    message: "Your message couldn't be sent. Try again.",
  };

  const renderInput = (
    onSubmit: PromptInputProps["onSubmit"],
    onError?: PromptInputProps["onError"],
  ) =>
    render(
      <PromptInput
        initialAttachments={[seeded]}
        onError={onError}
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

  const submit = () =>
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

  it("reports a rejected submit and keeps the attachments", async () => {
    const onError = vi.fn();
    renderInput(() => Promise.reject(new Error("send failed")), onError);

    submit();

    await waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });

  it("reports a thrown submit and keeps the attachments", async () => {
    const onError = vi.fn();
    renderInput(() => {
      throw new Error("send failed");
    }, onError);

    submit();

    await waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });

  it("falls back to a toast when a failed submit has no onError handler", async () => {
    renderInput(() => Promise.reject(new Error("send failed")));

    submit();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(failure.message),
    );
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });

  it("clears the attachments after a successful submit", async () => {
    renderInput(async () => {});

    submit();

    await waitFor(() =>
      expect(screen.queryByText("report.pdf")).not.toBeInTheDocument(),
    );
  });
});
