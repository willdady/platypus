import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  mutate,
  renderList,
  resetListHarness,
} from "@/test/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { PluginsList } from "./plugins-list";

beforeEach(resetListHarness);

describe("PluginsList", () => {
  it("reports a failed catalog read with a retry", async () => {
    mockScopedSWR(
      { "/plugins": { error: { status: 500, message: "Server error" } } },
      { strict: true },
    );

    await renderList(<PluginsList orgId="org1" />);

    expect(screen.getByText("Couldn't load plugins")).toBeInTheDocument();
    expect(screen.queryByText(/refreshing the page/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mutate).toHaveBeenCalledOnce();
  });
});
