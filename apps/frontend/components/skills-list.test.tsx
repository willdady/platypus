import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Skill } from "@platypus/schemas";
import {
  installRadixPointerPolyfills,
  openDropdownMenu as openMenu,
} from "@/lib/test-utils";

beforeAll(installRadixPointerPolyfills);

// --- Module mocks ------------------------------------------------------------

vi.mock("@/app/client-context", () => ({
  useBackendUrl: () => "http://test",
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    user: { id: "u1" },
    isOrgAdmin: true,
    actor: "org-admin",
  }),
}));

type SkillWithScope = Skill & { scope?: "organization" | "workspace" };

// The `GET .../skills` list this component renders. Set per test.
let skills: SkillWithScope[] = [];

vi.mock("swr", () => ({
  __esModule: true,
  default: (key: string | null) => {
    if (key?.includes("/skills")) {
      return {
        data: { results: skills },
        error: undefined,
        isLoading: false,
        mutate: mutateSpy,
      };
    }
    // Agent-association lookup — unused by these tests.
    return {
      data: { results: [] },
      error: undefined,
      isLoading: false,
      mutate: vi.fn(),
    };
  },
}));

const mutateSpy = vi.fn();

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { SkillsList } from "./skills-list";
import { toast } from "sonner";

// --- Helpers -----------------------------------------------------------------

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

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function openDetachDialog() {
  fireEvent.click(screen.getByText("Shared Skill"));
}

// --- Tests -------------------------------------------------------------------

describe("SkillsList detach", () => {
  afterEach(() => {
    skills = [];
    mutateSpy.mockClear();
    vi.restoreAllMocks();
  });

  it("surfaces the backend's reason and keeps the row when detach is refused", async () => {
    skills = [orgSkill];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(409, { error: "This skill is in use by an agent" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<SkillsList orgId="org1" workspaceId="ws1" />);
    openDetachDialog();
    fireEvent.click(screen.getByRole("button", { name: /Detach/ }));

    await waitFor(() =>
      expect(
        screen.getByText("This skill is in use by an agent"),
      ).toBeInTheDocument(),
    );

    expect(mutateSpy).not.toHaveBeenCalled();
    expect(screen.getByText("Organization Skill")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/attachments/skill/s1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("revalidates and closes the dialog when detach succeeds", async () => {
    skills = [orgSkill];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<SkillsList orgId="org1" workspaceId="ws1" />);
    openDetachDialog();
    fireEvent.click(screen.getByRole("button", { name: /Detach/ }));

    await waitFor(() => expect(mutateSpy).toHaveBeenCalled());
    expect(screen.queryByText("Organization Skill")).not.toBeInTheDocument();
  });
});

describe("SkillsList delete", () => {
  afterEach(() => {
    skills = [];
    mutateSpy.mockClear();
    vi.restoreAllMocks();
  });

  it("surfaces the backend's reason and leaves the skill in place when delete fails", async () => {
    skills = [workspaceSkill];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(409, { error: "Skill is referenced" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SkillsList orgId="org1" workspaceId="ws1" />);
    openMenu();
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.getByText("Skill is referenced")).toBeInTheDocument(),
    );
    expect(mutateSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/skills/s2",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("shows the backend's guidance, not an inline error, when delete is refused because the skill is Shared", async () => {
    skills = [workspaceSkill];
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(403, {
        error: "This skill is managed at the organization level",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<SkillsList orgId="org1" workspaceId="ws1" />);
    openMenu();
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "This skill is managed at the organization level",
      ),
    );
    expect(toast.error).not.toHaveBeenCalled();
    expect(
      screen.queryByText("This skill is managed at the organization level"),
    ).not.toBeInTheDocument();
  });

  it("deletes from the org-scoped path on the Organization surface (no workspaceId)", async () => {
    skills = [orgSkill];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<SkillsList orgId="org1" />);
    openMenu();
    fireEvent.click(screen.getByText("Delete"));
    // The Organization surface checks the live attachment count (a GET)
    // before opening the confirm dialog.
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(mutateSpy).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/skills/s1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("SkillsList promote", () => {
  afterEach(() => {
    skills = [];
    mutateSpy.mockClear();
    vi.restoreAllMocks();
  });

  it("surfaces the backend's reason when promote fails", async () => {
    skills = [workspaceSkill];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(409, { error: "Name already shared" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SkillsList orgId="org1" workspaceId="ws1" />);
    openMenu();
    fireEvent.click(screen.getByText("Promote to organization"));
    fireEvent.click(screen.getByRole("button", { name: "Promote" }));

    await waitFor(() =>
      expect(screen.getByText("Name already shared")).toBeInTheDocument(),
    );
    expect(mutateSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/skills/s2/promote",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
