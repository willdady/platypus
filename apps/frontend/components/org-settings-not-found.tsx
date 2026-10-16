"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyCard } from "@/components/empty-card";
import { orgRoutes } from "@/lib/routes";

/**
 * An Organization settings page that doesn't exist — a deleted record, a
 * stale link — shown inside the settings shell, so the menu stays in reach.
 */
export const OrgSettingsNotFound = () => {
  const { orgId } = useParams<{ orgId: string }>();
  return (
    <EmptyCard
      icon={<FileQuestion />}
      title="Page not found"
      description="This settings page doesn't exist. It may have been deleted."
      action={
        <Button asChild>
          <Link href={orgRoutes(orgId).settings.root}>Back to settings</Link>
        </Button>
      }
    />
  );
};
