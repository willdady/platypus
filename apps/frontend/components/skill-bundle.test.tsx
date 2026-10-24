import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Skill } from "@platypus/schemas";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
} from "@/test/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { SkillBundleCard } from "./skill-bundle";
import type { Serialized } from "@/lib/api-write";

function file(path: string, isText: boolean) {
  return {
    id: path,
    path,
    size: 10,
    sha256: "x",
    isText,
  };
}

function skill(overrides: Partial<Serialized<Skill>>): Serialized<Skill> {
  return {
    id: "s1",
    name: "pdf",
    description: "d",
    body: "b",
    frontmatter: {},
    needsSandbox: false,
    files: [],
    ...overrides,
  } as Serialized<Skill>;
}

const WARNING =
  "Some files in this Skill can't be copied to this Workspace's Sandbox.";

function renderCard(
  value: Serialized<Skill>,
  workspaceId: string | undefined = "ws1",
) {
  return render(
    <SkillBundleCard
      scope={workspaceId ? { orgId: "org1", workspaceId } : { orgId: "org1" }}
      skill={value}
      onReplaced={() => {}}
    />,
  );
}

/** The reads the card makes, the Skill import gate open unless overridden. */
function mockReads(
  reads: Record<string, { data: unknown }> = {},
  gate = { skillImportGate: "all", skillImportAllowed: false },
) {
  mockScopedSWR(
    {
      "/sandbox": { data: null },
      // Matched by substring, first wins: the Workspace URL holds the Organization's.
      "/workspaces/ws1": {
        data: { id: "ws1", skillImportAllowed: gate.skillImportAllowed },
      },
      "/organizations/org1": {
        data: { id: "org1", skillImportGate: gate.skillImportGate },
      },
      ...reads,
    },
    { strict: true },
  );
}

beforeEach(() => {
  resetListHarness();
  mockReads();
});

describe("SkillBundleCard", () => {
  it("badges a Skill that needs a Sandbox", () => {
    renderCard(skill({ needsSandbox: true }));
    expect(screen.getByText("Needs Sandbox")).toBeInTheDocument();
  });

  it("does not badge one that doesn't", () => {
    renderCard(skill({ files: [file("references/a.md", true)] }));
    expect(screen.queryByText("Needs Sandbox")).not.toBeInTheDocument();
  });

  it("warns when the Sandbox can't take this Skill's binary files", () => {
    mockReads({ "/sandbox": { data: { transfer: { upload: false } } } });
    renderCard(skill({ needsSandbox: true, files: [file("logo.png", false)] }));
    expect(screen.getByText(WARNING)).toBeInTheDocument();
  });

  it.each([
    ["the Sandbox takes binary files", { upload: true }, false],
    ["the Skill has only text files", { upload: false }, true],
  ])("doesn't warn when %s", (_label, transfer, textOnly) => {
    mockReads({ "/sandbox": { data: { transfer } } });
    renderCard(skill({ files: [file("logo.png", textOnly)] }));
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it("doesn't warn when the Workspace has no Sandbox", () => {
    renderCard(skill({ files: [file("logo.png", false)] }));
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it.each([
    ["all", false, true],
    ["selected", true, true],
    ["selected", false, false],
    ["off", true, false],
  ])(
    "under the %s gate, with the Workspace allowed %s, offers Replace bundle: %s",
    (skillImportGate, skillImportAllowed, offered) => {
      mockReads({}, { skillImportGate, skillImportAllowed });
      renderCard(skill({}));
      expect(
        screen.queryByRole("button", { name: /Replace bundle/ }) !== null,
      ).toBe(offered);
    },
  );

  it("always offers Replace bundle at Organization scope", () => {
    mockReads({}, { skillImportGate: "off", skillImportAllowed: false });
    render(
      <SkillBundleCard
        scope={{ orgId: "org1" }}
        skill={skill({})}
        onReplaced={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Replace bundle/ }),
    ).toBeInTheDocument();
  });

  it("says where a Skill installed from GitHub came from", () => {
    renderCard(
      skill({
        sourceType: "github",
        source: "anthropics/skills",
        skillPath: "skills/pdf",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
      }),
    );
    expect(
      screen.getByRole("link", {
        name: "anthropics/skills/skills/pdf @ 0123456",
      }),
    ).toHaveAttribute(
      "href",
      "https://github.com/anthropics/skills/tree/0123456789abcdef0123456789abcdef01234567/skills/pdf",
    );
  });
});
