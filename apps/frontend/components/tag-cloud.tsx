"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tag } from "lucide-react";

interface TagCloudProps {
  orgId: string;
  workspaceId: string;
  selectedTags?: string[];
  onTagToggle?: (tag: string) => void;
}

interface TagData {
  tag: string;
  count: number;
}

export const TagCloud = ({
  orgId,
  workspaceId,
  selectedTags = [],
  onTagToggle,
}: TagCloudProps) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading } = useSWR<{ results: TagData[] }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/chat/tags`,
        )
      : null,
    fetcher,
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex flex-col">
          <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <Tag className="size-5" /> Tags
          </h2>
          <p className="text-sm text-muted-foreground">
            Browse and filter chats by tag.
          </p>
        </div>
        <Card className="bg-transparent shadow-none py-0">
          <CardContent className="p-4">
            <div className="flex flex-wrap gap-2 animate-pulse">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-6 w-16 bg-muted rounded-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const DEFAULT_LIMIT = 30;
  const allTags = data?.results || [];

  if (allTags.length === 0) {
    return null;
  }

  const tags = showAll ? allTags : allTags.slice(0, DEFAULT_LIMIT);
  const hasMore = allTags.length > DEFAULT_LIMIT;

  const counts = allTags.map((t) => t.count);
  const minCount = Math.min(...counts);
  const maxCount = Math.max(...counts);

  const getFontSize = (count: number) => {
    if (maxCount === minCount) return "0.75rem"; // 12px
    // Linear scale between 0.75rem (12px) and 1.375rem (22px)
    const minSize = 0.75;
    const maxSize = 1.375;
    const size =
      minSize +
      ((count - minCount) / (maxCount - minCount)) * (maxSize - minSize);
    return `${size}rem`;
  };

  return (
    <>
      <Separator />
      <div className="space-y-4">
        <div className="flex flex-col">
          <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <Tag className="size-5" /> Tags
          </h2>
          <p className="text-sm text-muted-foreground">
            Browse and filter chats by tag.
          </p>
        </div>
        <Card className="bg-transparent shadow-none py-0">
          <CardContent className="p-4">
            <div className="flex flex-wrap gap-2 items-center">
              {tags.map((tagData) => {
                const isSelected = selectedTags.includes(tagData.tag);
                return (
                  <Badge
                    key={tagData.tag}
                    variant={isSelected ? "default" : "secondary"}
                    className="cursor-pointer font-mono inline-flex items-center"
                    style={{ fontSize: getFontSize(tagData.count) }}
                    onClick={() => onTagToggle?.(tagData.tag)}
                  >
                    <span>{tagData.tag}</span>
                    <span className="ml-1.5 opacity-50 text-[0.7em] leading-none">
                      {tagData.count}
                    </span>
                  </Badge>
                );
              })}
              {hasMore && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground h-auto py-0.5 px-2"
                  onClick={() => setShowAll((v) => !v)}
                >
                  {showAll
                    ? "Show less"
                    : `+${allTags.length - DEFAULT_LIMIT} more`}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
};
