import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TagCloud } from "./tag-cloud";

// Mock SWR
vi.mock("swr", () => ({
  default: vi.fn(),
}));

// Mock auth provider
vi.mock("./auth-provider", () => ({
  useAuth: vi.fn(),
}));

// Mock client context
vi.mock("@/app/client-context", () => ({
  useBackendUrl: vi.fn(),
}));

import useSWR from "swr";
import { useAuth } from "./auth-provider";
import { useBackendUrl } from "@/app/client-context";

describe("TagCloud", () => {
  const mockOrgId = "test-org-id";
  const mockWorkspaceId = "test-workspace-id";
  const mockBackendUrl = "http://localhost:4000";
  const mockTags = [
    { tag: "react", count: 10 },
    { tag: "typescript", count: 5 },
    { tag: "testing", count: 2 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useBackendUrl).mockReturnValue(mockBackendUrl);
    vi.mocked(useAuth).mockReturnValue({
      user: { id: "test-user-id" },
      session: null,
      isPending: false,
      isAuthLoading: false,
      error: null,
      authClient: {} as any,
      orgMembership: null,
      isOrgAdmin: false,
      isWorkspaceOwner: false,
      hasWorkspaceAccess: false,
    });
  });

  it("should call onTagToggle with correct tag when clicked", () => {
    const onTagToggle = vi.fn();
    vi.mocked(useSWR).mockReturnValue({
      data: { results: mockTags },
      isLoading: false,
      error: undefined,
      mutate: vi.fn(),
      isValidating: false,
    });

    render(
      <TagCloud
        orgId={mockOrgId}
        workspaceId={mockWorkspaceId}
        selectedTags={[]}
        onTagToggle={onTagToggle}
      />,
    );

    const reactTag = screen
      .getByText("react")
      .closest("span[data-slot='badge']");
    expect(reactTag).toBeInTheDocument();
    fireEvent.click(reactTag!);

    expect(onTagToggle).toHaveBeenCalledTimes(1);
    expect(onTagToggle).toHaveBeenCalledWith("react");
  });

  it("should display selected tags with variant='default' styling", () => {
    vi.mocked(useSWR).mockReturnValue({
      data: { results: mockTags },
      isLoading: false,
      error: undefined,
      mutate: vi.fn(),
      isValidating: false,
    });

    render(
      <TagCloud
        orgId={mockOrgId}
        workspaceId={mockWorkspaceId}
        selectedTags={["react"]}
        onTagToggle={vi.fn()}
      />,
    );

    // Find the badge containing "react" text
    const reactBadge = screen
      .getByText("react")
      .closest("span[data-slot='badge']");

    // Selected tags should have bg-primary class (variant="default")
    expect(reactBadge).toHaveClass("bg-primary");
    expect(reactBadge).toHaveClass("text-primary-foreground");
  });

  it("should display unselected tags with variant='secondary' styling", () => {
    vi.mocked(useSWR).mockReturnValue({
      data: { results: mockTags },
      isLoading: false,
      error: undefined,
      mutate: vi.fn(),
      isValidating: false,
    });

    render(
      <TagCloud
        orgId={mockOrgId}
        workspaceId={mockWorkspaceId}
        selectedTags={["react"]}
        onTagToggle={vi.fn()}
      />,
    );

    // Find unselected tags (typescript and testing)
    const typescriptBadge = screen
      .getByText("typescript")
      .closest("span[data-slot='badge']");
    const testingBadge = screen
      .getByText("testing")
      .closest("span[data-slot='badge']");

    // Unselected tags should have bg-secondary class (variant="secondary")
    expect(typescriptBadge).toHaveClass("bg-secondary");
    expect(typescriptBadge).toHaveClass("text-secondary-foreground");
    expect(testingBadge).toHaveClass("bg-secondary");
    expect(testingBadge).toHaveClass("text-secondary-foreground");
  });

  it("should have cursor-pointer class on tags (clickable)", () => {
    vi.mocked(useSWR).mockReturnValue({
      data: { results: mockTags },
      isLoading: false,
      error: undefined,
      mutate: vi.fn(),
      isValidating: false,
    });

    render(
      <TagCloud
        orgId={mockOrgId}
        workspaceId={mockWorkspaceId}
        selectedTags={[]}
        onTagToggle={vi.fn()}
      />,
    );

    const reactBadge = screen
      .getByText("react")
      .closest("span[data-slot='badge']");
    const typescriptBadge = screen
      .getByText("typescript")
      .closest("span[data-slot='badge']");

    // All tags should have cursor-pointer class
    expect(reactBadge).toHaveClass("cursor-pointer");
    expect(typescriptBadge).toHaveClass("cursor-pointer");
  });

  it("should show loading state when data is loading", () => {
    vi.mocked(useSWR).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: undefined,
      mutate: vi.fn(),
      isValidating: false,
    });

    render(
      <TagCloud
        orgId={mockOrgId}
        workspaceId={mockWorkspaceId}
        selectedTags={[]}
      />,
    );

    // Should show loading skeleton with "Tag Cloud" title
    expect(screen.getByText("Tag Cloud")).toBeInTheDocument();
    // Should show loading skeleton elements (animate-pulse class on container)
    expect(screen.getByText("Tag Cloud").closest(".animate-pulse")).toBeNull();
    // The loading skeleton is inside CardContent
    const skeletonContainer = document.querySelector(".animate-pulse");
    expect(skeletonContainer).toBeInTheDocument();
  });

  it("should return null when no tags are available", () => {
    vi.mocked(useSWR).mockReturnValue({
      data: { results: [] },
      isLoading: false,
      error: undefined,
      mutate: vi.fn(),
      isValidating: false,
    });

    const { container } = render(
      <TagCloud
        orgId={mockOrgId}
        workspaceId={mockWorkspaceId}
        selectedTags={[]}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("should not fetch when user is not authenticated", () => {
    vi.mocked(useAuth).mockReturnValue({
      user: null,
      session: null,
      isPending: false,
      isAuthLoading: false,
      error: null,
      authClient: {} as any,
      orgMembership: null,
      isOrgAdmin: false,
      isWorkspaceOwner: false,
      hasWorkspaceAccess: false,
    });

    vi.mocked(useSWR).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: undefined,
      mutate: vi.fn(),
      isValidating: false,
    });

    render(
      <TagCloud
        orgId={mockOrgId}
        workspaceId={mockWorkspaceId}
        selectedTags={[]}
      />,
    );

    // SWR should be called with null key when user is not authenticated
    expect(useSWR).toHaveBeenCalledWith(null, expect.any(Function));
  });

  it("should display tag counts alongside tag names", () => {
    vi.mocked(useSWR).mockReturnValue({
      data: { results: mockTags },
      isLoading: false,
      error: undefined,
      mutate: vi.fn(),
      isValidating: false,
    });

    render(
      <TagCloud
        orgId={mockOrgId}
        workspaceId={mockWorkspaceId}
        selectedTags={[]}
      />,
    );

    // Check that counts are displayed
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("should apply different font sizes based on tag count", () => {
    vi.mocked(useSWR).mockReturnValue({
      data: { results: mockTags },
      isLoading: false,
      error: undefined,
      mutate: vi.fn(),
      isValidating: false,
    });

    render(
      <TagCloud
        orgId={mockOrgId}
        workspaceId={mockWorkspaceId}
        selectedTags={[]}
      />,
    );

    const reactBadge = screen
      .getByText("react")
      .closest("span[data-slot='badge']");
    const testingBadge = screen
      .getByText("testing")
      .closest("span[data-slot='badge']");

    // React has count 10 (max), testing has count 2 (min)
    // React should have larger font size
    const reactFontSize = reactBadge?.style.fontSize;
    const testingFontSize = testingBadge?.style.fontSize;

    expect(reactFontSize).toBeDefined();
    expect(testingFontSize).toBeDefined();
    expect(parseFloat(reactFontSize!)).toBeGreaterThan(
      parseFloat(testingFontSize!),
    );
  });
});
