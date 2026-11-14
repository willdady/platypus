import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { skillCreateSchema } from "@platypus/schemas";
import { expectSentBodyToMatchSchema } from "@/test/test-utils";
import {
  authMock,
  swrMock,
  resetFormHarness,
  setDataFor,
  setupUser,
  stubAcceptedSave,
  toastSuccess,
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

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "new-skill" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "A long enough description for the skill." },
    });
    fireEvent.change(screen.getByLabelText("Body"), {
      target: { value: "A long enough body for the skill." },
    });
    await setupUser().type(screen.getByLabelText("Name"), "{Enter}");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(
      expectSentBodyToMatchSchema(fetchMock, skillCreateSchema),
    ).toMatchObject({ name: "new-skill" });
  });
});

describe("SkillForm save feedback", () => {
  beforeEach(() => {
    resetFormHarness();
    setDataFor("/agents", { results: [] });
  });

  it("toasts that the Skill was created", async () => {
    stubAcceptedSave({ id: "s1" });
    render(<SkillForm orgId="o1" workspaceId="ws1" />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "new-skill" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "A long enough description for the skill." },
    });
    fireEvent.change(screen.getByLabelText("Body"), {
      target: { value: "A long enough body for the skill." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Skill created"),
    );
  });

  it("toasts that the Skill was updated", async () => {
    stubAcceptedSave({ id: "s1" });
    renderEditForm();

    fireEvent.click(await screen.findByRole("button", { name: "Update" }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Skill updated"),
    );
  });

  it("toasts that the Skill was deleted", async () => {
    stubAcceptedSave({});
    renderEditForm();

    fireEvent.click(await screen.findByRole("button", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Skill deleted"),
    );
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
