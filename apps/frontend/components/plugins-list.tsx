"use client";

import { Blocks, Container, Globe, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { Badge } from "@/components/ui/badge";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

// Mirrors the read-only `GET /organizations/:orgId/plugins` payload (ADR-0013).
// Contributions are the ids the plugin registered — tool sets, sandbox
// backends, and web backends all tie back to their originating plugin here.
interface InstalledPlugin {
  name: string;
  version: string;
  origin: "core" | "third-party";
  contributions: {
    toolSets: string[];
    sandboxBackends: string[];
    webBackends: string[];
  };
}

const PluginsList = ({
  className,
  orgId,
}: {
  className?: string;
  orgId: string;
}) => {
  const { data, error } = useScopedSWR<{
    results: InstalledPlugin[];
  }>("plugins", { orgId });

  // No data and no error is still loading — gating on data rather than
  // `isLoading` alone keeps "No plugins installed" from flashing first.
  if (!data && !error) {
    return (
      <ul className={cn(className)} aria-label="Loading plugins">
        {[0, 1, 2].map((i) => (
          <li key={i} className="mb-2">
            <Item variant="outline" className="items-start">
              <Skeleton className="size-8 shrink-0 rounded-sm" />
              <ItemContent>
                {/* Name, version badge, origin badge */}
                <div className="flex items-center gap-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-[22px] w-12 rounded-full" />
                  <Skeleton className="h-[22px] w-12 rounded-full" />
                </div>
                {/* One contribution row: its label, then an id badge */}
                <div className="mt-1 flex items-center gap-1.5">
                  <Skeleton className="mr-1 h-3 w-16" />
                  <Skeleton className="h-[22px] w-20 rounded-full" />
                </div>
              </ItemContent>
            </Item>
          </li>
        ))}
      </ul>
    );
  }

  // Only a cold failure replaces the list; a failed revalidation keeps it.
  if (error && !data) {
    return (
      <Empty className="border-2 border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Blocks className="size-6" />
          </EmptyMedia>
          <EmptyTitle>Couldn&apos;t load plugins</EmptyTitle>
          <EmptyDescription>
            The installed-plugins catalog is temporarily unavailable. Try
            refreshing the page.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const plugins = data?.results ?? [];

  if (!plugins.length) {
    return (
      <Empty className="border-2 border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Blocks className="size-6" />
          </EmptyMedia>
          <EmptyTitle>No plugins installed</EmptyTitle>
          <EmptyDescription>
            Plugins are enabled at deploy time via the{" "}
            <code>PLATYPUS_PLUGINS</code> environment variable. Ask your
            operator to add one — there is no in-app install.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ul className={cn(className)}>
      {plugins.map((plugin) => {
        const toolSets = plugin.contributions.toolSets ?? [];
        const sandboxBackends = plugin.contributions.sandboxBackends ?? [];
        const webBackends = plugin.contributions.webBackends ?? [];

        return (
          <li key={plugin.name} className="mb-2">
            <Item variant="outline" className="items-start">
              <ItemMedia variant="icon">
                <Blocks className="size-5" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  <span className="font-mono">{plugin.name}</span>
                  <Badge variant="secondary">v{plugin.version}</Badge>
                  <Badge
                    variant={plugin.origin === "core" ? "default" : "outline"}
                  >
                    {plugin.origin === "core" ? "Core" : "Third-party"}
                  </Badge>
                </ItemTitle>
                {toolSets.length === 0 &&
                sandboxBackends.length === 0 &&
                webBackends.length === 0 ? (
                  <ItemDescription>No contributions.</ItemDescription>
                ) : (
                  <div className="flex flex-col gap-2 mt-1">
                    {toolSets.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground mr-1">
                          <Wrench className="size-3" /> Tool sets
                        </span>
                        {toolSets.map((id) => (
                          <Badge
                            key={id}
                            variant="outline"
                            className="font-mono font-normal"
                          >
                            {id}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {sandboxBackends.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground mr-1">
                          <Container className="size-3" /> Sandbox backends
                        </span>
                        {sandboxBackends.map((id) => (
                          <Badge
                            key={id}
                            variant="outline"
                            className="font-mono font-normal"
                          >
                            {id}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {webBackends.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground mr-1">
                          <Globe className="size-3" /> Web backends
                        </span>
                        {webBackends.map((id) => (
                          <Badge
                            key={id}
                            variant="outline"
                            className="font-mono font-normal"
                          >
                            {id}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </ItemContent>
            </Item>
          </li>
        );
      })}
    </ul>
  );
};

export { PluginsList };
