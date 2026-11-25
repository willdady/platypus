import { type ToolSet } from "@platypus/schemas";
import { serverRead } from "@/lib/server-read";

export type ToolSetsFailureReason = "unauthorized" | "unavailable";

export type ToolSetsResult =
  | { ok: true; toolSets: ToolSet[] }
  | { ok: false; reason: ToolSetsFailureReason };

export async function fetchToolSets(path: string): Promise<ToolSetsResult> {
  const result = await serverRead<unknown>(path);
  if (!result.ok) {
    return {
      ok: false,
      reason:
        result.status === 401 || result.status === 403
          ? "unauthorized"
          : "unavailable",
    };
  }

  const results = (result.body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) {
    return { ok: false, reason: "unavailable" };
  }

  return { ok: true, toolSets: results as ToolSet[] };
}

export function toolSetFormProps(result: ToolSetsResult): {
  toolSets: ToolSet[];
  toolSetsError?: ToolSetsFailureReason;
} {
  return result.ok
    ? { toolSets: result.toolSets, toolSetsError: undefined }
    : { toolSets: [], toolSetsError: result.reason };
}
