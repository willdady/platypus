import { useState } from "react";
import { useBackendUrl } from "@/components/auth-provider";
import {
  errorMessage,
  scopedPath,
  writeEntity,
  type Scope,
} from "@/lib/api-write";
import { joinUrl } from "@/lib/utils";
import { useDetachDialog } from "@/hooks/use-detach-dialog";

/** The minimum a row needs to appear in one of the Shared-resource dialogs. */
export interface NamedResource {
  readonly id: string;
  readonly name: string;
}

/** The Shared resources a Workspace can attach, detach, or promote (ADR-0007). */
export type SharedResourceType = "mcp" | "provider" | "skill" | "agent";

export interface SharedDetach<T> {
  /** The org-scoped row the detach dialog is open for, or null when closed. */
  readonly selected: T | null;
  readonly error: string | null;
  readonly detaching: boolean;
  readonly open: (item: T) => void;
  readonly close: () => void;
  /** Detach the open row; revalidates and closes on success. */
  readonly detach: () => Promise<void>;
}

/**
 * The detach half of the Shared-resource actions (#880): `useDetachDialog`'s
 * state plus the `attachments/<type>` write the four lists each re-implemented
 * around it — in-flight flag, revalidate-and-close on success, the backend's
 * reason inline on refusal.
 */
export function useSharedDetach<T extends NamedResource>({
  resourceType,
  scope,
  mutate,
}: {
  readonly resourceType: SharedResourceType;
  readonly scope: Scope;
  readonly mutate: () => void | Promise<unknown>;
}): SharedDetach<T> {
  const backendUrl = useBackendUrl();
  const dialog = useDetachDialog<T>();
  const [detaching, setDetaching] = useState(false);

  const detach = async () => {
    const target = dialog.selected;
    if (!target || !backendUrl || !scope.workspaceId) return;
    setDetaching(true);
    dialog.setError(null);
    try {
      const outcome = await writeEntity(
        backendUrl,
        `attachments/${resourceType}`,
        scope,
        { id: target.id },
      );
      if (outcome.outcome === "success") {
        dialog.close();
        await mutate();
      } else {
        dialog.setError(outcome.message);
      }
    } finally {
      setDetaching(false);
    }
  };

  return {
    selected: dialog.selected,
    error: dialog.error,
    detaching,
    open: dialog.open,
    close: dialog.close,
    detach,
  };
}

/** One workspace-private reference that a refused Promote asks the user to fix. */
export interface PromoteBlocker {
  readonly type: "provider" | "skill" | "subAgent" | "mcp";
  readonly id: string;
  readonly name: string;
}

export interface PromoteFlow<T> {
  readonly selected: T | null;
  readonly error: string | null;
  readonly blockers: PromoteBlocker[];
  readonly promoting: boolean;
  readonly open: (item: T) => void;
  readonly close: () => void;
  readonly confirm: () => Promise<void>;
}

function parseBlockers(body: unknown): PromoteBlocker[] {
  if (body && typeof body === "object" && "blockers" in body) {
    const { blockers } = body as { blockers: unknown };
    if (Array.isArray(blockers)) return blockers as PromoteBlocker[];
  }
  return [];
}

/**
 * Promote a workspace-private resource to an organization-shared one
 * (ADR-0007). The write stays raw rather than going through `writeEntity`
 * because the backend's 422 fix-this checklist carries a `blockers` array the
 * outcome mapping has nowhere to put; resources whose promote cannot be
 * blocked simply get an empty list.
 */
export function usePromoteShared<T extends NamedResource>({
  entity,
  scope,
  mutate,
}: {
  /** Collection entity as the API spells it: "agents" / "skills". */
  readonly entity: string;
  readonly scope: Scope;
  readonly mutate: () => void | Promise<unknown>;
}): PromoteFlow<T> {
  const backendUrl = useBackendUrl();
  const [selected, setSelected] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<PromoteBlocker[]>([]);
  const [promoting, setPromoting] = useState(false);

  const close = () => {
    setSelected(null);
    setError(null);
    setBlockers([]);
  };

  const open = (item: T) => {
    setError(null);
    setBlockers([]);
    setSelected(item);
  };

  const confirm = async () => {
    if (!selected || !backendUrl) return;
    setPromoting(true);
    setError(null);
    setBlockers([]);
    try {
      let response: Response;
      try {
        response = await fetch(
          joinUrl(
            backendUrl,
            `${scopedPath(entity, scope)}/${selected.id}/promote`,
          ),
          { method: "POST", credentials: "include" },
        );
      } catch {
        // The same failure `writeEntity` reports for an unreachable backend.
        setError("Network request failed");
        return;
      }
      if (response.ok) {
        await mutate();
        setSelected(null);
      } else {
        const body: unknown = await response.json().catch(() => null);
        setBlockers(parseBlockers(body));
        setError(
          errorMessage(body) ?? (response.statusText || "Failed to promote."),
        );
      }
    } finally {
      setPromoting(false);
    }
  };

  return { selected, error, blockers, promoting, open, close, confirm };
}

export interface DeleteGuard<T> {
  /** The row whose delete was blocked, with its live attachment count. */
  readonly blocked: { item: T; count: number } | null;
  readonly clear: () => void;
  /** Check attachments, then either block or hand the row to the delete flow. */
  readonly request: (item: T) => Promise<void>;
}

/**
 * A Shared resource can't be deleted while attached (ADR-0007). Check the live
 * attachment count first so the Organization surface explains the blocker up
 * front instead of offering a Delete button that is guaranteed to fail. If the
 * check itself fails we fall through — the backend still guards with a 409.
 */
export function useSharedDeleteGuard<T extends NamedResource>({
  resourceType,
  scope,
  onAllowed,
}: {
  readonly resourceType: SharedResourceType;
  readonly scope: Scope;
  /** Runs when nothing is attached — typically the delete flow's `request`. */
  readonly onAllowed: (item: T) => void;
}): DeleteGuard<T> {
  const backendUrl = useBackendUrl();
  const [blocked, setBlocked] = useState<{ item: T; count: number } | null>(
    null,
  );

  const request = async (item: T) => {
    if (backendUrl) {
      try {
        const res = await fetch(
          joinUrl(
            backendUrl,
            `${scopedPath("attachments", scope)}?resourceType=${resourceType}&resourceId=${item.id}`,
          ),
          { credentials: "include" },
        );
        const info = await res.json().catch(() => ({ results: [] }));
        const count = (info.results ?? []).length;
        if (count > 0) {
          setBlocked({ item, count });
          return;
        }
      } catch {
        // Fall through to the delete flow; the backend still guards it.
      }
    }
    onAllowed(item);
  };

  return { blocked, clear: () => setBlocked(null), request };
}
