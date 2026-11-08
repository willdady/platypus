"use client";

import { Button } from "@/components/ui/button";
import { Copy } from "lucide-react";
import { copyWithToast } from "@/lib/clipboard";
import { OrganizationForm } from "@/components/organization-form";
import { PageHeader } from "@/components/page-header";

function OrgSettingsPage({ orgId }: { orgId: string }) {
  return (
    <div>
      <PageHeader title="Organization Settings" />
      <div className="grid grid-cols-2 gap-6 mb-4">
        <div>
          <p className="text-sm mb-2">Organization ID</p>
          <div className="flex items-center justify-between">
            <p className="font-mono text-muted-foreground">{orgId}</p>
            <Button
              className="text-muted-foreground"
              variant="ghost"
              size="icon"
              aria-label="Copy Organization ID"
              onClick={() => copyWithToast(orgId)}
            >
              <Copy />
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-md">
        <OrganizationForm orgId={orgId} />
      </div>
    </div>
  );
}

export default OrgSettingsPage;
