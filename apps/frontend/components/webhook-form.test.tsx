import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import {
  authMock,
  swrMock,
  push,
  resetFormHarness,
  setData,
  setDataFor,
  setupUser,
  toastError,
  jsonResponse,
  stubAcceptedSave,
  stubRejectedSave,
} from "@/test/form-test-harness";
import { webhookCreateSchema } from "@platypus/schemas";
import { expectSentBodyToMatchSchema } from "@/test/test-utils";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
// The create form never keys a fetch off a webhook id, so SWR never loads
// real data here — the harness's default (unset) response is `undefined`.
vi.mock("swr", () => swrMock);

import { WebhookForm } from "./webhook-form";

// --- Helpers -----------------------------------------------------------------

function renderForm() {
  return render(<WebhookForm orgId="org1" workspaceId="ws1" />);
}

/** The create body the form put on the wire, checked against the strict schema. */
function savedCreateBody(fetchMock: ReturnType<typeof vi.fn>) {
  return expectSentBodyToMatchSchema(fetchMock, webhookCreateSchema);
}

// --- Tests -------------------------------------------------------------------

describe("WebhookForm event picker", () => {
  beforeEach(() => {
    resetFormHarness();
  });

  it("groups the Trigger run events under their own heading", () => {
    renderForm();

    const group = screen.getByRole("group", { name: "Trigger runs" });
    for (const label of [
      "Trigger run succeeded",
      "Trigger run failed",
      "Trigger run cancelled",
      "Trigger run suppressed",
    ]) {
      expect(
        within(group).getByRole("switch", { name: label }),
      ).toBeInTheDocument();
    }
    expect(
      within(screen.getByRole("group", { name: "Cards" })).getByRole("switch", {
        name: "Card moved",
      }),
    ).toBeInTheDocument();
  });
});

describe("WebhookForm form submission", () => {
  beforeEach(() => resetFormHarness());

  it("stops the Name at 100 characters, the most a save accepts", () => {
    renderForm();

    expect(screen.getByLabelText("Name")).toHaveAttribute("maxLength", "100");
  });

  it("saves on Enter in the Name field", async () => {
    const fetchMock = stubAcceptedSave({ id: "w1" });
    renderForm();

    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://example.com/hook" },
    });
    await setupUser().type(screen.getByLabelText("Name"), "Deploy hook{Enter}");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(savedCreateBody(fetchMock)).toMatchObject({ name: "Deploy hook" });
  });
});

describe("WebhookForm validation error surfacing", () => {
  beforeEach(() => {
    resetFormHarness();
  });

  it("saves, shows the rejected events error, then saves again once corrected", async () => {
    const fetchMock = stubRejectedSave([
      { path: ["events"], message: "At least one event is required" },
    ]);

    renderForm();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Deploy hook" },
    });
    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://example.com/hook" },
    });
    const saveButton = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveButton);

    expect(
      await screen.findByText("At least one event is required"),
    ).toBeInTheDocument();
    // A shown error disables Save until the offending field is corrected.
    expect(saveButton).toBeDisabled();

    // Toggling any event is an edit to the events field — it retracts the
    // error and re-enables Save, without needing a page reload.
    fireEvent.click(
      screen.getByRole("switch", { name: "Notification created" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByText("At least one event is required"),
      ).not.toBeInTheDocument(),
    );
    expect(saveButton).toBeEnabled();

    // The round trip completes: re-submitting now succeeds.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        "/org1/workspace/ws1/settings/webhooks",
      ),
    );
    // Every event starts subscribed, so the toggle above dropped one.
    const body = savedCreateBody(fetchMock);
    expect(body.events).not.toContain("notification.created");
    expect(body.events).toContain("notification.updated");
    expect(body.headers).toBeNull();
  });

  it("clears the enabled field's error when the switch is toggled", async () => {
    stubRejectedSave([{ path: ["enabled"], message: "Invalid enabled" }]);

    renderForm();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Invalid enabled")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Enabled" }));

    await waitFor(() =>
      expect(screen.queryByText("Invalid enabled")).not.toBeInTheDocument(),
    );
  });

  it("retracts a row-level headers error only when that row is edited", async () => {
    stubRejectedSave([
      { path: ["headers", "X-Foo"], message: "Header value is too long" },
    ]);

    renderForm();

    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Header 1 name" }), {
      target: { value: "X-Foo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Header 1 value" }), {
      target: { value: "bar" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("Header value is too long"),
    ).toBeInTheDocument();

    // Editing the unrelated second row must not strand or clear the first
    // row's error.
    fireEvent.change(screen.getByRole("textbox", { name: "Header 2 name" }), {
      target: { value: "X-Bar" },
    });
    expect(screen.getByText("Header value is too long")).toBeInTheDocument();

    // Editing the offending row retracts its own error.
    fireEvent.change(screen.getByRole("textbox", { name: "Header 1 name" }), {
      target: { value: "X-Foo-Fixed" },
    });
    await waitFor(() =>
      expect(
        screen.queryByText("Header value is too long"),
      ).not.toBeInTheDocument(),
    );
  });
});

describe("WebhookForm regenerate", () => {
  beforeEach(() => resetFormHarness());

  const record = {
    id: "wh1",
    name: "Ops",
    url: "https://hooks.test/ops",
    events: ["notification.created"],
    enabled: true,
    headers: null,
    signingSecret: "whsec_old",
  };

  const renderEdit = () => {
    setDataFor("/webhooks/wh1", record);
    render(<WebhookForm orgId="org1" workspaceId="ws1" webhookId="wh1" />);
  };

  it("keeps a refused regenerate in the dialog with the backend's message", async () => {
    stubRejectedSave("Signing secret is managed elsewhere", 409);
    renderEdit();

    fireEvent.click(await screen.findByRole("button", { name: "Regenerate" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Regenerate" }));

    expect(
      await within(dialog).findByText("Signing secret is managed elsewhere"),
    ).toBeVisible();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("clears a refusal when the dialog is cancelled", async () => {
    stubRejectedSave("Signing secret is managed elsewhere", 409);
    renderEdit();

    fireEvent.click(await screen.findByRole("button", { name: "Regenerate" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Regenerate" }));
    await within(dialog).findByText("Signing secret is managed elsewhere");

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    const reopened = await screen.findByRole("dialog");
    expect(
      within(reopened).queryByText("Signing secret is managed elsewhere"),
    ).not.toBeInTheDocument();
  });

  it("closes the dialog after a successful regenerate", async () => {
    stubAcceptedSave({ message: "ok" });
    renderEdit();

    fireEvent.click(await screen.findByRole("button", { name: "Regenerate" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Regenerate" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});

describe("WebhookForm delete", () => {
  beforeEach(() => resetFormHarness());

  it("keeps a refused delete in the dialog, with the backend's message", async () => {
    setData({
      id: "wh1",
      name: "Ops",
      url: "https://hooks.test/ops",
      events: ["chat.created"],
      enabled: true,
    });
    stubRejectedSave("Webhook is busy", 409);

    render(<WebhookForm orgId="org1" workspaceId="ws1" webhookId="wh1" />);
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await within(dialog).findByText("Webhook is busy")).toBeVisible();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});
