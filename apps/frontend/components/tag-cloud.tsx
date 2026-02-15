"use client";

import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Tag className="h-4 w-4" />
            Tag Cloud
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2 animate-pulse">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-6 w-16 bg-muted rounded-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  const tags = data?.results || [];

  if (tags.length === 0) {
    return null;
  }

  const counts = tags.map((t) => t.count);
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
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Tag className="h-4 w-4" />
          Tag Cloud
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-3 items-center">
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
        </div>
      </CardContent>
    </Card>
  );
};
