import { vi, type Mock } from "vitest";
import { resetSharedSpies } from "./test-utils";

export {
  jsonResponse,
  setupUser,
  stubAcceptedSave,
  stubRejectedSave,
  stubSaveSequence,
  stubPendingSave,
  push,
  refresh,
  toastError,
  toastSuccess,
  toastInfo,
  authState,
  authMock,
  navigationMock,
  toastMock,
} from "./test-utils";

// why: vi.mock is hoisted, so it must name an import, not a factory call's result
export type SwrResponse<T = unknown> = {
  data: T;
  error?: unknown;
  isLoading: boolean;
  mutate: Mock;
};

export const configuredMutate = vi.fn();

function buildResponse(data: unknown): SwrResponse {
  return { data, error: undefined, isLoading: false, mutate: vi.fn() };
}

const nullResponse: SwrResponse = buildResponse(undefined);

let defaultResponse: SwrResponse = nullResponse;
const responsesByKeySuffix = new Map<string, SwrResponse>();

export function setData(data: unknown) {
  defaultResponse = buildResponse(data);
}

export function setDataFor(keySuffix: string, data: unknown) {
  responsesByKeySuffix.set(keySuffix, buildResponse(data));
}

export function setError(error: unknown, keySuffix?: string) {
  if (keySuffix) {
    const response =
      responsesByKeySuffix.get(keySuffix) ?? buildResponse(undefined);
    response.error = error;
    responsesByKeySuffix.set(keySuffix, response);
    return;
  }
  defaultResponse = { ...defaultResponse, error };
}

export function setLoading(keySuffix?: string) {
  const response = { ...buildResponse(undefined), isLoading: true };
  if (keySuffix) responsesByKeySuffix.set(keySuffix, response);
  else defaultResponse = response;
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

export function resetFormHarness() {
  resetSharedSpies();
  configuredMutate.mockReset();
  defaultResponse = nullResponse;
  responsesByKeySuffix.clear();
}
