import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { authMock } from "@/lib/test-utils";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org1", workspaceId: "ws1" }),
}));

import { FsDownloadTool } from "./fs-download-tool";

type FsDownloadPart = ComponentProps<typeof FsDownloadTool>["toolPart"];

const part = (overrides: Partial<FsDownloadPart> = {}): FsDownloadPart =>
  ({
    type: "tool-fsDownload",
    toolCallId: "call-1",
    state: "output-available",
    input: { path: "out/report 1.pdf" },
    output: { path: "out/report 1.pdf", size: 1234 },
    ...overrides,
  }) as unknown as FsDownloadPart;

describe("FsDownloadTool", () => {
  it("offers the file as a Download link to the Workspace's download route", () => {
    render(<FsDownloadTool toolPart={part()} />);

    expect(screen.getByText("out/report 1.pdf")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /download/i })).toHaveAttribute(
      "href",
      "http://test/organizations/org1/workspaces/ws1/sandbox/file?path=out%2Freport+1.pdf",
    );
  });

  it("shows no link until the check has succeeded", () => {
    render(
      <FsDownloadTool
        toolPart={part({ state: "input-available", output: undefined })}
      />,
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Running")).toBeInTheDocument();
  });
});
