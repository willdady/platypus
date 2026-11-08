import { describe, it, expect, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { CloneDialog } from "./clone-dialog";
import { setupUser } from "@/test/test-utils";
import type { WriteOutcome } from "@/lib/api-write";

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
}));

const onClose = vi.fn();
const onCreated = vi.fn();

// The create's promise is held open until the test resolves it, so the
// pending UI (and the ref guard's in-flight window) is observable on demand.
let resolveCreate!: (outcome: WriteOutcome<{ id: string }>) => void;

function renderDialog(nameMaxLength = 30) {
  const create = vi.fn(
    () =>
      new Promise<WriteOutcome<{ id: string }>>((resolve) => {
        resolveCreate = resolve;
      }),
  );
  render(
    <CloneDialog
      noun="agent"
      original="Scout"
      onClose={onClose}
      create={create}
      onCreated={onCreated}
      nameMaxLength={nameMaxLength}
    />,
  );
  return create;
}

async function settle(outcome: WriteOutcome<{ id: string }>) {
  await act(async () => {
    resolveCreate(outcome);
  });
}

describe("CloneDialog", () => {
  it("titles itself from the lowercase noun", () => {
    renderDialog();

    expect(screen.getByRole("dialog", { name: "Clone agent" })).toBeVisible();
    expect(screen.getByPlaceholderText("Agent name")).toBeInTheDocument();
  });

  it("sends the create once for two rapid clicks", async () => {
    const create = renderDialog();
    const user = setupUser();

    await user.click(screen.getByRole("button", { name: "Clone" }));
    await user.click(screen.getByRole("button", { name: "Cloning..." }));

    expect(create).toHaveBeenCalledTimes(1);

    await settle({
      outcome: "success",
      data: { id: "a2" },
      revalidateKeys: [],
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("a2"));
    expect(onClose).toHaveBeenCalled();
  });

  it("sends the create once for two Enter presses in the name field", async () => {
    const create = renderDialog();
    const user = setupUser();

    await user.click(screen.getByLabelText("Name"));
    await user.keyboard("{Enter}{Enter}");

    expect(create).toHaveBeenCalledTimes(1);

    await settle({
      outcome: "success",
      data: { id: "a2" },
      revalidateKeys: [],
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("a2"));
    expect(onClose).toHaveBeenCalled();
  });

  it("is unmistakably busy while pending: buttons disabled, Escape refused", async () => {
    renderDialog();
    const user = setupUser();

    await user.click(screen.getByRole("button", { name: "Clone" }));

    expect(screen.getByRole("button", { name: "Cloning..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    await user.keyboard("{Escape}");

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await settle({
      outcome: "success",
      data: { id: "a2" },
      revalidateKeys: [],
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it("shows a refused create's message inline and re-enables Clone", async () => {
    renderDialog();
    const user = setupUser();

    await user.click(screen.getByRole("button", { name: "Clone" }));
    await settle({
      outcome: "forbidden",
      message: "You cannot clone this agent",
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "You cannot clone this agent",
    );
    expect(screen.getByRole("button", { name: "Clone" })).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows a name issue on the name field, not the entity's refusal", async () => {
    renderDialog();
    const user = setupUser();

    await user.click(screen.getByRole("button", { name: "Clone" }));
    await settle({
      outcome: "invalid",
      message: "This Agent cannot be cloned.",
      fieldErrors: {
        name: "Too big: expected string to have <=30 characters",
      },
    });

    const name = screen.getByLabelText("Name");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription(
      "Too big: expected string to have <=30 characters",
    );
    expect(
      screen.queryByText("This Agent cannot be cloned."),
    ).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("clears the name issue when the name is edited", async () => {
    renderDialog();
    const user = setupUser();

    await user.click(screen.getByRole("button", { name: "Clone" }));
    await settle({
      outcome: "invalid",
      message: "This Agent cannot be cloned.",
      fieldErrors: {
        name: "Too big: expected string to have <=30 characters",
      },
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();

    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Short");

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(name).not.toHaveAttribute("aria-invalid", "true");
  });

  it("keeps the entity's refusal for a schema failure elsewhere", async () => {
    renderDialog();
    const user = setupUser();

    await user.click(screen.getByRole("button", { name: "Clone" }));
    await settle({
      outcome: "invalid",
      message: "This Agent cannot be cloned.",
      fieldErrors: {
        description: "Too big: expected string to have <=128 characters",
      },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This Agent cannot be cloned.",
    );
    expect(screen.getByLabelText("Name")).toHaveAttribute(
      "aria-invalid",
      "false",
    );
  });

  it("keeps the entity's refusal when the name and another field both fail", async () => {
    renderDialog();
    const user = setupUser();

    await user.click(screen.getByRole("button", { name: "Clone" }));
    await settle({
      outcome: "invalid",
      message: "This Agent cannot be cloned.",
      fieldErrors: {
        name: "Too big: expected string to have <=30 characters",
        description: "Too big: expected string to have <=128 characters",
      },
    });

    expect(
      screen.getByText("Too big: expected string to have <=30 characters"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("This Agent cannot be cloned."),
    ).toBeInTheDocument();
  });

  it("enforces the Name limit on the input", () => {
    renderDialog(30);

    expect(screen.getByLabelText("Name")).toHaveAttribute("maxlength", "30");
  });
});
