import { vi, type Mock } from "vitest";

/**
 * Shared setup for the form test files (agent-form, mcp-form, webhook-form):
 * one navigation, config, auth, toast and data-fetching mock, plus helpers
 * for stubbing an accepted or rejected save, in place of three hand-rolled
 * copies of the same ~35 lines.
 *
 * These are plain module-level exports rather than something built by a
 * factory function: `vi.mock("swr", () => swrMock)` needs `swrMock` to be a
 * value Vitest's hoisting transform can see without moving it — hoisting
 * only special-cases local `vi.fn()` declarations, not arbitrary function
 * calls, so a `createHarness()` call assigned to a local const breaks (its
 * `vi.mock` gets hoisted above the assignment, the const doesn't move with
 * it). Importing a ready-made binding sidesteps that: nothing here needs
 * hoisting. Each test file gets its own copy of this module (Vitest
 * isolates modules per test file by default), so these module-level
 * mutables don't leak state across files — only within one file, which
 * `resetFormHarness` and `setData`/`setDataFor` are for.
 *
 * Usage — the `vi.mock` calls stay in the test file itself, as literal
 * calls, so Vitest's hoisting can find them:
 *
 * ```ts
 * import {
 *   navigationMock, configMock, authMock, toastMock, swrMock,
 * } from "@/lib/form-test-harness";
 *
 * vi.mock("next/navigation", () => navigationMock);
 * vi.mock("@/app/client-context", () => configMock);
 * vi.mock("@/components/auth-provider", () => authMock);
 * vi.mock("sonner", () => toastMock);
 * vi.mock("swr", () => swrMock);
 * ```
 */

export interface SwrResponse<T = unknown> {
  data: T;
  isLoading: boolean;
  mutate: Mock;
}

export const push = vi.fn();
export const toastError = vi.fn();
export const toastSuccess = vi.fn();
export const toastInfo = vi.fn();
export const configuredMutate = vi.fn();

export const navigationMock = { useRouter: () => ({ push }) };
export const configMock = { useBackendUrl: () => "http://test" };
export const authMock = { useAuth: () => ({ user: { id: "u1" } }) };
export const toastMock = {
  toast: { error: toastError, success: toastSuccess, info: toastInfo },
};

function buildResponse(data: unknown): SwrResponse {
  return { data, isLoading: false, mutate: vi.fn() };
}

const nullResponse: SwrResponse = buildResponse(undefined);

// Every response handed out is created once, here, and returned by
// reference on every subsequent call for the same key — never rebuilt per
// call. Forms key their reset-on-load effect off this `data` reference
// (`useResetOnChange(entity, ...)`); a mock that rebuilt the object on every
// render would churn that identity and retrigger the reset on every render,
// looping.
let defaultResponse: SwrResponse = nullResponse;
const responsesByKeySuffix = new Map<string, SwrResponse>();

/** Sets the response returned for any key with no more specific match. */
export function setData(data: unknown) {
  defaultResponse = buildResponse(data);
}

/** Sets the response returned for a key ending in `keySuffix`. */
export function setDataFor(keySuffix: string, data: unknown) {
  responsesByKeySuffix.set(keySuffix, buildResponse(data));
}

function swrFetcher(key: string | null): SwrResponse {
  if (!key) return nullResponse;
  for (const [suffix, response] of responsesByKeySuffix) {
    if (key.endsWith(suffix)) return response;
  }
  return defaultResponse;
}

export const swrMock = {
  __esModule: true,
  default: swrFetcher,
  useSWRConfig: () => ({ mutate: configuredMutate }),
};

/** Resets spies and data-fetching registrations between tests. */
export function resetFormHarness() {
  push.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  toastInfo.mockReset();
  configuredMutate.mockReset();
  defaultResponse = nullResponse;
  responsesByKeySuffix.clear();
}

/** Builds a fetch-shaped `Response` resolving to `body` with `status`. */
export function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
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
