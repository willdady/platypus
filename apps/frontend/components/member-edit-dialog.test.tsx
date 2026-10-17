import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { OrgMemberListItem } from "@platypus/schemas";
import {
  authMock,
  swrMock,
  resetFormHarness,
  savedBody,
  stubAcceptedSave,
  stubRejectedSave,
  toastError,
  toastSuccess,
} from "@/test/form-test-harness";
import { selectOption } from "@/test/test-utils";
import type { Serialized } from "@/lib/api-write";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { MemberEditDialog } from "./member-edit-dialog";

const member = {
  id: "m1",
  role: "member",
  user: { id: "u2", name: "Nina", email: "nina@example.com" },
  isSuperAdmin: false,
} as unknown as Serialized<OrgMemberListItem>;

const onSuccess = vi.fn();

function renderDialog() {
  return render(
    <MemberEditDialog
      orgId="org1"
      member={member}
      open
      onOpenChange={() => {}}
      onSuccess={onSuccess}
    />,
  );
}

async function changeRoleToAdmin() {
  renderDialog();
  await selectOption(
    screen.getByRole("combobox", { name: "Organization Role" }),
    "Admin",
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

beforeEach(() => {
  resetFormHarness();
  onSuccess.mockReset();
});

describe("MemberEditDialog", () => {
  // Saving the role the member already has would be a no-op write.
  it("keeps Save disabled until the role changes", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  // The role change is a PATCH on the one membership row, not the user.
  it("PATCHes the new role and reports success", async () => {
    const fetchMock = stubAcceptedSave({ id: "m1", role: "admin" });
    await changeRoleToAdmin();

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/members/m1",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(savedBody(fetchMock)).toEqual({ role: "admin" });
    expect(toastSuccess).toHaveBeenCalledWith("Member role updated");
  });

  // No field renders a server error, so the backend's refusal has to reach
  // the reader as a toast.
  it("toasts the backend's message on a refusal and stays open", async () => {
    stubRejectedSave("Member not found", 400);
    await changeRoleToAdmin();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Member not found"),
    );
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
