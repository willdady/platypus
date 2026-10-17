import { vi, type Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { openDropdownMenu, resetSharedSpies, setupUser } from "./test-utils";

// Lists stub the same `fetch` shapes forms do, so the write helpers come from
// the same place; re-exported here so a list test has one import to reach for.
export {
  jsonResponse,
  setupUser,
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
 * Shared setup for the resource-list test files (agents, org agents, skills,
 * triggers, blueprints, boards, dashboards, users, manage-sharing): one auth,
 * navigation, toast and data-fetching mock, plus the row-menu and confirm
 * gestures every one of them performs, in place of a hand-rolled copy per
 * file.
 *
 * The counterpart to `form-test-harness`, and module-level exports for the
 * same reason — see the note there: `vi.mock("swr", () => swrMock)` is
 * hoisted, so what it names has to be an import, not something a factory
 * call built.
 *
 * Usage — the `vi.mock` calls stay in the test file, as literal calls.
 * `next/navigation` and `sonner` are already mocked with the same spies by
 * `vitest.setup.ts`:
 *
 * ```ts
 * import { authMock, swrMock, mockScopedSWR } from "@/test/list-test-harness";
 *
 * vi.mock("@/components/auth-provider", () => authMock);
 * vi.mock("swr", () => swrMock);
 * ```
 */

export type SwrResponse = {
  data: unknown;
  error?: unknown;
  isLoading: boolean;
  mutate: Mock;
};

/**
 * The revalidation every list asserts on. One spy shared by every registered
 * read: a list revalidates the read it renders, and no suite here needs to
 * tell two reads' revalidations apart.
 */
export const mutate = vi.fn();

/**
 * What a test registers for one read: the rows it returns (the common case),
 * or an explicit response patch for a read that is loading, has failed, or
 * whose payload is not `{ results }`-shaped.
 */
export type ListRead = unknown[] | Partial<SwrResponse>;

function buildResponse(read: ListRead): SwrResponse {
  const base: SwrResponse = { data: undefined, isLoading: false, mutate };
  return Array.isArray(read)
    ? { ...base, data: { results: read } }
    : { ...base, ...read };
}

// Registered responses, matched against the request URL in insertion order —
// so a test registering both `/attachments?` and `/workspaces` gets the
// specific one first. Built once at registration and handed back by
// reference on every call: a response rebuilt per render would churn the
// `data` identity that list effects key off.
const responsesByUrlFragment = new Map<string, SwrResponse>();
let fallbackResponse = buildResponse([]);
let strict = false;
// What SWR returns for a `null` key: no data, not loading.
const withheldResponse: SwrResponse = {
  data: undefined,
  isLoading: false,
  mutate,
};

/**
 * Registers each read the list under test makes, keyed by a fragment of the
 * request URL (matched with `includes`, in the order given) — the `swr` call
 * `useScopedSWR` makes underneath, which is where a list's reads are steered
 * from. Substring rather than the form harness's suffix match, because a
 * list's read is keyed mid-URL (`/agents` inside `…/ws1/agents`).
 *
 * ```ts
 * mockScopedSWR({ "/agents": [agent], "/providers": [provider] });
 * mockScopedSWR({ "/skills": { error: new Error("500") } });
 * ```
 *
 * Any read with no match falls back to an empty list, which is what the
 * secondary lookups a list makes (providers, agent associations) want. That
 * also lets a mistyped URL render the empty state and pass, so new tests
 * should pass `{ strict: true }`: an unmatched read then throws, naming its
 * key, and every read the list makes has to be registered. A `null` key (a
 * conditional read switched off) is never a miss, and returns no data, as SWR
 * does. `resetListHarness` turns strict mode off again.
 *
 * ```ts
 * mockScopedSWR({ "/agents": [agent], "/providers": [] }, { strict: true });
 * ```
 */
export function mockScopedSWR(
  reads: Record<string, ListRead>,
  options: { strict?: boolean } = {},
) {
  if (options.strict) strict = true;
  for (const [fragment, read] of Object.entries(reads)) {
    responsesByUrlFragment.set(fragment, buildResponse(read));
  }
}

export const swrMock = {
  __esModule: true,
  default: (key: string | null): SwrResponse => {
    if (!key) return withheldResponse;
    for (const [fragment, response] of responsesByUrlFragment) {
      if (key.includes(fragment)) return response;
    }
    if (strict) {
      throw new Error(
        `swrMock (strict): no read registered for "${key}". Registered: ${
          [...responsesByUrlFragment.keys()].join(", ") || "none"
        }`,
      );
    }
    return fallbackResponse;
  },
  useSWRConfig: () => ({ mutate }),
};

/** Resets spies and read registrations between tests. */
export function resetListHarness() {
  resetSharedSpies();
  mutate.mockReset();
  responsesByUrlFragment.clear();
  fallbackResponse = buildResponse([]);
  strict = false;
}

/**
 * Renders a list, optionally opening the row's dropdown menu and picking
 * `menuItem` — the three lines every row-action test starts with. The render
 * itself happens before the first `await`, so a caller with no `menuItem` may
 * leave the promise unawaited; one with a `menuItem` must await it.
 */
export async function renderList(ui: ReactElement, menuItem?: string) {
  const result = render(ui);
  if (menuItem !== undefined) {
    await openDropdownMenu();
    await setupUser().click(screen.getByText(menuItem));
  }
  return result;
}

/** The open dropdown menu's items, in order, by their visible text. */
export function menuItemLabels() {
  return screen
    .getAllByRole("menuitem")
    .map((item) => item.textContent?.trim());
}

/**
 * Confirms the open dialog by clicking its button. `await`s the button, so it
 * also covers the surfaces that check something over the wire (an attachment
 * count) before the dialog appears.
 */
export async function confirmDialog(name: string | RegExp) {
  await setupUser().click(await screen.findByRole("button", { name }));
}
