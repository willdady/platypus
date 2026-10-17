import { useMemo, useSyncExternalStore } from "react";
import { vi, type Mock } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The spies and module mocks both harnesses hand to `vi.mock`, and that
 * `vitest.setup.ts` installs as every file's default `next/navigation` and
 * `sonner` mocks. They live here rather than in either harness because a form
 * and a list stub the same modules the same way; only the data-fetching mock
 * differs between them.
 *
 * These are plain module-level values, not something a factory builds:
 * `vi.mock("sonner", () => toastMock)` is hoisted above everything local, so
 * what it names has to be an import. Vitest gives each test file its own copy
 * of this module, so the mutable state below cannot leak between files —
 * `resetSharedSpies` is for resetting it within one.
 */

export const push = vi.fn();
export const refresh = vi.fn();
export const toastError = vi.fn();
export const toastSuccess = vi.fn();
export const toastInfo = vi.fn();

/**
 * The signed-in reader. Mutable so a test can drop the actor down from
 * `org-admin`, sign the reader out, or hand the workspace a delegation — the
 * lists gate Promote, Delete and the create CTAs on all three. `isPending`
 * holds the session unresolved, as `useScopedSWR` sees it before sign-in settles. Handed back by
 * reference on every `useAuth()` so the identity stays stable across renders.
 */
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
// Next keeps `useSearchParams` in step with `history.replaceState`; the default
// mock does the same off jsdom's location, so a list that writes its filters
// there re-renders as it would in the app.
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

/** Resets the shared spies and the signed-in reader between tests. */
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

/**
 * A user-event session for one interaction. user-event drives the full
 * pointer, focus and keyboard sequence a real browser does, so a control that
 * is disabled, covered or `pointer-events: none` refuses the gesture instead of
 * reacting as a bare `fireEvent` would. New tests reach for this over
 * `fireEvent`.
 */
export function setupUser() {
  return userEvent.setup();
}

/** Opens the first closed Radix DropdownMenu trigger found in the document. */
export async function openDropdownMenu() {
  const trigger = document.querySelector('[aria-haspopup="menu"]');
  if (!trigger) {
    throw new Error("No dropdown menu trigger found in the document");
  }
  await setupUser().click(trigger);
}

/**
 * Picks `option` on a Radix Select — named either by the element itself, or by
 * the value the closed trigger is currently reading (several of our Select
 * triggers have no accessible name, so the current value is all there is).
 *
 * Keyboard rather than pointer, as a keyboard user would: focus the trigger,
 * open it with ArrowDown, and click the option.
 */
export async function selectOption(from: string | HTMLElement, option: string) {
  const combobox =
    typeof from === "string"
      ? screen.getAllByRole("combobox").find((el) => el.textContent === from)
      : from;
  if (!combobox) {
    throw new Error(`No select reading "${String(from)}" found`);
  }
  const user = setupUser();
  combobox.focus();
  await user.keyboard("{ArrowDown}");
  await user.click(await screen.findByRole("option", { name: option }));
}

/**
 * Builds a fetch-shaped `Response` resolving to `body` with `status`. Carries
 * an empty `statusText`: the request module falls back to it when a failure
 * body names no reason, and a real `Response` has one.
 */
export function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as unknown as Response;
}

/** Stubs global `fetch` to resolve with an accepted (2xx) save. */
export function stubAcceptedSave(body: unknown = {}, status = 200): Mock {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status, body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Stubs global `fetch` to resolve with a rejected save, `{ error }`. */
export function stubRejectedSave(error: unknown, status = 400): Mock {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status, { error }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * Stubs global `fetch` with requests that stay in flight until `resolve` is
 * called, which settles every one of them as an accepted save — for asserting
 * what the UI does while a write is pending.
 */
export function stubPendingSave(body: unknown = {}, status = 200) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const fetchMock = vi
    .fn()
    .mockImplementation(() => released.then(() => jsonResponse(status, body)));
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, resolve: () => release() };
}

/**
 * Stubs global `fetch` to resolve each call in turn with the given
 * `{ status, body }` responses — for flows that make more than one request
 * (e.g. a save followed by a dependent, separately-failing write).
 */
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
