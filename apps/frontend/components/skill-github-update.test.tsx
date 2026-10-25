import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { Skill, SkillGithubUpdateCheck } from "@platypus/schemas";
import type { Serialized } from "@/lib/api-write";
import { SkillGithubUpdate } from "./skill-github-update";

const FROM = "a".repeat(40);
const TO = "b".repeat(40);

const DIFF: SkillGithubUpdateCheck = {
  upToDate: false,
  fromSha: FROM,
  toSha: TO,
  files: {
    added: [{ path: "scripts/run.sh", size: 20 }],
    removed: [{ path: "old.md", size: 10 }],
    changed: [{ path: "forms.md", oldSize: 7, newSize: 16 }],
  },
  skillMd: {
    before: "---\nname: pdf\n---\nUse pdf.",
    after: "---\nname: pdf\n---\nUse pdf better.",
  },
  needsSandbox: { before: false, after: true },
};

let check: SkillGithubUpdateCheck;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  check = DIFF;
  fetchMock = vi.fn((url: string) =>
    Promise.resolve(
      Response.json(url.endsWith("/check") ? check : { id: "s1", name: "pdf" }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function renderUpdate(modified: boolean, onUpdated = vi.fn()) {
  render(
    <SkillGithubUpdate
      skillUrl="/api/skills/s1"
      skill={{ id: "s1", modified } as Serialized<Skill>}
      onUpdated={onUpdated}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  return onUpdated;
}

function updateCalls() {
  return (fetchMock.mock.calls as [string, RequestInit][]).filter(([url]) =>
    url.endsWith("/update"),
  );
}

describe("SkillGithubUpdate", () => {
  it("says when the Skill is up to date", async () => {
    check = { upToDate: true };
    renderUpdate(false);
    expect(await screen.findByText("Up to date")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Update" }),
    ).not.toBeInTheDocument();
  });

  it("shows the file changes, the SKILL.md diff and the Sandbox change", async () => {
    renderUpdate(false);
    expect(await screen.findByText("aaaaaaa → bbbbbbb")).toBeInTheDocument();
    expect(screen.getByText("scripts/run.sh")).toBeInTheDocument();
    expect(screen.getByText("Removed")).toBeInTheDocument();
    expect(screen.getByText("7 B → 16 B")).toBeInTheDocument();
    expect(screen.getByText("- Use pdf.")).toBeInTheDocument();
    expect(screen.getByText("+ Use pdf better.")).toBeInTheDocument();
    expect(
      screen.getByText("After this update the skill needs a Sandbox."),
    ).toBeInTheDocument();
    expect(screen.getByText("Third-party scripts")).toBeInTheDocument();
  });

  it("updates an unedited Skill to the checked commit straight away", async () => {
    const onUpdated = renderUpdate(false);
    fireEvent.click(await screen.findByRole("button", { name: "Update" }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(JSON.parse(updateCalls()[0][1].body as string)).toEqual({
      commitSha: TO,
    });
  });

  it("warns a Modified Skill's edits will be lost before updating", async () => {
    const onUpdated = renderUpdate(true);
    fireEvent.click(await screen.findByRole("button", { name: "Update" }));
    expect(
      await screen.findByText(/Updating replaces those edits/),
    ).toBeInTheDocument();
    expect(updateCalls()).toEqual([]);

    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Update",
      }),
    );
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
  });
});
