import { useState } from "react";
import type { AttachmentResourceType } from "@platypus/schemas";
import { useBackendUrl } from "@/components/auth-provider";
import {
  attachmentsEntity,
  detachResource,
  errorMessage,
  scopedPath,
  scopedUrl,
  type Scope,
} from "@/lib/api-write";
import { fetcher, joinUrl } from "@/lib/utils";
import { toast } from "sonner";
import { useDeleteFlow, type DeleteFlow } from "@/hooks/use-delete-flow";

export type NamedResource = {
  readonly id: string;
  readonly name: string;
};

export function useSharedDetach<T extends NamedResource>({
  resourceType,
  scope,
  mutate,
}: {
  readonly resourceType: AttachmentResourceType;
  readonly scope: Scope;
  readonly mutate: () => void | Promise<unknown>;
}): DeleteFlow<T> {
  return useDeleteFlow<T>({
    delete: (target, backendUrl) => {
      const { orgId, workspaceId } = scope;
      // why: no workspace means no attachment address; answer 404 without a round trip
      if (!orgId || !workspaceId) {
        return Promise.resolve({ outcome: "notFound", message: "Not found" });
      }
      return detachResource(
        backendUrl,
        { orgId, workspaceId },
        resourceType,
        target.id,
      );
    },
    mutate,
  });
}

export type PromoteBlocker = {
  readonly type: "provider" | "skill" | "subAgent" | "mcp";
  readonly id: string;
  readonly name: string;
};

export type PromoteFlow<T> = {
  readonly selected: T | null;
  readonly error: string | null;
  readonly blockers: PromoteBlocker[];
  readonly promoting: boolean;
  readonly open: (item: T) => void;
  readonly close: () => void;
  readonly confirm: () => Promise<void>;
};

function parseBlockers(body: unknown): PromoteBlocker[] {
  if (body && typeof body === "object" && "blockers" in body) {
    const { blockers } = body;
    if (Array.isArray(blockers)) return blockers as PromoteBlocker[];
  }
  return [];
}

export function usePromoteShared<T extends NamedResource>({
  entity,
  scope,
  mutate,
}: {
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
      // why: raw fetch, not writeEntity, because the 422 carries a blockers array
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

export type DeleteGuard<T> = {
  readonly blocked: { item: T; count: number } | null;
  readonly clear: () => void;
  readonly request: (item: T) => Promise<void>;
};

export function useSharedDeleteGuard<T extends NamedResource>({
  resourceType,
  scope,
  onAllowed,
}: {
  readonly resourceType: AttachmentResourceType;
  readonly scope: Scope;
  readonly onAllowed: (item: T) => void;
}): DeleteGuard<T> {
  const backendUrl = useBackendUrl();
  const [blocked, setBlocked] = useState<{ item: T; count: number } | null>(
    null,
  );

  const request = async (item: T) => {
    if (!backendUrl) {
      onAllowed(item);
      return;
    }
    let count: number;
    try {
      const info: { results?: unknown[] } = await fetcher(
        scopedUrl(backendUrl, attachmentsEntity(resourceType, item.id), scope),
      );
      count = (info.results ?? []).length;
    } catch {
      toast.error(
        `Couldn't check where "${item.name}" is attached. Try again.`,
      );
      return;
    }
    if (count > 0) {
      setBlocked({ item, count });
      return;
    }
    onAllowed(item);
  };

  return { blocked, clear: () => setBlocked(null), request };
}
