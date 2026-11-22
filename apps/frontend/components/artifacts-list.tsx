"use client";

import { useState } from "react";
import { Download, FileText, MessageSquare, Pencil } from "lucide-react";
import { toast } from "sonner";
import type { Artifact, ArtifactList, ArtifactType } from "@platypus/schemas";
import { artifactTypeSchema } from "@platypus/schemas";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyCard } from "@/components/empty-card";
import { EntityCardList } from "@/components/entity-card-list";
import { ListState } from "@/components/list-state";
import { CardGridSkeleton } from "@/components/list-skeletons";
import {
  ListFooter,
  ListPagination,
  pageBounds,
  serverPage,
} from "@/components/list-pagination";
import { ListToolbar } from "@/components/list-toolbar";
import { RowActionsMenu } from "@/components/row-actions-menu";
import { SearchInput } from "@/components/search-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { useListParams, useSearchParamInput } from "@/hooks/use-list-params";
import { useMutation } from "@/hooks/use-mutation";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { readArtifact } from "@/hooks/use-artifact";
import { errorMessage, writeEntity, type Serialized } from "@/lib/api-write";
import { artifactTypeLabel } from "@/lib/artifact-file";
import { downloadArtifactContent } from "@/lib/artifact-download";
import { formatRelativeTime } from "@/lib/relative-time";
import { workspaceRoutes } from "@/lib/routes";
import { ALL } from "@/lib/search-params";
import { ArtifactRenameDialog } from "./artifact-rename-dialog";

/** Artifacts per page. The route caps a request at 100. */
const PAGE_SIZE = 20;
/** The URL param holding the title search. */
const QUERY_PARAM = "artifactQuery";
/** The URL param holding the type filter. */
const TYPE_PARAM = "artifactType";
/** The URL param holding the page. */
const PAGE_PARAM = "artifactsPage";

/** A list row plus the fields `EntityCardList` reads. */
type ArtifactCard = Serialized<Artifact> & {
  readonly name: string;
  readonly description: string;
};

/** The type a URL value names, or undefined for no filter. */
function typeFromParam(value: string | null): ArtifactType | undefined {
  const candidate = artifactTypeSchema.options.find((type) => type === value);
  return candidate;
}

/** A failed read's response body, where `fetchError` keeps the backend's reason. */
function errorInfo(error: unknown): unknown {
  return error && typeof error === "object" && "info" in error
    ? error.info
    : undefined;
}

/**
 * The Workspace's Artifacts, newest change first. The route pages, searches
 * and filters, so this list asks for one page at a time and the URL keeps
 * what the reader is looking at. A card opens the full-page viewer; its menu
 * renames, downloads, opens the source Chat when there still is one, or
 * deletes.
 */
