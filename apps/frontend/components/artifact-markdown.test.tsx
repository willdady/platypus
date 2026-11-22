import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { id: "u1" }, isPending: false }),
  useBackendUrl: () => "https://app.example.com",
}));

import { ArtifactMarkdown, fencedCode } from "./artifact-markdown";

describe("ArtifactMarkdown images", () => {
  it("does not load an image from a remote host, and shows its URL instead", () => {
    const { container } = render(
      <ArtifactMarkdown
        content={"![Chart](https://elsewhere.test/chart.png)"}
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/Image blocked: Chart/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "https://elsewhere.test/chart.png" }),
    ).toHaveAttribute("href", "https://elsewhere.test/chart.png");
  });

  it("loads a data: image", () => {
    const src = "data:image/png;base64,iVBORw0KGgo=";
    const { container } = render(
      <ArtifactMarkdown content={`![Chart](${src})`} />,
    );

    expect(container.querySelector("img")).toHaveAttribute("src", src);
  });

  it.each([
    ["https://app.example.com/files/org/ws/chat/message/0-a.png"],
    ["/files/org/ws/chat/message/0-a.png"],
  ])("loads an image from the app's own file storage: %s", (src) => {
    const { container } = render(
      <ArtifactMarkdown content={`![Chart](${src})`} />,
    );

    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://app.example.com/files/org/ws/chat/message/0-a.png",
    );
  });
});

describe("fencedCode", () => {
  it("uses a fence longer than any backtick run in the content", () => {
    expect(fencedCode("a ``` b", "markdown")).toBe(
      "````markdown\na ``` b\n````",
    );
  });
});
