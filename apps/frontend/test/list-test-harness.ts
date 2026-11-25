import { vi, type Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { openDropdownMenu, resetSharedSpies, setupUser } from "./test-utils";

export {
  jsonResponse,
  setupUser,
  expectEntryActionVariant,
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

// why: vi.mock is hoisted, so it must name an import, not a factory call's result
export type SwrResponse = {
  data: unknown;
  error?: unknown;
  isLoading: boolean;
  mutate: Mock;
};

export const mutate = vi.fn();

export type ListRead = unknown[] | Partial<SwrResponse>;

function buildResponse(read: ListRead): SwrResponse {
  const base: SwrResponse = { data: undefined, isLoading: false, mutate };
  return Array.isArray(read)
    ? { ...base, data: { results: read } }
    : { ...base, ...read };
}

const responsesByUrlFragment = new Map<string, SwrResponse>();
let fallbackResponse = buildResponse([]);
let strict = false;
const withheldResponse: SwrResponse = {
  data: undefined,
  isLoading: false,
  mutate,
};

export function mockScopedSWR(
  reads: Record<string, ListRead>,
  options: { strict?: boolean } = {},
) {
  if (options.strict) strict = true;
  for (const [fragment, read] of Object.entries(reads)) {
    responsesByUrlFragment.set(fragment, buildResponse(read));
  }
}

const swrCache = new Map<string, { data?: unknown }>();

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
  useSWRConfig: () => ({ mutate, cache: swrCache }),
};

export function resetListHarness() {
  resetSharedSpies();
  mutate.mockReset();
  responsesByUrlFragment.clear();
  fallbackResponse = buildResponse([]);
  strict = false;
}

export async function renderList(ui: ReactElement, menuItem?: string) {
  const result = render(ui);
  if (menuItem !== undefined) {
    await openDropdownMenu();
    await setupUser().click(screen.getByText(menuItem));
  }
  return result;
}

export function menuItemLabels() {
  return screen
    .getAllByRole("menuitem")
    .map((item) => item.textContent?.trim());
}

export async function openRowMenu(name: string) {
  await setupUser().click(
    screen.getByRole("button", { name: `Actions for ${name}` }),
  );
}

export async function chooseRowMenuAction(name: string, item: string) {
  await openRowMenu(name);
  await setupUser().click(await screen.findByRole("menuitem", { name: item }));
}

export async function confirmDialog(name: string | RegExp) {
  await setupUser().click(await screen.findByRole("button", { name }));
}
