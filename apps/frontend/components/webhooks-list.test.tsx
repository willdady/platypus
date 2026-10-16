import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
  menuItemLabels,
  confirmDialog,
  stubAcceptedSave,
  stubRejectedSave,
  toastError,
  mutate,
} from "@/test/list-test-harness";
import { openDropdownMenu } from "@/test/test-utils";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { WebhooksList } from "./webhooks-list";

beforeEach(resetListHarness);

describe("WebhooksList", () => {
  const webhook = {
    id: "wh1",
    workspaceId: "ws1",
    name: "Deploy hook",
    url: "https://hooks.example.com/deploy",
    enabled: true,
  };

  const render = () =>
    renderList(<WebhooksList orgId="org1" workspaceId="ws1" />);

  it("links each webhook to its detail page and shows its URL", async () => {
    mockScopedSWR({ webhooks: [webhook] }, { strict: true });
    await render();

    expect(screen.getByText("Deploy hook").closest("a")).toHaveAttribute(
      "href",
      "/org1/workspace/ws1/settings/webhooks/wh1",
    );
    expect(
      screen.getByText("https://hooks.example.com/deploy"),
    ).toBeInTheDocument();
  });

  // A long URL is cut off with an ellipsis inside the card, so the full URL
  // stays readable on hover.
  it("truncates the URL, keeping the full URL on hover", async () => {
    mockScopedSWR({ webhooks: [webhook] }, { strict: true });
    await render();

    const url = screen.getByText("https://hooks.example.com/deploy");
    expect(url).toHaveClass("truncate");
    expect(url).toHaveAttribute("title", "https://hooks.example.com/deploy");
  });

  // A disabled webhook still lists, badged — deleting it to turn it off would
  // lose its URL and secret.
  it("badges a disabled webhook rather than hiding it", async () => {
    mockScopedSWR(
      { webhooks: [{ ...webhook, enabled: false }] },
      { strict: true },
    );
    await render();

    expect(screen.getByText("Deploy hook")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  it("offers the create CTA when the workspace has none", async () => {
    mockScopedSWR({ webhooks: [] }, { strict: true });
    await render();

    expect(screen.getByText("No webhooks configured")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Add webhook/ }),
    ).toBeInTheDocument();
  });

  it("says the read failed rather than claiming there are none", async () => {
    mockScopedSWR({ webhooks: { error: new Error("500") } }, { strict: true });
    await render();

    expect(screen.getByText("Failed to load webhooks.")).toBeInTheDocument();
    expect(
      screen.queryByText("No webhooks configured"),
    ).not.toBeInTheDocument();
  });

  it("holds the rows with a skeleton, not the empty state, while loading", async () => {
    mockScopedSWR({ webhooks: { isLoading: true } }, { strict: true });
    await render();

    expect(
      screen.getByRole("status", { name: "Loading webhooks" }),
    ).toHaveAttribute("aria-busy", "true");
    expect(
      screen.queryByText("No webhooks configured"),
    ).not.toBeInTheDocument();
  });

  it("orders its menu Edit, Disable, then Delete", async () => {
    mockScopedSWR({ webhooks: [webhook] }, { strict: true });
    await renderList(<WebhooksList orgId="org1" workspaceId="ws1" />);
    await openDropdownMenu();

    expect(menuItemLabels()).toEqual(["Edit", "Disable", "Delete"]);
    expect(screen.getByRole("menuitem", { name: /Edit/ })).toHaveAttribute(
      "href",
      "/org1/workspace/ws1/settings/webhooks/wh1",
    );
  });

  it("offers Enable on a disabled webhook", async () => {
    mockScopedSWR(
      { webhooks: [{ ...webhook, enabled: false }] },
      { strict: true },
    );
    await renderList(<WebhooksList orgId="org1" workspaceId="ws1" />);
    await openDropdownMenu();

    expect(menuItemLabels()).toEqual(["Edit", "Enable", "Delete"]);
  });

  it("PUTs the flipped enabled flag and revalidates on success", async () => {
    const fetchMock = stubAcceptedSave();
    mockScopedSWR({ webhooks: [webhook] }, { strict: true });
    await renderList(
      <WebhooksList orgId="org1" workspaceId="ws1" />,
      "Disable",
    );

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/webhooks/wh1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
      }),
    );
  });

  it("toasts the backend's reason when the toggle is refused", async () => {
    stubRejectedSave("Nope", 409);
    mockScopedSWR({ webhooks: [webhook] }, { strict: true });
    await renderList(
      <WebhooksList orgId="org1" workspaceId="ws1" />,
      "Disable",
    );

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Nope"));
    expect(mutate).not.toHaveBeenCalled();
  });

  it("deletes after confirmation and revalidates", async () => {
    const fetchMock = stubAcceptedSave();
    mockScopedSWR({ webhooks: [webhook] }, { strict: true });
    await renderList(<WebhooksList orgId="org1" workspaceId="ws1" />, "Delete");

    expect(fetchMock).not.toHaveBeenCalled();
    await confirmDialog("Delete");

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/webhooks/wh1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
