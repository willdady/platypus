"use client";

import { useState } from "react";
import { Download, FileText, MessageSquare, Pencil } from "lucide-react";
import { toast } from "sonner";
import type { Artifact, ArtifactList, ArtifactType } from "@platypus/schemas";
import { artifactTypeSchema } from "@platypus/schemas";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyCard } from "@/components/empty-card";
import { Badge } from "@/components/ui/badge";
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
import { ArtifactUploadButton } from "./artifact-upload";

const PAGE_SIZE = 20;
const QUERY_PARAM = "artifactQuery";
const TYPE_PARAM = "artifactType";
const PAGE_PARAM = "artifactsPage";

type ArtifactCard = Serialized<Artifact> & {
  readonly name: string;
  readonly description: string;
};

function typeFromParam(value: string | null): ArtifactType | undefined {
  const candidate = artifactTypeSchema.options.find((type) => type === value);
  return candidate;
}

function errorInfo(error: unknown): unknown {
  return error && typeof error === "object" && "info" in error
    ? error.info
    : undefined;
}

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
  const [knownTotal, setKnownTotal] = useState(0);
  const bounds = pageBounds(requestedPage, knownTotal, PAGE_SIZE);
  const query = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String((bounds.page - 1) * PAGE_SIZE),
  });
  const term = search.trim();
  if (term) query.set("search", term);
  if (type) query.set("type", type);

  // why: the envelope's totalCount names the last page, which useScopedList unwraps away
  const { data, error, isLoading, mutate } = useScopedSWR<ArtifactList>(
    `artifacts?${query.toString()}`,
    scope,
    { keepPreviousData: true },
  );

  // why: derived during render — an effect would paint the unclamped page first
  if (data && data.totalCount !== knownTotal) {
    setKnownTotal(data.totalCount);
  }

  const rows = data?.results ?? [];
  const totalCount = data?.totalCount ?? 0;
  const pageWindow = serverPage(rows, bounds.page, bounds.pageCount, PAGE_SIZE);

  const isFiltered = term !== "" || type !== undefined;
  const hasRows = totalCount > 0;

  const upload = canManage ? (
    <ArtifactUploadButton
      orgId={orgId}
      workspaceId={workspaceId}
      variant={hasRows || isFiltered ? "outline" : "default"}
      onUploaded={() => void mutate()}
    />
  ) : undefined;

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
    description: `Updated ${formatRelativeTime(row.updatedAt)}`,
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
              description="Artifacts are the documents, diagrams, pages and scripts Agents make, or that you upload. Ask an Agent with the Artifacts Tool set for one in a Chat, or use Upload to bring in a text file."
              action={upload}
            />
          )
        }
        href={(card) => routes.artifacts.detail(card.id)}
        badges={(card) => (
          <Badge variant="secondary">{artifactTypeLabel(card.type)}</Badge>
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

      {hasRows ? (
        <ListFooter
          pagination={
            <ListPagination
              page={pageWindow}
              param={PAGE_PARAM}
              aria-label="Artifacts pages"
            />
          }
        >
          {upload}
        </ListFooter>
      ) : isFiltered && canManage ? (
        <ListFooter>{upload}</ListFooter>
      ) : null}

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
