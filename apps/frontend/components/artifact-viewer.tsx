"use client";

import type { ReactNode } from "react";
import { useId, useState } from "react";
import { useSWRConfig } from "swr";
import {
  isHandEditableArtifactType,
  type ArtifactRead,
  type ArtifactType,
} from "@platypus/schemas";
import { CopyIcon, DownloadIcon, PencilIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FormTextareaField } from "@/components/form-textarea-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { copyWithToast } from "@/lib/clipboard";
import { formatDateTime } from "@/lib/format-date";
import { artifactTypeLabel } from "@/lib/artifact-file";
import { downloadArtifactContent } from "@/lib/artifact-download";
import { scopedUrl, writeAt } from "@/lib/api-write";
import { cn } from "@/lib/utils";
import { useMutation } from "@/hooks/use-mutation";
import {
  artifactEntity,
  artifactVersionsEntity,
  isArtifactDeleted,
  useArtifact,
  useArtifactVersions,
} from "@/hooks/use-artifact";
import { ArtifactMarkdown, fencedCode } from "./artifact-markdown";
import { ArtifactPreviewFrame } from "./artifact-preview-frame";
import { isFramedArtifactType } from "@/lib/artifact-frame";
import { ListError, ListState } from "./list-state";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "./list-skeletons";
import { useUnsavedChangesGuard } from "./unsaved-changes-guard";

/**
 * A `createArtifact` call's content before it is stored. The viewer shows it
 * while the call streams, and keeps showing it until the saved version has been
 * read, so opening or completing the call does not jump the panel from one
 * rendering to another. A failed call never presents its partial content as a
 * saved Artifact.
 */
export type ArtifactLive = {
  status: "streaming" | "failed";
  title?: string;
  type?: ArtifactType;
  language?: string | null;
  content: string;
  error?: string;
};

