import { type ToolSet } from "@platypus/schemas";
import { joinUrl } from "@/lib/utils";

/**
 * Why a server-side tool sets read failed.
 *
 * `unauthorized` is called out separately because it is the case operators
 * actually hit: during SSR the frontend can only forward the cookies the
 * browser sent to the *frontend* origin, so a deployment whose frontend and
 * backend sit on different hosts forwards no session cookie and the backend
 * answers 401 (issue #819). Naming authentication in that case is the
 * difference between a dead end and a fixable one.
 */
export type ToolSetsFailureReason = "unauthorized" | "unavailable";

export type ToolSetsResult =
  | { ok: true; toolSets: ToolSet[] }
  | { ok: false; reason: ToolSetsFailureReason };

/**
 * Reads a tool sets collection from the backend during server-side rendering,
 * forwarding the caller's cookie header.
 *
 * Never throws and never returns `undefined`: a failed read is reported as a
 * value so the page can render an honest error instead of dying mid-render.
 * Callers get an empty `toolSets` array only when the backend really did
 * return an empty collection — "none exist" stays distinguishable from
 * "couldn't ask".
 */
export async function fetchToolSets(
  path: string,
  cookie: string,
): Promise<ToolSetsResult> {
  // Internal URL for SSR, falling back to BACKEND_URL for local dev.
  const backendUrl =
    process.env.INTERNAL_BACKEND_URL || process.env.BACKEND_URL || "";

  let response: Response;
  try {
    response = await fetch(joinUrl(backendUrl, path), { headers: { cookie } });
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason:
        response.status === 401 || response.status === 403
          ? "unauthorized"
          : "unavailable",
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) {
    return { ok: false, reason: "unavailable" };
  }

  return { ok: true, toolSets: results as ToolSet[] };
}

/**
 * Decodes a result into the props the Agent form takes, so the three pages
 * that render the form don't each repeat the unpacking.
 */
export function toolSetFormProps(result: ToolSetsResult): {
  toolSets: ToolSet[];
  toolSetsError?: ToolSetsFailureReason;
} {
  return result.ok
    ? { toolSets: result.toolSets, toolSetsError: undefined }
    : { toolSets: [], toolSetsError: result.reason };
}
