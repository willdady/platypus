import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import type { Skill } from "@platypus/schemas";
import {
  authMock,
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
  authState,
  menuItemLabels,
  setupUser,
} from "@/test/list-test-harness";
import { openDropdownMenu, selectOption } from "@/test/test-utils";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
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

beforeEach(resetListHarness);

// --- Tests -------------------------------------------------------------------

describe("SkillsList detach", () => {
  it("surfaces the backend's reason and keeps the dialog open when detach is refused", async () => {
    const fetchMock = stubRejectedSave("This skill is in use by an agent", 409);

    await renderSkills([orgSkill], "Detach");
    await confirmDialog(/Detach/);

    expect(
      await screen.findByText("This skill is in use by an agent"),
    ).toBeInTheDocument();

    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByText("Detach shared skill")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/attachments/skill/s1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("revalidates and closes the dialog when detach succeeds", async () => {
    stubAcceptedSave();

    await renderSkills([orgSkill], "Detach");
    await confirmDialog(/Detach/);

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(screen.queryByText("Detach shared skill")).not.toBeInTheDocument();
  });
});

describe("SkillsList shared skill card", () => {
  it("offers Edit in org settings and Detach in its menu", async () => {
    await renderSkills([orgSkill]);
    await openDropdownMenu();

    expect(menuItemLabels()).toEqual(["Edit in org settings", "Detach"]);
    expect(
      screen.getByRole("menuitem", { name: "Edit in org settings" }),
    ).toHaveAttribute("href", "/org1/settings/skills/s1");
  });

  it("does not open Detach when the card is clicked", async () => {
    await renderSkills([orgSkill]);
    fireEvent.click(screen.getByText("Shared Skill"));

    expect(screen.queryByText("Detach shared skill")).not.toBeInTheDocument();
  });

  it("offers no menu to a user who cannot manage Shared resources", async () => {
    authState.actor = "member";

    await renderSkills([orgSkill]);

    expect(
      screen.queryByRole("button", { name: "Actions for Shared Skill" }),
    ).not.toBeInTheDocument();
  });
});

describe("SkillsList invocation badge", () => {
  it("badges a user-invocable-only Skill but not a model-visible one", async () => {
    await renderSkills([
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

  it("badges a Skill that needs a Sandbox, Shared or not", async () => {
    await renderSkills([
      { ...orgSkill, needsSandbox: true },
      { ...workspaceSkill, id: "scripts", name: "Scripts", needsSandbox: true },
      workspaceSkill,
    ]);

    expect(screen.getAllByText("Needs Sandbox")).toHaveLength(2);
  });
});

describe("SkillsList delete", () => {
  it("surfaces the backend's reason and leaves the skill in place when delete fails", async () => {
    const fetchMock = stubRejectedSave("Skill is referenced", 409);

    await renderSkills([workspaceSkill], "Delete");
    await confirmDialog("Delete");

    expect(await screen.findByText("Skill is referenced")).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/skills/s2",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("shows the backend's guidance, not an inline error, when delete is refused because the skill is Shared", async () => {
    stubRejectedSave("This skill is managed at the organization level", 403);

    await renderSkills([workspaceSkill], "Delete");
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

    await renderOrgSkills([orgSkill], "Delete");

    expect(
      await screen.findByText("Can't delete shared skill"),
    ).toBeInTheDocument();
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

    await renderOrgSkills([orgSkill], "Delete");
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

describe("SkillsList card height", () => {
  it("reserves a two-line description box, with the full text on hover", async () => {
    await renderSkills([workspaceSkill]);

    const description = screen.getByText("desc");
    expect(description).toHaveClass("line-clamp-2", "min-h-[2lh]");
    expect(description).toHaveAttribute("title", "desc");
  });

  it("keeps the description box when there is no description", async () => {
    await renderSkills([{ ...workspaceSkill, description: "" }]);

    expect(screen.getByRole("paragraph")).toHaveClass("min-h-[2lh]");
  });

  it("truncates the no-agents warning to one line, with the full text on hover", async () => {
    await renderSkills([workspaceSkill]);

    expect(
      screen.getByText("Skill not associated with any agents.", {
        exact: false,
      }),
    ).toHaveClass("truncate");
    expect(
      screen.getByTitle("WARNING: Skill not associated with any agents."),
    ).toBeInTheDocument();
  });
});

describe("SkillsList unattached warning", () => {
  const card = () =>
    screen.getByText(orgSkill.name).closest('[data-slot="item"]');

  it("warns about a Skill attached to no Workspaces on the Organization surface", async () => {
    mockScopedSWR({ "/attachments?": [] });
    await renderOrgSkills([orgSkill]);

    expect(
      screen.getByText("Not attached to any workspaces."),
    ).toBeInTheDocument();
    expect(card()).toHaveClass("border-warning");
  });

  it("doesn't warn about a Skill attached to a Workspace", async () => {
    mockScopedSWR({
      "/attachments?": [{ workspaceId: "ws1", workspaceName: "Eng" }],
    });
    await renderOrgSkills([orgSkill]);

    expect(
      screen.queryByText("Not attached to any workspaces."),
    ).not.toBeInTheDocument();
    expect(card()).not.toHaveClass("border-warning");
  });

  it("shows a non-admin no warning", async () => {
    authState.actor = "member";
    mockScopedSWR({ "/attachments?": [] });
    await renderOrgSkills([orgSkill]);

    expect(
      screen.queryByText("Not attached to any workspaces."),
    ).not.toBeInTheDocument();
    expect(card()).not.toHaveClass("border-warning");
  });
});

describe("SkillsList promote", () => {
  it("reports an unreachable backend rather than leaving the dialog silent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    await renderSkills([workspaceSkill], "Promote to organization");
    await confirmDialog("Promote");

    expect(
      await screen.findByText("Network request failed"),
    ).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("surfaces the backend's reason when promote fails", async () => {
    const fetchMock = stubRejectedSave("Name already shared", 409);

    await renderSkills([workspaceSkill], "Promote to organization");
    await confirmDialog("Promote");

    expect(await screen.findByText("Name already shared")).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/skills/s2/promote",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("SkillsList filters", () => {
  const skillNamed = (id: string, name: string): SkillWithScope => ({
    ...workspaceSkill,
    id,
    name,
  });

  const search = (text: string) =>
    fireEvent.change(screen.getByRole("searchbox", { name: "Search skills" }), {
      target: { value: text },
    });

  it("narrows the list to the skills whose name fuzzily matches the search", async () => {
    await renderSkills([
      skillNamed("a", "write-release-note"),
      skillNamed("b", "triage-issue"),
    ]);

    search("wrn");

    expect(screen.getByText("write-release-note")).toBeInTheDocument();
    expect(screen.queryByText("triage-issue")).not.toBeInTheDocument();
  });

  it("clears the search with its clear button", async () => {
    await renderSkills([
      skillNamed("a", "write-release-note"),
      skillNamed("b", "triage-issue"),
    ]);

    search("wrn");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    expect(screen.getByText("triage-issue")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Clear search" }),
    ).not.toBeInTheDocument();
  });

  it("says no skills match, rather than none exist, when the filters exclude every skill", async () => {
    await renderSkills([skillNamed("a", "write-release-note")]);

    search("zzz");

    expect(
      screen.getByText("No skills match your filters."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No skills yet/i)).not.toBeInTheDocument();
  });

  it("offers no filters on the Organization surface", async () => {
    await renderOrgSkills([orgSkill]);

    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  describe("in the URL", () => {
    const skills = [skillNamed("a", "alpha"), skillNamed("b", "bravo")];
    const agents = [{ id: "ag1", name: "Writer", skillIds: ["a"] }];
    const renderWithAgents = () => {
      mockScopedSWR({ "/skills": skills, "/agents": agents });
      return renderList(<SkillsList orgId="org1" workspaceId="ws1" />);
    };

    it("writes the search and agent to the query string, leaving defaults out", async () => {
      const replaceState = vi.spyOn(window.history, "replaceState");
      const pushState = vi.spyOn(window.history, "pushState");
      await renderWithAgents();

      search("al");
      search("alp");
      expect(window.location.search).toBe("?skillQuery=alp");

      await selectOption("Any agent", "Writer");
      expect(window.location.search).toBe("?skillQuery=alp&skillAgent=ag1");

      search("  ");
      await selectOption("Writer", "Any agent");
      expect(window.location.search).toBe("");
      // Every write replaces the entry: a keystroke is not a step back.
      expect(replaceState).toHaveBeenCalled();
      expect(pushState).not.toHaveBeenCalled();
    });

    it("reads the search and agent back from the query string", async () => {
      window.history.replaceState(null, "", "?skillQuery=br&skillAgent=ag1");
      await renderWithAgents();

      expect(
        screen.getByRole("searchbox", { name: "Search skills" }),
      ).toHaveValue("br");
      expect(
        screen.getByRole("combobox", { name: "Filter by agent" }),
      ).toHaveTextContent("Writer");
      expect(
        screen.getByText("No skills match your filters."),
      ).toBeInTheDocument();
    });

    it("falls back to any agent for an agent id not in the list", async () => {
      window.history.replaceState(null, "", "?skillAgent=nope");
      await renderWithAgents();

      expect(
        screen.getByRole("combobox", { name: "Filter by agent" }),
      ).toHaveTextContent("Any agent");
      expect(screen.getByText("alpha")).toBeInTheDocument();
      expect(screen.getByText("bravo")).toBeInTheDocument();
    });

    it("ignores the params on the Organization surface, which has no filters", async () => {
      window.history.replaceState(null, "", "?skillQuery=zzz");
      await renderOrgSkills([orgSkill]);

      expect(screen.getByText(orgSkill.name)).toBeInTheDocument();
    });
  });

  describe("by agent", () => {
    const skills = [
      skillNamed("a", "alpha"),
      skillNamed("b", "bravo"),
      skillNamed("c", "charlie"),
    ];
    const agents = [
      { id: "ag1", name: "Writer", skillIds: ["a", "b"] },
      { id: "ag2", name: "Triager", skillIds: ["b"] },
      { id: "ag3", name: "Idle", skillIds: [] },
    ];

    const renderWithAgents = () => {
      mockScopedSWR({ "/skills": skills, "/agents": agents });
      return renderList(<SkillsList orgId="org1" workspaceId="ws1" />);
    };

    const shownNames = () =>
      ["alpha", "bravo", "charlie"].filter((name) => screen.queryByText(name));

    it("shows only the skills attached to the chosen agent", async () => {
      await renderWithAgents();

      await selectOption("Any agent", "Triager");

      expect(shownNames()).toEqual(["bravo"]);
    });

    it("shows only the skills attached to no agent when Unattached is chosen", async () => {
      await renderWithAgents();

      await selectOption("Any agent", "Unattached");

      expect(shownNames()).toEqual(["charlie"]);
    });

    it("falls back to any agent when the chosen agent no longer uses a listed skill", async () => {
      const { rerender } = await renderWithAgents();
      await selectOption("Any agent", "Triager");

      mockScopedSWR({
        "/agents": agents.map((agent) =>
          agent.id === "ag2" ? { ...agent, skillIds: [] } : agent,
        ),
      });
      rerender(<SkillsList orgId="org1" workspaceId="ws1" />);

      expect(shownNames()).toEqual(["alpha", "bravo", "charlie"]);
      expect(
        screen.getByRole("combobox", { name: "Filter by agent" }),
      ).toHaveTextContent("Any agent");
    });

    it("offers only agents attached to a listed skill", async () => {
      await renderWithAgents();

      fireEvent.keyDown(
        screen.getByRole("combobox", { name: "Filter by agent" }),
        {
          key: "ArrowDown",
        },
      );

      const options = await screen.findAllByRole("option");
      expect(options.map((option) => option.textContent)).toEqual([
        "Any agent",
        "Writer",
        "Triager",
        "Unattached",
      ]);
    });
  });
});

describe("SkillsList list states", () => {
  it("shows the empty state, without filter controls, when the workspace has no skills", async () => {
    await renderSkills([]);

    expect(screen.getByText(/No skills yet/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("searchbox", { name: "Search skills" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Filter by agent" }),
    ).not.toBeInTheDocument();
  });

  it("surfaces a failed read rather than rendering an empty list", async () => {
    mockScopedSWR({ "/skills": { error: new Error("500") } });
    await renderList(<SkillsList orgId="org1" workspaceId="ws1" />);

    expect(screen.getByText(/Failed to load skills/)).toBeInTheDocument();
  });

  it("holds the grid with a skeleton, not the empty state, while loading", async () => {
    mockScopedSWR({ "/skills": { isLoading: true } });
    await renderList(<SkillsList orgId="org1" workspaceId="ws1" />);

    expect(
      screen.getByRole("status", { name: "Loading skills" }),
    ).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText(/No skills yet/i)).not.toBeInTheDocument();
  });
});

describe("SkillsList paging", () => {
  // Ten skills, "skill-01" … "skill-10": two pages of eight.
  const tenSkills = Array.from({ length: 10 }, (_, i) => {
    const name = `skill-${String(i + 1).padStart(2, "0")}`;
    return { ...workspaceSkill, id: name, name };
  });
  const shownNames = () =>
    tenSkills.map((s) => s.name).filter((name) => screen.queryByText(name));
  const pages = () =>
    screen.queryByRole("navigation", { name: "Skills pages" });

  it("shows eight skills and pages to the rest, writing the page to the URL", async () => {
    await renderSkills(tenSkills);

    expect(shownNames()).toEqual(tenSkills.slice(0, 8).map((s) => s.name));
    expect(pages()).toHaveTextContent("Page 1 of 2");
    expect(
      screen.getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();

    await setupUser().click(screen.getByRole("button", { name: "Next page" }));

    expect(shownNames()).toEqual(["skill-09", "skill-10"]);
    expect(pages()).toHaveTextContent("Page 2 of 2");
    expect(window.location.search).toBe("?skillsPage=2");
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();

    await setupUser().click(
      screen.getByRole("button", { name: "Previous page" }),
    );
    expect(window.location.search).toBe("");
  });

  it("reads the page back from the URL", async () => {
    window.history.replaceState(null, "", "?skillsPage=2");
    await renderSkills(tenSkills);

    expect(shownNames()).toEqual(["skill-09", "skill-10"]);
  });

  it.each([
    ["abc", "Page 1 of 2"],
    ["0", "Page 1 of 2"],
    ["-3", "Page 1 of 2"],
    ["999", "Page 2 of 2"],
  ])("clamps ?skillsPage=%s to a valid page", async (value, expected) => {
    window.history.replaceState(null, "", `?skillsPage=${value}`);
    await renderSkills(tenSkills);

    expect(pages()).toHaveTextContent(expected);
  });

  it("shows the new last page when the current one empties", async () => {
    window.history.replaceState(null, "", "?skillsPage=2");
    const { rerender } = await renderSkills(tenSkills);

    mockScopedSWR({ "/skills": tenSkills.slice(0, 9) });
    rerender(<SkillsList orgId="org1" workspaceId="ws1" />);
    expect(shownNames()).toEqual(["skill-09"]);

    mockScopedSWR({ "/skills": tenSkills.slice(0, 8) });
    rerender(<SkillsList orgId="org1" workspaceId="ws1" />);
    expect(shownNames()).toEqual(tenSkills.slice(0, 8).map((s) => s.name));
    expect(pages()).not.toBeInTheDocument();
  });

  it("returns to page 1 when a filter changes", async () => {
    window.history.replaceState(null, "", "?skillsPage=2");
    await renderSkills(tenSkills);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search skills" }), {
      target: { value: "skill" },
    });

    expect(window.location.search).toBe("?skillQuery=skill");
    expect(pages()).toHaveTextContent("Page 1 of 2");
  });

  it("hides the page controls when the filters match nothing", async () => {
    await renderSkills(tenSkills);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search skills" }), {
      target: { value: "zzz" },
    });

    expect(
      screen.getByText("No skills match your filters."),
    ).toBeInTheDocument();
    expect(pages()).not.toBeInTheDocument();
  });

  it("draws no page controls for a list that fits on one page", async () => {
    await renderSkills(tenSkills.slice(0, 8));

    expect(pages()).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Create skill/ }),
    ).toBeInTheDocument();
  });

  it("does not page the Organization surface", async () => {
    await renderOrgSkills(tenSkills);

    expect(shownNames()).toHaveLength(10);
    expect(pages()).not.toBeInTheDocument();
  });
});