/** The language a Preview tab's fenced block is rendered as. */
function previewLanguage(
  type: ArtifactType | undefined,
  language?: string | null,
): string {
  if (type === undefined) return "text";
  switch (type) {
    case "markdown":
      return "markdown";
    case "code":
      return language || "text";
    case "mermaid":
      return "mermaid";
    case "html":
      return "html";
    case "svg":
      return "svg";
    default: {
      // A new ArtifactType must decide its own Preview language, not fall to text.
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

/**
 * The language a Code tab's fenced block is highlighted as. A Mermaid block is
 * `text` here rather than `mermaid`, because the renderer draws a `mermaid`
 * fence as a diagram — the opposite of showing its source.
 */
function codeTabLanguage(
  type: ArtifactType | undefined,
  language?: string | null,
): string {
  return type === "mermaid" ? "text" : previewLanguage(type, language);
}

/**
 * The one Artifact viewer: the Chat's side panel and the full-page view. It
 * owns the Preview and Code tabs, copy and download for every type, the
 * version picker, the read-only mark on an older version, and the hand editor
 * a markdown Artifact's latest version opens. Markdown, code and Mermaid render
 * in the app's own DOM; HTML and SVG run only inside the Artifact frame, so an
 * older version previews by reading that version first. While a `createArtifact`
 * call streams it takes the partial content as `live`; a stored version always
 * wins once read.
 */
export function ArtifactViewer({
  orgId,
  workspaceId,
  artifactId,
  version,
  live,
  onClose,
  className,
}: {
  orgId: string;
  workspaceId: string;
  /** The stored Artifact; absent while a call's content is not yet stored. */
  artifactId?: string;
  /** The version a Chat Card opens; omitted reads the latest. */
  version?: number;
  live?: ArtifactLive;
  onClose?: () => void;
  className?: string;
}) {
  const backendUrl = useBackendUrl();
  // Saving a hand edit is the Workspace Owner's, as rename and delete are, so
  // the action is only offered to them.
  const { ownsWorkspace } = useAuth();
  const { mutate: mutateKey } = useSWRConfig();
  const scope = { orgId, workspaceId };
  // A version the reader picks in the panel. It is remembered only for the
  // Artifact and opening version it was picked against: when a Card opens
  // another version, the prop wins again without an effect resetting it.
  const versionKey = `${artifactId}:${version ?? "latest"}`;
  const [picked, setPicked] = useState<{
    key: string;
    version: number;
  } | null>(null);
  const selected = picked?.key === versionKey ? picked.version : version;

  const { data, error, isLoading, mutate } = useArtifact(
    scope,
    artifactId,
    selected,
  );
  const { data: versions, mutate: mutateVersions } = useArtifactVersions(
    scope,
    artifactId,
  );

  // The hand editor: the text being edited, and the stored version it started
  // from. Edit is offered only on the latest markdown version, so the base is
  // always the latest — the save names it, and the backend refuses one that has
  // been overtaken. `saveError` is the save's refusal, shown beside the text it
  // belongs to; the text itself is never replaced by it.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [baseVersion, setBaseVersion] = useState<number>();
  const [saveError, setSaveError] = useState<{
    kind: "conflict" | "content";
    message: string;
  } | null>(null);
  const editFormId = useId();

  const savedContent = data?.version.content ?? "";
  const isDirty = editing && draft !== savedContent;
  // The standard guard: register the edit's dirty state and route every way
  // out of it through the one "Discard unsaved changes?" dialog.
  const confirmDiscard = useUnsavedChangesGuard(isDirty);

  const { run: saveEdit, pending: isSaving } = useMutation(async () => {
    if (!artifactId || baseVersion === undefined) return undefined;

    return await writeAt<ArtifactRead>(
      scopedUrl(backendUrl, artifactVersionsEntity(artifactId), scope),
      {
        method: "POST",
        data: { content: draft, baseVersion },
      },
    );
  });

  const startEditing = (content: string, fromVersion: number) => {
    // Pin the panel to the version being edited. The latest read revalidates
    // on focus, and an Agent's new version would otherwise slide the text
    // being compared out from under the edit; the pinned version is immutable,
    // and seeding its key with what is on screen keeps the editor from
    // remounting into a loading state.
    if (selected === undefined) {
      void mutateKey(
        scopedUrl(
          backendUrl,
          artifactEntity(artifactId ?? "", fromVersion),
          scope,
        ),
        data,
        { revalidate: false },
      );
      setPicked({ key: versionKey, version: fromVersion });
    }
    setDraft(content);
    setBaseVersion(fromVersion);
    setSaveError(null);
    setEditing(true);
  };

  const stopEditing = () => {
    setSaveError(null);
    setEditing(false);
  };

  const cancelEditing = () => confirmDiscard(stopEditing);

  const submitEdit = async () => {
    setSaveError(null);
    const result = await saveEdit();
    if (!result) return;

    switch (result.outcome) {
      case "success": {
        const saved = result.data;
        setEditing(false);
        setDraft(saved.version.content);
        // Show the version the save wrote, and revalidate both reads behind
        // the viewer: the version being edited and the picker's list.
        setPicked({ key: versionKey, version: saved.version.version });
        void mutate();
        void mutateVersions();
        toast.success("Artifact updated");
        return;
      }
      case "conflict":
        // The text stays in the editor; the message says the Artifact moved on.
        setSaveError({ kind: "conflict", message: result.message });
        return;
      case "invalid":
        // The message is rendered beside the field it belongs to.
        setSaveError({
          kind: "content",
          message: result.fieldErrors.content ?? result.message,
        });
        return;
      default:
        toast.error(result.message);
    }
  };

  if (error && isArtifactDeleted(error)) {
    return (
      <ArtifactFrame className={className} onClose={onClose} title="Artifact">
        <div className="p-4">
          <ListState variant="empty">This Artifact has been deleted.</ListState>
        </div>
      </ArtifactFrame>
    );
  }

  if (data) {
    const { artifact, version: current } = data;
    const latestVersion = versions?.results[0]?.version;
    const onLatest = latestVersion === current.version;
    const isLatest = latestVersion === undefined || onLatest;
    // Edit is offered only once the version list confirms this is the latest:
    // a Card that opened an older version must not offer it while the list is
    // still loading.
    const canEdit =
      ownsWorkspace && isHandEditableArtifactType(artifact.type) && onLatest;
    // Once open, the editor stays open: a revalidation that reveals a newer
    // version must not hide the text the User is typing. Its save then
    // conflicts, which is the case the editor is built for.
    const showEditor = editing;

    const pickVersion = (value: string) => {
      const pick = () => {
        setPicked({ key: versionKey, version: Number(value) });
        setEditing(false);
      };
      if (editing) confirmDiscard(pick);
      else pick();
    };

    const close = () => {
      setEditing(false);
      onClose?.();
    };

    return (
      <ArtifactFrame
        className={className}
        onClose={
          onClose
            ? () => (editing ? confirmDiscard(close) : close())
            : undefined
        }
        title={artifact.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">
              {artifactTypeLabel(artifact.type)}
            </Badge>
            {versions && versions.results.length > 0 ? (
              <Select
                value={String(selected ?? current.version)}
                onValueChange={pickVersion}
              >
                <SelectTrigger
                  size="sm"
                  aria-label="Artifact version"
                  className="h-6 gap-1 px-2 text-xs"
                >
                  <SelectValue>{`Version ${selected ?? current.version}`}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {versions.results.map((entry) => (
                    <SelectItem
                      key={entry.version}
                      value={String(entry.version)}
                      className="text-xs"
                    >
                      {`Version ${entry.version} · ${
                        entry.author === "agent" ? "Agent" : "You"
                      } · ${formatDateTime(entry.createdAt)}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="text-muted-foreground text-xs">
                Version {current.version}
              </span>
            )}
            {!isLatest && !editing && (
              <Badge variant="outline">Read-only</Badge>
            )}
          </span>
        }
        actions={
          showEditor ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={cancelEditing}
                disabled={isSaving}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                form={editFormId}
                disabled={!isDirty || isSaving}
              >
                {isSaving ? "Saving..." : "Save"}
              </Button>
            </>
          ) : (
            <>
              {canEdit && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => startEditing(current.content, current.version)}
                >
                  <PencilIcon />
                  Edit
                </Button>
              )}
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Copy Artifact source"
                onClick={() => void copyWithToast(current.content, "Copied")}
              >
                <CopyIcon />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Download Artifact"
                onClick={() =>
                  downloadArtifactContent(artifact, current.content)
                }
              >
                <DownloadIcon />
              </Button>
            </>
          )
        }
      >
        {showEditor ? (
          <ArtifactEditor
            formId={editFormId}
            content={draft}
            onChange={(value) => {
              setDraft(value);
              if (saveError?.kind === "content") setSaveError(null);
            }}
            conflict={saveError?.kind === "conflict" ? saveError.message : null}
            contentError={
              saveError?.kind === "content" ? saveError.message : null
            }
            disabled={isSaving}
            canSave={isDirty && !isSaving}
            onSubmit={() => void submitEdit()}
          />
        ) : (
          <ArtifactTabs
            type={artifact.type}
            language={artifact.language}
            content={current.content}
            scriptOrigins={data.scriptOrigins}
          />
        )}
      </ArtifactFrame>
    );
  }

  if (error) {
    return (
      <ArtifactFrame className={className} onClose={onClose} title="Artifact">
        <div className="p-4">
          <ListError
            error={error}
            subject="this artifact"
            onRetry={() => void mutate()}
          />
        </div>
      </ArtifactFrame>
    );
  }

  if (live?.status === "failed") {
    const title = live.title?.trim() || "Artifact";
    return (
      <ArtifactFrame
        className={className}
        onClose={onClose}
        title={title}
        subtitle={
          live.type ? (
            <Badge variant="secondary">{artifactTypeLabel(live.type)}</Badge>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-2 p-4">
          <ListState variant="empty">This Artifact was not saved.</ListState>
          {live.error && (
            <p className="text-destructive text-xs">{live.error}</p>
          )}
        </div>
      </ArtifactFrame>
    );
  }

  if (live) {
    const title = live.title?.trim() || "Creating Artifact…";

    return (
      <ArtifactFrame
        className={className}
        onClose={onClose}
        title={title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {live.type && (
              <Badge variant="secondary">{artifactTypeLabel(live.type)}</Badge>
            )}
            <span className="text-muted-foreground text-xs">Streaming</span>
          </span>
        }
      >
        {live.content === "" ? (
          <div className="p-4">
            <ListState variant="empty">
              Waiting for the Agent to write this Artifact…
            </ListState>
          </div>
        ) : (
          <ArtifactTabs
            type={live.type}
            language={live.language}
            content={live.content}
            streaming
          />
        )}
      </ArtifactFrame>
    );
  }

  if (isLoading) {
    return (
      <ArtifactFrame className={className} onClose={onClose} title="Artifact">
        <LoadingRegion
          label="Loading artifact"
          className="flex flex-col gap-3 p-4"
        >
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-40 w-full" />
        </LoadingRegion>
      </ArtifactFrame>
    );
  }

  return (
    <ArtifactFrame className={className} onClose={onClose} title="Artifact">
      <div className="p-4">
        <ListError
          error={error}
          subject="this artifact"
          onRetry={() => void mutate()}
        />
      </div>
    </ArtifactFrame>
  );
}

/**
 * The hand editor: a plain text area with the rendered document beside it.
 * The Save button lives in the viewer's header and submits this form through
 * `formId`. Both refusals — a conflict, and content over the limit — render
 * here beside the text they belong to, and the text itself is never replaced.
 */
function ArtifactEditor({
  formId,
  content,
  onChange,
  conflict,
  contentError,
  disabled,
  canSave,
  onSubmit,
}: {
  formId: string;
  content: string;
  onChange: (value: string) => void;
  conflict: string | null;
  contentError: string | null;
  disabled: boolean;
  canSave: boolean;
  onSubmit: () => void;
}) {
  return (
    <form
      id={formId}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) onSubmit();
      }}
    >
      {conflict && (
        <div className="p-4 pb-0">
          <Alert variant="destructive">
            <AlertTitle>Artifact changed</AlertTitle>
            <AlertDescription>{conflict}</AlertDescription>
          </Alert>
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-2 divide-x">
        <div className="flex min-h-0 flex-col p-4">
          <FormTextareaField
            label="Artifact content"
            name="artifact-content"
            value={content}
            onChange={onChange}
            error={contentError}
            disabled={disabled}
            spellCheck={false}
            className="min-h-0 flex-1"
            textareaClassName="min-h-0 flex-1 resize-none font-mono text-xs"
          />
        </div>
        <div className="min-h-0 overflow-auto p-4">
          <ArtifactMarkdown content={content} />
        </div>
      </div>
    </form>
  );
}

/**
 * The Preview and Code tabs for one piece of content. Markdown, code and
 * Mermaid preview from the first byte. A stored HTML or SVG Artifact runs in
 * the Artifact frame; while a call is still streaming, partial HTML or SVG
 * stays on source — there is no complete document to run, and its approved
 * origins are only known once the saved version is read.
 */
function ArtifactTabs({
  type,
  language,
  content,
  scriptOrigins = [],
  streaming = false,
}: {
  type: ArtifactType | undefined;
  language?: string | null;
  content: string;
  scriptOrigins?: readonly string[];
  /** True for a call that has not been saved yet. */
  streaming?: boolean;
}) {
  const framed = !streaming && type !== undefined && isFramedArtifactType(type);
  const previewAvailable =
    type !== undefined && !(streaming && isFramedArtifactType(type));
  return (
    <Tabs
      defaultValue={previewAvailable ? "preview" : "code"}
      className="flex min-h-0 flex-1 flex-col gap-0"
    >
      <TabsList className="mx-4 mt-3 h-auto self-start p-0.5">
        <TabsTrigger
          value="preview"
          disabled={!previewAvailable}
          title={
            previewAvailable
              ? undefined
              : streaming
                ? "Preview is unavailable until the Agent finishes writing this Artifact"
                : "Preview is unavailable until the Artifact's type is known"
          }
          className="px-2 py-0.5 text-xs"
        >
          Preview
        </TabsTrigger>
        <TabsTrigger value="code" className="px-2 py-0.5 text-xs">
          Code
        </TabsTrigger>
      </TabsList>
      <TabsContent
        value="preview"
        className={
          framed
            ? "mt-0 min-h-0 flex-1 overflow-hidden p-4"
            : "mt-0 min-h-0 flex-1 overflow-auto p-4"
        }
      >
        {type !== undefined && isFramedArtifactType(type) ? (
          <ArtifactPreviewFrame
            type={type}
            content={content}
            scriptOrigins={scriptOrigins}
          />
        ) : type === "markdown" ? (
          <ArtifactMarkdown content={content} />
        ) : (
          <ArtifactMarkdown
            content={fencedCode(content, previewLanguage(type, language))}
          />
        )}
      </TabsContent>
      <TabsContent
        value="code"
        className="mt-0 min-h-0 flex-1 overflow-auto p-4"
      >
        <ArtifactMarkdown
          content={fencedCode(content, codeTabLanguage(type, language))}
        />
      </TabsContent>
    </Tabs>
  );
}

function ArtifactFrame({
  title,
  subtitle,
  actions,
  onClose,
  className,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  onClose?: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={`Artifact: ${title}`}
      className={cn("flex min-h-0 flex-col bg-background", className)}
    >
      <header className="flex items-start gap-2 border-b p-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="truncate font-semibold text-sm" title={title}>
            {title}
          </h2>
          {subtitle}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          {onClose && (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Close Artifact"
              onClick={onClose}
            >
              <XIcon />
            </Button>
          )}
        </div>
      </header>
      {children}
    </section>
  );
}
