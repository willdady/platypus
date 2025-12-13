import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import { TriangleAlert, Plus } from "lucide-react";
import Link from "next/link";
import { Button } from "./ui/button";

interface NoProvidersAlertProps {
  orgId: string;
  workspaceId: string;
}

export const NoProvidersAlert = ({
  orgId,
  workspaceId,
}: NoProvidersAlertProps) => {
  return (
    <div className="flex items-center justify-center h-full">
      <Alert className="min-w-sm max-w-md">
        <TriangleAlert />
        <AlertTitle>No AI providers configured</AlertTitle>
        <AlertDescription>
          <p className="mb-2">
            You need to configure at least one AI provider to start chatting.
          </p>
          <Button size="sm" asChild>
            <Link
              href={`/${orgId}/workspace/${workspaceId}/settings/providers/create`}
            >
              <Plus /> Add provider
            </Link>
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
};
