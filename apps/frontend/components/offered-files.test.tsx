import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PlatypusUIMessage } from "@platypus/schemas";
import { authMock } from "@/test/test-utils";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org1", workspaceId: "ws1" }),
}));

import { OfferedFiles, offeredFiles } from "./offered-files";

type MessagePart = NonNullable<PlatypusUIMessage["parts"]>[number];

function offer(
  path: string,
  size: number,
  state = "output-available",
): MessagePart {
  return {
    type: "tool-fsDownload",
    toolCallId: `call-${path}-${size}`,
    state,
    input: { path },
    output: state === "output-available" ? { path, size } : undefined,
    errorText: state === "output-error" ? "not found" : undefined,
  } as unknown as MessagePart;
}

describe("offeredFiles", () => {
  it("keeps one entry per path, with the latest offer's size", () => {
    expect(
      offeredFiles([
        offer("out/a.csv", 1),
        { type: "step-start" },
        offer("b.pdf", 5),
        offer("out/a.csv", 2),
        offer("out/a.csv", 3),
      ]),
    ).toEqual([
      { path: "out/a.csv", size: 3 },
      { path: "b.pdf", size: 5 },
    ]);
  });

  it("leaves out failed and unfinished calls", () => {
    expect(
      offeredFiles([
        offer("gone.txt", 0, "output-error"),
        offer("pending.txt", 0, "input-available"),
      ]),
    ).toEqual([]);
  });
});

describe("OfferedFiles", () => {
  it("shows each file's name, path and size, with a Download link to the Workspace's download route", () => {
    render(<OfferedFiles files={[{ path: "out/report 1.pdf", size: 1234 }]} />);

    expect(screen.getByText("report 1.pdf")).toBeInTheDocument();
    expect(screen.getByText("out/report 1.pdf")).toBeInTheDocument();
    expect(screen.getByText("1.2 KB")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /download/i })).toHaveAttribute(
      "href",
      "http://test/organizations/org1/workspaces/ws1/sandbox/file?path=out%2Freport+1.pdf",
    );
  });
});
