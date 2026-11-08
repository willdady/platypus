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

function renderDialog() {
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
});
