import { vi, type Mock } from "vitest";
import { resetSharedSpies } from "./test-utils";

// The write-stubbing helpers live in `test-utils` — lists stub the same
// `fetch` shapes — and are re-exported here so a form test still has one
// import to reach for.
export {
  jsonResponse,
  stubAcceptedSave,
  stubRejectedSave,
  stubSaveSequence,
  push,
  toastError,
  toastSuccess,
  toastInfo,
  authState,
  authMock,
  navigationMock,
  toastMock,
} from "./test-utils";

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
 *   navigationMock, authMock, toastMock, swrMock,
 * } from "@/lib/form-test-harness";
 *
 * vi.mock("next/navigation", () => navigationMock);
 * vi.mock("@/components/auth-provider", () => authMock);
 * vi.mock("sonner", () => toastMock);
 * vi.mock("swr", () => swrMock);
 * ```
 */

export interface SwrResponse<T = unknown> {
  data: T;
  error?: unknown;
  isLoading: boolean;
  mutate: Mock;
}

export const configuredMutate = vi.fn();

function buildResponse(data: unknown): SwrResponse {
  return { data, error: undefined, isLoading: false, mutate: vi.fn() };
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

/**
 * Makes the read for a key ending in `keySuffix` fail. With no suffix, every
 * read with no more specific match fails — the cold detail read a form's
 * failure state exists for.
 */
export function setError(error: unknown, keySuffix?: string) {
  if (keySuffix) {
    const response =
      responsesByKeySuffix.get(keySuffix) ?? buildResponse(undefined);
    response.error = error;
    responsesByKeySuffix.set(keySuffix, response);
    return;
  }
  // Copied rather than mutated: the default may still be the shared null
  // response, and setting `error` on that would leak into every null key.
  defaultResponse = { ...defaultResponse, error };
}

/**
 * Makes the read for a key ending in `keySuffix` still in flight: no data,
 * `isLoading`. With no suffix, every read with no more specific match is.
 */
export function setLoading(keySuffix?: string) {
  const response = { ...buildResponse(undefined), isLoading: true };
  if (keySuffix) responsesByKeySuffix.set(keySuffix, response);
  else defaultResponse = response;
}

// Suffix matching, not substring: a form's registered key is the tail of the
// request URL (`/providers`), and a substring match would also catch the
// detail read beneath it (`/providers/p1`). The list harness matches on
// `includes` instead, because a list's reads are keyed mid-URL.
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
  resetSharedSpies();
  configuredMutate.mockReset();
  defaultResponse = nullResponse;
  responsesByKeySuffix.clear();
}

/**
 * The JSON body the form put on the wire for the last save. Typed on the one
 * thing it reads rather than `Mock`, whose generic varies with how the caller
 * spelled `vi.fn()`.
 */
export function savedBody(fetchMock: { mock: { calls: unknown[][] } }) {
  const [, init] = fetchMock.mock.calls.at(-1) as unknown as [
    string,
    RequestInit,
  ];
  return JSON.parse(String(init.body));
}
