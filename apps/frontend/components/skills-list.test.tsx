import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import type { Skill } from "@platypus/schemas";
import {
  authMock,
  toastMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
  confirmDialog,
  stubAcceptedSave,
  stubRejectedSave,
  mutate,
  toastError,
  toastInfo,
} from "@/lib/list-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import { SkillsList } from "./skills-list";

// --- Fixtures ----------------------------------------------------------------

type SkillWithScope = Skill & { scope?: "organization" | "workspace" };

const orgSkill: SkillWithScope = {
  id: "s1",
  name: "Shared Skill",
  description: "desc",
  scope: "organization",
} as unknown as SkillWithScope;

const workspaceSkill: SkillWithScope = {
  id: "s2",
  name: "Workspace Skill",
  description: "desc",
  scope: "workspace",
} as unknown as SkillWithScope;

/** Renders the Workspace surface with `skills` in the list. */
function renderSkills(skills: SkillWithScope[], menuItem?: string) {
  mockScopedSWR({ "/skills": skills });
  return renderList(<SkillsList orgId="org1" workspaceId="ws1" />, menuItem);
}

/** Renders the Organization surface, which has no `workspaceId`. */
function renderOrgSkills(skills: SkillWithScope[], menuItem?: string) {
  mockScopedSWR({ "/skills": skills });
  return renderList(<SkillsList orgId="org1" />, menuItem);
}

const openDetachDialog = () =>
  fireEvent.click(screen.getByText("Shared Skill"));

beforeEach(resetListHarness);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe("SkillsList detach", () => {
  it("surfaces the backend's reason and keeps the row when detach is refused", async () => {
    const fetchMock = stubRejectedSave("This skill is in use by an agent", 409);

    renderSkills([orgSkill]);
    openDetachDialog();
    await confirmDialog(/Detach/);

    await waitFor(() =>
      expect(
        screen.getByText("This skill is in use by an agent"),
      ).toBeInTheDocument(),
    );

    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByText("Organization Skill")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/attachments/skill/s1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("revalidates and closes the dialog when detach succeeds", async () => {
    stubAcceptedSave();

    renderSkills([orgSkill]);
    openDetachDialog();
    await confirmDialog(/Detach/);

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(screen.queryByText("Organization Skill")).not.toBeInTheDocument();
  });
});

describe("SkillsList invocation badge", () => {
  it("badges a user-invocable-only Skill but not a model-visible one", () => {
    renderSkills([
      {
        ...workspaceSkill,
        id: "user-only",
        name: "User Only Skill",
        disableModelInvocation: true,
      },
      workspaceSkill,
    ]);

    expect(screen.getAllByText("User-invocable only")).toHaveLength(1);
    expect(screen.getByText("Workspace Skill")).toBeInTheDocument();
  });
});

describe("SkillsList delete", () => {
  it("surfaces the backend's reason and leaves the skill in place when delete fails", async () => {
    const fetchMock = stubRejectedSave("Skill is referenced", 409);

    renderSkills([workspaceSkill], "Delete");
    await confirmDialog("Delete");

    await waitFor(() =>
      expect(screen.getByText("Skill is referenced")).toBeInTheDocument(),
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/skills/s2",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("shows the backend's guidance, not an inline error, when delete is refused because the skill is Shared", async () => {
    stubRejectedSave("This skill is managed at the organization level", 403);

    renderSkills([workspaceSkill], "Delete");
    await confirmDialog("Delete");

    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(
        "This skill is managed at the organization level",
      ),
    );
    expect(toastError).not.toHaveBeenCalled();
    expect(
      screen.queryByText("This skill is managed at the organization level"),
    ).not.toBeInTheDocument();
  });

  it("blocks delete and reports the attachment count when the skill is still attached", async () => {
    const fetchMock = stubAcceptedSave({ results: [{ id: "att1" }] });

    renderOrgSkills([orgSkill], "Delete");

    await waitFor(() =>
      expect(screen.getByText("Can't delete shared skill")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/is shared with 1 workspace\./),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/attachments?resourceType=skill&resourceId=s1",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("deletes from the org-scoped path on the Organization surface (no workspaceId)", async () => {
    const fetchMock = stubAcceptedSave();

    renderOrgSkills([orgSkill], "Delete");
    // The Organization surface checks the live attachment count (a GET)
    // before opening the confirm dialog.
    await confirmDialog("Delete");

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/skills/s1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("SkillsList promote", () => {
  it("reports an unreachable backend rather than leaving the dialog silent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    renderSkills([workspaceSkill], "Promote to organization");
    await confirmDialog("Promote");

    await waitFor(() =>
      expect(screen.getByText("Network request failed")).toBeInTheDocument(),
    );
    expect(mutate).not.toHaveBeenCalled();
  });

  it("surfaces the backend's reason when promote fails", async () => {
    const fetchMock = stubRejectedSave("Name already shared", 409);

    renderSkills([workspaceSkill], "Promote to organization");
    await confirmDialog("Promote");

    await waitFor(() =>
      expect(screen.getByText("Name already shared")).toBeInTheDocument(),
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/skills/s2/promote",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("SkillsList list states", () => {
  it("shows the empty state when the workspace has no skills", () => {
    renderSkills([]);

    expect(screen.getByText(/No skills yet/i)).toBeInTheDocument();
  });

  it("surfaces a failed read rather than rendering an empty list", () => {
    mockScopedSWR({ "/skills": { error: new Error("500") } });
    renderList(<SkillsList orgId="org1" workspaceId="ws1" />);

    expect(screen.getByText(/Failed to load skills/)).toBeInTheDocument();
  });
});
