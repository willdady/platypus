import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
} from "@/lib/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { A2aEndpointNotices } from "./a2a-endpoint-notices";

const NOTICE = "A2A endpoints are turned off here";

/**
 * The Workspace read is registered first: its URL also contains the
 * Organization's, and the harness matches in insertion order.
 */
const seed = (
  a2aGate: string,
  workspace: { a2aAllowed: boolean } | "loading",
) =>
  mockScopedSWR({
    "/workspaces/ws1":
      workspace === "loading"
        ? { isLoading: true }
        : { data: { id: "ws1", ...workspace } },
    "/organizations/org1": { data: { id: "org1", a2aGate } },
  });

const renderNotices = () =>
  render(<A2aEndpointNotices orgId="org1" workspaceId="ws1" />);

beforeEach(resetListHarness);

describe("A2aEndpointNotices", () => {
  it("warns when the Organization has A2A off", () => {
    seed("off", { a2aAllowed: true });
    renderNotices();

    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(
      screen.getByText(/Ask an organization admin to allow them/),
    ).toBeInTheDocument();
  });

  it("warns when the Organization allows only selected workspaces and this isn't one", () => {
    seed("selected", { a2aAllowed: false });
    renderNotices();

    expect(screen.getByText(NOTICE)).toBeInTheDocument();
  });

  it("says nothing when this workspace is selected", () => {
    seed("selected", { a2aAllowed: true });
    renderNotices();

    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it("says nothing when the Organization allows every workspace", () => {
    seed("all", { a2aAllowed: false });
    renderNotices();

    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it("says nothing while the workspace a selected gate depends on loads", () => {
    seed("selected", "loading");
    renderNotices();

    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });
});
