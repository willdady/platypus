import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SkillGithubPreview } from "@platypus/schemas";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
} from "@/test/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { SkillGithubInstall } from "./skill-github-install";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const WARNING = /1 selected Skill includes scripts written by a third party/;

function candidate(
  skillPath: string,
  overrides: Partial<SkillGithubPreview["skills"][number]> = {},
) {
  return {
    skillPath,
    name: skillPath.split("/").at(-1)!,
    description: "A skill.",
    body: "Use it.",
    files: [],
    needsSandbox: false,
    error: null,
    taken: false,
    ...overrides,
  };
}

const PREVIEW: SkillGithubPreview = {
  owner: "anthropics",
  repo: "skills",
  ref: null,
  path: "skills",
  commitSha: SHA,
  skills: [
    candidate("skills/pdf", {
      needsSandbox: true,
      files: [{ path: "scripts/fill.py", size: 2048 }],
    }),
    candidate("skills/docx"),
    candidate("skills/taken", { taken: true }),
    candidate("skills/broken", {
      name: null,
      description: null,
      body: null,
      error: "Frontmatter is not valid YAML at line 3",
    }),
  ],
};

/** What a test changes about the preview the fake GitHub answers. */
let PREVIEW_OVERRIDE: Partial<SkillGithubPreview>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetListHarness();
  PREVIEW_OVERRIDE = {};
  mockScopedSWR(
    {
      "/workspaces/ws1": { data: { id: "ws1", skillImportAllowed: false } },
      "/organizations/org1": { data: { id: "org1", skillImportGate: "all" } },
    },
    { strict: true },
  );
  fetchMock = vi.fn((url: string) =>
    Promise.resolve(
      Response.json(
        url.endsWith("/preview")
          ? { ...PREVIEW, ...PREVIEW_OVERRIDE }
          : {
              results: [
                {
                  skillPath: "skills/pdf",
                  status: 201,
                  skillId: "s1",
                  name: "pdf",
                },
              ],
            },
      ),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function renderInstall() {
  render(
    <SkillGithubInstall
      scope={{ orgId: "org1", workspaceId: "ws1" }}
      skillsHref="/skills"
      skillHrefBase="/skills"
    />,
  );
  fireEvent.change(screen.getByLabelText("GitHub repository"), {
    target: { value: "anthropics/skills/skills" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Find skills" }));
  await screen.findByText(/anthropics\/skills@0123456/);
}

describe("SkillGithubInstall", () => {
  it("can't pick a Skill whose name is taken or that breaks a rule, and says why", async () => {
    await renderInstall();
    expect(screen.getByRole("checkbox", { name: /taken/ })).toBeDisabled();
    expect(
      screen.getByText("A skill named taken already exists here."),
    ).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /broken/ })).toBeDisabled();
    expect(
      screen.getByText("Frontmatter is not valid YAML at line 3"),
    ).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /docx/ })).toBeEnabled();
  });

  it("warns about third-party scripts once a Skill needing a Sandbox is picked", async () => {
    await renderInstall();
    fireEvent.click(screen.getByRole("checkbox", { name: /docx/ }));
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /pdf/ }));
    expect(screen.getByText(WARNING)).toBeInTheDocument();
  });

  it("installs the picked Skills at the previewed commit and shows how each went", async () => {
    await renderInstall();
    fireEvent.click(screen.getByRole("checkbox", { name: /pdf/ }));
    fireEvent.click(screen.getByRole("button", { name: "Install 1 skill" }));

    await screen.findByRole("link", { name: "pdf" });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toMatch(/\/workspaces\/ws1\/skills\/github\/install$/);
    expect(JSON.parse(init.body as string)).toEqual({
      owner: "anthropics",
      repo: "skills",
      ref: null,
      commitSha: SHA,
      skillPaths: ["skills/pdf"],
    });
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "pdf" })).toHaveAttribute(
        "href",
        "/skills/s1",
      ),
    );
  });

  it("picks no more Skills than one install takes", async () => {
    PREVIEW_OVERRIDE.skills = Array.from({ length: 51 }, (_, i) =>
      candidate(`skills/s${i}`),
    );
    await renderInstall();
    fireEvent.click(screen.getByRole("button", { name: "Select first 50" }));
    expect(
      screen.getByRole("button", { name: "Install 50 skills" }),
    ).toBeEnabled();
    expect(screen.getAllByRole("checkbox")[50]).toBeDisabled();
  });

  it("explains instead when the Organization's gate shuts this Workspace out", () => {
    mockScopedSWR(
      {
        "/workspaces/ws1": { data: { id: "ws1", skillImportAllowed: false } },
        "/organizations/org1": { data: { id: "org1", skillImportGate: "off" } },
      },
      { strict: true },
    );
    render(
      <SkillGithubInstall
        scope={{ orgId: "org1", workspaceId: "ws1" }}
        skillsHref="/skills"
        skillHrefBase="/skills"
      />,
    );
    expect(
      screen.getByText(/doesn't allow importing skills into this workspace/),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("GitHub repository"),
    ).not.toBeInTheDocument();
  });
});
