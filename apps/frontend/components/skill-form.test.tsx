import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  navigationMock,
  authMock,
  toastMock,
  swrMock,
  resetFormHarness,
  setDataFor,
} from "@/lib/form-test-harness";

vi.mock("next/navigation", () => navigationMock);
vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
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
