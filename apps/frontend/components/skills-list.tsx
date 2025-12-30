"use client";

import {
  Item,
  ItemTitle,
  ItemActions,
  ItemDescription,
  ItemContent,
} from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EllipsisVertical, Pencil } from "lucide-react";
import { type Skill } from "@platypus/schemas";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
  EmptyMedia,
} from "@/components/ui/empty";

export const SkillsList = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  const { data: skillsData, isLoading } = useSWR<{
    results: Skill[];
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/skills`,
        )
      : null,
    fetcher,
  );

  const skills = skillsData?.results || [];

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (!skills.length) {
    return null;
  }

  return (
    <ul className="grid grid-cols-1 lg:grid-cols-2 grid-rows-1 gap-4">
      {skills.map((skill) => (
        <li key={skill.id}>
          <Item variant="outline" className="h-full">
            <ItemContent>
              <ItemTitle>{skill.name}</ItemTitle>
              <ItemDescription className="text-xs line-clamp-2">
                {skill.description}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    className="cursor-pointer text-muted-foreground"
                    variant="ghost"
                    size="icon"
                  >
                    <EllipsisVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem asChild>
                    <Link
                      className="cursor-pointer"
                      href={`/${orgId}/workspace/${workspaceId}/skills/${skill.id}`}
                    >
                      <Pencil /> Edit
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </ItemActions>
          </Item>
        </li>
      ))}
    </ul>
  );
};
