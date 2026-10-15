import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const read = vi.hoisted(() => ({
  data: undefined as { results: { id: string; name: string }[] } | undefined,
}));

vi.mock("@/hooks/use-scoped-swr", () => ({
  useScopedSWR: () => ({ data: read.data, error: undefined, isLoading: false }),
}));

import { WorkspaceList } from "./workspace-list";

describe("WorkspaceList", () => {
  it("lists workspaces by name without reordering the cached results", () => {
    read.data = {
      results: [
        { id: "ws2", name: "Beta" },
        { id: "ws1", name: "Alpha" },
      ],
    };

    render(<WorkspaceList orgId="org1" />);

    expect(
      screen.getAllByRole("link").map((l) => l.textContent?.trim()),
    ).toEqual(["Alpha", "Beta"]);
    expect(read.data.results.map((w) => w.name)).toEqual(["Beta", "Alpha"]);
  });
});
