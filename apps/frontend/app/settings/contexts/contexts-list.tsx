"use client";

import { Button } from "@/components/ui/button";
import { type Context } from "@platypus/schemas";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { Globe, FolderClosed } from "lucide-react";
import { useScopedList } from "@/hooks/use-scoped-list";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useEntityForm } from "@/hooks/use-entity-form";
import { ContextsList } from "@/components/contexts-list";
import { ListError } from "@/components/list-state";
import { Skeleton } from "@/components/ui/skeleton";

type ContextWithWorkspaceName = {
  workspaceName?: string | null;
} & Context;

function ContextsPage() {
  const {
    data,
    results: contexts,
    error,
    isLoading,
  } = useScopedList<ContextWithWorkspaceName>("users/me/contexts", {});
  // Until the read lands there is no telling whether a global context exists,
  // so the editor stays hidden and Save stays off: a save then would POST a
  // duplicate, and anything typed would be overwritten when the data arrives.
  const isLoaded = data !== undefined;

  const globalCtx = contexts.find((c) => !c.workspaceId);

  const {
    formData,
    setField,
    seedFormData,
    validationErrors,
    isSubmitting,
    submit,
  } = useEntityForm({
    initialData: { content: globalCtx?.content || "" },
    entity: "users/me/contexts",
    scope: {},
    id: globalCtx?.id,
    buildPayload: (data) => data,
    // No field to key it to: the backend's refusal is the message to show.
    conflictField: null,
    successMessage: "Global context saved",
  });

  // Seed the editor from the global context once it is known, and again only
  // when a different one arrives (the first save creates it). Keyed on the id,
  // not the list: a revalidation hands back a new array, and re-seeding on that
  // would overwrite what the user is typing.
  useResetOnChange(isLoaded ? (globalCtx?.id ?? null) : undefined, () =>
    seedFormData({ content: globalCtx?.content || "" }),
  );

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Contexts</h1>

      <div className="flex flex-col gap-8">
        {/* Global Context Section */}
        <div>
          <div className="mb-4">
            <h2 className="text-lg font-semibold mb-2 flex items-center gap-2">
              <Globe className="size-5" />
              Global Context
            </h2>
            <p className="text-sm text-muted-foreground">
              Your global context applies across all workspaces and chats. Use
              it to provide personal information, preferences, or instructions
              that should always be available to the AI.
            </p>
          </div>
          <div className="flex flex-col gap-3">
            <div className="border rounded-lg p-4 bg-muted/30">
              <div className="flex flex-col gap-3">
                {isLoaded ? (
                  <ExpandableTextarea
                    id="global-context-edit"
                    label=""
                    placeholder="Enter context about yourself, your preferences, or general instructions..."
                    value={formData.content}
                    onChange={(e) => setField("content", e.target.value)}
                    error={validationErrors.content}
                    className="!font-mono"
                    maxLength={1000}
                  />
                ) : isLoading || !error ? (
                  // The textarea and its character counter.
                  <div aria-label="Loading global context">
                    <Skeleton className="h-16 w-full" />
                    <div className="flex justify-end mt-1">
                      <Skeleton className="h-4 w-14" />
                    </div>
                  </div>
                ) : (
                  <ListError error={error} subject="global context" />
                )}
                <div className="flex items-center justify-between">
                  <Button
                    onClick={() => void submit()}
                    disabled={!isLoaded || isSubmitting}
                  >
                    {isSubmitting ? "Saving..." : "Save"}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Workspace Contexts Section */}
        <div>
          <div className="mb-4">
            <h2 className="text-lg font-semibold mb-2 flex items-center gap-2">
              <FolderClosed className="size-5" />
              Workspace Contexts
            </h2>
            <p className="text-sm text-muted-foreground">
              Similar to global context, workspace context is specific to a
              single workspace. Use them to provide information about yourself
              which should only apply when working in that workspace.
            </p>
          </div>
          <ContextsList />
        </div>
      </div>
    </div>
  );
}

export default ContextsPage;
