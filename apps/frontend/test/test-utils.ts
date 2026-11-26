import { useMemo, useSyncExternalStore } from "react";
import { expect, vi, type Mock } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { z } from "zod";

export const push = vi.fn();
export const refresh = vi.fn();
export const toastError = vi.fn();
export const toastSuccess = vi.fn();
export const toastInfo = vi.fn();

export const authState: {
  user: { id: string; timezone?: string | null } | null;
  actor: string;
  workspaceDelegation: unknown;
  ownsWorkspace?: boolean;
  isPending?: boolean;
} = { user: { id: "u1" }, actor: "org-admin", workspaceDelegation: null };

export const authMock = {
  useAuth: () => authState,
  useBackendUrl: () => "http://test",
};
const locationListeners = new Set<() => void>();
if (typeof window !== "undefined") {
  const nativeReplaceState = window.history.replaceState.bind(window.history);
  window.history.replaceState = (...args) => {
    nativeReplaceState(...args);
    locationListeners.forEach((listener) => listener());
  };
}
function subscribeToLocation(listener: () => void) {
  locationListeners.add(listener);
  return () => locationListeners.delete(listener);
}
function useLocationSearchParams() {
  const search = useSyncExternalStore(
    subscribeToLocation,
    () => window.location.search,
  );
  return useMemo(() => new URLSearchParams(search), [search]);
}

export const navigationMock = {
  useRouter: () => ({ push, refresh }),
  useSearchParams: useLocationSearchParams,
};
export const toastMock = {
  toast: { error: toastError, success: toastSuccess, info: toastInfo },
};

export function resetSharedSpies() {
  push.mockReset();
  refresh.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  toastInfo.mockReset();
  authState.user = { id: "u1" };
  authState.actor = "org-admin";
  authState.workspaceDelegation = null;
  authState.isPending = false;
  if (typeof window !== "undefined") window.history.replaceState(null, "", "/");
}

export function setupUser() {
  return userEvent.setup();
}

export async function openDropdownMenu() {
  const trigger = document.querySelector('[aria-haspopup="menu"]');
  if (!trigger) {
    throw new Error("No dropdown menu trigger found in the document");
  }
  await setupUser().click(trigger);
}

export async function selectOption(from: string | HTMLElement, option: string) {
  const combobox =
    typeof from === "string"
      ? screen.getAllByRole("combobox").find((el) => el.textContent === from)
      : from;
  if (!combobox) {
    throw new Error(`No select reading "${from as string}" found`);
  }
  const user = setupUser();
  combobox.focus();
  await user.keyboard("{ArrowDown}");
  await user.click(await screen.findByRole("option", { name: option }));
}

export function firePageShow(persisted: boolean) {
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: persisted });
  window.dispatchEvent(event);
}

export function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

export function expectEntryActionVariant(
  link: HTMLElement,
  state: "empty" | "populated",
) {
  if (state === "empty") {
    expect(link).toHaveClass("bg-primary");
    return;
  }
  expect(link).toHaveClass("border");
  expect(link).not.toHaveClass("bg-primary");
}

type SentBodyFetchMock = { mock: { calls: unknown[][] } };

export function fetchInit(
  fetchMock: SentBodyFetchMock,
  callIndex = 0,
): RequestInit {
  const [, init] = fetchMock.mock.calls.at(callIndex) as unknown as [
    string,
    RequestInit,
  ];
  return init;
}

export function expectSentBodyToMatchSchema<T extends z.ZodType>(
  fetchMock: SentBodyFetchMock,
  schema: T,
  callIndex = -1,
): z.input<T> {
  const [, init] = fetchMock.mock.calls.at(callIndex) as unknown as [
    string,
    RequestInit,
  ];
  const raw = init.body;
  if (typeof raw !== "string") {
    throw new Error(
      `Fetch call ${callIndex} carried no JSON body (got ${
        raw === undefined ? "undefined" : typeof raw
      })`,
    );
  }
  const body: unknown = JSON.parse(raw);
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues
      .map(
        (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
      )
      .join("\n");
    throw new Error(
      `Sent body does not match the request schema:\n${issues}\n${JSON.stringify(
        body,
        null,
        2,
      )}`,
    );
  }
  return body as z.input<T>;
}

export function stubAcceptedSave(body: unknown = {}, status = 200): Mock {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status, body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function stubRejectedSave(error: unknown, status = 400): Mock {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status, { error }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function stubPendingSave(body: unknown = {}, status = 200) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const fetchMock = vi
    .fn()
    .mockImplementation(() => released.then(() => jsonResponse(status, body)));
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, resolve: () => release() };
}

export function stubSaveSequence(
  ...responses: Array<{ status: number; body: unknown }>
): Mock {
  const fetchMock = vi.fn();
  for (const { status, body } of responses) {
    fetchMock.mockResolvedValueOnce(jsonResponse(status, body));
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
