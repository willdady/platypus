import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { id: "u1" }, isPending: false }),
  useBackendUrl: () => "https://app.example.com",
}));

import {
  ArtifactMarkdown,
  artifactSchema,
  fencedCode,
} from "./artifact-markdown";

const DATA_IMAGE = "data:image/png;base64,iVBORw0KGgo=";

describe("ArtifactMarkdown images", () => {
  it("does not load an image from a remote host, and shows its URL instead", () => {
    render(
      <ArtifactMarkdown
        content={"![Chart](https://elsewhere.test/chart.png)"}
      />,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText(/Image blocked: Chart/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "https://elsewhere.test/chart.png" }),
    ).toHaveAttribute("href", "https://elsewhere.test/chart.png");
  });

  it("loads a data: image", () => {
    render(<ArtifactMarkdown content={`![Chart](${DATA_IMAGE})`} />);

    expect(screen.getByRole("img")).toHaveAttribute("src", DATA_IMAGE);
  });

  it.each([
    ["https://app.example.com/files/org/ws/chat/message/0-a.png"],
    ["/files/org/ws/chat/message/0-a.png"],
  ])("loads an image from the app's own file storage: %s", (src) => {
    render(<ArtifactMarkdown content={`![Chart](${src})`} />);

    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      "https://app.example.com/files/org/ws/chat/message/0-a.png",
    );
  });

  it("blocks a stored-file path that escapes /files/, showing its URL", () => {
    render(<ArtifactMarkdown content={"![x](/files/../auth/x)"} />);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("/files/../auth/x")).toBeInTheDocument();
  });

  it("loads an image from the deployment's storage base", () => {
    render(
      <ArtifactMarkdown
        content={
          "![Chart](https://cdn.example.com/org/ws/chat/message/0-a.png)"
        }
        storageBaseUrl="https://cdn.example.com"
      />,
    );

    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      "https://cdn.example.com/org/ws/chat/message/0-a.png",
    );
  });

  it("blocks a storage base image until the read names that base", () => {
    render(
      <ArtifactMarkdown
        content={
          "![Chart](https://cdn.example.com/org/ws/chat/message/0-a.png)"
        }
      />,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText(/Image blocked: Chart/)).toBeInTheDocument();
  });

  it("strips an img's srcset, which the image rule never sees", () => {
    render(
      <ArtifactMarkdown
        content={`<img src="${DATA_IMAGE}" srcset="https://elsewhere.test/a.png 1x" alt="Chart">`}
      />,
    );

    const image = screen.getByRole("img");
    expect(image).toHaveAttribute("src", DATA_IMAGE);
    expect(image).not.toHaveAttribute("srcset");
  });
});

describe("the gutter under an Artifact's last line", () => {
  it("wraps a document in a box of its own height that carries the gutter", () => {
    render(
      <ArtifactMarkdown
        content={"A first line.\n\nThe last line."}
        gutter="document"
      />,
    );

    const gutter = screen.getByTestId("artifact-gutter");
    expect(gutter).toHaveClass("pb-4");
    expect(gutter.className).not.toMatch(/(^|\s)(h|size|min-h|max-h)-/);
    expect(gutter).toContainElement(screen.getByText("The last line."));
  });

  it("puts the gutter of filled source inside the block that scrolls", () => {
    render(
      <ArtifactMarkdown
        content={fencedCode("const a = 1;", "ts")}
        gutter="source"
      />,
    );

    const gutter = screen.getByTestId("artifact-gutter");
    expect(gutter).toHaveClass(
      "size-full",
      "[&_[data-streamdown=code-block-body]]:pb-8",
    );
    expect(gutter).not.toHaveClass("pb-4");
    expect(gutter).toHaveTextContent("const a = 1;");
  });

  it("adds nothing unless a surface asks for it", () => {
    render(<ArtifactMarkdown content={"The last line."} />);

    expect(screen.queryByTestId("artifact-gutter")).not.toBeInTheDocument();
    expect(screen.getByText("The last line.")).toBeInTheDocument();
  });
});

describe("the Artifact markdown schema", () => {
  it.each([
    "audio",
    "base",
    "embed",
    "form",
    "iframe",
    "link",
    "meta",
    "object",
    "picture",
    "script",
    "source",
    "track",
    "video",
  ])("drops %s", (tag) => {
    expect(artifactSchema.tagNames).not.toContain(tag);
  });

  it("keeps data: images for the image component to decide", () => {
    expect(artifactSchema.protocols?.src).toContain("data");
  });
});

describe("fencedCode", () => {
  it("uses a fence longer than any backtick run in the content", () => {
    expect(fencedCode("a ``` b", "markdown")).toBe(
      "````markdown\na ``` b\n````",
    );
  });
});
