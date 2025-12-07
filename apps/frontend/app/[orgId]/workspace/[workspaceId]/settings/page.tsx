'use client';

import { Button } from "@/components/ui/button";
import { Copy } from "lucide-react";
import { useParams } from "next/navigation";
import { toast } from "sonner";


const WorkspaceSettingsPage = () => {
  const { orgId, workspaceId } = useParams<{ orgId: string; workspaceId: string }>();

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Workspace Settings</h1>
      <div className="grid grid-cols-2 gap-6">
        <div>
          <p className="text-sm text-muted-foreground mb-2">Organization ID</p>
          <div className="flex items-center justify-between">
            <p className="font-mono">{orgId}</p>
            <Button
              className="cursor-pointer text-muted-foreground"
              variant="ghost"
              size="icon"
              onClick={() => {
                navigator.clipboard.writeText(orgId);
                toast.info("Copied to clipboard");
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div>
          <p className="text-sm text-muted-foreground mb-2">Workspace ID</p>
          <div className="flex items-center justify-between">
            <p className="font-mono">{workspaceId}</p>
            <Button
              className="cursor-pointer text-muted-foreground"
              variant="ghost"
              size="icon"
              onClick={() => {
                navigator.clipboard.writeText(workspaceId);
                toast.info("Copied to clipboard");
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WorkspaceSettingsPage;
