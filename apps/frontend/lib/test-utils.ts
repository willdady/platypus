import { vi, type Mock } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

/**
 * The spies and module mocks both harnesses hand to `vi.mock`. They live here
 * rather than in either harness because a form and a list stub the same three
 * modules the same way; only the data-fetching mock differs between them.
 *
 * These are plain module-level values, not something a factory builds:
 * `vi.mock("sonner", () => toastMock)` is hoisted above everything local, so
 * what it names has to be an import. Vitest gives each test file its own copy
 * of this module, so the mutable state below cannot leak between files —
 * `resetSharedSpies` is for resetting it within one.
 */

export const push = vi.fn();
export const toastError = vi.fn();
export const toastSuccess = vi.fn();
export const toastInfo = vi.fn();

/**
 * The signed-in reader. Mutable so a test can drop the actor down from
 * `org-admin`, sign the reader out, or hand the workspace a delegation — the
 * lists gate Promote, Delete and the create CTAs on all three. Handed back by
 * reference on every `useAuth()` so the identity stays stable across renders.
 */
export const authState: {
  user: { id: string } | null;
  actor: string;
  workspaceDelegation: unknown;
} = { user: { id: "u1" }, actor: "org-admin", workspaceDelegation: null };

export const authMock = {
  useAuth: () => authState,
  useBackendUrl: () => "http://test",
};
export const navigationMock = { useRouter: () => ({ push }) };
export const toastMock = {
  toast: { error: toastError, success: toastSuccess, info: toastInfo },
};

/** Resets the shared spies and the signed-in reader between tests. */
export function resetSharedSpies() {
  push.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  toastInfo.mockReset();
  authState.user = { id: "u1" };
  authState.actor = "org-admin";
  authState.workspaceDelegation = null;
}

/**
 * Radix's DropdownMenu opens on pointerdown and grabs pointer capture,
 * neither of which jsdom implements. Call once (e.g. in `beforeAll`) before
 * rendering anything that uses a Radix DropdownMenu/Select/etc.
 */
export function installRadixPointerPolyfills() {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
}

/**
 * jsdom has no ResizeObserver; cmdk's Command palette and the chart surfaces
 * subscribe to one on mount. Assigned rather than `vi.stubGlobal`-ed, so a
 * test file's `vi.unstubAllGlobals()` does not take it away again.
 */
export function installResizeObserverStub() {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

/**
 * jsdom has no matchMedia; `PromptInputTextarea` subscribes to it for the
 * mobile Enter-inserts-a-newline branch. Reports no match, which is the
 * desktop branch every test here wants.
 */
export function installMatchMediaStub() {
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

/** Opens the first closed Radix DropdownMenu trigger found in the document. */
export function openDropdownMenu() {
  const trigger = document.querySelector('[aria-haspopup="menu"]');
  if (!trigger) {
    throw new Error("No dropdown menu trigger found in the document");
  }
  // Our DropdownMenu trigger only opens on pointerdown for a mouse; jsdom
  // leaves `pointerType` empty, so the tap has to be completed with a click.
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 });
  fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 });
  fireEvent.click(trigger, { button: 0 });
}

/**
 * Picks `option` on a Radix Select — named either by the element itself, or by
 * the value the closed trigger is currently reading (several of our Select
 * triggers have no accessible name, so the current value is all there is).
 *
 * Keyboard rather than pointer: Radix opens on ArrowDown without the pointer
 * capture jsdom lacks. `scrollIntoView` is stubbed only for the duration of
 * the interaction — Radix calls it while positioning the list, and a caller
 * may have its own stub installed that this must not clobber.
 */
export async function selectOption(from: string | HTMLElement, option: string) {
  const combobox =
    typeof from === "string"
      ? screen.getAllByRole("combobox").find((el) => el.textContent === from)
      : from;
  if (!combobox) {
    throw new Error(`No select reading "${String(from)}" found`);
  }
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = () => {};
  try {
    fireEvent.keyDown(combobox, { key: "ArrowDown" });
    const item = await screen.findByRole("option", { name: option });
    fireEvent.keyDown(item, { key: "Enter" });
  } finally {
    Element.prototype.scrollIntoView = scrollIntoView;
  }
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
