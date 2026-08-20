"use client";

import { useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { fetcher, joinUrl } from "@/lib/utils";
import { writeAt } from "@/lib/api-write";
import { useBackendUrl } from "@/app/client-context";
import { type Context } from "@platypus/schemas";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { Globe, FolderClosed } from "lucide-react";
import useSWR from "swr";
import { ContextsList } from "@/components/contexts-list";

interface ContextWithWorkspaceName extends Context {
  workspaceName?: string | null;
}

const findGlobalContext = (contexts?: {
  results: ContextWithWorkspaceName[];
}) => contexts?.results.find((c) => !c.workspaceId);

const ContextsPage = () => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  const { data: contexts, mutate } = useSWR<{
    results: ContextWithWorkspaceName[];
  }>(user ? joinUrl(backendUrl, "/users/me/contexts") : null, fetcher);

  const [globalContextContent, setGlobalContextContent] = useState(
    () => findGlobalContext(contexts)?.content || "",
  );
  const [isSavingGlobal, setIsSavingGlobal] = useState(false);

  // Sync server-provided global context into editable local state whenever the
  // fetched data changes, using React's "adjust state during render" pattern.
  const [prevContexts, setPrevContexts] = useState(contexts);
  if (contexts !== prevContexts) {
    setPrevContexts(contexts);
    setGlobalContextContent(findGlobalContext(contexts)?.content || "");
  }

  const handleSaveGlobal = async () => {
    const globalCtx = findGlobalContext(contexts);
    setIsSavingGlobal(true);

    const outcome = globalCtx
      ? await writeAt(
          joinUrl(backendUrl, `/users/me/contexts/${globalCtx.id}`),
          {
            method: "PUT",
            data: { content: globalContextContent },
          },
        )
      : await writeAt(joinUrl(backendUrl, "/users/me/contexts"), {
          method: "POST",
          data: { content: globalContextContent, workspaceId: undefined },
        });

    if (outcome.outcome === "success") {
      toast.success("Global context saved");
      mutate();
    } else if (!globalCtx && outcome.outcome === "conflict") {
      toast.error("You already have a global context");
    } else {
      toast.error(
        globalCtx ? "Failed to update context" : "Failed to create context",
      );
    }
    setIsSavingGlobal(false);
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Contexts</h1>

      <div className="space-y-8">
        {/* Global Context Section */}
        <div>
          <div className="mb-4">
            <h2 className="text-lg font-semibold mb-2 flex items-center gap-2">
              <Globe className="w-5 h-5" />
              Global Context
            </h2>
            <p className="text-sm text-muted-foreground">
              Your global context applies across all workspaces and chats. Use
              it to provide personal information, preferences, or instructions
              that should always be available to the AI.
            </p>
          </div>
          <div className="space-y-3">
            <div className="border rounded-lg p-4 bg-muted/30">
              <div className="space-y-3">
                <ExpandableTextarea
                  id="global-context-edit"
                  label=""
                  placeholder="Enter context about yourself, your preferences, or general instructions..."
                  value={globalContextContent}
                  onChange={(e) => setGlobalContextContent(e.target.value)}
                  className="!font-mono"
                  maxLength={1000}
                />
                <div className="flex items-center justify-between">
                  <Button onClick={handleSaveGlobal} disabled={isSavingGlobal}>
                    Save
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
              <FolderClosed className="w-5 h-5" />
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
};

export default ContextsPage;
