import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  authMock,
  swrMock,
  resetFormHarness,
  savedBody,
  setDataFor,
  setupUser,
  stubAcceptedSave,
} from "@/test/form-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);
// The bundle card loads its own files; not under test here.
vi.mock("@/components/skill-bundle", () => ({ SkillBundleCard: () => null }));

import { SkillForm } from "./skill-form";

function renderEditForm() {
  setDataFor("/skills/s1", {
    id: "s1",
    workspaceId: "ws1",
    name: "my-skill",
    description: "A long enough description for the skill.",
    body: "A long enough body for the skill.",
    argumentHint: null,
    disableModelInvocation: false,
    agentIds: ["a1"],
  });
  setDataFor("/agents", {
    results: [{ id: "a1", name: "Helper", description: "" }],
  });
  return render(<SkillForm orgId="o1" workspaceId="ws1" skillId="s1" />);
}

describe("SkillForm form submission", () => {
  beforeEach(() => {
    resetFormHarness();
    setDataFor("/agents", { results: [] });
  });

  it("saves on Enter in the Name field", async () => {
    const fetchMock = stubAcceptedSave({ id: "s1" });
    render(<SkillForm orgId="o1" workspaceId="ws1" />);

    await setupUser().type(screen.getByLabelText("Name"), "new-skill{Enter}");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(savedBody(fetchMock)).toMatchObject({ name: "new-skill" });
  });
});

describe("SkillForm Delete", () => {
  beforeEach(() => {
    resetFormHarness();
  });

  it("is enabled while the agent set matches what is saved", () => {
    renderEditForm();

    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("is blocked, saying why, while agent changes are unsaved", () => {
    renderEditForm();

    fireEvent.click(screen.getByRole("switch", { name: /Helper/ }));

    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(
      screen.getByText("This skill has unsaved agent changes. Update first."),
    ).toBeInTheDocument();
  });
});