export function ArtifactsList({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) {
  const scope = { orgId, workspaceId };
  const backendUrl = useBackendUrl();
  const { ownsWorkspace } = useAuth();
  const canManage = ownsWorkspace === true;
  const routes = workspaceRoutes(orgId, workspaceId);

  const { value: search, onValueChange: setSearch } = useSearchParamInput(
    QUERY_PARAM,
    PAGE_PARAM,
  );
  const { get, set } = useListParams(PAGE_PARAM);
  const type = typeFromParam(get(TYPE_PARAM));

  const requestedPage = Math.max(
    Number.parseInt(get(PAGE_PARAM) ?? "", 10) || 1,
    1,
  );
  // The count the last page landed with. The first render has none, so it asks
  // for page 1; a deep link to a later page asks for the real page on the
  // render after that. Clamping the request itself keeps a URL a deletion made
  // too large from fetching — and labelling — a page that no longer exists.
  const [knownTotal, setKnownTotal] = useState(0);
  const bounds = pageBounds(requestedPage, knownTotal, PAGE_SIZE);
  const query = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String((bounds.page - 1) * PAGE_SIZE),
  });
  const term = search.trim();
  if (term) query.set("search", term);
  if (type) query.set("type", type);

  // `useScopedList` unwraps the envelope; this page needs its `totalCount` to
  // name the last page, so it reads the envelope and takes `results` itself.
  const { data, error, isLoading, mutate } = useScopedSWR<ArtifactList>(
    `artifacts?${query.toString()}`,
    scope,
    // Keep the page already on screen while the next one loads, so the page
    // number (read from the response's total) doesn't fall back to 1 mid-fetch.
    { keepPreviousData: true },
  );

  // Adjusting state during render is React's pattern for state derived from a
  // read that has just landed; it re-renders before the browser paints, so the
  // clamped page and its request take effect together.
  if (data && data.totalCount !== knownTotal) {
    setKnownTotal(data.totalCount);
  }

  const rows = data?.results ?? [];
  const totalCount = data?.totalCount ?? 0;
  const pageWindow = serverPage(rows, bounds.page, bounds.pageCount, PAGE_SIZE);

  const isFiltered = term !== "" || type !== undefined;
  const hasRows = totalCount > 0;

  const [renameTarget, setRenameTarget] = useState<Serialized<Artifact> | null>(
    null,
  );

  const deleteFlow = useDeleteFlow<ArtifactCard>({
    mutate,
    delete: (card, backendUrl) =>
      writeEntity(backendUrl, "artifacts", scope, { id: card.id }),
    onSuccess: () => {
      toast.success("Artifact deleted");
    },
  });

  const download = useMutation(async (row: Serialized<Artifact>) => {
    if (!backendUrl) return;
    try {
      const read = await readArtifact(backendUrl, scope, row.id);
      downloadArtifactContent(read.artifact, read.version.content);
    } catch (error) {
      toast.error(
        errorMessage(errorInfo(error)) ?? "Could not download this Artifact",
      );
    }
  });

  const cards: ArtifactCard[] = rows.map((row) => ({
    ...row,
    name: row.title,
    description: artifactTypeLabel(row.type),
  }));

  return (
    <>
      <ListToolbar>
        <SearchInput
          placeholder="Search artifacts..."
          aria-label="Search artifacts"
          value={search}
          onValueChange={setSearch}
          className="w-full sm:w-64"
        />
        <Select
          value={type ?? ALL}
          onValueChange={(value) =>
            set(TYPE_PARAM, value === ALL ? null : value)
          }
        >
          <SelectTrigger className="w-44" aria-label="Filter by type">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            {artifactTypeSchema.options.map((option) => (
              <SelectItem key={option} value={option}>
                {artifactTypeLabel(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ListToolbar>

      <EntityCardList
        items={cards}
        ghosts={pageWindow}
        isLoading={isLoading && !data}
        error={error}
        data={data}
        subject="artifacts"
        onRetry={() => void mutate()}
        skeleton={<CardGridSkeleton descriptionLines={1} />}
        descriptionLines={1}
        empty={
          isFiltered ? (
            <ListState variant="empty">
              No artifacts match your filters.
            </ListState>
          ) : (
            <EmptyCard
              icon={<FileText />}
              title="No artifacts yet"
              description="Artifacts are the documents, diagrams, pages and scripts Agents make. Ask an Agent with the Artifacts Tool set for one in a Chat, and it will be kept here."
            />
          )
        }
        href={(card) => routes.artifacts.detail(card.id)}
        meta={(card) => (
          <span
            className="flex h-4 items-center gap-1 text-xs text-muted-foreground"
            title={new Date(card.updatedAt).toLocaleString()}
          >
            Updated {formatRelativeTime(card.updatedAt)}
          </span>
        )}
        menu={(card) => (
          <RowActionsMenu
            name={card.name}
            actions={[
              ...(canManage
                ? [
                    {
                      label: "Rename",
                      icon: <Pencil />,
                      onSelect: () => setRenameTarget(card),
                    },
                  ]
                : []),
              {
                label: "Download",
                icon: <Download />,
                onSelect: () => void download.run(card),
                disabled: download.pending,
              },
              ...(card.sourceChatId
                ? [
                    {
                      label: "Open source Chat",
                      icon: <MessageSquare />,
                      href: routes.chat.detail(card.sourceChatId),
                    },
                  ]
                : []),
            ]}
            remove={
              canManage
                ? { onSelect: () => deleteFlow.request(card) }
                : undefined
            }
          />
        )}
      />

      {hasRows && (
        <ListFooter
          pagination={
            <ListPagination
              page={pageWindow}
              param={PAGE_PARAM}
              aria-label="Artifacts pages"
            />
          }
        />
      )}

      {renameTarget && (
        <ArtifactRenameDialog
          artifact={renameTarget}
          scope={scope}
          open
          onOpenChange={(open) => {
            if (!open) setRenameTarget(null);
          }}
          onRenamed={() => void mutate()}
        />
      )}

      <DeleteConfirmDialog
        noun="artifact"
        name={deleteFlow.target?.name}
        consequence="This also deletes all of its versions."
        {...deleteFlow.dialogProps}
      />
    </>
  );
}
