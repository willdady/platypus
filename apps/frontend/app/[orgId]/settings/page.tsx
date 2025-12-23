"use client";

import { Button } from "@/components/ui/button";
import { Copy } from "lucide-react";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { OrganisationForm } from "@/components/organisation-form";

const OrgSettingsPage = () => {
  const { orgId } = useParams<{
    orgId: string;
  }>();

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Organisation Settings</h1>
      <div className="grid grid-cols-2 gap-6 mb-4">
        <div>
          <p className="text-sm text-muted-foreground mb-2">Organisation ID</p>
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
      </div>

      <div className="max-w-md">
        <OrganisationForm orgId={orgId} />
      </div>
    </div>
  );
};

export default OrgSettingsPage;
