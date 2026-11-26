import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { contextCreateSchema } from "@platypus/schemas";
import {
  authMock,
  configuredMutate,
  push,
  toastError,
  toastSuccess,
  resetFormHarness,
  stubAcceptedSave,
  stubRejectedSave,
} from "@/test/form-test-harness";
import { expectSentBodyToMatchSchema, selectOption } from "@/test/test-utils";
import { FIX_FORM_ERRORS_MESSAGE } from "@/lib/apply-write-outcome";

// why: vi.hoisted, so the swr mock can read it before the module body runs
const state = vi.hoisted(
  (): {
    contextData: unknown;
    orgsError: Error | undefined;
    workspacesError: Error | undefined;
    workspacesPending: boolean;
    noOrgs: boolean;
  } => ({
    contextData: undefined,
    orgsError: undefined,
    workspacesError: undefined,
    workspacesPending: false,
    noOrgs: false,
  }),
);

vi.mock("@/components/auth-provider", () => authMock);

const workspaces = [
  { id: "ws1", name: "Alpha", organizationId: "o1" },
  { id: "ws2", name: "Beta", organizationId: "o1" },
];

// why: four keys with an array key — more than the harness's swrMock expresses
vi.mock("swr", () => ({
  __esModule: true,
  default: (key: unknown) => {
    if (Array.isArray(key)) {
      // why: SWR never fetches an empty-array key, so it stays without data
      if (key.length === 0) {
        return {
          data: undefined,
          error: undefined,
          isLoading: false,
          mutate: vi.fn(),
        };
      }
      return {
        data:
          state.workspacesError || state.workspacesPending
            ? undefined
            : workspaces,
        error: state.workspacesError,
        isLoading: false,
        mutate: vi.fn(),
      };
    }
    if (typeof key === "string" && key.endsWith("/users/me/contexts/ctx1")) {
      return {
        data: state.contextData,
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
      };
    }
    if (typeof key === "string" && key.endsWith("/users/me/contexts")) {
      return {
        data: { results: [] },
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
      };
    }
    if (typeof key === "string" && key.endsWith("/organizations")) {
      return {
        data: state.orgsError
          ? undefined
          : { results: state.noOrgs ? [] : [{ id: "o1", name: "Org One" }] },
        error: state.orgsError,
        isLoading: false,
        mutate: vi.fn(),
      };
    }
    return {
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: vi.fn(),
    };
  },
  useSWRConfig: () => ({ mutate: configuredMutate }),
}));

import { WorkspaceContextForm } from "./workspace-context-form";

const CONTEXTS_URL = "http://test/users/me/contexts";
const CONTEXT_URL = `${CONTEXTS_URL}/ctx1`;

function renderEditForm() {
  state.contextData = {
    id: "ctx1",
    userId: "u1",
    workspaceId: "ws1",
    content: "existing context",
  };
  return render(<WorkspaceContextForm contextId="ctx1" />);
}

function chooseWorkspace() {
  return selectOption(screen.getByRole("combobox"), "Alpha");
}

function submit() {
  return fireEvent.click(screen.getByRole("button", { name: /Save|Update/ }));
}

describe("WorkspaceContextForm writes", () => {
  beforeEach(() => {
    resetFormHarness();
    state.contextData = undefined;
    state.orgsError = undefined;
    state.workspacesError = undefined;
  });

  it("creates through writeAt, revalidates the list, and lands on it", async () => {
    const fetchMock = stubAcceptedSave({ id: "c1" });

    render(<WorkspaceContextForm />);
    await chooseWorkspace();
    submit();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CONTEXTS_URL);
    expect(init.method).toBe("POST");
    expect(expectSentBodyToMatchSchema(fetchMock, contextCreateSchema)).toEqual(
      {
        content: "",
        workspaceId: "ws1",
      },
    );
    expect(configuredMutate).toHaveBeenCalledWith(CONTEXTS_URL);
    expect(toastSuccess).toHaveBeenCalledWith("Workspace context created");
    expect(push).toHaveBeenCalledWith("/settings/contexts");
  });

  it("shows a create's conflict inline against the Workspace field", async () => {
    stubRejectedSave("You already have a context for this scope", 409);

    render(<WorkspaceContextForm />);
    await chooseWorkspace();
    submit();

    expect(
      await screen.findByText("You already have a context for this scope"),
    ).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
    expect(configuredMutate).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("renders a rejected field inline and says why the save stopped", async () => {
    stubRejectedSave([{ path: ["content"], message: "Too long" }], 400);

    render(<WorkspaceContextForm />);
    await chooseWorkspace();
    submit();

    expect(await screen.findByText("Too long")).toBeInTheDocument();
    expect(toastError).toHaveBeenCalledWith(FIX_FORM_ERRORS_MESSAGE);
  });

  it("updates through writeAt and revalidates both the list and the record", async () => {
    const fetchMock = stubAcceptedSave({ id: "ctx1" });

    renderEditForm();
    submit();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CONTEXT_URL);
    expect(init.method).toBe("PUT");
    expect(configuredMutate).toHaveBeenCalledWith(CONTEXTS_URL);
    expect(configuredMutate).toHaveBeenCalledWith(CONTEXT_URL);
    expect(toastSuccess).toHaveBeenCalledWith("Workspace context updated");
    expect(push).toHaveBeenCalledWith("/settings/contexts");
  });

  it("surfaces a forbidden update as mapped messaging", async () => {
    stubRejectedSave("Not your context", 403);

    renderEditForm();
    submit();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Not your context"),
    );
    expect(configuredMutate).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps a failed delete in the dialog, with the backend's message", async () => {
    stubRejectedSave("This context is still in use", 409);

    renderEditForm();
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    fireEvent.click(deleteButtons[deleteButtons.length - 1]);

    expect(
      await screen.findByText("This context is still in use"),
    ).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("WorkspaceContextForm workspace read", () => {
  beforeEach(() => {
    resetFormHarness();
    state.contextData = undefined;
    state.orgsError = undefined;
    state.workspacesError = undefined;
    state.workspacesPending = false;
    state.noOrgs = false;
  });

  it("holds the Workspace picker disabled, and says why, while workspaces load", () => {
    state.workspacesPending = true;

    render(<WorkspaceContextForm />);

    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByText("Loading workspaces…")).toBeInTheDocument();
  });

  it("does not hold the picker loading for a user in no organization", () => {
    state.noOrgs = true;

    render(<WorkspaceContextForm />);

    expect(screen.queryByText("Loading workspaces…")).not.toBeInTheDocument();
  });

  it("surfaces a failed workspaces read in the UI, not the console", () => {
    state.workspacesError = new Error("500");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(<WorkspaceContextForm />);

    expect(
      screen.getByText("Couldn't load your workspaces."),
    ).toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("surfaces a failed organizations read, which the picker also depends on", () => {
    state.orgsError = new Error("500");

    render(<WorkspaceContextForm />);

    expect(
      screen.getByText("Couldn't load your workspaces."),
    ).toBeInTheDocument();
  });
});
