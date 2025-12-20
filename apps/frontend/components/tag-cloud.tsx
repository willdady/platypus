"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tag } from "lucide-react";

interface TagCloudProps {
  workspaceId: string;
}

interface TagData {
  tag: string;
  count: number;
}

export const TagCloud = ({ workspaceId }: TagCloudProps) => {
  const backendUrl = useBackendUrl();
  const { data, isLoading } = useSWR<{ results: TagData[] }>(
    `${backendUrl}/chat/tags?workspaceId=${workspaceId}`,
    fetcher
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
    const size = minSize + ((count - minCount) / (maxCount - minCount)) * (maxSize - minSize);
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
          {tags.map((tagData) => (
            <Badge
              key={tagData.tag}
              variant="secondary"
              className="hover:bg-primary hover:text-primary-foreground transition-colors cursor-default font-mono inline-flex items-center"
              style={{ fontSize: getFontSize(tagData.count) }}
            >
              <span>{tagData.tag}</span>
              <span className="ml-1.5 opacity-50 text-[0.7em] leading-none">
                {tagData.count}
              </span>
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};
