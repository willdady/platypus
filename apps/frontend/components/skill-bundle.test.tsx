import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Skill } from "@platypus/schemas";
import {
  authMock,
  toastMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
} from "@/lib/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import { SkillBundleCard } from "./skill-bundle";

const file = (path: string, isText: boolean) => ({
  id: path,
  path,
  size: 10,
  sha256: "x",
  isText,
});

const skill = (overrides: Partial<Skill>): Skill =>
  ({
    id: "s1",
    name: "pdf",
    description: "d",
    body: "b",
    frontmatter: {},
    needsSandbox: false,
    files: [],
    ...overrides,
  }) as Skill;

const WARNING =
  "Some files in this Skill can't be copied to this Workspace's Sandbox.";

const renderCard = (value: Skill, workspaceId: string | undefined = "ws1") =>
  render(
    <SkillBundleCard
      scope={workspaceId ? { orgId: "org1", workspaceId } : { orgId: "org1" }}
      skill={value}
      onReplaced={() => {}}
    />,
  );

beforeEach(() => {
  resetListHarness();
  mockScopedSWR({ "/sandbox": { data: null } });
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
    mockScopedSWR({ "/sandbox": { data: { transfer: { upload: false } } } });
    renderCard(skill({ needsSandbox: true, files: [file("logo.png", false)] }));
    expect(screen.getByText(WARNING)).toBeInTheDocument();
  });

  it.each([
    ["the Sandbox takes binary files", { upload: true }, false],
    ["the Skill has only text files", { upload: false }, true],
  ])("doesn't warn when %s", (_label, transfer, textOnly) => {
    mockScopedSWR({ "/sandbox": { data: { transfer } } });
    renderCard(skill({ files: [file("logo.png", textOnly)] }));
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it("doesn't warn when the Workspace has no Sandbox", () => {
    renderCard(skill({ files: [file("logo.png", false)] }));
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });
});
