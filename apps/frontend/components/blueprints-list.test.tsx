import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Blueprint } from "@platypus/schemas";
import {
  installRadixPointerPolyfills,
  openDropdownMenu as openMenu,
} from "@/lib/test-utils";

beforeAll(installRadixPointerPolyfills);

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => ({ user: { id: "u1" } }),
}));

const { toastInfoSpy } = vi.hoisted(() => ({ toastInfoSpy: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: toastInfoSpy, success: vi.fn() },
}));

// The `GET .../blueprints` list this component renders. Set per test.
let blueprints: Blueprint[] = [];
const mutateSpy = vi.fn();

vi.mock("swr", () => ({
  __esModule: true,
  default: () => ({
    data: { results: blueprints },
    error: undefined,
    isLoading: false,
    mutate: mutateSpy,
  }),
}));

import { BlueprintsList } from "./blueprints-list";

// --- Fixtures ----------------------------------------------------------------

const blueprint: Blueprint = {
  id: "b1",
  name: "Starter",
  description: "Starter workspace",
  items: [],
} as unknown as Blueprint;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  blueprints = [];
  mutateSpy.mockClear();
  toastInfoSpy.mockClear();
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe("BlueprintsList delete", () => {
  it("deletes through the request module and revalidates on success", async () => {
    blueprints = [blueprint];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<BlueprintsList orgId="org1" />);
    openMenu();
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(mutateSpy).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/blueprints/b1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("surfaces the backend's reason inline and does not revalidate when delete is refused", async () => {
    blueprints = [blueprint];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(409, { error: "Blueprint is in use" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<BlueprintsList orgId="org1" />);
    openMenu();
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.getByText("Blueprint is in use")).toBeInTheDocument(),
    );
    expect(mutateSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("surfaces a forbidden refusal inline like any other failure", async () => {
    blueprints = [blueprint];
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(403, {
        error: "You do not have permission to delete blueprints",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<BlueprintsList orgId="org1" />);
    openMenu();
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(
        screen.getByText("You do not have permission to delete blueprints"),
      ).toBeInTheDocument(),
    );
    expect(toastInfoSpy).not.toHaveBeenCalled();
    expect(mutateSpy).not.toHaveBeenCalled();
  });
});
