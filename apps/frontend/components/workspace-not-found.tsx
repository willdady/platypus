"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyCard } from "@/components/empty-card";
import { orgRoutes } from "@/lib/routes";

/**
 * A Workspace that doesn't exist (or was deleted), shown inside the shell
 * with the way back to its Organization.
 */
export const WorkspaceNotFound = () => {
  const { orgId } = useParams<{ orgId: string }>();
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-4">
      <EmptyCard
        className="max-w-md"
        icon={<FileQuestion />}
        title="Workspace not found"
        description="This workspace doesn't exist. It may have been deleted."
        action={
          <Button asChild>
            <Link href={orgRoutes(orgId).root}>Back to Organization</Link>
          </Button>
        }
      />
    </div>
  );
};
